"""FastAPI app — PolyQuantLab API.

(API surface intentionally matches PolyBackTest's schema for drop-in
compatibility, but this is our own product, not a fork.)


Routes:
  GET  /health
  GET  /v1/markets/resolved             — list resolved markets (filter universe)
  GET  /v1/markets/{market_id}          — metadata (PolyBackTest schema)
  GET  /v1/markets/{market_id}/timeseries — paginated mid-price time series
  GET  /v1/markets/{market_id}/orderbook  — current (or point-in-time) book
  GET  /v1/markets/{market_id}/volume     — volume aggregation (1h/24h/7d/all)
  GET  /v1/snapshot-at/{ts}             — point-in-time orderbook lookup
  GET  /v1/snapshots                    — historical orderbook snapshots range
  GET  /v1/candles                      — OHLC at 5m / 15m / 1h / 4h / 24h
  GET  /v1/underlying                   — Binance spot / Bybit linear price history
  GET  /v1/spot/trades                  — Binance 1m OHLC + aggressive flow
  GET  /v1/spot/trades/latest           — most recent 1m bucket per ticker
  POST /v1/backtest                     — submit a backtest job (returns job_id, async)
  GET  /v1/backtest                     — list this key's recent backtest jobs
  GET  /v1/backtest/{job_id}            — poll status / fetch completed result

Run:
  uvicorn api.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import asyncpg
from clickhouse_connect.driver.asyncclient import AsyncClient
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field

from arq import create_pool
from arq.connections import ArqRedis

from api.auth import lookup_api_key, record_usage, require_api_key
from api.job_store import JobStatus, JobStore
from api.rate_limiter import RateLimiter
from api.routes_internal import router as internal_router
from api.tiers import TierLimits, resolve_tier
from backtest.data_loader import list_resolved_markets, load_snapshots
from collector.config import get_settings
from collector.db import make_clickhouse, make_postgres_pool
from collector.logging_setup import get_logger, setup_logging
from worker.backtest_worker import _redis_settings_from_url

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    settings = get_settings()
    app.state.pg = await make_postgres_pool(settings)
    app.state.ch = await make_clickhouse(settings)
    app.state.rate_limiter = RateLimiter(settings.redis_url)
    app.state.job_store = JobStore(settings.redis_url)
    # ArqRedis is the SUBMIT side of the queue — workers consume from
    # the same Redis using the same key namespace.
    app.state.arq: ArqRedis = await create_pool(
        _redis_settings_from_url(settings.redis_url)
    )
    log.info("api_started")
    try:
        yield
    finally:
        await app.state.pg.close()
        await app.state.ch.close()
        await app.state.rate_limiter.close()
        await app.state.job_store.close()
        await app.state.arq.aclose()


app = FastAPI(
    title="Prediction Market Backtest API",
    version="0.1.0",
    description="Cross-platform (Polymarket + Kalshi) Up/Down market data + backtesting",
    lifespan=lifespan,
)

# Server-to-server endpoints used by the Next.js frontend
# (Stripe webhook sync + dashboard API key management).
# Auth on every route inside is the shared X-Internal-Secret header.
app.include_router(internal_router)


# ---------------------------------------------------------------------------
# Dependency: validate the raw key against the DB
# ---------------------------------------------------------------------------


async def authed_key(
    request: Request,
    response: Response,
) -> dict[str, Any]:
    """Authenticate the caller, then (if an end-user API key) enforce
    tier-based rate limits.

    Two valid authentication paths:

    1. **API key** (`Authorization: Bearer ...` or `X-API-Key`) — the
       normal flow for programmatic users. Subject to tier rate limits,
       and the call is logged in `api_usage_daily`.

    2. **Internal secret** (`X-Internal-Secret: <shared secret>`) — used
       by the Next.js dashboard proxies (`web/app/api/markets/...`) to
       fetch data on behalf of a Supabase-authenticated user without
       forcing every browser session to first mint an API key. We trust
       the Next.js process to have already authenticated the user; this
       header MUST never reach an end user. Calls via this path bypass
       rate limiting (Next.js is responsible for upstream caps) and are
       NOT recorded in api_usage_daily — they're "system" requests.

    The validated record is enriched with the resolved `TierLimits` so
    downstream route handlers (especially /v1/backtest) can apply
    feature-level gates (max_market_limit, concurrent_backtests) without
    re-resolving the tier. For internal-secret callers, we return the
    Premium tier limits so feature gates don't trip on dashboard reads.
    """
    settings = get_settings()
    internal_secret_hdr = request.headers.get("X-Internal-Secret")
    if (
        internal_secret_hdr
        and settings.internal_api_secret
        and internal_secret_hdr == settings.internal_api_secret
    ):
        # Trusted server-to-server call from Next.js. No rate limit, no
        # usage logging — just hand back a synthetic record so the route
        # handlers (which read record["tier_limits"]) keep working.
        return {
            "api_key_id": "__internal__",
            "user_id": None,
            "tier": "premium",
            "tier_limits": resolve_tier("premium"),
            "is_internal": True,
        }

    # Fall through to normal API-key auth path.
    token = await require_api_key(
        authorization=request.headers.get("Authorization"),
        x_api_key=request.headers.get("X-API-Key"),
    )
    pool: asyncpg.Pool = request.app.state.pg
    record = await lookup_api_key(pool, token)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key"
        )

    tier_limits: TierLimits = resolve_tier(record.get("tier"))
    record["tier_limits"] = tier_limits

    rate_limiter: RateLimiter = request.app.state.rate_limiter
    decision = await rate_limiter.check(str(record["api_key_id"]), tier_limits)

    # Pack the rate-limit state into a header dict that we apply BOTH to
    # the success response and to the HTTPException — FastAPI doesn't
    # propagate Response.headers automatically when a dependency raises,
    # so we have to attach them via HTTPException(headers=...) on 429.
    rl_headers = {
        "X-RateLimit-Limit": str(decision.limit),
        "X-RateLimit-Remaining": str(max(decision.remaining, 0)),
        "X-RateLimit-Reset": str(max(decision.reset_seconds, 1)),
        "X-RateLimit-Tier": tier_limits.display_name,
    }
    for k, v in rl_headers.items():
        response.headers[k] = v

    if not decision.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Rate limit exceeded ({decision.granularity}). "
                f"Limit {decision.limit} per "
                f"{'second' if decision.granularity == 'rps' else 'minute'}; "
                f"retry in {max(decision.reset_seconds, 1)}s."
            ),
            headers={
                **rl_headers,
                "Retry-After": str(max(decision.reset_seconds, 1)),
            },
        )

    await record_usage(pool, record["api_key_id"])
    return record


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    ch: AsyncClient = request.app.state.ch
    try:
        result = await ch.query(
            "SELECT max(ts) AS latest, count() AS n FROM orderbook_snapshots "
            "WHERE ts > now() - INTERVAL 5 MINUTE"
        )
        latest, n = result.result_rows[0]
        return {
            "ok": n > 0,
            "latest_snapshot": latest.isoformat() if latest else None,
            "snapshots_last_5min": n,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/v1/markets/resolved")
async def get_resolved_markets(
    request: Request,
    event_type: str | None = Query(default=None, examples=["fomc", "cpi", "crypto_up_down"]),
    ticker: str | None = Query(default=None, examples=["BTC", "TSLA", "FED"]),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    limit: int = Query(default=100, le=1000),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    pool = request.app.state.pg
    markets = await list_resolved_markets(
        pool,
        event_type=event_type,
        ticker=ticker,
        since=since,
        until=until,
        limit=limit,
    )
    return {"markets": markets, "count": len(markets)}


async def _underlying_price_at(ch: AsyncClient, ticker: str, ts: datetime) -> float | None:
    """Closest spot price to ts (within 5 minutes)."""
    if not ticker:
        return None
    result = await ch.query(
        """
        SELECT price FROM underlying_prices
         WHERE ticker = {ticker:String}
           AND source = 'binance_spot'
           AND ts >= {lo:DateTime64(3)}
           AND ts <= {hi:DateTime64(3)}
         ORDER BY abs(toUnixTimestamp64Milli(ts) - toUnixTimestamp64Milli({target:DateTime64(3)}))
         LIMIT 1
        """,
        parameters={
            "ticker": ticker,
            "target": ts,
            "lo": ts.replace(microsecond=0).replace(tzinfo=ts.tzinfo) - _td(minutes=5),
            "hi": ts.replace(microsecond=0).replace(tzinfo=ts.tzinfo) + _td(minutes=5),
        },
    )
    if not result.result_rows:
        return None
    return float(result.result_rows[0][0])


def _td(**kwargs):
    from datetime import timedelta

    return timedelta(**kwargs)


async def _market_volume(ch: AsyncClient, market_id: str) -> tuple[float, int]:
    """Sum of (price * size) across all observed trades for the market."""
    result = await ch.query(
        """
        SELECT coalesce(sum(price * size), 0) AS notional, count() AS n
          FROM trades WHERE market_id = {market_id:String}
        """,
        parameters={"market_id": market_id},
    )
    if not result.result_rows:
        return 0.0, 0
    row = result.result_rows[0]
    return float(row[0]), int(row[1])


async def _market_liquidity_snapshot(
    ch: AsyncClient, market_id: str
) -> float | None:
    """Latest book depth on YES side (sum of top-10 bid sizes)."""
    result = await ch.query(
        """
        SELECT yes_bids FROM orderbook_snapshots
         WHERE market_id = {market_id:String}
         ORDER BY ts DESC LIMIT 1
        """,
        parameters={"market_id": market_id},
    )
    if not result.result_rows:
        return None
    import orjson

    try:
        bids = orjson.loads(result.result_rows[0][0])
    except orjson.JSONDecodeError:
        return None
    return float(sum(level.get("size", 0) for level in bids if isinstance(level, dict)))


def _winner_from_outcome(resolution_outcome: str | None, market_outcome: str | None) -> str | None:
    """Normalise to "Up" / "Down" (or None if unresolved)."""
    if not resolution_outcome:
        return None
    txt = resolution_outcome.lower()
    if txt in ("up", "yes") or "up" in txt:
        return "Up"
    if txt in ("down", "no") or "down" in txt:
        return "Down"
    return resolution_outcome


@app.get("/v1/markets/{market_id}")
async def get_market(
    market_id: str,
    request: Request,
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Metadata for one market. Matches the schema PolyBackTest advertises:
    market_id, event_id, slug, market_type, start_time, end_time,
    {ticker}_price_start, {ticker}_price_end, winner, final_volume,
    final_liquidity, resolved_at.
    """
    pool = request.app.state.pg
    ch = request.app.state.ch

    row = await pool.fetchrow(
        """
        SELECT m.market_id, m.outcome, m.yes_token_id, m.no_token_id,
               m.is_active, m.tick_size,
               e.event_id, e.polymarket_slug, e.ticker, e.event_type,
               e.question, e.created_at, e.resolution_at, e.resolved_at,
               e.resolution_outcome
          FROM markets m
          JOIN events  e ON e.event_id = m.event_id
         WHERE m.market_id = $1
        """,
        market_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Market not found")

    ticker = row["ticker"]
    start_time = row["created_at"]
    end_time = row["resolution_at"]
    resolved_at = row["resolved_at"]

    # Pull underlying prices at start and end (best-effort — may be null if
    # the market started before we deployed)
    price_start = await _underlying_price_at(ch, ticker, start_time) if start_time else None
    price_end = await _underlying_price_at(ch, ticker, end_time) if end_time else None

    final_volume, _trade_count = await _market_volume(ch, market_id)
    final_liquidity = await _market_liquidity_snapshot(ch, market_id)
    winner = _winner_from_outcome(row["resolution_outcome"], row["outcome"])

    underlying_key = f"{ticker.lower()}_price"  # btc_price_start, eth_price_end, etc.
    return {
        "market_id": row["market_id"],
        "event_id": str(row["event_id"]),
        "slug": row["polymarket_slug"],
        "market_type": row["event_type"],
        "ticker": ticker,
        "outcome": row["outcome"],
        "start_time": start_time.isoformat() if start_time else None,
        "end_time": end_time.isoformat() if end_time else None,
        f"{underlying_key}_start": price_start,
        f"{underlying_key}_end": price_end,
        "winner": winner,
        "final_volume": final_volume,
        "final_liquidity": final_liquidity,
        "resolved_at": resolved_at.isoformat() if resolved_at else None,
    }


@app.get("/v1/markets/{market_id}/timeseries")
async def get_market_timeseries(
    market_id: str,
    request: Request,
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=100, le=10_000),
    offset: int = Query(default=0, ge=0),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Paginated mid-price time series. Matches PolyBackTest's timeseries
    schema: each point has id, time, {ticker}_price, price_up, price_down.
    """
    pool = request.app.state.pg
    ch = request.app.state.ch

    meta = await pool.fetchrow(
        """
        SELECT m.market_id, e.event_type AS market_type, e.ticker
          FROM markets m
          JOIN events  e ON e.event_id = m.event_id
         WHERE m.market_id = $1
        """,
        market_id,
    )
    if not meta:
        raise HTTPException(status_code=404, detail="Market not found")

    ticker = meta["ticker"]

    # Build the WHERE clause
    params: dict[str, Any] = {"market_id": market_id, "limit": limit, "offset": offset}
    where = ["market_id = {market_id:String}"]
    if start:
        params["start"] = start
        where.append("ts >= {start:DateTime64(3)}")
    if end:
        params["end"] = end
        where.append("ts < {end:DateTime64(3)}")

    # Count total (for pagination)
    count_result = await ch.query(
        f"SELECT count() FROM orderbook_snapshots WHERE {' AND '.join(where)}",
        parameters=params,
    )
    total = int(count_result.result_rows[0][0]) if count_result.result_rows else 0

    # Fetch the slice
    result = await ch.query(
        f"""
        SELECT ts, mid_yes, underlying_price,
               toUInt64(toUnixTimestamp64Milli(ts)) AS row_id
          FROM orderbook_snapshots
         WHERE {' AND '.join(where)}
         ORDER BY ts ASC
         LIMIT {{limit:UInt64}} OFFSET {{offset:UInt64}}
        """,
        parameters=params,
    )

    underlying_key = f"{ticker.lower()}_price"
    snapshots = []
    for ts, mid_yes, underlying_price, row_id in result.result_rows:
        price_up = float(mid_yes) if mid_yes is not None else None
        price_down = (1.0 - price_up) if price_up is not None else None
        snapshots.append(
            {
                "id": int(row_id),
                "time": ts.isoformat(),
                underlying_key: float(underlying_price) if underlying_price is not None else None,
                "price_up": price_up,
                "price_down": price_down,
            }
        )

    return {
        "market": {"market_id": market_id, "market_type": meta["market_type"]},
        "snapshots": snapshots,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/v1/markets/{market_id}/orderbook")
async def get_market_orderbook(
    market_id: str,
    request: Request,
    at: datetime | None = Query(
        default=None,
        description="Return the orderbook at (or closest to) this timestamp. Defaults to latest.",
    ),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Single-snapshot orderbook for the requested market.
    Matches PolyBackTest's `orderbook_up` / `orderbook_down` schema.
    """
    pool = request.app.state.pg
    ch = request.app.state.ch

    meta = await pool.fetchrow(
        "SELECT market_id FROM markets WHERE market_id = $1",
        market_id,
    )
    if not meta:
        raise HTTPException(status_code=404, detail="Market not found")

    if at is None:
        result = await ch.query(
            """
            SELECT ts, yes_bids, yes_asks, no_bids, no_asks,
                   mid_yes, spread_yes, underlying_price
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
             ORDER BY ts DESC LIMIT 1
            """,
            parameters={"market_id": market_id},
        )
    else:
        result = await ch.query(
            """
            SELECT ts, yes_bids, yes_asks, no_bids, no_asks,
                   mid_yes, spread_yes, underlying_price
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
               AND ts <= {at:DateTime64(3)}
             ORDER BY ts DESC LIMIT 1
            """,
            parameters={"market_id": market_id, "at": at},
        )

    if not result.result_rows:
        raise HTTPException(status_code=404, detail="No snapshots for this market")

    import orjson

    ts, yb, ya, nb, na, mid_yes, spread, underlying = result.result_rows[0]

    def _safe_json(raw):
        try:
            return orjson.loads(raw)
        except (orjson.JSONDecodeError, TypeError):
            return []

    return {
        "market_id": market_id,
        "time": ts.isoformat(),
        "mid_yes": float(mid_yes) if mid_yes is not None else None,
        "spread_yes": float(spread) if spread is not None else None,
        "underlying_price": float(underlying) if underlying is not None else None,
        "orderbook_up":   {"bids": _safe_json(yb), "asks": _safe_json(ya)},
        "orderbook_down": {"bids": _safe_json(nb), "asks": _safe_json(na)},
    }


@app.get("/v1/snapshot-at/{ts}")
async def get_snapshot_at(
    ts: datetime,
    request: Request,
    market_id: str = Query(...),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Point-in-time orderbook lookup — returns the snapshot whose ts is
    the greatest value ≤ requested ts. Equivalent to the
    /v1/snapshot-at/{ts} endpoint listed on the PolyBackTest landing page.
    """
    # Delegate to the orderbook endpoint with `at=` parameter
    return await get_market_orderbook(market_id=market_id, request=request, at=ts)


@app.get("/v1/markets/{market_id}/volume")
async def get_market_volume(
    market_id: str,
    request: Request,
    window: str = Query(
        default="all",
        examples=["1h", "24h", "7d", "all"],
        description="Aggregation window for the volume sum.",
    ),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Volume + trade-count aggregation for a market, with an optional
    rolling window (1h / 24h / 7d / all).
    """
    ch = request.app.state.ch
    interval = {
        "1h":  "INTERVAL 1 HOUR",
        "24h": "INTERVAL 24 HOUR",
        "7d":  "INTERVAL 7 DAY",
    }.get(window)
    where = "market_id = {market_id:String}"
    if interval:
        where += f" AND ts > now() - {interval}"

    result = await ch.query(
        f"""
        SELECT coalesce(sum(price * size), 0) AS notional,
               coalesce(sum(size), 0)         AS volume_shares,
               count()                        AS trade_count,
               min(ts)                        AS first_trade,
               max(ts)                        AS last_trade
          FROM trades WHERE {where}
        """,
        parameters={"market_id": market_id},
    )
    if not result.result_rows:
        notional = volume = trade_count = 0
        first_trade = last_trade = None
    else:
        notional, volume, trade_count, first_trade, last_trade = result.result_rows[0]

    # When the WHERE matched zero trades, ClickHouse returns min/max as the
    # zero-value DateTime (1970-01-01). Translate that to null for the API.
    epoch_zero = datetime(1970, 1, 1, tzinfo=first_trade.tzinfo if first_trade else None)
    if first_trade and first_trade.replace(tzinfo=None) == datetime(1970, 1, 1):
        first_trade = None
    if last_trade and last_trade.replace(tzinfo=None) == datetime(1970, 1, 1):
        last_trade = None
    _ = epoch_zero  # silence unused-var if branch never used

    return {
        "market_id": market_id,
        "window": window,
        "notional_usd": float(notional),
        "volume_shares": float(volume),
        "trade_count": int(trade_count),
        "first_trade": first_trade.isoformat() if first_trade else None,
        "last_trade":  last_trade.isoformat()  if last_trade  else None,
    }


@app.get("/v1/snapshots")
async def get_snapshots(
    request: Request,
    market_id: str = Query(...),
    start: datetime = Query(...),
    end: datetime = Query(...),
    limit: int = Query(default=10_000, le=100_000),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    ch = request.app.state.ch
    snapshots = await load_snapshots(ch, market_id, start, end, limit)
    return {
        "market_id": market_id,
        "count": len(snapshots),
        "snapshots": [
            {
                "ts": s.ts.isoformat(),
                "yes_bids": [{"price": l.price, "size": l.size} for l in s.yes_bids],
                "yes_asks": [{"price": l.price, "size": l.size} for l in s.yes_asks],
                "no_bids": [{"price": l.price, "size": l.size} for l in s.no_bids],
                "no_asks": [{"price": l.price, "size": l.size} for l in s.no_asks],
                "underlying_price": s.underlying_price,
                "underlying_ticker": s.underlying_ticker,
            }
            for s in snapshots
        ],
    }


CANDLE_TABLES = {
    "5m":  "candles_5m",
    "15m": "candles_15m",
    "1h":  "candles_1h",
    "4h":  "candles_4h",
    "24h": "candles_24h",
}


@app.get("/v1/candles")
async def get_candles(
    request: Request,
    market_id: str = Query(...),
    timeframe: str = Query(..., examples=["5m", "15m", "1h", "4h", "24h"]),
    start: datetime = Query(...),
    end: datetime = Query(...),
    limit: int = Query(default=1000, le=10_000),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """OHLC candles for one market at the requested timeframe.

    Backed by a ClickHouse AggregatingMergeTree materialized view per
    timeframe (see db/migrations/001_candles.sql). Reading uses the
    *Merge combinators to collapse partial aggregates.
    """
    table = CANDLE_TABLES.get(timeframe)
    if table is None:
        raise HTTPException(
            status_code=400,
            detail=f"timeframe must be one of {list(CANDLE_TABLES.keys())}",
        )
    ch = request.app.state.ch
    query = f"""
    SELECT bucket,
           argMinMerge(open_state)  AS open,
           maxMerge(high_state)     AS high,
           minMerge(low_state)      AS low,
           argMaxMerge(close_state) AS close,
           countMerge(n_state)      AS n_snapshots
      FROM {table}
     WHERE market_id = {{market_id:String}}
       AND bucket   >= {{start:DateTime}}
       AND bucket    < {{end:DateTime}}
     GROUP BY market_id, bucket
     ORDER BY bucket ASC
     LIMIT {{limit:UInt64}}
    """
    result = await ch.query(
        query,
        parameters={
            "market_id": market_id,
            "start": start,
            "end": end,
            "limit": limit,
        },
    )
    candles = [
        {
            "bucket": row[0].isoformat(),
            "open": row[1],
            "high": row[2],
            "low": row[3],
            "close": row[4],
            "n_snapshots": int(row[5]),
        }
        for row in result.result_rows
    ]
    return {
        "market_id": market_id,
        "timeframe": timeframe,
        "count": len(candles),
        "candles": candles,
    }


@app.get("/v1/spot/trades")
async def get_spot_trades(
    request: Request,
    ticker: str = Query(..., examples=["BTC", "ETH", "SOL"]),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=100, le=10_000),
    offset: int = Query(default=0, ge=0),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Paginated 1-minute OHLC + aggressive flow imbalance from Binance
    spot aggTrades.

    PolyBackTest schema reference:
      /v3/{coin}/spot/trades — paginated list of OHLC buckets.
    """
    ch = request.app.state.ch
    params: dict[str, Any] = {
        "ticker": ticker.upper(),
        "limit": limit,
        "offset": offset,
    }
    where = ["ticker = {ticker:String}"]
    if start:
        params["start"] = start
        where.append("bucket >= {start:DateTime}")
    if end:
        params["end"] = end
        where.append("bucket <  {end:DateTime}")

    # Total count for pagination
    count_result = await ch.query(
        f"SELECT count() FROM binance_spot_trades WHERE {' AND '.join(where)}",
        parameters=params,
    )
    total = int(count_result.result_rows[0][0]) if count_result.result_rows else 0

    result = await ch.query(
        f"""
        SELECT bucket, price_open, price_high, price_low, price_close,
               total_volume, num_trades,
               aggressive_buy_volume, aggressive_sell_volume,
               toUInt64(toUnixTimestamp(bucket)) AS row_id
          FROM binance_spot_trades
         WHERE {' AND '.join(where)}
         ORDER BY bucket DESC
         LIMIT {{limit:UInt64}} OFFSET {{offset:UInt64}}
        """,
        parameters=params,
    )
    rows = [
        {
            "id": int(r[9]),
            "timestamp": r[0].isoformat(),
            "price_open": float(r[1]),
            "price_high": float(r[2]),
            "price_low": float(r[3]),
            "price_close": float(r[4]),
            "total_volume": float(r[5]),
            "num_trades": int(r[6]),
            "aggressive_buy_volume": float(r[7]),
            "aggressive_sell_volume": float(r[8]),
        }
        for r in result.result_rows
    ]
    return {"ticker": ticker.upper(), "total": total, "limit": limit, "offset": offset, "trades": rows}


@app.get("/v1/spot/trades/latest")
async def get_spot_trades_latest(
    request: Request,
    ticker: str = Query(..., examples=["BTC", "ETH", "SOL"]),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """The most recent completed 1-minute OHLC bucket for one ticker.
    PolyBackTest schema reference: /v3/{coin}/spot/trades/latest.
    """
    ch = request.app.state.ch
    result = await ch.query(
        """
        SELECT bucket, price_open, price_high, price_low, price_close,
               total_volume, num_trades,
               aggressive_buy_volume, aggressive_sell_volume,
               toUInt64(toUnixTimestamp(bucket)) AS row_id
          FROM binance_spot_trades
         WHERE ticker = {ticker:String}
         ORDER BY bucket DESC LIMIT 1
        """,
        parameters={"ticker": ticker.upper()},
    )
    if not result.result_rows:
        raise HTTPException(status_code=404, detail="No trade data yet for this ticker")
    r = result.result_rows[0]
    return {
        "id": int(r[9]),
        "ticker": ticker.upper(),
        "timestamp": r[0].isoformat(),
        "price_open": float(r[1]),
        "price_high": float(r[2]),
        "price_low": float(r[3]),
        "price_close": float(r[4]),
        "total_volume": float(r[5]),
        "num_trades": int(r[6]),
        "aggressive_buy_volume": float(r[7]),
        "aggressive_sell_volume": float(r[8]),
    }


@app.get("/v1/underlying")
async def get_underlying(
    request: Request,
    ticker: str = Query(..., examples=["BTC", "ETH", "SOL"]),
    source: str = Query(default="binance_spot", examples=["binance_spot", "binance_futures"]),
    start: datetime = Query(...),
    end: datetime = Query(...),
    limit: int = Query(default=10_000, le=100_000),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Binance spot/futures price history for one ticker."""
    ch = request.app.state.ch
    result = await ch.query(
        """
        SELECT ts, price, source
          FROM underlying_prices
         WHERE ticker = {ticker:String}
           AND source = {source:String}
           AND ts >= {start:DateTime64(3)}
           AND ts <  {end:DateTime64(3)}
         ORDER BY ts
         LIMIT {limit:UInt64}
        """,
        parameters={
            "ticker": ticker.upper(),
            "source": source,
            "start": start,
            "end": end,
            "limit": limit,
        },
    )
    return {
        "ticker": ticker.upper(),
        "source": source,
        "count": len(result.result_rows),
        "points": [
            {"ts": row[0].isoformat(), "price": row[1]} for row in result.result_rows
        ],
    }


class BacktestRequest(BaseModel):
    strategy: dict[str, Any] = Field(
        ...,
        examples=[
            {
                "type": "threshold_entry",
                "threshold": 0.30,
                "direction": "below",
                "side": "buy_yes",
                "size_usd": 100,
            },
            {
                "type": "mean_reversion",
                "lookback": 30,
                "z_threshold": 2.0,
                "size_usd": 100,
            },
        ],
    )
    event_type: str | None = None
    ticker: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    market_limit: int = Field(default=50, le=500)


@app.post("/v1/backtest")
async def post_backtest(
    request: Request,
    response: Response,
    body: BacktestRequest,
    wait_for_result: bool = Query(
        default=False,
        description=(
            "If true, hold the HTTP connection until the backtest finishes "
            "(up to 30 s) and return the completed result inline — like a "
            "synchronous endpoint. If 30 s isn't enough, you'll get a 504 "
            "with the job_id so you can poll GET /v1/backtest/{job_id} "
            "instead. Use false (default) for UI / long jobs."
        ),
    ),
    auth: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Submit a backtest job.

    Two modes:
      * **Async** (default, `wait_for_result=false`): returns HTTP 202 +
        `job_id` immediately. Client polls `GET /v1/backtest/{job_id}`.
        Best for UI and long jobs; survives client disconnects.
      * **Sync-style** (`wait_for_result=true`): the API holds the
        connection while a worker processes the job, then returns HTTP
        200 with the completed result inline. Matches the curl-friendly
        pattern PolyBackTest data customers expect. Caps at 30 s of
        wait; longer than that and you get a 504 + the job_id so you
        can keep polling.

    Tier gates (rate limit already checked in `authed_key`):
      * `market_limit` cap from the tier prevents Free users from
        queueing a 500-market scan.
      * Per-key concurrent in-flight cap (`tier.concurrent_backtests`):
        users can't flood the queue with their own work and starve
        others.
    """
    tier_limits: TierLimits = auth["tier_limits"]
    if body.market_limit > tier_limits.max_market_limit:
        raise HTTPException(
            status_code=402,
            detail=(
                f"{tier_limits.display_name} tier allows market_limit "
                f"up to {tier_limits.max_market_limit}; you requested "
                f"{body.market_limit}. Upgrade for more."
            ),
        )

    api_key_id = str(auth["api_key_id"])
    job_store: JobStore = request.app.state.job_store

    # Per-key concurrency check: count user's jobs that haven't terminated.
    recent = await job_store.list_for_user(api_key_id, limit=tier_limits.concurrent_backtests + 5)
    in_flight = sum(1 for j in recent if j.status in (JobStatus.QUEUED, JobStatus.RUNNING))
    if in_flight >= tier_limits.concurrent_backtests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"{tier_limits.display_name} tier allows "
                f"{tier_limits.concurrent_backtests} concurrent backtests; "
                f"you currently have {in_flight} in flight. Wait or upgrade."
            ),
            headers={"Retry-After": "5"},
        )

    # Record the job BEFORE enqueueing — if the enqueue fails we want a
    # FAILED row, not a phantom queue entry.
    params = body.model_dump(mode="json")
    record = await job_store.create(api_key_id, params)

    arq: ArqRedis = request.app.state.arq
    try:
        await arq.enqueue_job(
            "run_backtest_job",
            record.job_id,
            body.strategy,
            body.event_type,
            body.ticker,
            body.since.isoformat() if body.since else None,
            body.until.isoformat() if body.until else None,
            body.market_limit,
        )
    except Exception as exc:  # noqa: BLE001
        await job_store.mark_failed(record.job_id, f"enqueue_failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job queue unavailable; please retry shortly.",
            headers={"Retry-After": "5"},
        ) from exc

    # --- Sync-style waiting ------------------------------------------------
    # If the caller asked for inline result, poll our own JobStore until the
    # worker writes back COMPLETED / FAILED. This is just a convenience for
    # API users who don't want to implement polling themselves — internally
    # the job still flows through the same worker pool as async submissions.
    if wait_for_result:
        SYNC_TIMEOUT = 30.0       # hard cap, well under typical HTTP idle limits
        POLL_INTERVAL = 0.25      # 4 polls/sec — cheap (Redis GET)
        elapsed = 0.0
        while elapsed < SYNC_TIMEOUT:
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL
            current = await job_store.get(record.job_id)
            if current is None:
                # Job was GC'd while we waited — should be impossible inside
                # 30 s, but treat defensively.
                break
            if current.status == JobStatus.COMPLETED:
                return current.to_dict()
            if current.status == JobStatus.FAILED:
                # Surface the worker's error to the client so they can fix
                # their strategy spec without needing to poll separately.
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={
                        "error": current.error,
                        "job_id": current.job_id,
                    },
                )
        # 30 s elapsed without completion — return 504 + the job_id so the
        # caller can keep polling on their own schedule.
        response.headers["X-Job-Id"] = record.job_id
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "message": (
                    "Backtest still running after 30 s. Poll GET "
                    "/v1/backtest/{job_id} to retrieve the result when ready."
                ),
                "job_id": record.job_id,
            },
            headers={"X-Job-Id": record.job_id},
        )

    # --- Async (default) — return 202 with job_id, let the client poll ----
    response.status_code = status.HTTP_202_ACCEPTED
    return record.to_dict()


@app.get("/v1/backtest/{job_id}")
async def get_backtest_job(
    job_id: str,
    request: Request,
    auth: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Fetch the state (and result, if completed) of a backtest job.

    Authorisation: callers can only read jobs they submitted. We compare
    the API key id stored on the job record against the authenticated
    key — a different user with the same job_id (even if guessed) gets
    a 404 rather than 403 so we don't leak existence.
    """
    job_store: JobStore = request.app.state.job_store
    rec = await job_store.get(job_id)
    if rec is None or rec.api_key_id != str(auth["api_key_id"]):
        raise HTTPException(status_code=404, detail="Job not found")
    return rec.to_dict()


@app.get("/v1/backtest")
async def list_backtest_jobs(
    request: Request,
    limit: int = Query(default=20, le=100),
    offset: int = Query(default=0, ge=0),
    auth: dict = Depends(authed_key),
) -> dict[str, Any]:
    """List this API key's recent backtest jobs, newest first.

    Returned records include params + status; for COMPLETED jobs the
    result blob is also included. If the listing is large, paginate via
    `offset`. Older than ~500 jobs ago are GC'd by job_store.
    """
    job_store: JobStore = request.app.state.job_store
    jobs = await job_store.list_for_user(
        str(auth["api_key_id"]), limit=limit, offset=offset
    )
    return {
        "jobs": [j.to_dict() for j in jobs],
        "limit": limit,
        "offset": offset,
        "count": len(jobs),
    }
