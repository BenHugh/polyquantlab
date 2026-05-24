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
from backtest.slippage import platform_fee, settlement_payoff, walk_book
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


def _replay_single_market(
    snapshots: list[OrderBookSnapshot],
    strategy,
    resolution_at: datetime | None,
    yes_resolved_price: float,
) -> tuple[list[Trade], float, float]:
    """Replay one market. Returns (trades, pnl, fees).

    The returned trades carry per-trade `pnl` populated at settlement —
    the BacktestResult on the frontend uses this to plot a real
    cumulative-PnL curve (not just notional exposure).
    """
    if not snapshots:
        return [], 0.0, 0.0

    history: deque[OrderBookSnapshot] = deque(maxlen=HISTORY_WINDOW)
    trades: list[Trade] = []
    open_position: tuple[Side, float, float] | None = None  # (side, avg_price, filled_usd)
    fees_total = 0.0

    # Try calling strategy with resolution_at if it accepts the kwarg
    import inspect
    sig = inspect.signature(strategy.func) if hasattr(strategy, "func") else None
    pass_resolution = (
        sig is not None and "resolution_at" in sig.parameters
    )

    for snap in snapshots:
        history.append(snap)
        if open_position is not None:
            # Once we've taken a position in v0, hold to settlement.
            # Future versions can support stop-loss / take-profit.
            continue

        try:
            if pass_resolution:
                # The strategy may have resolution_at baked in by build_strategy;
                # if not, inject it here.
                action = strategy(list(history)[:-1], snap, resolution_at=resolution_at)
            else:
                action = strategy(list(history)[:-1], snap)
        except TypeError:
            action = strategy(list(history)[:-1], snap)

        if action is None:
            continue

        side, size_usd = action
        fill = walk_book(snap, side, size_usd)
        if fill is None:
            continue
        avg_price, filled_usd, slippage_bps = fill
        platform = _platform_of(snap.market_id)
        fee = platform_fee(platform, filled_usd)
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
            )
        )
        open_position = (side, avg_price, filled_usd)

    # Settle: rewrite each trade with its realised PnL now that we know the
    # outcome. We keep the original ordering so the frontend can render a
    # proper cumulative-PnL chart over time.
    settled_trades = [_settle_trade_pnl(t, yes_resolved_price) for t in trades]

    pnl = 0.0
    if open_position is not None:
        side, avg_price, filled_usd = open_position
        pnl = settlement_payoff(side, avg_price, filled_usd, yes_resolved_price)
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
            market_start = since or resolution.resolved_at.replace(
                hour=0, minute=0
            )
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
    strategy = build_strategy(strategy_spec)
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
