"""Periodic event-type re-classification.

WHY THIS EXISTS
---------------
The collector's discovery loop only sees ACTIVE events on Polymarket
(`closed=false`). Once an event resolves and closes, it falls out of
the discovery feed forever. That means if we ever ship a classifier
fix, OLD already-resolved rows keep their stale event_type and
silently drift.

We hit exactly this on 2026-05-24: 1-hour Up/Down markets were being
mis-tagged as `daily_up_down` for two days; after fixing the
classifier we had to hand-write a one-off SQL UPDATE because all the
historical 1h markets had already closed and were no longer reachable
via Gamma.

This module makes that backfill automatic. Every hour:

  1. Load every row from `events` (just the slug, question, raw JSON
     and current event_type — cheap).
  2. Re-run `classify_event` using the slug, question, and the tag
     set captured in `events.raw` from the most recent discovery.
  3. If the new classification differs AND falls into our supported
     Up/Down family, UPDATE the row.
  4. Anything that now classifies as "other" (e.g. a market that was
     in scope when we collected it but the scope tightened later) is
     left alone — we don't want to silently delete user-facing data.
     Just logged as `dropped_from_scope`.

The classifier itself is the single source of truth; this loop just
makes sure historical rows agree with the current rule set.

Cost is trivial: ~3000 rows × a few µs of regex = sub-second per run.
The DB write batch is small (only differences).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import asyncpg

from collector.discovery import (
    WINDOW_TAG_TO_TYPE,
    _event_tag_slugs,
    classify_event,
)
from collector.logging_setup import get_logger

log = get_logger(__name__)

# Supported event types — only re-classify INTO these. Anything else
# (e.g. "other" or a never-defined value) is treated as "out of scope"
# and the row is left at its existing tag for human review.
SUPPORTED_TYPES = set(WINDOW_TAG_TO_TYPE.values())


async def reclassify_once(pool: asyncpg.Pool) -> dict[str, int]:
    """Run one pass over the events table. Returns counters for logging.

    Read pattern: a single SELECT pulls everything we need. We then
    fire small UPDATEs for the (typically few) rows that actually need
    fixing — bulk UPDATE FROM VALUES would be marginally faster but
    not worth the readability cost at this scale.
    """
    rows = await pool.fetch(
        "SELECT event_id, polymarket_slug, question, event_type, raw FROM events"
    )

    reclassified = 0
    dropped_from_scope = 0
    skipped_unparseable = 0

    async with pool.acquire() as conn:
        for row in rows:
            raw: Any = row["raw"]
            # `raw` is jsonb — asyncpg gives us a str OR a dict depending
            # on codec config. Normalise.
            if isinstance(raw, str):
                try:
                    raw_dict = json.loads(raw)
                except json.JSONDecodeError:
                    skipped_unparseable += 1
                    continue
            elif isinstance(raw, dict):
                raw_dict = raw
            else:
                skipped_unparseable += 1
                continue

            tags = _event_tag_slugs(raw_dict)
            new_type = classify_event(row["polymarket_slug"], row["question"], tags)

            if new_type == row["event_type"]:
                continue

            if new_type not in SUPPORTED_TYPES:
                # Row was in scope at collection time, but the current
                # classifier would drop it. Don't touch — preserve for
                # auditing. The data is still valid for past backtests.
                dropped_from_scope += 1
                continue

            await conn.execute(
                "UPDATE events SET event_type=$1, updated_at=NOW() WHERE event_id=$2",
                new_type,
                row["event_id"],
            )
            reclassified += 1

    return {
        "checked": len(rows),
        "reclassified": reclassified,
        "dropped_from_scope": dropped_from_scope,
        "skipped_unparseable": skipped_unparseable,
    }


async def run_reclassify_forever(
    pool: asyncpg.Pool, interval_s: int = 3600
) -> None:
    """Long-running loop. Sleeps `interval_s` between passes.

    Default 1 hour is plenty — the only reason this exists is to catch
    classifier-rule changes, and those happen at most every few days.
    If we ever ship classifier changes more often we can drop to 15m
    without any concern; the work is cheap.
    """
    # Stagger the first run so the collector can finish its own startup
    # before we hammer the DB. 60s is arbitrary but harmless.
    await asyncio.sleep(60)
    while True:
        try:
            stats = await reclassify_once(pool)
            log.info("reclassify_cycle_done", **stats)
        except Exception:  # noqa: BLE001
            log.exception("reclassify_cycle_failed")
        await asyncio.sleep(interval_s)
