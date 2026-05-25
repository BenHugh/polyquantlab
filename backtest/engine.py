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
from backtest.slippage import (
    platform_fee,
    settlement_payoff,
    walk_book,
    walk_book_to_sell_shares,
)
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


def _replay_single_market(
    snapshots: list[OrderBookSnapshot],
    strategy,
    resolution_at: datetime | None,
    yes_resolved_price: float,
    *,
    fill_mode: str = "walk_book",
    max_fill_price: float = 1.0,
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

    for snap in snapshots:
        history.append(snap)

        # ── In a position: check for TP/SL exit ──────────────────────────
        if open_position is not None:
            if on_in_position is None:
                continue
            try:
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
            if pass_resolution:
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

        if fill_mode == "mid":
            mid_at_fill = _mid_for_side(snap, side)
            if mid_at_fill is None:
                continue
            avg_price = mid_at_fill
            filled_usd = size_usd
            slippage_bps = 0.0
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
            trades, pnl, fees = _replay_single_market(
                snapshots,
                strategy,
                market["resolution_at"],
                resolution.outcome_yes_price,
                fill_mode=fill_mode,
                max_fill_price=max_fill_price,
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
    # Pull fill-mode + max-fill-price off the spec before handing it to
    # build_strategy — they're execution params, not strategy params.
    # Defaults: walk_book (realistic) + 1.0 (no ceiling). Mid-fill is
    # documented in the UI as "optimistic / matches PolyBackTest".
    spec_for_strategy = {
        k: v
        for k, v in strategy_spec.items()
        if k not in ("fill_mode", "max_fill_price")
    }
    fill_mode = str(strategy_spec.get("fill_mode") or "walk_book").lower()
    if fill_mode not in ("walk_book", "mid"):
        fill_mode = "walk_book"
    try:
        max_fill_price = float(strategy_spec.get("max_fill_price", 1.0))
    except (TypeError, ValueError):
        max_fill_price = 1.0
    max_fill_price = max(0.0, min(1.0, max_fill_price))

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
