"""Arbitrage engine — real-time mispricing between Polymarket binary
markets and Binance spot.

The thesis is straightforward:
  - A Polymarket "Will BTC be UP at H+1h?" market is a binary option on
    BTC's price path over the next ≤1h. Its YES mid implies a market
    probability P_mkt that BTC ends above the strike.
  - Binance BTC spot trades continuously. The current spot price and
    recent realised volatility imply a model probability P_model that
    BTC ends above the strike over the same horizon (log-normal random
    walk, drift assumed ≈ 0 for sub-hour windows).
  - Mismatch = P_mkt − P_model. If |mismatch| > fee + slippage budget,
    we have a tradeable opportunity:
      - P_mkt > P_model → YES is over-priced; buy NO (or sell YES)
      - P_mkt < P_model → YES is under-priced; buy YES

This module is engine-only — no I/O loops, no UI. The FastAPI handler
calls `find_live_opportunities()` once per cycle and serves the result.

Design notes for the model:
  - log-normal walk assumes the next-1h log return r ~ N(0, σ²τ) with
    σ estimated from the last `vol_window_sec` of Binance ticks
  - we deliberately don't model drift — for BTC at sub-hour horizons
    the drift term is dwarfed by σ√τ, and assuming r̄=0 keeps the model
    interpretable (deviation from model = mispricing, not regime call)
  - σ is computed as annualised vol from log returns of consecutive
    ticks within the window, then scaled back to τ via σ_τ = σ_ann × √τ

Edge after fees:
  expected_pnl_per_share = |mismatch| − fee_round_trip(p_mid)
  where fee_round_trip ≈ 0.072 × p × (1−p) on entry only (exit at
  0/1 incurs no fee because p×(1−p) = 0 at the extremes; this matches
  the engine's existing Polymarket 2026 fee formula).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from clickhouse_connect.driver.asyncclient import AsyncClient


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Window for realised-volatility estimation. Sub-hour Polymarket markets
# care most about very recent regime — 10 min captures the active hour's
# volatility without smoothing too aggressively over regime changes.
DEFAULT_VOL_WINDOW_SEC = 600

# Polymarket 2026 fee rate. Same constant as backtest/slippage.py /
# the codegen template — keeps the EV calc honest end-to-end.
TAKER_FEE_RATE = 0.072

# Minimum |mismatch| (in probability points, 0–1) before we surface the
# opportunity. Below this the EV is dominated by fees and microstructure
# noise. A 4pp mismatch on a 0.5 token = $0.04/share — net ~$0.022/share
# after the ~0.018 round-trip fee.
DEFAULT_MIN_EDGE_PP = 0.04

# Sanity bound on time-to-resolution.
#
# MIN_TAU_S = 180 (3 min):
#   Lower bound is execution-feasibility, not data-quality. A user who
#   sees the row, clicks "View on Polymarket", lands on the market
#   page, reviews + decides + signs the transaction needs at least
#   90-150 seconds. Showing rows with τ < 3 min puts the user in a
#   position where they click and arrive AFTER resolution — terrible
#   UX. For sub-3-min arb, the user needs an API bot, not the UI.
#   (Pro tier should expose an API_MIN_TAU_S override for bot users.)
#
# MAX_TAU_S = 24 hours:
#   Above this σ√τ swamps the underlying-vs-strike signal and the
#   model probability hangs near 0.5 regardless of price — no edge.
MIN_TAU_S = 180
MAX_TAU_S = 24 * 3600

# Maximum bid-ask spread on the SIDE WE'D BUY before we drop the row.
# Wider than this and the "ask" we'd pay isn't representative of real
# fillable price — the trade looks great on paper but liquidity is fake
# (classic Polymarket 11¢/89¢ book problem). 0.06 = 6¢ between bid &
# ask on the side we'd hit is the practical cutoff for "real liquidity".
MAX_FILL_SPREAD = 0.06

# Refuse to recommend a buy if the ask itself is at the extreme. A
# trade at 0.97 has almost no upside even if model says 0.999 — pays
# 3¢ for 3¢ expected payoff before fees. Polymarket fees + slippage
# would eat it. (Independent of the spread filter: a tight book at
# 0.96/0.97 still fails this filter.)
MAX_FILL_PRICE_FOR_BUY = 0.85

# Confidence tier threshold. Polymarket binary maker bots typically
# quote 0.49/0.50 or 0.50/0.51 as the "default symmetric" book around
# 0.50. Opportunities surfacing at fill ≥ 0.30 are sitting at or near
# this maker-bot zone — they tend to survive 30+ seconds because the
# bot is genuinely making a market on both sides. Opportunities below
# fill = 0.30 are deep mispricings (e.g. NO ask at 4¢ when model says
# 99.9% NO) which represent stale quotes from a bot that hasn't
# repriced — HFT scanners pick those off in milliseconds, so by the
# time our 4s-polling UI shows them, they're likely gone.
STABLE_FILL_THRESHOLD = 0.30


@dataclass(frozen=True)
class ArbOpportunity:
    """One tradeable mismatch row, ready to render in the UI."""

    market_id: str
    ticker: str          # BTC / ETH / SOL
    event_type: str      # "5m" / "1h" / "daily_up_down" / ...
    question: str        # human-readable market title
    polymarket_slug: str # the slug used in Polymarket's event URL

    # Time slice
    resolution_at: datetime
    seconds_to_resolution: float

    # Underlying & strike
    underlying_now: float
    strike_price: float       # the reference price from market_open snapshot
    log_diff: float           # ln(strike / underlying_now); 0 = right at strike

    # Volatility
    sigma_annual: float       # realised σ over vol_window (annualised)
    sigma_tau: float          # σ scaled to time-to-resolution

    # Probabilities
    market_yes_mid: float     # Polymarket's YES mid (diagnostic only)
    model_yes_prob: float     # our log-normal view
    mismatch_mid: float       # market_yes_mid − model_yes_prob (signed)

    # Book (real fillable prices)
    yes_bid: float
    yes_ask: float
    no_bid: float
    no_ask: float
    fill_price: float         # the side we'd buy at (yes_ask or no_ask)
    fill_spread: float        # spread on the side we'd buy (sanity filter)

    # Trade hint
    direction: str            # "BUY_YES" or "BUY_NO"
    edge_per_share: float     # win_prob - fill_price; gross EV per $1 spent
    est_fee_per_share: float  # one-sided entry fee
    expected_pnl_per_share: float  # after fee

    # Confidence — "stable" rows sit at the maker-default zone (fill
    # 0.30-0.85) and tend to persist 30+ seconds; "stale" rows are deep
    # mispricings (fill < 0.30 or > 0.85) that HFT scanners likely
    # already arbed in ms. Both classes are surfaced; UI filters/labels.
    tier: str                 # "stable" | "stale"


# ---------------------------------------------------------------------------
# Vol estimation
# ---------------------------------------------------------------------------


# Sampling cadence for the vol estimator. Tick-level (~50ms) close-to-
# close σ is dominated by microstructure noise (bid-ask bounce, latency
# jitter) — empirically inflates σ by ~5x for BTC. Sampling at a coarser
# interval discards the noise and recovers the fundamental σ. 5s is the
# sweet spot: still tight enough to capture intra-hour regime, but well
# above bid-ask bounce timescale.
VOL_SAMPLE_INTERVAL_SEC = 5


async def realised_vol(
    ch: AsyncClient,
    ticker: str,
    now: datetime,
    window_sec: int = DEFAULT_VOL_WINDOW_SEC,
) -> float | None:
    """Annualised realised volatility from Binance ticks in
    [now − window, now], bucketed into 5-second bars before taking log
    returns. ClickHouse does the bucketing server-side via
    toStartOfInterval(... INTERVAL 5 SECOND) + argMax(price, ts) to get
    the bar close (last tick) per bucket.

    Why 5s bars instead of raw ticks: ticks are ~50ms apart with heavy
    microstructure noise (bid-ask bounce inflates σ by 3-5×). Sampling
    at 5s discards the noise and recovers the fundamental σ that maps
    to "how much will price move in the next hour".

    Returns None if fewer than 30 bars land in the window — under that
    the σ estimate is too noisy to trust.
    """
    rows = await ch.query(
        f"""
        SELECT argMax(price, ts) AS px
          FROM underlying_prices
         WHERE ticker = {{ticker:String}}
           AND ts BETWEEN {{start:DateTime64(3)}} AND {{end:DateTime64(3)}}
         GROUP BY toStartOfInterval(ts, INTERVAL {VOL_SAMPLE_INTERVAL_SEC} SECOND)
         ORDER BY toStartOfInterval(ts, INTERVAL {VOL_SAMPLE_INTERVAL_SEC} SECOND)
        """,
        parameters={
            "ticker": ticker,
            "start": now - timedelta(seconds=window_sec),
            "end": now,
        },
    )
    prices = [float(r[0]) for r in rows.result_rows if r[0] is not None]
    if len(prices) < 30:
        return None
    log_rets: list[float] = []
    for i in range(1, len(prices)):
        if prices[i - 1] > 0 and prices[i] > 0:
            log_rets.append(math.log(prices[i] / prices[i - 1]))
    if len(log_rets) < 20:
        return None
    mean = sum(log_rets) / len(log_rets)
    var = sum((r - mean) ** 2 for r in log_rets) / max(1, len(log_rets) - 1)
    sigma_per_bar = math.sqrt(var)
    # bars per year = (seconds per year) / (seconds per bar)
    bars_per_year = (365.0 * 24.0 * 3600.0) / VOL_SAMPLE_INTERVAL_SEC
    return sigma_per_bar * math.sqrt(bars_per_year)


async def latest_underlying(
    ch: AsyncClient, ticker: str, now: datetime
) -> tuple[float, datetime] | None:
    """Most recent Binance spot tick (price, ts). Returns None if no tick
    in the last 60s — collector is probably down."""
    rows = await ch.query(
        """
        SELECT price, ts
          FROM underlying_prices
         WHERE ticker = {ticker:String}
           AND ts > {since:DateTime64(3)}
         ORDER BY ts DESC
         LIMIT 1
        """,
        parameters={"ticker": ticker, "since": now - timedelta(seconds=60)},
    )
    if not rows.result_rows:
        return None
    price, ts = rows.result_rows[0]
    return float(price), ts


# ---------------------------------------------------------------------------
# Probability model
# ---------------------------------------------------------------------------


def _norm_cdf(x: float) -> float:
    """Standard normal CDF — math.erf is in the standard library so we
    don't need scipy. Accurate to ~1e-7 across the range we use."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def model_yes_probability(
    underlying_now: float,
    strike_price: float,
    sigma_annual: float,
    seconds_to_resolution: float,
) -> tuple[float, float, float]:
    """Probability that a log-normal price walk ends ABOVE `strike` in
    `seconds_to_resolution` from `underlying_now`, given annualised σ.

    Returns (P_YES, log_diff, sigma_tau) so callers can render the
    diagnostic columns too.

    Math:
      r = ln(P_T / P_now) ~ N(0, σ²τ)        (zero-drift assumption)
      P_YES = P(P_T > strike) = P(r > ln(strike/P_now))
            = 1 − Φ(ln(strike/P_now) / σ√τ)
    """
    if sigma_annual <= 0 or seconds_to_resolution <= 0:
        # No vol or expired — degenerate to indicator at the current spot.
        return (1.0 if underlying_now > strike_price else 0.0, 0.0, 0.0)
    tau_years = seconds_to_resolution / (365.0 * 24.0 * 3600.0)
    sigma_tau = sigma_annual * math.sqrt(tau_years)
    if sigma_tau <= 0:
        return (1.0 if underlying_now > strike_price else 0.0, 0.0, 0.0)
    log_diff = math.log(strike_price / underlying_now)
    p_yes = 1.0 - _norm_cdf(log_diff / sigma_tau)
    # Clamp ε-away from the bounds so downstream EV math (which divides
    # by p × (1−p) in some places) doesn't blow up.
    p_yes = min(0.9995, max(0.0005, p_yes))
    return p_yes, log_diff, sigma_tau


# ---------------------------------------------------------------------------
# EV calculation
# ---------------------------------------------------------------------------


def _entry_fee(price: float) -> float:
    """Polymarket 2026 fee per $1 notional, entering at price `price`.
    fee = rate × p × (1-p). Exit at resolution (0 or 1) incurs no fee
    because p×(1-p) = 0 at the extremes."""
    return TAKER_FEE_RATE * price * (1.0 - price)


def expected_pnl(
    yes_ask: float,
    no_ask: float,
    model_yes_prob: float,
) -> tuple[str, float, float, float, float]:
    """Pick the side with positive net EV based on REAL fillable asks
    (not mids). Returns (direction, fill_price, edge, fee, net).

    Per-share economics, paying real ask price:
      BUY_YES at yes_ask:  cost = yes_ask, payoff = 1 if YES wins (prob q)
                           gross E = q × 1 − yes_ask
                                   = q − yes_ask
      BUY_NO  at no_ask:   gross E = (1 − q) − no_ask

    Whichever is more positive wins. If both are negative, the market
    isn't mispriced enough to overcome the bid-ask spread → no trade.

    Args:
      yes_ask: actual lowest YES ask price (what you'd pay to buy YES)
      no_ask:  actual lowest NO ask price  (what you'd pay to buy NO)
      model_yes_prob: model probability that YES outcome occurs (q above)
    """
    q = model_yes_prob
    ev_yes = q - yes_ask
    ev_no = (1.0 - q) - no_ask
    if ev_yes >= ev_no:
        direction = "BUY_YES"
        fill_price = yes_ask
        gross = ev_yes
    else:
        direction = "BUY_NO"
        fill_price = no_ask
        gross = ev_no
    fee = _entry_fee(fill_price)
    net = gross - fee
    return direction, fill_price, gross, fee, net


# ---------------------------------------------------------------------------
# Live scanner
# ---------------------------------------------------------------------------


async def find_live_opportunities(
    ch: AsyncClient,
    pg_pool: Any,  # asyncpg.Pool — type hint stays loose to avoid a hard import
    *,
    tickers: tuple[str, ...] = ("BTC", "ETH", "SOL"),
    event_types: tuple[str, ...] = ("5m", "15m", "1h", "4h", "daily_up_down"),
    min_edge_pp: float = DEFAULT_MIN_EDGE_PP,
    vol_window_sec: int = DEFAULT_VOL_WINDOW_SEC,
    now: datetime | None = None,
) -> list[ArbOpportunity]:
    """One scan cycle.

    Steps:
      1. Cache realised σ + latest spot per ticker (3 queries, ~ms each)
      2. Pull all currently-live (not yet resolved) markets matching the
         ticker/event filters from Postgres
      3. For each market, pull the latest Polymarket snapshot from
         ClickHouse and the market_open snapshot for the strike
      4. Compute model probability, mismatch, EV after fees
      5. Filter on min_edge_pp and return sorted by expected PnL desc

    Designed to run every 1-5s as a polling loop. ~50 markets × ~3
    ClickHouse queries each is comfortably <500ms on a warm DB.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    # 1. Per-ticker pre-fetch.
    underlying_cache: dict[str, tuple[float, datetime]] = {}
    sigma_cache: dict[str, float] = {}
    for ticker in tickers:
        u = await latest_underlying(ch, ticker, now)
        if u is None:
            continue
        underlying_cache[ticker] = u
        sig = await realised_vol(ch, ticker, now, vol_window_sec)
        if sig is not None:
            sigma_cache[ticker] = sig

    if not underlying_cache or not sigma_cache:
        return []

    # 2. Active markets.
    rows = await pg_pool.fetch(
        """
        SELECT m.market_id, e.ticker, e.event_type, e.resolution_at,
               e.question, e.polymarket_slug
          FROM markets m
          JOIN events e ON e.event_id = m.event_id
         WHERE e.ticker      = ANY($1::text[])
           AND e.event_type  = ANY($2::text[])
           AND e.resolved_at IS NULL
           AND e.resolution_at > $3
           AND e.resolution_at < $4
        """,
        list(tickers),
        list(event_types),
        now + timedelta(seconds=MIN_TAU_S),
        now + timedelta(seconds=MAX_TAU_S),
    )

    out: list[ArbOpportunity] = []
    for row in rows:
        market_id = row["market_id"]
        ticker = row["ticker"]
        if ticker not in underlying_cache or ticker not in sigma_cache:
            continue
        underlying_now, _under_ts = underlying_cache[ticker]
        sigma_annual = sigma_cache[ticker]
        resolution_at: datetime = row["resolution_at"]
        tau_s = (resolution_at - now).total_seconds()
        if tau_s <= 0:
            continue

        # 3. Polymarket snapshot — newest first, and earliest for strike.
        latest_snap_rows = await ch.query(
            """
            SELECT yes_bids, yes_asks, no_bids, no_asks, underlying_price, ts
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
             ORDER BY ts DESC
             LIMIT 1
            """,
            parameters={"market_id": market_id},
        )
        if not latest_snap_rows.result_rows:
            continue
        yb, ya, nb, na, _up, _ts = latest_snap_rows.result_rows[0]

        book = _book_top(yb, ya, nb, na)
        if book is None:
            continue

        # market_open snapshot's underlying_price is the strike.
        open_rows = await ch.query(
            """
            SELECT underlying_price
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
               AND underlying_price IS NOT NULL
             ORDER BY ts ASC
             LIMIT 1
            """,
            parameters={"market_id": market_id},
        )
        if not open_rows.result_rows or open_rows.result_rows[0][0] is None:
            continue
        strike_price = float(open_rows.result_rows[0][0])

        # 4. Model + EV using REAL asks (not mid). Mid-based EV looks
        # great in wide-book Polymarket markets but isn't fillable — see
        # polymarket_thin_book_reality.md. Using yes_ask / no_ask gives
        # us the EV of a trade you could actually execute.
        p_model, log_diff, sigma_tau = model_yes_probability(
            underlying_now, strike_price, sigma_annual, tau_s
        )
        direction, fill_price, edge, fee, net_ev = expected_pnl(
            book.yes_ask, book.no_ask, p_model
        )
        if net_ev <= 0:
            continue
        if edge < min_edge_pp:
            continue

        # Spread filter on the side we'd buy — wider than this and the
        # "ask" isn't representative of real fillable liquidity.
        fill_spread = (
            book.yes_spread if direction == "BUY_YES" else book.no_spread
        )
        if fill_spread > MAX_FILL_SPREAD:
            continue
        # Extreme-price filter — keep but as a "drop" not "tier" filter,
        # because paying 0.95+ even for near-certain payoff yields too
        # little upside even before lag/gas. Still drop the row.
        if fill_price > MAX_FILL_PRICE_FOR_BUY:
            continue

        # Tier classification — see STABLE_FILL_THRESHOLD comment for
        # why 0.30 is the cutoff. "stable" rows are near the maker
        # default book and tend to persist; "stale" rows are deep
        # mispricings that HFT bots have likely already taken before
        # our 4s scan picks them up.
        tier = "stable" if fill_price >= STABLE_FILL_THRESHOLD else "stale"

        out.append(
            ArbOpportunity(
                market_id=market_id,
                ticker=ticker,
                event_type=row["event_type"],
                question=row.get("question") or "",
                polymarket_slug=row.get("polymarket_slug") or "",
                resolution_at=resolution_at,
                seconds_to_resolution=tau_s,
                underlying_now=underlying_now,
                strike_price=strike_price,
                log_diff=log_diff,
                sigma_annual=sigma_annual,
                sigma_tau=sigma_tau,
                market_yes_mid=book.yes_mid,
                model_yes_prob=p_model,
                mismatch_mid=book.yes_mid - p_model,
                yes_bid=book.yes_bid,
                yes_ask=book.yes_ask,
                no_bid=book.no_bid,
                no_ask=book.no_ask,
                fill_price=fill_price,
                fill_spread=fill_spread,
                direction=direction,
                edge_per_share=edge,
                est_fee_per_share=fee,
                expected_pnl_per_share=net_ev,
                tier=tier,
            )
        )

    # 5. Best opportunity first.
    out.sort(key=lambda o: o.expected_pnl_per_share, reverse=True)
    return out


@dataclass(frozen=True)
class BookTop:
    """Both sides' best bid + best ask for a Polymarket binary market.
    yes_bid / yes_ask are the YES token; no_bid / no_ask are the NO token.
    These are the ACTUAL fillable prices — what arb EV math should use."""

    yes_bid: float
    yes_ask: float
    no_bid: float
    no_ask: float

    @property
    def yes_mid(self) -> float:
        return (self.yes_bid + self.yes_ask) / 2.0

    @property
    def yes_spread(self) -> float:
        return self.yes_ask - self.yes_bid

    @property
    def no_spread(self) -> float:
        return self.no_ask - self.no_bid


def _book_top(yb_raw: Any, ya_raw: Any, nb_raw: Any, na_raw: Any) -> BookTop | None:
    """Parse the 4 JSON arrays into best-prices on both sides. Returns
    None if any side is empty — a one-sided book can't honestly support
    a fillable trade.
    """
    try:
        import orjson  # local import keeps the engine's hot path lean
    except ImportError:  # pragma: no cover
        import json as orjson  # type: ignore

    def best(raw: Any, want_max: bool) -> float | None:
        if not raw:
            return None
        try:
            data = orjson.loads(raw) if isinstance(raw, (bytes, str)) else raw
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(data, list) or not data:
            return None
        prices: list[float] = []
        for lvl in data:
            try:
                prices.append(float(lvl["price"]))
            except (KeyError, TypeError, ValueError):
                continue
        if not prices:
            return None
        return max(prices) if want_max else min(prices)

    yes_bid = best(yb_raw, want_max=True)
    yes_ask = best(ya_raw, want_max=False)
    no_bid = best(nb_raw, want_max=True)
    no_ask = best(na_raw, want_max=False)
    if any(x is None for x in (yes_bid, yes_ask, no_bid, no_ask)):
        return None
    return BookTop(yes_bid, yes_ask, no_bid, no_ask)  # type: ignore[arg-type]
