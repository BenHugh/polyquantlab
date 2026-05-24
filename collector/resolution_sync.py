"""Backfill `events.resolved_at` + `events.resolution_outcome` for markets
that have settled on Polymarket but that we discovered before settlement.

Why this is critical:
  * `backtest/data_loader.py:list_resolved_markets` filters on
    `e.resolved_at IS NOT NULL`. Without this sync, `/v1/backtest`
    returns an empty universe regardless of the strategy submitted.
  * `discovery.py` only writes the *creation-time* metadata; it never
    revisits an event to record how it ended. This module is the
    missing half of that loop.

How Polymarket signals settlement:
  Querying Gamma `/events?slug=<slug>` returns an event whose
  `markets[0].closed == True` when settlement is final. The winning
  outcome is identified by `outcomePrices == ["1","0"]` (Up wins) or
  `["0","1"]` (Down wins). Mid-values (e.g. "0.5") indicate a canceled
  or disputed market that shouldn't be backtested against.

Throttling:
  We hit Gamma at ~3 req/sec to be polite. With ~2k unresolved events
  in the backlog, a first full pass completes in ~10 minutes. Steady
  state (only markets resolved in the last 10 min) is dozens of
  requests per cycle — easily within Gamma's tolerance.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from collector.config import Settings
from collector.logging_setup import get_logger

log = get_logger(__name__)


RESOLUTION_CYCLE_INTERVAL = 600   # seconds — one full pass every 10 min
INTER_REQUEST_DELAY = 0.30        # ~3 req/sec to Gamma
BATCH_SIZE = 300                  # markets fetched per cycle (cap to keep cycle <2 min)


# ---------------------------------------------------------------------------
# Outcome decoder
# ---------------------------------------------------------------------------


def _parse_outcome(outcomes_raw: Any, prices_raw: Any) -> str | None:
    """Map Gamma's (outcomes, outcomePrices) pair to a single string label.

    Returns one of:
      * "Up" / "Down" (or whatever Polymarket labels them) — the winner
      * "Inconclusive" — prices split between outcomes (canceled / disputed)
      * None — couldn't parse (logged upstream, market stays unresolved)
    """
    if isinstance(outcomes_raw, str):
        try:
            outcomes = json.loads(outcomes_raw)
        except json.JSONDecodeError:
            return None
    else:
        outcomes = outcomes_raw
    if isinstance(prices_raw, str):
        try:
            prices = json.loads(prices_raw)
        except json.JSONDecodeError:
            return None
    else:
        prices = prices_raw

    if not isinstance(outcomes, list) or not isinstance(prices, list):
        return None
    if len(outcomes) != len(prices):
        return None

    try:
        numeric = [float(p) for p in prices]
    except (TypeError, ValueError):
        return None

    # Standard binary settlement: one outcome at ~1.0, the other at ~0.0.
    winner_idx = next(
        (i for i, p in enumerate(numeric) if p >= 0.99),
        None,
    )
    if winner_idx is None:
        return "Inconclusive"
    return str(outcomes[winner_idx])


# ---------------------------------------------------------------------------
# Gamma fetch
# ---------------------------------------------------------------------------


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    stop=stop_after_attempt(3),
    reraise=True,
)
async def _fetch_event_by_slug(
    client: httpx.AsyncClient,
    base_url: str,
    slug: str,
) -> dict[str, Any] | None:
    """Return the Gamma event payload, or None if not found."""
    resp = await client.get(
        f"{base_url}/events",
        params={"slug": slug},
        headers={"User-Agent": "polybacktest-clone/0.1"},
    )
    resp.raise_for_status()
    data = resp.json()
    if not data:
        return None
    return data[0] if isinstance(data, list) else data


# ---------------------------------------------------------------------------
# Postgres update
# ---------------------------------------------------------------------------


UPDATE_RESOLUTION_SQL = """
UPDATE events
SET    resolved_at        = $2,
       resolution_outcome = $3,
       updated_at         = NOW()
WHERE  event_id = $1
  AND  resolved_at IS NULL;
"""


async def _apply_resolution(
    pool: asyncpg.Pool,
    event_id: Any,
    resolved_at: datetime,
    outcome: str,
) -> bool:
    """Returns True if a row was updated (i.e. wasn't already resolved)."""
    result = await pool.execute(UPDATE_RESOLUTION_SQL, event_id, resolved_at, outcome)
    # asyncpg returns "UPDATE N" — parse N
    try:
        return int(result.split()[-1]) > 0
    except (ValueError, IndexError):
        return False


def _parse_resolved_at(event: dict[str, Any]) -> datetime:
    """Pick the best timestamp for when settlement happened.

    Gamma exposes `closedTime` on some events; otherwise we fall back to
    `endDate` (the scheduled resolution time). Worst case we stamp `now()`
    on the catch-up path so the row is no longer NULL.
    """
    for field in ("closedTime", "endDate"):
        v = event.get(field)
        if not v:
            continue
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
    return datetime.now(tz=UTC)


# ---------------------------------------------------------------------------
# Main cycle
# ---------------------------------------------------------------------------


SELECT_UNRESOLVED_SQL = """
SELECT event_id, polymarket_slug
FROM   events
WHERE  resolved_at IS NULL
  AND  resolution_at IS NOT NULL
  AND  resolution_at < NOW() - INTERVAL '90 seconds'
ORDER  BY resolution_at ASC
LIMIT  $1;
"""


async def run_resolution_sync_once(
    settings: Settings,
    pool: asyncpg.Pool,
    client: httpx.AsyncClient,
) -> dict[str, int]:
    """One cycle. Returns counts for logging."""
    rows = await pool.fetch(SELECT_UNRESOLVED_SQL, BATCH_SIZE)
    stats = {"checked": 0, "resolved": 0, "still_open": 0, "missing": 0, "errors": 0}

    for r in rows:
        stats["checked"] += 1
        slug = r["polymarket_slug"]
        try:
            event = await _fetch_event_by_slug(
                client, settings.polymarket_gamma_api, slug
            )
        except Exception as exc:
            log.warning("resolution_fetch_failed", slug=slug, error=str(exc))
            stats["errors"] += 1
            await asyncio.sleep(INTER_REQUEST_DELAY)
            continue

        if event is None:
            stats["missing"] += 1
            await asyncio.sleep(INTER_REQUEST_DELAY)
            continue

        markets = event.get("markets") or []
        if not markets or not bool(markets[0].get("closed")):
            stats["still_open"] += 1
            await asyncio.sleep(INTER_REQUEST_DELAY)
            continue

        m = markets[0]
        outcome = _parse_outcome(m.get("outcomes"), m.get("outcomePrices"))
        if outcome is None:
            log.warning(
                "resolution_unparseable",
                slug=slug,
                outcomes=m.get("outcomes"),
                prices=m.get("outcomePrices"),
            )
            stats["errors"] += 1
            await asyncio.sleep(INTER_REQUEST_DELAY)
            continue

        resolved_at = _parse_resolved_at(event)
        try:
            if await _apply_resolution(pool, r["event_id"], resolved_at, outcome):
                stats["resolved"] += 1
        except Exception as exc:
            log.warning("resolution_update_failed", slug=slug, error=str(exc))
            stats["errors"] += 1
        await asyncio.sleep(INTER_REQUEST_DELAY)

    return stats


async def run_resolution_sync_forever(
    settings: Settings,
    pool: asyncpg.Pool,
) -> None:
    async with httpx.AsyncClient(timeout=20.0) as client:
        while True:
            try:
                stats = await run_resolution_sync_once(settings, pool, client)
                log.info("resolution_sync_cycle_done", **stats)
            except Exception as exc:
                log.error("resolution_sync_cycle_failed", error=str(exc))
            await asyncio.sleep(RESOLUTION_CYCLE_INTERVAL)
