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
from backtest.engine import EXECUTION_PARAMS
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
    # ClickHouse returns DateTime64 as naive datetimes in Python. Postgres
    # gives us tz-aware UTC. Mixing them blows up later (`snap.ts <
    # strategy.started_at` raises TypeError on naive-vs-aware comparison).
    # Force-tag ts as UTC — that's what ClickHouse actually stores.
    if ts is not None and ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
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
    market_open: OrderBookSnapshot | None,
) -> tuple[Side, float] | None:
    """Run a strategy on a single snapshot. Returns (side, size_usd)
    on fire, None otherwise. Wraps the call in try/except — a bad
    spec shouldn't kill the whole worker.

    Class-based strategies (ConditionBasedStrategy from Phase M+) have
    `reset_market_state` as a sentinel attribute and accept the
    market_open kwarg that primitives like coin_move_since_open_* and
    time_since_market_open_s read off the context. Function strategies
    (threshold_entry / mean_reversion / time_before_resolution) don't
    accept market_open — we sniff the attribute and dispatch
    accordingly. Same convention as backtest/engine.py."""
    try:
        is_class_based = hasattr(strategy_callable, "reset_market_state")
        if is_class_based:
            return strategy_callable(
                [], snapshot,
                resolution_at=resolution_at,
                market_open=market_open,
            )
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
# Per-(strategy, market) caches
# ---------------------------------------------------------------------------
#
# Two pieces of state need to survive across snapshots:
#
#  1. The market_open reference snapshot. Phase Q's `coin_move_since_open_*`
#     and `time_since_market_open_s` primitives read this from the
#     evaluator context. The backtest engine uses snapshots[0]; here we
#     query ClickHouse for the earliest snapshot per market_id on first
#     encounter, then cache.
#
#  2. The class-based strategy instance itself. ConditionBasedStrategy
#     accumulates `_entry_cross_state` and `_exit_cross_state` across
#     calls so `crosses_above` / `crosses_below` can fire on the
#     snapshot that completes the transition. If we rebuilt the
#     instance every call (the old behaviour), cross-state was always
#     empty and those operators silently never fired in paper trading.
#
# Both caches are unbounded in memory but small in practice (paper
# strategies × active markets). Cleared per-cycle when the strategy
# row set changes.

# market_id → OrderBookSnapshot (first ever seen)
_MARKET_OPEN_CACHE: dict[str, OrderBookSnapshot] = {}

# (paper_strategy_id, market_id) → strategy callable with persisted state
_STRATEGY_INSTANCE_CACHE: dict[tuple[Any, str], Any] = {}

# ---------------------------------------------------------------------------
# Diagnostics (Phase AE)
# ---------------------------------------------------------------------------
#
# "opened=0" in paper_cycle_done for hours doesn't tell us WHY. Three
# possibilities collapse into the same log line:
#   - no active strategies in the DB at all
#   - strategies exist but their ticker / event_type filter rejects
#     every market in the snapshot batch
#   - filters pass but the trigger function never fires (conditions
#     too strict, cross-state never accumulates, etc.)
# We split each of those into its own counter and surface them on the
# end-of-cycle log so a user can `journalctl ... | grep paper_cycle_done`
# and immediately see which dropoff stage is the problem.

# Fingerprint of the previously-seen active strategy set. When this
# changes we emit a one-shot `paper_strategies_loaded` line listing
# every strategy currently being evaluated — useful for confirming
# whether a strategy actually made it into the trader process or got
# silently filtered out by Postgres.
_LAST_STRATEGY_FINGERPRINT: tuple = ()

# Set of strategy IDs we've already logged a build-failure trace for.
# When `build_strategy(spec)` raises for an active strategy, the first
# occurrence dumps a full traceback + the offending spec shape so we can
# diagnose schema drift / missing fields. Subsequent failures from the
# same strategy are silent (already counted via `instance_errors`) — we
# don't need 50 copies of the same trace every 5 seconds.
_LOGGED_BUILD_FAILURES: set[Any] = set()


async def _market_open_for(
    ch: AsyncClient,
    market_id: str,
    ticker: str,
) -> OrderBookSnapshot | None:
    """Return the earliest snapshot we have for `market_id`. Cached."""
    cached = _MARKET_OPEN_CACHE.get(market_id)
    if cached is not None:
        return cached
    result = await ch.query(
        """
        SELECT market_id, ts, yes_bids, yes_asks, no_bids, no_asks,
               underlying_price
          FROM orderbook_snapshots
         WHERE market_id = {market_id:String}
         ORDER BY ts ASC LIMIT 1
        """,
        parameters={"market_id": market_id},
    )
    if not result.result_rows:
        return None
    snap = _row_to_snapshot(result.result_rows[0], ticker=ticker)
    _MARKET_OPEN_CACHE[market_id] = snap
    return snap


def _get_strategy_instance(
    paper_strategy_id: Any,
    market_id: str,
    spec_copy: dict[str, Any],
):
    """Return the cached strategy callable for (strategy_id, market_id),
    building it (and clearing per-market state) on first encounter."""
    key = (paper_strategy_id, market_id)
    existing = _STRATEGY_INSTANCE_CACHE.get(key)
    if existing is not None:
        return existing
    # Mirror what backtest/engine.py does: strip execution-level keys
    # (fill_mode, max_fill_price, order_type, queue_aware, …) from the
    # spec before passing it to build_strategy(). Without this,
    # ConditionBasedStrategy.__init__ raises TypeError for "unexpected
    # keyword argument 'fill_mode'" and every cycle silently fails to
    # evaluate. This was the actual root cause of the 22h
    # opened=0 / evals=0 / inst_err every cycle observation.
    spec_for_strategy = {
        k: v for k, v in spec_copy.items() if k not in EXECUTION_PARAMS
    }
    fn = build_strategy(spec_for_strategy)
    reset = getattr(fn, "reset_market_state", None)
    if callable(reset):
        reset()
    _STRATEGY_INSTANCE_CACHE[key] = fn
    return fn


def _purge_caches_for_strategy(paper_strategy_id: Any) -> None:
    """Drop every cache entry tied to a strategy (called when it's
    paused, deleted, or hasn't appeared in recent active-strategy
    lists). Prevents unbounded memory growth."""
    keys_to_drop = [
        k for k in _STRATEGY_INSTANCE_CACHE if k[0] == paper_strategy_id
    ]
    for k in keys_to_drop:
        _STRATEGY_INSTANCE_CACHE.pop(k, None)


# ---------------------------------------------------------------------------
# One trigger pass over recent snapshots
# ---------------------------------------------------------------------------


async def _open_positions_for_new_snapshots(
    pool: asyncpg.Pool,
    ch: AsyncClient,
    since_ts: datetime,
) -> dict[str, int]:
    """For each new snapshot in (since_ts, now), evaluate every active
    strategy and open a virtual position if it triggers.

    Returns a dict of diagnostic counters. `opened` is the number of
    positions inserted (i.e. the metric users care about); the others
    expose pipeline dropoff so a user with all-zero `opened` can see
    which stage rejected everything. See the "Diagnostics" block at
    the top of this file for the rationale.
    """
    global _LAST_STRATEGY_FINGERPRINT

    counters: dict[str, int] = {
        "opened": 0,
        "active_strategies": 0,
        "snapshots_seen": 0,
        "markets_in_batch": 0,
        "skipped_resolved": 0,
        "skipped_filter": 0,
        "skipped_backfill": 0,
        "instance_errors": 0,
        "evaluations": 0,
        "actions_fired": 0,
        "fill_failed": 0,
    }

    # 1. Load all active strategies. Tiny table (≤ a few hundred rows).
    strategies = await pool.fetch(
        """
        SELECT paper_strategy_id, strategy_spec, ticker, event_type,
               size_usd, started_at
          FROM paper_strategies
         WHERE active = TRUE
        """
    )
    counters["active_strategies"] = len(strategies)

    # Detect a change in the active set and emit a one-shot summary
    # ("here's the universe of strategies I am evaluating") so a user
    # SSH'd into the VPS sees the actual roster, not just per-cycle
    # zero-counts.
    fingerprint = tuple(
        sorted(
            (
                str(r["paper_strategy_id"]),
                r["ticker"] or "*",
                r["event_type"] or "*",
            )
            for r in strategies
        )
    )
    if fingerprint != _LAST_STRATEGY_FINGERPRINT:
        _LAST_STRATEGY_FINGERPRINT = fingerprint
        # Active strategy set changed → reset the once-per-strategy
        # build-failure log gate so a re-added strategy gets a fresh
        # traceback if it still fails.
        _LOGGED_BUILD_FAILURES.clear()
        # Per-strategy detail. Keep PII out — log only id prefix +
        # filter + spec.type (the schema-level discriminator).
        roster = []
        for r in strategies:
            spec_raw = r["strategy_spec"]
            spec = (
                json.loads(spec_raw)
                if isinstance(spec_raw, str)
                else dict(spec_raw)
            )
            roster.append({
                "id": str(r["paper_strategy_id"])[:8],
                "ticker": r["ticker"] or "*",
                "event_type": r["event_type"] or "*",
                "type": spec.get("type", "?"),
                "size_usd": float(r["size_usd"]),
            })
        log.info(
            "paper_strategies_loaded",
            count=len(strategies),
            roster=roster,
        )

    if not strategies:
        # Reclaim instance-cache memory if all strategies disappeared.
        _STRATEGY_INSTANCE_CACHE.clear()
        return counters

    # Pre-compile the parsed spec + filter ctx per active strategy. The
    # actual callable now lives in _STRATEGY_INSTANCE_CACHE keyed by
    # (strategy_id, market_id) so cross-state survives across snapshots.
    compiled: list[dict[str, Any]] = []
    active_ids = set()
    for srow in strategies:
        spec_raw = srow["strategy_spec"]
        spec = (
            json.loads(spec_raw)
            if isinstance(spec_raw, str)
            else dict(spec_raw)
        )
        active_ids.add(srow["paper_strategy_id"])
        compiled.append({
            "paper_strategy_id": srow["paper_strategy_id"],
            "spec": spec,
            "ticker": srow["ticker"],
            "event_type": srow["event_type"],
            "size_usd": float(srow["size_usd"]),
            "started_at": srow["started_at"],
        })
    # Garbage-collect cache entries for strategies that are no longer
    # active (paused, deleted). Bounds memory at active-strategy size.
    stale_keys = [
        k for k in _STRATEGY_INSTANCE_CACHE if k[0] not in active_ids
    ]
    for k in stale_keys:
        _STRATEGY_INSTANCE_CACHE.pop(k, None)
    if not compiled:
        return counters

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
    counters["snapshots_seen"] = len(snapshot_rows.result_rows)
    if not snapshot_rows.result_rows:
        return counters

    # 3. Fetch the metadata for each market touched in this batch — one
    # Postgres query. We only need market_id → (ticker, event_type,
    # resolution_at). For most paper-trading scenarios this is < 50
    # markets.
    market_ids = sorted({r[0] for r in snapshot_rows.result_rows})
    counters["markets_in_batch"] = len(market_ids)
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
    for row in snapshot_rows.result_rows:
        market_id = row[0]
        m_meta = meta.get(market_id)
        if not m_meta:
            continue  # market not in events table (shouldn't happen)
        if m_meta["resolved_at"] is not None:
            counters["skipped_resolved"] += 1
            continue  # already resolved — settlement loop handles it
        snap = _row_to_snapshot(row, ticker=m_meta["ticker"])

        # Resolve market_open once per market in this batch (cached
        # across cycles in _MARKET_OPEN_CACHE). condition_based
        # primitives like coin_move_since_open_* read this from ctx.
        market_open = await _market_open_for(
            ch, market_id, ticker=m_meta["ticker"],
        )

        for ctx in compiled:
            # Filter: only consider markets matching this strategy's
            # ticker / event_type filters.
            if ctx["ticker"] and ctx["ticker"] != m_meta["ticker"]:
                counters["skipped_filter"] += 1
                continue
            if ctx["event_type"] and ctx["event_type"] != m_meta["event_type"]:
                counters["skipped_filter"] += 1
                continue
            # Don't backfill — only consider markets/snapshots that
            # arrived AFTER the strategy was created.
            if snap.ts < ctx["started_at"]:
                counters["skipped_backfill"] += 1
                continue
            # Strategy size overrides the spec's own size_usd so the
            # user's slider is the source of truth.
            spec_copy = dict(ctx["spec"])
            spec_copy["size_usd"] = ctx["size_usd"]
            try:
                trigger_fn = _get_strategy_instance(
                    ctx["paper_strategy_id"], market_id, spec_copy,
                )
            except Exception as build_exc:  # noqa: BLE001
                counters["instance_errors"] += 1
                # First failure for this strategy gets a full traceback
                # + the spec keys we tried to build with — enough to
                # identify schema drift (missing field, wrong type,
                # outdated spec.type, etc.). Subsequent failures stay
                # silent (counter still increments) so logs don't drown.
                if ctx["paper_strategy_id"] not in _LOGGED_BUILD_FAILURES:
                    _LOGGED_BUILD_FAILURES.add(ctx["paper_strategy_id"])
                    import traceback
                    log.error(
                        "paper_strategy_build_failed",
                        strategy_id=str(ctx["paper_strategy_id"])[:8],
                        spec_type=spec_copy.get("type"),
                        spec_keys=sorted(spec_copy.keys()),
                        error=f"{type(build_exc).__name__}: {build_exc}",
                        traceback=traceback.format_exc()[-1500:],
                    )
                continue
            counters["evaluations"] += 1
            action = _evaluate_one(
                trigger_fn, snap,
                resolution_at=m_meta["resolution_at"],
                market_open=market_open,
            )
            if action is None:
                continue
            counters["actions_fired"] += 1
            side, size_usd = action
            fill = walk_book(snap, side, size_usd)
            if fill is None:
                counters["fill_failed"] += 1
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
                counters["opened"] += 1

    return counters


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
        # Reclaim per-market caches now that this market is resolved.
        _MARKET_OPEN_CACHE.pop(r["market_id"], None)
        for k in [k for k in _STRATEGY_INSTANCE_CACHE if k[1] == r["market_id"]]:
            _STRATEGY_INSTANCE_CACHE.pop(k, None)
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
            counters = await _open_positions_for_new_snapshots(
                pool, ch, since_ts=last_snapshot_ts
            )
            settled = await _settle_newly_resolved(pool, since_ts=last_settle_ts)
            # Surface every dropoff counter — see "Diagnostics" comment
            # at the top of this file. A user grepping `paper_cycle_done`
            # can now tell which pipeline stage rejected everything when
            # `opened=0` persists for hours.
            log.info(
                "paper_cycle_done",
                opened=counters["opened"],
                settled=settled,
                active=counters["active_strategies"],
                snaps=counters["snapshots_seen"],
                mkts=counters["markets_in_batch"],
                skip_resolved=counters["skipped_resolved"],
                skip_filter=counters["skipped_filter"],
                skip_backfill=counters["skipped_backfill"],
                evals=counters["evaluations"],
                fired=counters["actions_fired"],
                fill_fail=counters["fill_failed"],
                inst_err=counters["instance_errors"],
                window_s=PAPER_POLL_INTERVAL_S,
            )
        except Exception as exc:  # noqa: BLE001
            # structlog's default JSON renderer drops `exc_info` to just
            # the boolean — no traceback in journalctl. Pull the stack
            # via traceback.format_exc so we can debug from logs alone
            # next time without spinning up a manual repro.
            import traceback
            log.error(
                "paper_cycle_failed",
                error=f"{type(exc).__name__}: {exc}",
                traceback=traceback.format_exc()[-2000:],
            )

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
