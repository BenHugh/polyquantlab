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

# Sanity bound on time-to-resolution. Markets <60s out have unreliable
# books (one-sided liquidity). Markets >24h out have such big σ√τ that
# the model's probability hangs near 0.5 regardless of price — no signal.
MIN_TAU_S = 60
MAX_TAU_S = 24 * 3600


@dataclass(frozen=True)
class ArbOpportunity:
    """One tradeable mismatch row, ready to render in the UI."""

    market_id: str
    ticker: str          # BTC / ETH / SOL
    event_type: str      # "5m" / "1h" / "daily_up_down" / ...
    question: str        # human-readable market title

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
    market_yes_mid: float     # Polymarket's view
    model_yes_prob: float     # our log-normal view
    mismatch: float           # market_yes_mid − model_yes_prob (signed)

    # Trade hint
    direction: str            # "BUY_YES" or "BUY_NO"
    edge_per_share: float     # expected gross PnL/share before fees
    est_fee_per_share: float  # one-sided entry fee at mid
    expected_pnl_per_share: float  # after fee


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
    """Polymarket 2026 fee per $1 notional, entering at mid `price`.
    fee = rate × p × (1-p). Exit at resolution (0 or 1) incurs no fee
    because p×(1-p) = 0 at the extremes."""
    return TAKER_FEE_RATE * price * (1.0 - price)


def expected_pnl(
    market_yes_mid: float, model_yes_prob: float
) -> tuple[str, float, float, float]:
    """Pick the direction with positive EV. Returns
    (direction, edge_per_share, fee_per_share, net_per_share).

    Per-share economics:
      Buy YES at p:  win 1 with prob q, lose p with prob (1−q)
                     gross E = q×(1−p) − (1−q)×p = q − p
      Buy NO at (1−p): win 1 with prob (1−q), lose (1−p) with prob q
                     gross E = (1−q)×p − q×(1−p) = p − q
    So edge = |q − p|; direction = NO if p > q else YES.
    (p = market_yes_mid, q = model_yes_prob.)
    """
    edge = abs(market_yes_mid - model_yes_prob)
    direction = "BUY_NO" if market_yes_mid > model_yes_prob else "BUY_YES"
    # Fee approximation: charge the entry-side fee at mid of the side
    # we're buying. NO mid = 1 − YES mid; fee formula is symmetric.
    entry_price = market_yes_mid if direction == "BUY_YES" else (1.0 - market_yes_mid)
    fee = _entry_fee(entry_price)
    return direction, edge, fee, edge - fee


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
               e.question
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

        market_yes_mid = _mid_from_book(yb, ya)
        if market_yes_mid is None:
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

        # 4. Model + EV.
        p_model, log_diff, sigma_tau = model_yes_probability(
            underlying_now, strike_price, sigma_annual, tau_s
        )
        direction, edge, fee, net_ev = expected_pnl(market_yes_mid, p_model)
        if edge < min_edge_pp:
            continue
        # Defensive: skip rows where the net EV is negative (fees eat
        # the entire mismatch). We still log a row when |mismatch| was
        # ≥ min_edge_pp but net_ev < 0; surface only positive nets.
        if net_ev <= 0:
            continue

        out.append(
            ArbOpportunity(
                market_id=market_id,
                ticker=ticker,
                event_type=row["event_type"],
                question=row.get("question") or "",
                resolution_at=resolution_at,
                seconds_to_resolution=tau_s,
                underlying_now=underlying_now,
                strike_price=strike_price,
                log_diff=log_diff,
                sigma_annual=sigma_annual,
                sigma_tau=sigma_tau,
                market_yes_mid=market_yes_mid,
                model_yes_prob=p_model,
                mismatch=market_yes_mid - p_model,
                direction=direction,
                edge_per_share=edge,
                est_fee_per_share=fee,
                expected_pnl_per_share=net_ev,
            )
        )

    # 5. Best opportunity first.
    out.sort(key=lambda o: o.expected_pnl_per_share, reverse=True)
    return out


def _mid_from_book(yb_raw: Any, ya_raw: Any) -> float | None:
    """Mid of best-bid / best-ask. Same parsing rules as
    backtest/data_loader.py — orjson loads the JSON string the
    collector wrote, falls back to None on bad input.

    Returns None if either side is empty (one-sided book — can't fairly
    quote a mid). The caller skips the market in that case.
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

    best_bid = best(yb_raw, want_max=True)
    best_ask = best(ya_raw, want_max=False)
    if best_bid is None or best_ask is None:
        return None
    return (best_bid + best_ask) / 2.0
