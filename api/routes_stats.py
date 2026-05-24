"""Aggregate / analytics endpoints (`/v1/stats/...`).

These are the "show off our data" endpoints that surface insights
Polymarket itself doesn't publish — they help users (and us, in
marketing) see whether Polymarket's prediction markets are
well-calibrated, where mispricings concentrate, and how liquidity
behaves across windows.

Currently only one endpoint: market calibration. More to come (volume
profiles, mispricing leaderboards, etc.).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any

from clickhouse_connect.driver.asyncclient import AsyncClient
from fastapi import APIRouter, Query, Request, Response

router = APIRouter(prefix="/v1/stats", tags=["stats"])


# ---------------------------------------------------------------------------
# Market calibration
# ---------------------------------------------------------------------------
#
# Question we're answering: "When Polymarket says the market is at X%
# probability T minutes before resolution, how often does that actually
# happen?"
#
# Output is a table of buckets. If markets are perfectly calibrated, the
# bucket centred on 30% will resolve Up ~30% of the time. Systematic
# deviations are tradeable edges.
#
# Implementation: for each resolved market in scope, pull the orderbook
# mid_yes at (resolution_at - minutes_before). Bucket by mid, then for
# each bucket compute: count, mean mid, observed Up-rate.
#
# We query ClickHouse per-market in parallel (asyncio.gather, chunked) —
# the per-market query is a single index seek so it's fast. For 1k
# markets and 50-parallel chunks, the whole thing is ~1-2s.


async def _mid_yes_at(
    ch: AsyncClient, market_id: str, target_ts: datetime
) -> float | None:
    """Latest non-null mid_yes snapshot at or before `target_ts` for a
    single market.

    Why we filter `mid_yes IS NOT NULL`: as a binary market approaches
    resolution, the orderbook often becomes one-sided — everyone bids
    the winning side, nobody offers — and we can't compute a mid (it
    needs both a top bid AND a top ask). The collector writes mid_yes
    as NULL in those cases.

    Without this filter we'd take the most recent snapshot regardless,
    hit a NULL mid, return None, and silently exclude that market from
    every calibration plot. That's exactly what was happening to the
    daily Up/Down markets — most of their final-minute snapshots are
    one-sided.

    Walking back to find the most recent snapshot WITH a valid mid is
    the right behavior: it's still the closest we have to "what was the
    market saying T-N minutes before resolution".
    """
    result = await ch.query(
        """
        SELECT mid_yes
          FROM orderbook_snapshots
         WHERE market_id = {market_id:String}
           AND ts <= {target:DateTime64(3)}
           AND mid_yes IS NOT NULL
         ORDER BY ts DESC LIMIT 1
        """,
        parameters={"market_id": market_id, "target": target_ts},
    )
    if not result.result_rows:
        return None
    v = result.result_rows[0][0]
    return float(v) if v is not None else None


def _normalise_outcome(outcome: str | None) -> int | None:
    """1 = Up won, 0 = Down won, None = inconclusive / unknown.
    Mirrors the same logic the /v1/markets/{id} endpoint uses."""
    if not outcome:
        return None
    txt = outcome.lower()
    if "up" in txt or txt == "yes":
        return 1
    if "down" in txt or txt == "no":
        return 0
    return None


@router.get("/calibration")
async def market_calibration(
    request: Request,
    response: Response,
    ticker: str | None = Query(default=None, examples=["BTC", "ETH", "SOL"]),
    event_type: str | None = Query(
        default=None, examples=["5m", "15m", "1h", "4h", "24h"]
    ),
    minutes_before: float = Query(
        default=1.0,
        ge=0.0,
        le=60.0 * 24,
        description="How far before resolution to sample the implied probability.",
    ),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    buckets: int = Query(default=10, ge=2, le=50),
    max_markets: int = Query(default=2000, ge=10, le=10_000),
) -> dict[str, Any]:
    """Calibration analysis across resolved markets.

    Returns a histogram-style breakdown: each bucket reports how many
    markets were trading in that implied-probability range at
    `minutes_before` before resolution, and what fraction of those
    markets actually resolved Up.
    """
    # Lazy import of authed_key — at module load time main.py hasn't
    # finished importing yet (circular), but by the time a request
    # arrives main.py is fully loaded and this import is cheap.
    from api.main import authed_key
    await authed_key(request, response)

    pool = request.app.state.pg
    ch: AsyncClient = request.app.state.ch

    from backtest.data_loader import list_resolved_markets

    universe = await list_resolved_markets(
        pool,
        event_type=event_type,
        ticker=ticker,
        since=since,
        until=until,
        limit=max_markets,
    )

    if not universe:
        return {
            "params": {
                "ticker": ticker,
                "event_type": event_type,
                "minutes_before": minutes_before,
                "buckets": buckets,
            },
            "n_markets": 0,
            "buckets": [],
        }

    # Build the list of (market_id, target_ts, outcome) we need to score.
    targets: list[tuple[str, datetime, int]] = []
    delta = timedelta(minutes=minutes_before)
    for row in universe:
        outcome = _normalise_outcome(row.get("resolution_outcome"))
        if outcome is None:
            continue  # inconclusive markets don't tell us about calibration
        resolution_at = row.get("resolution_at")
        if resolution_at is None:
            continue
        targets.append((row["market_id"], resolution_at - delta, outcome))

    # Fan out the ClickHouse lookups. 50-parallel keeps us well within
    # both ClickHouse's connection pool and the per-query CPU budget on
    # a small instance.
    CONCURRENCY = 50
    sem = asyncio.Semaphore(CONCURRENCY)

    async def _one(market_id: str, target_ts: datetime, outcome: int):
        async with sem:
            mid = await _mid_yes_at(ch, market_id, target_ts)
        return (mid, outcome) if mid is not None else None

    raw = await asyncio.gather(*[_one(*t) for t in targets])
    pairs: list[tuple[float, int]] = [r for r in raw if r is not None]

    # Bucket the (mid, outcome) pairs uniformly across [0, 1].
    bins: list[dict[str, Any]] = []
    width = 1.0 / buckets
    for i in range(buckets):
        lo = i * width
        hi = (i + 1) * width if i < buckets - 1 else 1.0001  # include 1.0
        in_bucket = [(m, o) for m, o in pairs if lo <= m < hi]
        n = len(in_bucket)
        if n == 0:
            bins.append(
                {
                    "lo": lo,
                    "hi": min(hi, 1.0),
                    "n_markets": 0,
                    "up_rate": None,
                    "mean_mid": None,
                }
            )
            continue
        ups = sum(o for _, o in in_bucket)
        mean_mid = sum(m for m, _ in in_bucket) / n
        bins.append(
            {
                "lo": lo,
                "hi": min(hi, 1.0),
                "n_markets": n,
                "up_rate": ups / n,
                "mean_mid": mean_mid,
            }
        )

    return {
        "params": {
            "ticker": ticker,
            "event_type": event_type,
            "minutes_before": minutes_before,
            "buckets": buckets,
            "since": since.isoformat() if since else None,
            "until": until.isoformat() if until else None,
        },
        "n_markets": len(pairs),
        "n_total_resolved": len(universe),
        "buckets": bins,
    }
