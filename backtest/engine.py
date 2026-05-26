"""Backtest engine.

Given (1) a universe of markets and (2) a strategy spec, replay the historical
orderbook snapshots and simulate trades with realistic fills + fees + PnL.

This is the actual product. Optimised for clarity over speed in v0 — a single
market replays in O(N) where N is the number of snapshots, and we sequentially
process markets. A 30-day backtest across 100 markets with 1-second snapshots
runs in a few seconds.
"""

from __future__ import annotations

import asyncio
import math
from collections import deque
from datetime import datetime
from typing import Any

import asyncpg
from clickhouse_connect.driver.asyncclient import AsyncClient

from backtest.data_loader import (
    list_resolved_markets,
    load_resolution,
    load_snapshots,
)
import hashlib

from backtest.slippage import (
    platform_fee,
    settlement_payoff,
    walk_book,
    walk_book_to_sell_shares,
)


# Spec keys that are engine-level execution params, NOT strategy-class
# constructor kwargs. Anything in this set must be stripped from the
# spec dict before passing to build_strategy() — otherwise the strategy
# __init__ raises TypeError on unexpected kwargs (e.g.
# ConditionBasedStrategy doesn't accept fill_mode). Exposed at module
# scope so paper_trader.py can share the same authoritative list.
EXECUTION_PARAMS: frozenset[str] = frozenset({
    "fill_mode", "max_fill_price",
    "dispute_pct", "na_pct", "dispute_payoff_pct", "random_seed",
    "order_type", "limit_offset_cents", "limit_timeout_s",
    "queue_aware",
})


def _apply_resolution_risk(
    market_id: str,
    original_yes_price: float,
    dispute_pct: float,
    na_pct: float,
    dispute_payoff_pct: float,
    random_seed: int,
) -> tuple[float, str]:
    """Stochastically perturb the resolved YES price to model UMA dispute
    risk and N/A outcomes.

    Background: Polymarket resolves via UMA, which can (1) take hours-
    days to finalise, (2) be disputed (~5% historically on contested
    markets), or (3) resolve N/A (~2%) for ambiguous claims. A vanilla
    backtest assumes a clean settlement at 1.0 or 0.0 — that's wrong on
    the tail and can hide strategies that look great in theory but die
    on disputed markets.

    Determinism: we seed the per-market RNG with sha256(seed || market_id)
    so the same backtest run twice gives identical numbers. Without
    determinism the user would never trust a sweep result that's
    re-fired to check.

    Returns (modified_yes_price, label) where label is "resolved" |
    "disputed" | "na" — the engine doesn't use the label but the UI
    can render a small icon per trade in a future iteration.
    """
    if dispute_pct <= 0 and na_pct <= 0:
        return original_yes_price, "resolved"
    digest = hashlib.sha256(f"{random_seed}:{market_id}".encode()).digest()
    rng_val = int.from_bytes(digest[:8], "big") / (2 ** 64)
    if rng_val < dispute_pct:
        return dispute_payoff_pct, "disputed"
    if rng_val < dispute_pct + na_pct:
        # Half-refund — matches UMA's "p1 cannot be determined" outcome.
        return 0.5, "na"
    return original_yes_price, "resolved"
from backtest.strategies import build_strategy
from backtest.types import (
    BacktestResult,
    OrderBookSnapshot,
    Side,
    Trade,
)


HISTORY_WINDOW = 60  # how many recent snapshots to keep for the strategy


def _platform_of(market_id: str) -> str:
    return "kalshi" if market_id.startswith("kalshi:") else "polymarket"


def _settle_trade_pnl(trade: Trade, yes_resolved_price: float) -> Trade:
    """Take an open Trade and a known resolution outcome, return a new
    Trade with `pnl` populated.

    Math:
      shares = size / price
      payoff = shares * (value of your side at settlement)
        - BUY_YES: value = yes_resolved_price       (1.0 if YES won, 0 if NO won)
        - BUY_NO:  value = 1 - yes_resolved_price   (1.0 if NO won, 0 if YES won)
        - SELL_YES / SELL_NO: inverse (rare in v0; we mostly buy)
      pnl    = payoff - size  (gross, before fees)

    The result is at most a loss of `size` and at most a profit of
    `size * (1/price - 1)` per dollar staked.
    """
    if trade.side == Side.BUY_YES:
        value_per_share = yes_resolved_price
    elif trade.side == Side.BUY_NO:
        value_per_share = 1.0 - yes_resolved_price
    elif trade.side == Side.SELL_YES:
        # Short YES: you collected `size` USD at fill, owe shares at settlement
        value_per_share = -yes_resolved_price
    elif trade.side == Side.SELL_NO:
        value_per_share = -(1.0 - yes_resolved_price)
    else:
        return trade  # unknown side — leave pnl as None

    shares = trade.size / trade.price if trade.price > 0 else 0.0
    payoff = shares * value_per_share
    if trade.side in (Side.BUY_YES, Side.BUY_NO):
        pnl = payoff - trade.size
    else:
        # For sells, we collected `size` upfront and pay `shares * value` later
        pnl = trade.size + payoff

    # dataclass(frozen=True) → use dataclasses.replace
    from dataclasses import replace
    return replace(
        trade,
        pnl=pnl,
        resolution_yes_price=yes_resolved_price,
    )


def _close_side(side: Side) -> Side:
    """Map an open-position side to the side that closes it."""
    if side == Side.BUY_YES:  return Side.SELL_YES
    if side == Side.SELL_YES: return Side.BUY_YES
    if side == Side.BUY_NO:   return Side.SELL_NO
    return Side.BUY_NO


def _mid_for_side(snap: OrderBookSnapshot, side: Side) -> float | None:
    """Mid price of the BID side for the side we want to BUY (or SELL).

    For BUY_YES / SELL_YES this is the YES mid; for BUY_NO / SELL_NO
    this is the NO mid. Used by fill_mode="mid" entries + exits.
    """
    if side in (Side.BUY_YES, Side.SELL_YES):
        if snap.yes_bids and snap.yes_asks:
            return (snap.yes_bids[0].price + snap.yes_asks[0].price) / 2
    else:
        if snap.no_bids and snap.no_asks:
            return (snap.no_bids[0].price + snap.no_asks[0].price) / 2
    return None


def _best_ask_for_side(snap: OrderBookSnapshot, side: Side) -> float | None:
    """Top of the ask book on the side we want to BUY. Used by
    max_fill_price guard."""
    if side == Side.BUY_YES and snap.yes_asks:
        return snap.yes_asks[0].price
    if side == Side.BUY_NO and snap.no_asks:
        return snap.no_asks[0].price
    return None


def _book_side_for_limit(snap: OrderBookSnapshot, side: Side) -> list:
    """Return the side of the book where our limit order joins the
    queue.  A BUY adds liquidity on the bid side; a SELL on the ask
    side. (We don't have NO-bids in the same dataset as YES-asks, so
    each token side has its own pair of stacks.)"""
    if side == Side.BUY_YES:
        return list(snap.yes_bids)
    if side == Side.BUY_NO:
        return list(snap.no_bids)
    if side == Side.SELL_YES:
        return list(snap.yes_asks)
    if side == Side.SELL_NO:
        return list(snap.no_asks)
    return []


def _size_at_level(snap: OrderBookSnapshot, side: Side, target_price: float) -> float:
    """How many tokens sit at `target_price` on the relevant side of
    the book in this snapshot. 0 if the level is empty.

    Polymarket prices are in 1¢ increments so we can compare with a
    1e-4 tolerance without losing fidelity to the actual tick."""
    levels = _book_side_for_limit(snap, side)
    for lvl in levels:
        if abs(lvl.price - target_price) < 1e-4:
            return float(lvl.size)
    return 0.0


def _book_crossed(snap: OrderBookSnapshot, side: Side, limit_price: float) -> bool:
    """True when an aggressive opposite-side flow has reached our
    price (best bid ≤ our buy, best ask ≥ our sell). This is the
    Phase Y v1 fill trigger; the queue-aware path uses it AND the
    queue-depletion path together."""
    if side == Side.BUY_YES and snap.yes_bids:
        return snap.yes_bids[0].price <= limit_price
    if side == Side.BUY_NO and snap.no_bids:
        return snap.no_bids[0].price <= limit_price
    if side == Side.SELL_YES and snap.yes_asks:
        return snap.yes_asks[0].price >= limit_price
    if side == Side.SELL_NO and snap.no_asks:
        return snap.no_asks[0].price >= limit_price
    return False


def _try_limit_fill(
    snapshots: list[OrderBookSnapshot],
    start_idx: int,
    side: Side,
    limit_price: float,
    timeout_s: float,
    size_usd: float,
    queue_aware: bool = False,
) -> tuple[float, float, int] | None:
    """Walk forward from `start_idx` until the limit order fills or
    the timeout expires. Returns (avg_price, filled_usd, end_idx) or
    None if we never filled.

    Two fill paths:

      1. "Book crossed" — an aggressive opposite-side order swept down
         (or up) to our price. Implies our level was fully consumed,
         which fills any queue position. This is the Phase Y v1 model.

      2. "Queue depleted" (only when queue_aware=True) — even if no
         aggressive cross happens, the size sitting AHEAD of us at our
         price level can shrink over time: some orders fill via partial
         crosses, others get cancelled. We approximate both as the
         observed decrease in size_at_level over time. Once the
         cumulative decrease ≥ our initial queue position, we declare
         the order filled. Captures cancel-rate behaviour: high
         cancel-rate levels clear out and fill more aggressively even
         when the market price didn't visit us.

    The queue model deliberately conflates fills and cancels into a
    single "level decrease" signal. Distinguishing them properly
    requires joining with the trades table per snapshot, which we
    skip for v1 — the conflation underestimates fill probability
    slightly (some "fills" at our level happened to other people
    AHEAD of us, not us), but the direction is right and the
    direction matters: with queue_aware=True a maker strategy
    fills MORE often, not less.

    Maker fee is 0% on both paths (Polymarket crypto-market current
    schedule)."""
    start_snap = snapshots[start_idx]
    deadline = start_snap.ts.timestamp() + timeout_s

    initial_queue: float | None = None
    prev_size_at_level: float | None = None
    cumulative_decrease: float = 0.0
    if queue_aware:
        initial_queue = _size_at_level(start_snap, side, limit_price)
        prev_size_at_level = initial_queue

    for j in range(start_idx, len(snapshots)):
        snap = snapshots[j]
        if snap.ts.timestamp() > deadline:
            return None
        # Path 1: aggressive cross.
        if _book_crossed(snap, side, limit_price):
            return limit_price, size_usd, j
        # Path 2: queue depletion (opt-in).
        if queue_aware and prev_size_at_level is not None:
            cur_size = _size_at_level(snap, side, limit_price)
            delta = prev_size_at_level - cur_size
            if delta > 0:
                cumulative_decrease += delta
            elif delta < 0:
                # New orders arrived AT or behind our level. They don't
                # push us up the queue — but they don't push us back
                # either, since we were already in front of them. Ignore.
                pass
            prev_size_at_level = cur_size
            # If the initial level was empty (no queue ahead of us), the
            # first opposite-side order that reaches our price fills us
            # — already handled by Path 1, so a 0 initial_queue means we
            # never resolve via Path 2 here.
            if initial_queue and cumulative_decrease >= initial_queue:
                return limit_price, size_usd, j
    return None


def _replay_single_market(
    snapshots: list[OrderBookSnapshot],
    strategy,
    resolution_at: datetime | None,
    yes_resolved_price: float,
    *,
    fill_mode: str = "walk_book",
    max_fill_price: float = 1.0,
    order_type: str = "market",
    limit_offset_cents: float = -2.0,
    limit_timeout_s: float = 60.0,
    queue_aware: bool = False,
) -> tuple[list[Trade], float, float]:
    """Replay one market. Returns (trades, pnl, fees).

    PnL accounting (with TP/SL support added in Phase M):

    - Entry trades carry `pnl = 0` while open. Their *round-trip* PnL is
      attributed to the corresponding close trade, so the frontend's
      cumulative-PnL curve correctly shows the change at the moment the
      position is closed (not when it was opened).
    - Close trades from TP/SL exits carry `pnl = (close_proceeds - entry_size)`.
    - For positions still open at the end of replay, `_settle_trade_pnl`
      retroactively stamps the entry trade with the settlement payoff —
      preserving the v0 behavior for legacy strategies.
    - Per-market `pnl` is the sum of every trade's PnL after that pass.

    Position exits: if the strategy exposes `on_in_position(...)` (the
    Strategy Builder's condition_based strategy does), we call it each
    snapshot while a position is open. It returns "exit" to close at the
    current opposite-side bid. Function strategies (threshold_entry etc.)
    have no such hook and continue to hold to settlement.

    Re-entry: after an exit, up to `max_trades_per_market` total entries
    are allowed (default 1; the Strategy Builder UI exposes this).
    """
    if not snapshots:
        return [], 0.0, 0.0

    # Market-open reference (first recorded snapshot). Phase Q evaluators
    # — coin_move_since_open, time_since_market_open — close over this.
    # We pass it through to every strategy call so per-market state
    # doesn't have to live on the strategy instance.
    market_open = snapshots[0]

    # Reset any per-market state on the strategy (e.g. crosses_above /
    # crosses_below previous-value tracking). Safe to call even on
    # function strategies — getattr returns None and we skip.
    reset_state = getattr(strategy, "reset_market_state", None)
    if callable(reset_state):
        reset_state()

    history: deque[OrderBookSnapshot] = deque(maxlen=HISTORY_WINDOW)
    trades: list[Trade] = []
    open_position: tuple[Side, float, float, int] | None = None
    # (side, entry_price, entry_usd, entry_trade_idx)
    fees_total = 0.0
    n_fills = 0

    on_in_position = getattr(strategy, "on_in_position", None)
    max_trades_per_market = int(getattr(strategy, "max_trades_per_market", 1))

    import inspect
    sig = inspect.signature(strategy.func) if hasattr(strategy, "func") else None
    pass_resolution = (
        sig is not None and "resolution_at" in sig.parameters
    )

    # ConditionBasedStrategy.__call__ accepts market_open; function
    # strategies don't. Detect by attribute presence (class instances
    # have it, partials don't).
    pass_market_open = hasattr(strategy, "reset_market_state")

    for snap in snapshots:
        history.append(snap)

        # ── In a position: check for TP/SL exit ──────────────────────────
        if open_position is not None:
            if on_in_position is None:
                continue
            try:
                if pass_market_open:
                    exit_signal = on_in_position(
                        list(history)[:-1], snap, open_position[:3],
                        resolution_at=resolution_at,
                        market_open=market_open,
                    )
                else:
                    exit_signal = on_in_position(
                        list(history)[:-1], snap, open_position[:3],
                        resolution_at=resolution_at,
                    )
            except TypeError:
                exit_signal = on_in_position(list(history)[:-1], snap, open_position[:3])
            if exit_signal != "exit":
                continue

            entry_side, entry_price, entry_usd, entry_idx = open_position
            close_side = _close_side(entry_side)
            shares = entry_usd / entry_price if entry_price > 0 else 0.0
            if fill_mode == "mid":
                # Mid-fill close: pretend the whole share count clears at mid.
                # Unrealistic but matches PolyBackTest's optimistic accounting
                # so users can compare like-for-like.
                close_mid = _mid_for_side(snap, close_side)
                if close_mid is None:
                    continue
                close_price = close_mid
                close_usd_received = shares * close_mid
                close_slip = 0.0
            else:
                close_fill = walk_book_to_sell_shares(snap, close_side, shares)
                if close_fill is None:
                    continue
                close_price, close_usd_received, close_slip = close_fill
            close_fee = platform_fee(_platform_of(snap.market_id), close_usd_received, close_price)
            fees_total += close_fee
            round_trip_pnl = close_usd_received - entry_usd
            trades.append(
                Trade(
                    ts=snap.ts,
                    market_id=snap.market_id,
                    side=close_side,
                    price=close_price,
                    size=close_usd_received,
                    slippage_bps=close_slip,
                    fees=close_fee,
                    pnl=round_trip_pnl,
                    underlying_price=snap.underlying_price,
                )
            )
            # Mark the entry trade closed so _settle_trade_pnl skips it.
            from dataclasses import replace
            trades[entry_idx] = replace(trades[entry_idx], pnl=0.0)
            open_position = None
            continue

        # ── No position: try to enter ────────────────────────────────────
        if n_fills >= max_trades_per_market:
            continue

        try:
            if pass_market_open:
                action = strategy(
                    list(history)[:-1], snap,
                    resolution_at=resolution_at,
                    market_open=market_open,
                )
            elif pass_resolution:
                action = strategy(list(history)[:-1], snap, resolution_at=resolution_at)
            else:
                action = strategy(list(history)[:-1], snap)
        except TypeError:
            action = strategy(list(history)[:-1], snap)

        if action is None:
            continue

        side, size_usd = action

        # max_fill_price guard: skip the entry if the best ask we'd hit
        # is above the user's ceiling. This is the cleanest defense
        # against "mid said 0.60 but the book is wide so I'd actually
        # pay 0.90" — see Phase O notes on PolyBackTest comparison.
        best_ask = _best_ask_for_side(snap, side)
        if (
            side in (Side.BUY_YES, Side.BUY_NO)
            and best_ask is not None
            and best_ask > max_fill_price
        ):
            continue

        if order_type == "limit":
            # Maker entry — place a limit at best_ask + offset/100 (offset
            # is in cents; -2 means 2c below). Then walk forward up to
            # limit_timeout_s seconds checking whether the book crossed
            # our price. Maker fee = 0 (Polymarket crypto markets pay no
            # taker fee, and no rebate either — this is the conservative
            # placeholder).
            ref_price = best_ask if best_ask is not None else _mid_for_side(snap, side)
            if ref_price is None:
                continue
            limit_price = ref_price + (limit_offset_cents / 100.0)
            # Clamp to (0, 1) just in case the offset is large.
            limit_price = max(0.01, min(0.99, limit_price))
            current_idx = snapshots.index(snap)
            fill = _try_limit_fill(
                snapshots, current_idx, side, limit_price, limit_timeout_s, size_usd,
                queue_aware=queue_aware,
            )
            if fill is None:
                # Order never filled inside the timeout; cancel + scan on.
                continue
            avg_price, filled_usd, _fill_idx = fill
            slippage_bps = 0.0
            fee = 0.0  # maker is free on Polymarket today
        elif fill_mode == "mid":
            mid_at_fill = _mid_for_side(snap, side)
            if mid_at_fill is None:
                continue
            avg_price = mid_at_fill
            filled_usd = size_usd
            slippage_bps = 0.0
            fee = platform_fee(_platform_of(snap.market_id), filled_usd, avg_price)
        else:
            fill = walk_book(snap, side, size_usd)
            if fill is None:
                continue
            avg_price, filled_usd, slippage_bps = fill
            fee = platform_fee(_platform_of(snap.market_id), filled_usd, avg_price)
        fees_total += fee
        trades.append(
            Trade(
                ts=snap.ts,
                market_id=snap.market_id,
                side=side,
                price=avg_price,
                size=filled_usd,
                slippage_bps=slippage_bps,
                fees=fee,
                underlying_price=snap.underlying_price,
            )
        )
        open_position = (side, avg_price, filled_usd, len(trades) - 1)
        n_fills += 1

    # Trades closed via TP/SL already have pnl set; settle the rest.
    settled_trades = [
        t if t.pnl is not None else _settle_trade_pnl(t, yes_resolved_price)
        for t in trades
    ]

    # Per-market PnL = sum of every trade's realised PnL. Entry trades for
    # TP/SL-closed positions carry pnl=0 (the round-trip is on the close
    # trade), so this sum is non-double-counted by construction.
    pnl = sum(t.pnl or 0.0 for t in settled_trades)
    return settled_trades, pnl, fees_total


def _sharpe_ratio(per_market_pnls: list[float]) -> float | None:
    if len(per_market_pnls) < 5:
        return None
    mean = sum(per_market_pnls) / len(per_market_pnls)
    var = sum((p - mean) ** 2 for p in per_market_pnls) / len(per_market_pnls)
    std = math.sqrt(var)
    # Floating-point safe "is std basically zero?" check. When every
    # per-market PnL is identical (e.g. 178 trades all = −$10), the
    # mathematical std is exactly 0, but accumulated FP error makes it
    # come out as something like 1e-15. Without this epsilon the next
    # line divides by ~zero and we get nonsense like -7.5e16. Threshold
    # is set well above typical FP noise but below any realistic real
    # std (PnLs are USD with 2 decimals; std < 1e-6 means everyone agrees).
    if std < 1e-6:
        return None
    # Approximate annualised — without time scaling, this is per-trade Sharpe
    return mean / std


def _max_drawdown(per_market_pnls: list[float]) -> float:
    peak = 0.0
    drawdown = 0.0
    running = 0.0
    for pnl in per_market_pnls:
        running += pnl
        if running > peak:
            peak = running
        drawdown = min(drawdown, running - peak)
    return drawdown


# Cap concurrent I/O. ClickHouse + Postgres on a single small VPS can
# comfortably handle 50 parallel queries; going higher buys little (CPU
# becomes the bottleneck) and risks pool exhaustion. Empirically 50 takes
# the 200-market backtest from ~60s sequential to ~12s parallel.
_BACKTEST_CONCURRENCY = 50


async def _process_one_market(
    *,
    market: dict[str, Any],
    strategy,
    ch: AsyncClient,
    pg_pool: asyncpg.Pool,
    since: datetime | None,
    sem: asyncio.Semaphore,
    fill_mode: str = "walk_book",
    max_fill_price: float = 1.0,
    dispute_pct: float = 0.0,
    na_pct: float = 0.0,
    dispute_payoff_pct: float = 0.5,
    random_seed: int = 42,
    order_type: str = "market",
    limit_offset_cents: float = -2.0,
    limit_timeout_s: float = 60.0,
    queue_aware: bool = False,
) -> tuple[list[Trade], float, float] | None:
    """Load + replay one market under the global concurrency cap.

    Returns (trades, pnl, fees) for markets that produced trades, or None
    for markets that should be skipped (no resolution / no snapshots /
    strategy never fired).

    Catching exceptions per-market: a single bad market shouldn't poison
    a 200-market backtest. We log + skip; the worst case is a smaller
    sample.
    """
    market_id = market["market_id"]
    async with sem:
        try:
            resolution = await load_resolution(pg_pool, market_id)
            if resolution is None:
                return None
            # When the user didn't pin a `since`, load EVERY snapshot we
            # have for this market so the strategy can enter at the first
            # available data point (typically market creation, e.g. 5 min
            # before resolution for 5m markets). The previous default of
            # "midnight of resolution day" artificially clustered all
            # entry timestamps around midnight UTC, which made a 50-market
            # backtest look like 50 trades at the same instant — a
            # PolyBackTest-comparison surfaced this in [[known-limitations]].
            # 1970 is a safe lower bound (cheaper than special-casing None
            # through the ClickHouse-typed parameter binding).
            market_start = since or datetime(1970, 1, 1, tzinfo=resolution.resolved_at.tzinfo)
            snapshots = await load_snapshots(
                ch,
                market_id=market_id,
                start=market_start,
                end=resolution.resolved_at,
            )
            if not snapshots:
                return None
            resolved_yes_price, _outcome_label = _apply_resolution_risk(
                market_id,
                resolution.outcome_yes_price,
                dispute_pct, na_pct, dispute_payoff_pct, random_seed,
            )
            trades, pnl, fees = _replay_single_market(
                snapshots,
                strategy,
                market["resolution_at"],
                resolved_yes_price,
                fill_mode=fill_mode,
                max_fill_price=max_fill_price,
                order_type=order_type,
                limit_offset_cents=limit_offset_cents,
                limit_timeout_s=limit_timeout_s,
                queue_aware=queue_aware,
            )
            return (trades, pnl, fees) if trades else None
        except Exception:  # noqa: BLE001
            # Don't let one market kill the whole run.
            return None


async def run_backtest(
    *,
    ch: AsyncClient,
    pg_pool: asyncpg.Pool,
    strategy_spec: dict[str, Any],
    event_type: str | None = None,
    ticker: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    market_limit: int = 100,
) -> BacktestResult:
    """Run a strategy across all resolved markets matching the filter.

    Each market is processed concurrently (asyncio.gather, capped at
    `_BACKTEST_CONCURRENCY`). After all complete we sort trades into
    chronological order so the frontend equity curve renders correctly.
    """
    # Pull engine-level (vs strategy-level) params off the spec before
    # build_strategy. EXECUTION_PARAMS is module-level so paper_trader
    # can use the same authoritative list. Defaults are conservative:
    # walk_book + no ceiling + zero dispute risk so legacy strategies
    # are unaffected.
    spec_for_strategy = {
        k: v for k, v in strategy_spec.items() if k not in EXECUTION_PARAMS
    }
    fill_mode = str(strategy_spec.get("fill_mode") or "walk_book").lower()
    if fill_mode not in ("walk_book", "mid"):
        fill_mode = "walk_book"
    try:
        max_fill_price = float(strategy_spec.get("max_fill_price", 1.0))
    except (TypeError, ValueError):
        max_fill_price = 1.0
    max_fill_price = max(0.0, min(1.0, max_fill_price))

    # Resolution-risk params (Phase X.3). All default to 0 = off, so
    # existing strategies see no behaviour change.
    try:
        dispute_pct = max(0.0, min(1.0, float(strategy_spec.get("dispute_pct", 0))))
    except (TypeError, ValueError):
        dispute_pct = 0.0
    try:
        na_pct = max(0.0, min(1.0, float(strategy_spec.get("na_pct", 0))))
    except (TypeError, ValueError):
        na_pct = 0.0
    try:
        dispute_payoff_pct = max(0.0, min(1.0, float(strategy_spec.get("dispute_payoff_pct", 0.5))))
    except (TypeError, ValueError):
        dispute_payoff_pct = 0.5
    try:
        random_seed = int(strategy_spec.get("random_seed", 42))
    except (TypeError, ValueError):
        random_seed = 42

    # Maker / limit-order params (Phase Y.2). Defaults preserve the
    # existing taker-only behaviour. "market" = walk_book (or mid if
    # fill_mode=mid); "limit" = post at best_ask + offset and walk
    # forward in time waiting for the book to cross.
    order_type = str(strategy_spec.get("order_type") or "market").lower()
    if order_type not in ("market", "limit"):
        order_type = "market"
    try:
        limit_offset_cents = float(strategy_spec.get("limit_offset_cents", -2.0))
    except (TypeError, ValueError):
        limit_offset_cents = -2.0
    try:
        limit_timeout_s = float(strategy_spec.get("limit_timeout_s", 60.0))
    except (TypeError, ValueError):
        limit_timeout_s = 60.0
    limit_timeout_s = max(1.0, min(3600.0, limit_timeout_s))
    queue_aware = bool(strategy_spec.get("queue_aware", False))

    strategy = build_strategy(spec_for_strategy)
    universe = await list_resolved_markets(
        pg_pool,
        event_type=event_type,
        ticker=ticker,
        since=since,
        until=until,
        limit=market_limit,
    )

    # Fan out: gather everything in parallel. The semaphore is created
    # per-call so two simultaneous backtests don't share it (they'd
    # serialise unnecessarily).
    sem = asyncio.Semaphore(_BACKTEST_CONCURRENCY)
    per_market_results = await asyncio.gather(
        *[
            _process_one_market(
                market=m,
                strategy=strategy,
                ch=ch,
                pg_pool=pg_pool,
                since=since,
                sem=sem,
                fill_mode=fill_mode,
                max_fill_price=max_fill_price,
                dispute_pct=dispute_pct,
                na_pct=na_pct,
                dispute_payoff_pct=dispute_payoff_pct,
                random_seed=random_seed,
                order_type=order_type,
                limit_offset_cents=limit_offset_cents,
                limit_timeout_s=limit_timeout_s,
                queue_aware=queue_aware,
            )
            for m in universe
        ]
    )

    # Aggregate. We rebuild chronological order because asyncio.gather
    # preserves submission order (matches `universe` order, which is
    # sorted by resolved_at DESC), but the equity curve and max-drawdown
    # both want chronological (ASC) — we flip + sort by trade ts after.
    result = BacktestResult()
    per_market_pnls: list[float] = []
    wins = 0
    losses = 0

    # Walk markets oldest-first so per_market_pnls is in chronological
    # order for max_drawdown (which is path-dependent).
    for market, market_result in zip(reversed(universe), reversed(per_market_results)):
        if market_result is None:
            continue
        trades, pnl, fees = market_result
        result.trades.extend(trades)
        result.total_pnl += pnl
        result.total_fees += fees
        per_market_pnls.append(pnl - fees)
        result.n_markets += 1
        if pnl > fees:
            wins += 1
        else:
            losses += 1

    # Final sort by trade timestamp — defensive against any out-of-order
    # snapshots ending up in result.trades from concurrent processing.
    result.trades.sort(key=lambda t: t.ts)

    if wins + losses > 0:
        result.win_rate = wins / (wins + losses)
    result.sharpe = _sharpe_ratio(per_market_pnls)
    result.max_drawdown = _max_drawdown(per_market_pnls)
    return result
