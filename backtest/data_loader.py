"""Load historical orderbook + resolution data from ClickHouse / Postgres."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import asyncpg
import orjson
from clickhouse_connect.driver.asyncclient import AsyncClient

from backtest.types import OrderBookLevel, OrderBookSnapshot, Resolution


def _parse_levels(raw: str | None) -> list[OrderBookLevel]:
    if not raw:
        return []
    try:
        data = orjson.loads(raw) if isinstance(raw, (bytes, str)) else raw
    except orjson.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for level in data:
        if not isinstance(level, dict):
            continue
        try:
            price = float(level.get("price"))
            size = float(level.get("size", 0))
        except (TypeError, ValueError):
            continue
        out.append(OrderBookLevel(price=price, size=size))
    return out


async def load_snapshots(
    ch: AsyncClient,
    market_id: str,
    start: datetime,
    end: datetime,
    limit: int = 100_000,
) -> list[OrderBookSnapshot]:
    """Fetch all snapshots for one market in [start, end), oldest first."""
    query = """
    SELECT market_id, ts, yes_bids, yes_asks, no_bids, no_asks,
           underlying_price, underlying_ticker
      FROM orderbook_snapshots
     WHERE market_id = {market_id:String}
       AND ts >= {start:DateTime64(3)}
       AND ts <  {end:DateTime64(3)}
     ORDER BY ts
     LIMIT {limit:UInt64}
    """
    result = await ch.query(
        query,
        parameters={"market_id": market_id, "start": start, "end": end, "limit": limit},
    )
    snapshots: list[OrderBookSnapshot] = []
    for row in result.result_rows:
        (mid, ts, yb, ya, nb, na, up, ut) = row
        snapshots.append(
            OrderBookSnapshot(
                market_id=mid,
                ts=ts,
                yes_bids=_parse_levels(yb),
                yes_asks=_parse_levels(ya),
                no_bids=_parse_levels(nb),
                no_asks=_parse_levels(na),
                underlying_price=up,
                underlying_ticker=ut or "",
            )
        )
    return snapshots


async def load_resolution(
    pg_pool: asyncpg.Pool,
    market_id: str,
) -> Resolution | None:
    """Look up settlement outcome from Postgres events table.

    For Polymarket: event.resolution_outcome is "Up" / "Down" or similar.
    For Kalshi:    same column, populated when status flips to settled.

    Returns None if the market hasn't resolved yet — backtest skips it.
    """
    row = await pg_pool.fetchrow(
        """
        SELECT e.resolved_at, e.resolution_outcome, m.outcome AS market_outcome
          FROM markets m
          JOIN events  e ON e.event_id = m.event_id
         WHERE m.market_id = $1
        """,
        market_id,
    )
    if not row or row["resolved_at"] is None:
        return None
    resolution_outcome = (row["resolution_outcome"] or "").lower()
    market_outcome = (row["market_outcome"] or "").lower()
    # Heuristic: did this market's YES side win?
    yes_won = (
        resolution_outcome == "yes"
        or resolution_outcome == market_outcome
        or resolution_outcome.startswith("up")
        and "up" in market_outcome
    )
    return Resolution(
        market_id=market_id,
        resolved_at=row["resolved_at"],
        outcome_yes_price=1.0 if yes_won else 0.0,
    )


async def list_resolved_markets(
    pg_pool: asyncpg.Pool,
    *,
    event_type: str | None = None,
    ticker: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """List markets that have already resolved, filtered by criteria.

    Used to pick the universe of markets a backtest will run over.
    """
    where_clauses = ["e.resolved_at IS NOT NULL"]
    params: list[Any] = []
    if event_type:
        params.append(event_type)
        where_clauses.append(f"e.event_type = ${len(params)}")
    if ticker:
        params.append(ticker)
        where_clauses.append(f"e.ticker = ${len(params)}")
    if since:
        params.append(since)
        where_clauses.append(f"e.resolved_at >= ${len(params)}")
    if until:
        params.append(until)
        where_clauses.append(f"e.resolved_at < ${len(params)}")
    params.append(limit)
    sql = f"""
    SELECT m.market_id,
           e.ticker,
           e.event_type,
           e.question,
           e.created_at,
           e.resolution_at,
           e.resolved_at,
           e.resolution_outcome,
           m.outcome AS market_outcome
      FROM markets m
      JOIN events  e ON e.event_id = m.event_id
     WHERE {' AND '.join(where_clauses)}
     ORDER BY e.resolved_at DESC
     LIMIT ${len(params)}
    """
    rows = await pg_pool.fetch(sql, *params)
    return [dict(r) for r in rows]
