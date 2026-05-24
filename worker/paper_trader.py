"""Paper-trading worker.

Continuously evaluates user-saved strategies against newly-arriving
orderbook snapshots, recording virtual fills + virtual P&L.

ARCHITECTURE
------------
This is a STANDALONE long-running process, separate from:
  - `collector` (collects raw data from Polymarket / Binance / Bybit)
  - `backtest_worker` (one-off ARQ jobs for historical backtests)

We use a polling design rather than Redis pub/sub:
  - Cycle every PAPER_POLL_INTERVAL_S seconds.
  - Query ClickHouse for snapshots in the last poll window.
  - For each strategy, look at the snapshots relevant to its filter.
  - Open virtual positions on triggers; settle on resolutions.

The polling latency (~5s by default) is fine for paper trading — we're
recording behaviour over hours and days. Sub-second precision wouldn't
help paper-trading users; it would just generate more DB load.

LIMITATIONS (deliberate, v0):
  * No history for strategies that need a lookback window. Strategies
    that only inspect the CURRENT snapshot (threshold_entry,
    time_before_resolution) work fully; mean_reversion needs a
    pre-loaded history we don't (yet) provide. Documented.
  * Once-per-market per-strategy: matches the v0 backtest engine and is
    enforced by a UNIQUE constraint on paper_positions. If a strategy
    fires again on the same market we silently skip it.
  * Settlement uses resolved_at from Postgres. The resolution_sync loop
    inside the collector keeps that fresh.
"""

from __future__ import annotations

import asyncio
import json
import signal
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import asyncpg
from clickhouse_connect.driver.asyncclient import AsyncClient

from api import paper_db
from backtest.slippage import platform_fee, walk_book
from backtest.strategies import build_strategy
from backtest.types import OrderBookLevel, OrderBookSnapshot, Side
from collector.config import get_settings
from collector.db import make_clickhouse, make_postgres_pool
from collector.logging_setup import get_logger, setup_logging

log = get_logger(__name__)


PAPER_POLL_INTERVAL_S = 5
# How far back into the snapshot stream we look on each cycle. We add a
# 2× safety overlap so a slow tick never causes us to miss a snapshot
# at the boundary — duplicate processing is fine because INSERTs use
# ON CONFLICT (paper_strategy_id, market_id).
PAPER_LOOKBACK_S = PAPER_POLL_INTERVAL_S * 2


# ---------------------------------------------------------------------------
# Snapshot-row helpers (mirrors backtest/data_loader.py:_parse_levels)
# ---------------------------------------------------------------------------


def _parse_levels(raw: Any) -> list[OrderBookLevel]:
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    out: list[OrderBookLevel] = []
    for lvl in raw:
        if isinstance(lvl, dict):
            try:
                out.append(
                    OrderBookLevel(
                        price=float(lvl.get("price")),
                        size=float(lvl.get("size", 0)),
                    )
                )
            except (TypeError, ValueError):
                continue
    return out


def _row_to_snapshot(row: tuple, ticker: str) -> OrderBookSnapshot:
    market_id, ts, yes_bids, yes_asks, no_bids, no_asks, underlying = row
    return OrderBookSnapshot(
        market_id=market_id,
        ts=ts,
        yes_bids=_parse_levels(yes_bids),
        yes_asks=_parse_levels(yes_asks),
        no_bids=_parse_levels(no_bids),
        no_asks=_parse_levels(no_asks),
        underlying_price=float(underlying) if underlying is not None else None,
        underlying_ticker=ticker,
    )


# ---------------------------------------------------------------------------
# Strategy evaluation
# ---------------------------------------------------------------------------


def _evaluate_one(
    strategy_callable,
    snapshot: OrderBookSnapshot,
    resolution_at: datetime | None,
) -> tuple[Side, float] | None:
    """Run a strategy on a single snapshot (no history). Returns
    (side, size_usd) on fire, None otherwise. Wraps the function-call
    in a try/except — a bad spec shouldn't kill the whole worker."""
    try:
        import inspect

        sig = (
            inspect.signature(strategy_callable.func)
            if hasattr(strategy_callable, "func")
            else None
        )
        pass_resolution = (
            sig is not None and "resolution_at" in sig.parameters
        )
        if pass_resolution:
            return strategy_callable([], snapshot, resolution_at=resolution_at)
        return strategy_callable([], snapshot)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# One trigger pass over recent snapshots
# ---------------------------------------------------------------------------


async def _open_positions_for_new_snapshots(
    pool: asyncpg.Pool,
    ch: AsyncClient,
    since_ts: datetime,
) -> int:
    """For each new snapshot in (since_ts, now), evaluate every active
    strategy and open a virtual position if it triggers.

    Returns the number of positions opened this pass.
    """
    # 1. Load all active strategies. Tiny table (≤ a few hundred rows).
    strategies = await pool.fetch(
        """
        SELECT paper_strategy_id, strategy_spec, ticker, event_type,
               size_usd, started_at
          FROM paper_strategies
         WHERE active = TRUE
        """
    )
    if not strategies:
        return 0

    # Pre-build the callables once per cycle so the strategy_spec → fn
    # mapping doesn't run on every snapshot.
    compiled: list[tuple[Any, dict[str, Any]]] = []
    for srow in strategies:
        spec_raw = srow["strategy_spec"]
        spec = (
            json.loads(spec_raw)
            if isinstance(spec_raw, str)
            else dict(spec_raw)
        )
        try:
            fn = build_strategy(spec)
        except Exception:  # noqa: BLE001
            continue
        compiled.append(
            (
                fn,
                {
                    "paper_strategy_id": srow["paper_strategy_id"],
                    "spec": spec,
                    "ticker": srow["ticker"],
                    "event_type": srow["event_type"],
                    "size_usd": float(srow["size_usd"]),
                    "started_at": srow["started_at"],
                },
            )
        )
    if not compiled:
        return 0

    # 2. Pull all new snapshots in one ClickHouse round-trip. We grab
    # the market metadata we need (ticker, event_type, resolution_at)
    # via a Postgres join.
    snapshot_rows = await ch.query(
        """
        SELECT market_id, ts, yes_bids, yes_asks, no_bids, no_asks,
               underlying_price
          FROM orderbook_snapshots
         WHERE ts >= {since:DateTime64(3)}
         ORDER BY ts
         LIMIT 100000
        """,
        parameters={"since": since_ts},
    )
    if not snapshot_rows.result_rows:
        return 0

    # 3. Fetch the metadata for each market touched in this batch — one
    # Postgres query. We only need market_id → (ticker, event_type,
    # resolution_at). For most paper-trading scenarios this is < 50
    # markets.
    market_ids = sorted({r[0] for r in snapshot_rows.result_rows})
    meta_rows = await pool.fetch(
        """
        SELECT m.market_id, e.ticker, e.event_type, e.resolution_at,
               e.resolved_at
          FROM markets m
          JOIN events  e ON e.event_id = m.event_id
         WHERE m.market_id = ANY($1::text[])
        """,
        market_ids,
    )
    meta = {
        r["market_id"]: {
            "ticker": r["ticker"],
            "event_type": r["event_type"],
            "resolution_at": r["resolution_at"],
            "resolved_at": r["resolved_at"],
        }
        for r in meta_rows
    }

    # 4. For each snapshot × strategy, check filter compatibility and
    # try the trigger. The double-loop is small in practice (a handful
    # of strategies × ~500 snapshots/cycle).
    opened = 0
    for row in snapshot_rows.result_rows:
        market_id = row[0]
        m_meta = meta.get(market_id)
        if not m_meta:
            continue  # market not in events table (shouldn't happen)
        if m_meta["resolved_at"] is not None:
            continue  # already resolved — settlement loop handles it
        snap = _row_to_snapshot(row, ticker=m_meta["ticker"])

        for fn, ctx in compiled:
            # Filter: only consider markets matching this strategy's
            # ticker / event_type filters.
            if ctx["ticker"] and ctx["ticker"] != m_meta["ticker"]:
                continue
            if ctx["event_type"] and ctx["event_type"] != m_meta["event_type"]:
                continue
            # Don't backfill — only consider markets/snapshots that
            # arrived AFTER the strategy was created.
            if snap.ts < ctx["started_at"]:
                continue
            # Strategy size overrides the spec's own size_usd to make
            # explicit user-configured sizing the source of truth.
            spec_copy = dict(ctx["spec"])
            spec_copy["size_usd"] = ctx["size_usd"]
            try:
                trigger_fn = build_strategy(spec_copy)
            except Exception:  # noqa: BLE001
                continue
            action = _evaluate_one(
                trigger_fn, snap, resolution_at=m_meta["resolution_at"]
            )
            if action is None:
                continue
            side, size_usd = action
            fill = walk_book(snap, side, size_usd)
            if fill is None:
                continue
            avg_price, filled_usd, slippage_bps = fill
            # Price-dependent fee — same formula as the backtest engine.
            fee = platform_fee("polymarket", filled_usd, avg_price)
            inserted = await paper_db.open_position(
                pool,
                strategy_id=ctx["paper_strategy_id"],
                market_id=market_id,
                side=side.value if hasattr(side, "value") else str(side),
                fill_price=float(avg_price),
                size_usd=float(filled_usd),
                slippage_bps=float(slippage_bps),
                fees=float(fee),
                # Capture underlying spot at trigger time (added in Phase J)
                underlying_price=(
                    float(snap.underlying_price)
                    if snap.underlying_price is not None
                    else None
                ),
            )
            if inserted:
                opened += 1

    return opened


# ---------------------------------------------------------------------------
# Settlement: close open positions on newly-resolved markets
# ---------------------------------------------------------------------------


async def _settle_newly_resolved(
    pool: asyncpg.Pool, since_ts: datetime
) -> int:
    """Find markets that resolved since the last cycle and close any
    open paper positions on them. Returns the number of positions
    settled."""
    rows = await pool.fetch(
        """
        SELECT m.market_id, e.resolution_outcome
          FROM markets m
          JOIN events  e ON e.event_id = m.event_id
         WHERE e.resolved_at IS NOT NULL
           AND e.resolved_at >= $1
           AND EXISTS (
               SELECT 1 FROM paper_positions p
                WHERE p.market_id = m.market_id
                  AND p.closed_at IS NULL
           )
        """,
        since_ts - timedelta(hours=1),  # buffer in case sync was delayed
    )
    settled = 0
    for r in rows:
        # Same Up/Down normalisation as backtest engine + routes_internal.
        outcome = (r["resolution_outcome"] or "").lower()
        if outcome in ("up", "yes") or "up" in outcome:
            yes_price = 1.0
        elif outcome in ("down", "no") or "down" in outcome:
            yes_price = 0.0
        else:
            continue  # inconclusive — leave positions open for now
        n = await paper_db.settle_positions_for_market(
            pool,
            market_id=r["market_id"],
            resolution_yes_price=yes_price,
        )
        settled += n
    return settled


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


async def run_paper_trader_forever(
    pool: asyncpg.Pool, ch: AsyncClient, stop_event: asyncio.Event
) -> None:
    """Single long-running coroutine. Polls every PAPER_POLL_INTERVAL_S
    seconds; sleeps interruptibly so SIGTERM exits cleanly."""
    last_snapshot_ts = datetime.now(tz=timezone.utc) - timedelta(seconds=PAPER_LOOKBACK_S)
    last_settle_ts = datetime.now(tz=timezone.utc) - timedelta(seconds=PAPER_LOOKBACK_S)
    log.info("paper_trader_started", poll_s=PAPER_POLL_INTERVAL_S)

    while not stop_event.is_set():
        cycle_start = datetime.now(tz=timezone.utc)
        try:
            opened = await _open_positions_for_new_snapshots(
                pool, ch, since_ts=last_snapshot_ts
            )
            settled = await _settle_newly_resolved(pool, since_ts=last_settle_ts)
            log.info(
                "paper_cycle_done",
                opened=opened,
                settled=settled,
                window_s=PAPER_POLL_INTERVAL_S,
            )
        except Exception:  # noqa: BLE001
            log.exception("paper_cycle_failed")

        # Advance both cursors with a small overlap so we never miss
        # rows on the boundary. ON CONFLICT deduplicates re-processing.
        last_snapshot_ts = cycle_start - timedelta(seconds=PAPER_LOOKBACK_S)
        last_settle_ts = cycle_start - timedelta(seconds=PAPER_LOOKBACK_S)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=PAPER_POLL_INTERVAL_S)
        except asyncio.TimeoutError:
            pass


async def main() -> None:
    setup_logging()
    settings = get_settings()
    pool = await make_postgres_pool(settings)
    ch = await make_clickhouse(settings)

    stop_event = asyncio.Event()

    def _stop(*_: object) -> None:
        log.info("paper_trader_shutdown_signal")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _stop)

    try:
        await run_paper_trader_forever(pool, ch, stop_event)
    finally:
        await pool.close()
        await ch.close()


if __name__ == "__main__":
    asyncio.run(main())
