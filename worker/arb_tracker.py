"""Arb opportunity tracker — runs the Arb Scanner on a fixed cadence
and records what the engine saw into arb_audit_log, then settles each
row once the underlying market resolves.

Why this exists:
  The Arb Scanner shows live "model says +$0.47 net EV / share". Users
  (and us) need to know whether that model EV translates into actual
  realised PnL after Polygon gas, execution lag, and adverse selection.
  This worker captures every detection + waits for the market to settle,
  giving us a longitudinal dataset to answer:
    - What % of model EV is realised on average?
    - Does the stable tier consistently outperform stale?
    - Which tickers / event_types calibrate best?

Design:
  - Detection loop runs every DETECT_INTERVAL_S (30s). It calls
    find_live_opportunities() and INSERTs each result into
    arb_audit_log ON CONFLICT (market_id) DO NOTHING. This means we
    record the engine's FIRST belief about each market — later scans
    of the same market are no-ops. That first belief is the meaningful
    prediction; subsequent re-detections are momentum drift, not new
    signal.
  - Settlement loop runs every SETTLE_INTERVAL_S (120s). It pulls
    audit rows whose resolution_at is in the past and whose resolved_at
    is NULL, looks up each market's resolution in events, and writes
    resolved_outcome + realized_pnl_per_share.
  - Both loops share the same asyncpg pool and run as concurrent tasks
    in main(). Stop signal cleanly cancels both.

Critical math note (realized PnL):
  For BUY_NO at fill price p:
    cost   = p (per share)
    fee    = TAKER_FEE_RATE × p × (1−p)   (one-sided at entry)
    payoff = 1 if NO wins, 0 if YES wins
    realised PnL = payoff − cost − fee
  For BUY_YES at fill price p: same structure but payoff is 1 iff YES wins.
  For BUY_BOTH (logical arb): we hold 1 YES + 1 NO share. fill_price is
    the COMBINED cost (yes_ask + no_ask); fee is fee(yes_ask)+fee(no_ask).
    Exactly one leg pays $1.00 at resolution regardless of outcome, so
    payoff is a deterministic $1.00 — realised PnL == model EV (no model
    risk; that's the definition of a logical arb).
  Exit at resolution incurs no extra fee (p × (1−p) = 0 at p ∈ {0, 1}).
  We reuse the stored est_fee_per_share rather than recomputing from
  fill_price, because the combined fill_price of a logical arb would
  break the single-leg fee formula. This mirrors
  backtest/arb_engine.py:_entry_fee / logical_arb_ev / expected_pnl.
"""

from __future__ import annotations

import asyncio
import signal
from datetime import datetime, timezone
from typing import Any

import asyncpg
import structlog
from clickhouse_connect.driver.asyncclient import AsyncClient

from backtest.arb_engine import (
    TAKER_FEE_RATE,
    ArbOpportunity,
    find_live_opportunities,
)
from collector.config import get_settings
from collector.db import make_clickhouse, make_postgres_pool
from collector.logging_setup import setup_logging

log = structlog.get_logger()


# Detection cadence. Faster = more granular, but ~3 ClickHouse queries
# per scan per market, so we don't want to hammer. 30s is the sweet
# spot: most markets last 5m+ so we capture them, and 30s gives the
# UI time to debounce a fresh signal before we lock in the first
# detection.
DETECT_INTERVAL_S = 30

# Settlement cadence. Polymarket markets resolve at fixed boundaries
# (HH:00, HH:05, HH:15 etc.) so a 120s pass catches the resolution
# within ~2 min of fact. Slow enough not to bog down the DB with
# repeated "any resolutions yet?" scans.
SETTLE_INTERVAL_S = 120


def _compute_realized_pnl(
    direction: str,
    fill_price: float,
    resolved_outcome: str,
    est_fee: float,
) -> float:
    """Per-share realised PnL after the entry fee. See module docstring
    for the math. Outcome is 'yes_won' or 'no_won'.

    `est_fee` is the entry fee computed at DETECTION time (stored in
    est_fee_per_share). We reuse it rather than recomputing from
    fill_price because for a logical arb (BUY_BOTH) the stored
    fill_price is the COMBINED cost (yes_ask + no_ask), so the
    single-leg fee formula rate·p·(1−p) would be wrong. For the
    directional case est_fee == rate·fill·(1−fill), so reusing it is
    identical to the old behaviour — no regression.
    """
    if direction == "BUY_BOTH":
        # Logical arb: we hold BOTH the YES and NO share. Exactly one
        # pays $1.00 at resolution regardless of which way the market
        # goes, so the payoff is a deterministic $1.00. fill_price is
        # the combined entry cost. Realised PnL == model EV here (no
        # model risk — that's the whole point of a logical arb).
        return 1.0 - fill_price - est_fee
    if direction == "BUY_NO":
        won = resolved_outcome == "no_won"
    else:  # BUY_YES
        won = resolved_outcome == "yes_won"
    payoff = 1.0 if won else 0.0
    return payoff - fill_price - est_fee


async def _insert_detections(
    pool: asyncpg.Pool, opps: list[ArbOpportunity]
) -> int:
    """Bulk insert detections. ON CONFLICT DO NOTHING means the first
    detection per market wins — subsequent scans of the same market
    are silently ignored. Returns the number of new rows actually
    inserted (asyncpg's executemany doesn't return per-row results so
    we use a single INSERT ... ON CONFLICT ... RETURNING)."""
    if not opps:
        return 0
    rows = [
        (
            o.market_id, o.ticker, o.event_type,
            o.tier, o.direction,
            o.fill_price, o.fill_spread,
            o.underlying_now, o.strike_price,
            o.seconds_to_resolution, o.sigma_annual, o.sigma_tau,
            o.model_yes_prob, o.expected_pnl_per_share, o.est_fee_per_share,
            o.resolution_at,
        )
        for o in opps
    ]
    # asyncpg doesn't have COPY for ON CONFLICT, and executemany doesn't
    # return rowcount. Loop with single INSERTs — fine because typical
    # scan size is <200 rows and most are duplicates (no-op).
    inserted = 0
    async with pool.acquire() as conn:
        for r in rows:
            inserted_row = await conn.fetchrow(
                """
                INSERT INTO arb_audit_log (
                    market_id, ticker, event_type,
                    tier, direction,
                    fill_price, fill_spread,
                    spot_at_detection, strike_price,
                    seconds_to_resolution, sigma_annual, sigma_tau,
                    model_yes_prob, model_ev_per_share, est_fee_per_share,
                    resolution_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16
                )
                ON CONFLICT (market_id) DO NOTHING
                RETURNING id
                """,
                *r,
            )
            if inserted_row is not None:
                inserted += 1
    return inserted


async def _settle_resolved(pool: asyncpg.Pool) -> int:
    """For every unresolved audit row whose resolution_at is in the
    past, look up the market's resolved_outcome from the events table
    and patch in resolved_outcome + realized_pnl_per_share.

    Joins audit_log → markets → events. Polymarket events have
    `resolution_outcome` text ('Up' / 'Down' or similar) that we
    normalise to 'yes_won' / 'no_won' to match the audit_log CHECK.
    """
    now = datetime.now(tz=timezone.utc)
    rows = await pool.fetch(
        """
        SELECT a.id, a.direction, a.fill_price, a.est_fee_per_share,
               e.resolution_outcome, e.resolved_at
          FROM arb_audit_log a
          JOIN markets m ON m.market_id = a.market_id
          JOIN events  e ON e.event_id  = m.event_id
         WHERE a.resolved_at IS NULL
           AND a.resolution_at < $1
           AND e.resolved_at IS NOT NULL
           AND e.resolution_outcome IS NOT NULL
         LIMIT 500
        """,
        now,
    )
    if not rows:
        return 0
    settled = 0
    async with pool.acquire() as conn:
        for r in rows:
            outcome_raw = (r["resolution_outcome"] or "").lower()
            # Polymarket "Up or Down" markets: YES wins on UP, NO on DOWN.
            # We normalise here so the audit_log CHECK constraint is
            # respected and downstream queries don't need to know
            # Polymarket's exact text.
            if outcome_raw.startswith("up"):
                resolved_outcome = "yes_won"
            elif outcome_raw.startswith("down"):
                resolved_outcome = "no_won"
            else:
                # Unknown outcome — log and skip; never silently misclassify.
                log.warning(
                    "arb_settle_unknown_outcome",
                    audit_id=r["id"],
                    outcome_raw=outcome_raw,
                )
                continue
            realized = _compute_realized_pnl(
                r["direction"], float(r["fill_price"]), resolved_outcome,
                float(r["est_fee_per_share"]),
            )
            await conn.execute(
                """
                UPDATE arb_audit_log
                   SET resolved_outcome = $1,
                       realized_pnl_per_share = $2,
                       resolved_at = $3
                 WHERE id = $4
                """,
                resolved_outcome,
                realized,
                r["resolved_at"],
                r["id"],
            )
            settled += 1
    return settled


# ---------------------------------------------------------------------------
# Long-running loops
# ---------------------------------------------------------------------------


async def detection_loop(
    pool: asyncpg.Pool,
    ch: AsyncClient,
    stop_event: asyncio.Event,
) -> None:
    """Periodically run the Arb Scanner and persist first-detections.

    Errors here are surfaced + swallowed so a transient ClickHouse
    hiccup doesn't kill the worker. The detector is idempotent
    (ON CONFLICT DO NOTHING), so a failed cycle just means we delay
    a few seconds before re-detecting.
    """
    log.info("arb_detector_started", interval_s=DETECT_INTERVAL_S)
    while not stop_event.is_set():
        try:
            opps = await find_live_opportunities(ch, pool)
            inserted = await _insert_detections(pool, opps)
            log.info(
                "arb_detector_cycle",
                seen=len(opps),
                inserted=inserted,
                interval_s=DETECT_INTERVAL_S,
            )
        except Exception as exc:  # noqa: BLE001 — keep the worker alive
            import traceback
            log.error(
                "arb_detector_failed",
                error=f"{type(exc).__name__}: {exc}",
                traceback=traceback.format_exc()[-1500:],
            )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=DETECT_INTERVAL_S)
        except asyncio.TimeoutError:
            pass


async def settlement_loop(
    pool: asyncpg.Pool,
    stop_event: asyncio.Event,
) -> None:
    """Periodically patch resolved outcomes onto open audit rows.

    Runs at a slower cadence than detection — markets resolve at
    fixed boundaries so we don't need second-level latency on this.
    """
    log.info("arb_settler_started", interval_s=SETTLE_INTERVAL_S)
    while not stop_event.is_set():
        try:
            n = await _settle_resolved(pool)
            if n > 0:
                log.info("arb_settler_cycle", settled=n)
        except Exception as exc:  # noqa: BLE001
            import traceback
            log.error(
                "arb_settler_failed",
                error=f"{type(exc).__name__}: {exc}",
                traceback=traceback.format_exc()[-1500:],
            )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=SETTLE_INTERVAL_S)
        except asyncio.TimeoutError:
            pass


async def main() -> None:
    setup_logging()
    settings = get_settings()
    pool = await make_postgres_pool(settings)
    ch = await make_clickhouse(settings)

    stop_event = asyncio.Event()

    def _stop(*_: object) -> None:
        log.info("arb_tracker_shutdown_signal")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _stop)

    try:
        # Two concurrent tasks: detection (fast) + settlement (slow).
        # asyncio.gather propagates exceptions; both loops catch their
        # own errors so this shouldn't fire — but if it does we want
        # the supervisor to restart us.
        await asyncio.gather(
            detection_loop(pool, ch, stop_event),
            settlement_loop(pool, stop_event),
        )
    finally:
        await pool.close()
        await ch.close()


if __name__ == "__main__":
    asyncio.run(main())
