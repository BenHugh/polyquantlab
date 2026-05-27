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
  GET  /v1/polymarket/live-board        — currently-trading market per timeframe (Live Terminal)
  GET  /v1/polymarket/recent-trades     — recent N Polymarket trades for a ticker
  POST /v1/backtest                     — submit a backtest job (returns job_id, async)
  GET  /v1/backtest                     — list this key's recent backtest jobs
  GET  /v1/backtest/{job_id}            — poll status / fetch completed result

Run:
  uvicorn api.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import asyncpg
from clickhouse_connect.driver.asyncclient import AsyncClient
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field

from arq import create_pool
from arq.connections import ArqRedis

from api.auth import lookup_api_key, record_usage, require_api_key
from api.job_store import JobStatus, JobStore
from api.rate_limiter import RateLimiter
from api.routes_internal import router as internal_router
from api.routes_paper import router as paper_router
from api.routes_stats import router as stats_router
from api.tiers import TierLimits, resolve_tier
from backtest.arb_engine import find_live_opportunities
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
app.include_router(stats_router)
app.include_router(paper_router)


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
    with_underlying: bool = Query(
        default=False,
        description=(
            "Enrich each row with `underlying_start`, `underlying_end`, "
            "and `underlying_delta_pct` (= (end-start)/start * 100). "
            "Costs ~10ms × N markets of additional ClickHouse work, so "
            "off by default — UI calls it explicitly when surfacing "
            "the column."
        ),
    ),
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

    if with_underlying and markets:
        ch: AsyncClient = request.app.state.ch
        # Fan out per-market price lookups concurrently. Each market
        # needs two lookups (start + end); we cap concurrency to keep
        # ClickHouse happy on a small VPS.
        import asyncio
        sem = asyncio.Semaphore(40)

        async def _enrich(m: dict[str, Any]) -> None:
            ticker = m.get("ticker")
            # `created_at` from Postgres is the market start; `resolution_at`
            # is the planned end. We use resolved_at if present, falling
            # back to resolution_at.
            start_ts = m.get("created_at")
            end_ts = m.get("resolved_at") or m.get("resolution_at")
            if not (ticker and start_ts and end_ts):
                return
            async with sem:
                start_price, end_price = await asyncio.gather(
                    _underlying_price_at(ch, ticker, start_ts),
                    _underlying_price_at(ch, ticker, end_ts),
                )
            m["underlying_start"] = start_price
            m["underlying_end"] = end_price
            if start_price and end_price and start_price > 0:
                m["underlying_delta_pct"] = (
                    (end_price - start_price) / start_price * 100.0
                )
            else:
                m["underlying_delta_pct"] = None

        await asyncio.gather(*[_enrich(m) for m in markets])

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


@app.get("/v1/polymarket/live-board")
async def get_polymarket_live_board(
    request: Request,
    ticker: str = Query(..., examples=["BTC", "ETH", "SOL"]),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Single-shot dashboard payload for the Live Terminal page.

    For each event_type (5m/15m/1h/4h/daily_up_down) returns the
    currently-trading market for the given ticker — defined as
    `is_active AND resolution_at > now()`, ordered by soonest
    resolution — together with its latest orderbook snapshot.

    The Next.js dashboard polls this every 5 s.  One call replaces
    what would otherwise be ~5 separate `/v1/markets/{id}/orderbook`
    fetches per refresh.
    """
    import orjson

    pool = request.app.state.pg
    ch = request.app.state.ch

    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (e.event_type)
               m.market_id, e.polymarket_slug, e.event_type, e.question,
               m.outcome, e.resolution_at
          FROM markets m JOIN events e ON e.event_id = m.event_id
         WHERE e.ticker = $1
           AND m.is_active = TRUE
           AND e.resolution_at IS NOT NULL
           AND e.resolution_at > NOW()
         ORDER BY e.event_type, e.resolution_at ASC
        """,
        ticker.upper(),
    )
    if not rows:
        return {"ticker": ticker.upper(), "boards": []}

    boards: list[dict[str, Any]] = []

    for row in rows:
        market_id = row["market_id"]
        snap = await ch.query(
            """
            SELECT ts, yes_bids, yes_asks, no_bids, no_asks,
                   mid_yes, spread_yes, underlying_price
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
             ORDER BY ts DESC LIMIT 1
            """,
            parameters={"market_id": market_id},
        )
        if not snap.result_rows:
            continue

        ts_, yb, ya, nb, na, mid_yes, spread, underlying = snap.result_rows[0]

        # "Price to beat": the BTC spot at the moment we first saw this
        # market trade. For Polymarket's "Up or Down" markets, the
        # resolution criterion is BTC at resolution_at vs BTC at market
        # open — and our first recorded snapshot is the closest proxy
        # we have to "market open" without parsing the slug or relying
        # on raw Gamma metadata. Worth ~30 ms / call on ClickHouse;
        # cached implicitly by the primary key (market_id, ts).
        first_snap = await ch.query(
            """
            SELECT underlying_price
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
               AND underlying_price IS NOT NULL
             ORDER BY ts ASC LIMIT 1
            """,
            parameters={"market_id": market_id},
        )
        price_to_beat: float | None = None
        if first_snap.result_rows and first_snap.result_rows[0][0] is not None:
            price_to_beat = float(first_snap.result_rows[0][0])

        # Recent mid-yes series for the in-card sparkline. 5-min window,
        # bucketed at 5 s → up to 60 data points. NULL-mid buckets are
        # dropped server-side so the UI doesn't have to filter — they
        # happen when the book is one-sided near resolution.
        series_q = await ch.query(
            """
            SELECT toStartOfInterval(ts, INTERVAL 5 SECOND) AS bucket,
                   avg(mid_yes) AS avg_mid
              FROM orderbook_snapshots
             WHERE market_id = {market_id:String}
               AND ts > now() - INTERVAL 5 MINUTE
               AND mid_yes IS NOT NULL
             GROUP BY bucket
             ORDER BY bucket
            """,
            parameters={"market_id": market_id},
        )
        recent_mid_yes = [
            {"ts": r[0].isoformat(), "mid_yes": float(r[1])}
            for r in series_q.result_rows
        ]

        # Last trade prices (per side, last 60 s). Falls back to None
        # when the market has been quiet — UI then uses mid as headline.
        # Why 60 s: longer windows let a stale outlier (e.g. one-off
        # 5¢ probe trade) hijack the headline; 60 s tracks the "current"
        # tape closely.
        trade_rows = await ch.query(
            """
            SELECT side, price, ts
              FROM trades
             WHERE market_id = {market_id:String}
               AND ts > now() - INTERVAL 60 SECOND
             ORDER BY ts DESC LIMIT 20
            """,
            parameters={"market_id": market_id},
        )
        last_trade_yes_price: float | None = None
        last_trade_no_price: float | None = None
        last_trade_ts: Any = None
        for tr in trade_rows.result_rows:
            tside, tprice, tts = tr[0], float(tr[1]), tr[2]
            if tside.endswith("_YES") and last_trade_yes_price is None:
                last_trade_yes_price = tprice
            elif tside.endswith("_NO") and last_trade_no_price is None:
                last_trade_no_price = tprice
            if last_trade_ts is None:
                last_trade_ts = tts
            if last_trade_yes_price is not None and last_trade_no_price is not None:
                break

        def _safe_json(raw: Any) -> list[dict[str, Any]]:
            try:
                return orjson.loads(raw)
            except (orjson.JSONDecodeError, TypeError):
                return []

        yes_bids = _safe_json(yb)
        yes_asks = _safe_json(ya)
        no_bids = _safe_json(nb)
        no_asks = _safe_json(na)

        best_no_bid = no_bids[0]["price"] if no_bids else None
        best_no_ask = no_asks[0]["price"] if no_asks else None
        mid_no = (
            (best_no_bid + best_no_ask) / 2
            if best_no_bid is not None and best_no_ask is not None
            else None
        )
        spread_no = (
            best_no_ask - best_no_bid
            if best_no_bid is not None and best_no_ask is not None
            else None
        )

        resolution_at = row["resolution_at"]
        time_to_resolution_s = (
            int((resolution_at - ts_.replace(tzinfo=resolution_at.tzinfo)).total_seconds())
            if resolution_at is not None
            else None
        )

        best_yes_bid = yes_bids[0]["price"] if yes_bids else None
        best_yes_ask = yes_asks[0]["price"] if yes_asks else None

        boards.append({
            "event_type": row["event_type"],
            "market_id": market_id,
            "slug": row["polymarket_slug"],
            "question": row["question"],
            "outcome": row["outcome"],
            "resolution_at": resolution_at.isoformat() if resolution_at else None,
            "time_to_resolution_s": time_to_resolution_s,
            "snapshot_ts": ts_.isoformat(),
            "mid_yes": float(mid_yes) if mid_yes is not None else None,
            "mid_no": mid_no,
            "best_yes_bid": best_yes_bid,
            "best_yes_ask": best_yes_ask,
            "best_no_bid": best_no_bid,
            "best_no_ask": best_no_ask,
            "spread_yes": float(spread) if spread is not None else None,
            "spread_no": spread_no,
            "last_trade_yes_price": last_trade_yes_price,
            "last_trade_no_price": last_trade_no_price,
            "last_trade_ts": last_trade_ts.isoformat() if last_trade_ts else None,
            "underlying_price": float(underlying) if underlying is not None else None,
            "price_to_beat": price_to_beat,
            "recent_mid_yes": recent_mid_yes,
            "orderbook_up": {"bids": yes_bids, "asks": yes_asks},
            "orderbook_down": {"bids": no_bids, "asks": no_asks},
        })

    return {
        "ticker": ticker.upper(),
        "as_of": datetime.utcnow().isoformat() + "Z",
        "boards": boards,
    }


@app.get("/v1/polymarket/recent-trades")
async def get_polymarket_recent_trades(
    request: Request,
    ticker: str = Query(..., examples=["BTC", "ETH", "SOL"]),
    event_type: str | None = Query(
        default=None,
        examples=["5m", "15m", "1h", "4h", "daily_up_down"],
        description="Restrict to one timeframe.",
    ),
    limit: int = Query(default=50, le=500),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Most recent N Polymarket trades for a ticker, joined with market
    metadata. Powers the Live Terminal "Recent Trades" panel.

    `side` is the raw label written by the WS client:
      BUY_YES / SELL_YES / BUY_NO / SELL_NO
    and `outcome` is the market's `Up` or `Down` label, so the UI can
    render "BUY UP" / "SELL DOWN" / etc. however it likes.

    Window is fixed to the last hour — anything older is irrelevant
    for a live dashboard; the historical lookup is `/v1/markets/{id}/volume`.
    """
    pool = request.app.state.pg
    ch = request.app.state.ch

    args: list[Any] = [ticker.upper()]
    sql = """
        SELECT m.market_id, e.polymarket_slug, e.event_type, m.outcome
          FROM markets m JOIN events e ON e.event_id = m.event_id
         WHERE e.ticker = $1 AND m.is_active = TRUE
    """
    if event_type:
        sql += " AND e.event_type = $2"
        args.append(event_type)
    rows = await pool.fetch(sql, *args)
    if not rows:
        return {
            "ticker": ticker.upper(),
            "event_type": event_type,
            "count": 0,
            "trades": [],
        }
    market_map: dict[str, dict[str, Any]] = {r["market_id"]: dict(r) for r in rows}

    result = await ch.query(
        """
        SELECT trade_id, market_id, ts, side, price, size
          FROM trades
         WHERE market_id IN {ids:Array(String)}
           AND ts > now() - INTERVAL 1 HOUR
         ORDER BY ts DESC
         LIMIT {limit:UInt32}
        """,
        parameters={"ids": list(market_map.keys()), "limit": limit},
    )

    trades: list[dict[str, Any]] = []
    for r in result.result_rows:
        market_id = r[1]
        meta = market_map.get(market_id)
        if meta is None:
            continue
        price = float(r[4])
        size = float(r[5])
        trades.append({
            "trade_id": r[0],
            "market_id": market_id,
            "slug": meta["polymarket_slug"],
            "event_type": meta["event_type"],
            "outcome": meta["outcome"],
            "ts": r[2].isoformat(),
            "side": r[3],
            "price": price,
            "size": size,
            "notional_usd": price * size,
        })

    return {
        "ticker": ticker.upper(),
        "event_type": event_type,
        "limit": limit,
        "count": len(trades),
        "trades": trades,
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


# ---------------------------------------------------------------------------
# Arb endpoint — live Polymarket × Binance mispricing scanner
# ---------------------------------------------------------------------------
#
# Single-shot snapshot of "what mispricings exist right now?". The UI
# polls this every 3-5 s; designed to be cheap enough to call that often
# without overloading ClickHouse (typical call ≤ 500 ms, mostly the
# Polymarket snapshot queries — one per active market). For users who
# want push-style updates they can use the existing /v1/stream WebSocket
# alongside this and re-fetch arb when a new snapshot lands.

@app.get("/v1/arb/live")
async def get_arb_live(
    request: Request,
    min_edge_pp: float = Query(
        default=0.04,
        ge=0.0,
        le=0.5,
        description="Minimum |market_yes − model_yes| in probability points. "
                    "Below this, the mismatch is dominated by fees and noise. "
                    "0.04 = 4pp is the practical floor.",
    ),
    vol_window_sec: int = Query(
        default=600,
        ge=60,
        le=3600,
        description="Realised-vol estimation window in seconds. Shorter = "
                    "more responsive to current regime; longer = less noisy.",
    ),
    tickers: str = Query(
        default="BTC,ETH,SOL",
        description="Comma-separated tickers to scan.",
    ),
    event_types: str = Query(
        default="5m,15m,1h,4h,daily_up_down",
        description="Comma-separated Polymarket event types to scan.",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    _: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Real-time arbitrage opportunities between Polymarket binary
    markets and Binance spot.

    See backtest/arb_engine.py for the math:
      - Polymarket YES mid → market's implied probability
      - Binance spot + 5s-bar realised σ → log-normal model probability
      - Mismatch + EV after fees + spread filter → tradeable rows

    Returns rows sorted by expected net PnL per share (highest first).
    Empty list when no edges clear the filters — that's normal during
    quiet markets or when bots are actively repricing.
    """
    ch = request.app.state.ch
    pg = request.app.state.pg

    ticker_list = tuple(t.strip().upper() for t in tickers.split(",") if t.strip())
    event_list = tuple(e.strip() for e in event_types.split(",") if e.strip())
    if not ticker_list or not event_list:
        raise HTTPException(status_code=400, detail="tickers and event_types must be non-empty")

    opps = await find_live_opportunities(
        ch,
        pg,
        tickers=ticker_list,
        event_types=event_list,
        min_edge_pp=min_edge_pp,
        vol_window_sec=vol_window_sec,
    )

    return {
        "as_of": datetime.now(tz=timezone.utc).isoformat(),
        "count": len(opps),
        "tickers": list(ticker_list),
        "event_types": list(event_list),
        "min_edge_pp": min_edge_pp,
        # Render dataclass → dict for JSON. dataclasses.asdict would also
        # work but does a recursive deepcopy we don't need; flat dict is
        # cheaper and gives us explicit control over field naming.
        "opportunities": [
            {
                "market_id": o.market_id,
                "ticker": o.ticker,
                "event_type": o.event_type,
                "question": o.question,
                "resolution_at": o.resolution_at.isoformat(),
                "seconds_to_resolution": o.seconds_to_resolution,
                "underlying_now": o.underlying_now,
                "strike_price": o.strike_price,
                "log_diff": o.log_diff,
                "sigma_annual": o.sigma_annual,
                "sigma_tau": o.sigma_tau,
                "market_yes_mid": o.market_yes_mid,
                "model_yes_prob": o.model_yes_prob,
                "mismatch_mid": o.mismatch_mid,
                "yes_bid": o.yes_bid,
                "yes_ask": o.yes_ask,
                "no_bid": o.no_bid,
                "no_ask": o.no_ask,
                "fill_price": o.fill_price,
                "fill_spread": o.fill_spread,
                "direction": o.direction,
                "edge_per_share": o.edge_per_share,
                "est_fee_per_share": o.est_fee_per_share,
                "expected_pnl_per_share": o.expected_pnl_per_share,
                "tier": o.tier,
            }
            for o in opps[:limit]
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


@app.websocket("/v1/stream")
async def stream_snapshots(websocket: WebSocket) -> None:
    """Live orderbook snapshot stream — push every new row that hits
    ClickHouse, filtered by the user's `ticker` and `event_type`.

    Why polling-over-WS instead of true push: keeps the API process
    decoupled from the collector. Collector writes to ClickHouse; we
    poll for new rows every ~1 s. Latency is ~1-3 s end-to-end, which
    matches what the underlying Polymarket WS rate-limits anyway (8
    snapshots/sec/market). A future Redis pub/sub upgrade can drop
    this to <100 ms when users actually need it.

    Auth: `?api_key=...` query param (websockets don't reliably carry
    custom Authorization headers across proxies; query is the
    standard escape hatch).  The internal-secret bypass (`?token=...`
    matching INTERNAL_API_SECRET) also works — used by the dashboard
    Live Terminal upgrade path.

    Filters:
      ticker      BTC | ETH | SOL  (required)
      event_type  5m | 15m | 1h | 4h | daily_up_down  (optional)
    """
    # Accept early so we can negotiate auth via close codes.
    await websocket.accept()

    qp = dict(websocket.query_params)
    ticker = (qp.get("ticker") or "").upper().strip()
    event_type = qp.get("event_type")
    api_key = qp.get("api_key")
    internal_token = qp.get("token")

    if ticker not in ("BTC", "ETH", "SOL"):
        await websocket.close(code=1008, reason="ticker must be BTC/ETH/SOL")
        return

    pool: asyncpg.Pool = websocket.app.state.pg
    ch: AsyncClient = websocket.app.state.ch

    # Auth — either valid API key OR matching internal secret.
    settings = get_settings()
    authed = False
    api_key_id: Any = None
    if internal_token and internal_token == settings.internal_api_secret:
        authed = True
        api_key_id = "__internal__"
    elif api_key:
        rec = await lookup_api_key(pool, api_key)
        if rec is not None:
            authed = True
            api_key_id = rec["api_key_id"]
    if not authed:
        await websocket.close(code=1008, reason="missing or invalid api_key")
        return

    # Resolve the active market_ids matching the filter once at
    # subscription start. Refreshed every 60 s so newly-created
    # markets join the stream organically.
    async def load_market_ids() -> list[str]:
        sql = """
            SELECT m.market_id FROM markets m
              JOIN events  e ON e.event_id = m.event_id
             WHERE e.ticker = $1 AND m.is_active = TRUE
        """
        args: list[Any] = [ticker]
        if event_type:
            sql += " AND e.event_type = $2"
            args.append(event_type)
        rows = await pool.fetch(sql, *args)
        return [r["market_id"] for r in rows]

    market_ids = await load_market_ids()
    if not market_ids:
        await websocket.send_json({
            "type": "ready",
            "warning": "no active markets match the filter — stream will fire when new ones open",
        })
    else:
        await websocket.send_json({
            "type": "ready",
            "ticker": ticker,
            "event_type": event_type,
            "subscribed_market_ids": market_ids[:10],
            "n_subscribed": len(market_ids),
        })

    # Cursor starts at "now" — clients can ask for backfill via REST.
    last_ts = datetime.utcnow()
    last_market_refresh = last_ts

    try:
        while True:
            # Refresh the active-markets set every 60 s.
            if (datetime.utcnow() - last_market_refresh).total_seconds() > 60:
                market_ids = await load_market_ids()
                last_market_refresh = datetime.utcnow()
                if not market_ids:
                    await asyncio.sleep(1.0)
                    continue

            if market_ids:
                result = await ch.query(
                    """
                    SELECT market_id, ts, mid_yes, spread_yes,
                           best_yes_bid, best_yes_ask,
                           underlying_price
                      FROM orderbook_snapshots
                     WHERE market_id IN {ids:Array(String)}
                       AND ts > {since:DateTime64(3)}
                     ORDER BY ts ASC
                     LIMIT 500
                    """,
                    parameters={"ids": market_ids, "since": last_ts},
                )
                if result.result_rows:
                    payload = []
                    for r in result.result_rows:
                        payload.append({
                            "market_id": r[0],
                            "ts": r[1].isoformat(),
                            "mid_yes": float(r[2]) if r[2] is not None else None,
                            "spread_yes": float(r[3]) if r[3] is not None else None,
                            "best_yes_bid": float(r[4]) if r[4] is not None else None,
                            "best_yes_ask": float(r[5]) if r[5] is not None else None,
                            "underlying_price": float(r[6]) if r[6] is not None else None,
                        })
                        if r[1] > last_ts:
                            last_ts = r[1]
                    await websocket.send_json({
                        "type": "snapshots",
                        "count": len(payload),
                        "rows": payload,
                    })

            # Heartbeat — keep proxies and tcp middleboxes happy.
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        # Client closed cleanly — nothing to do.
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("ws_stream_error", error=str(exc), api_key_id=str(api_key_id))
        try:
            await websocket.close(code=1011, reason=f"server error: {exc}")
        except Exception:  # noqa: BLE001
            pass


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


# ---------------------------------------------------------------------------
# Parameter sweep — POST /v1/backtest/sweep
# ---------------------------------------------------------------------------
#
# Unlike single backtest jobs (which run one strategy), a sweep runs a
# grid of N strategies and returns a 2D heatmap of summary stats. See
# backtest/sweep.py for the implementation details (the load-once / replay-
# many architecture that makes large grids feasible).
#
# Result shape is different from single backtest, so we tag the JobStore
# payload with `kind="sweep"` and the frontend dispatches on it.


class SweepAxis(BaseModel):
    """One axis of the parameter grid."""
    param: str = Field(
        ...,
        description=(
            "Which key in the base strategy spec to override on this axis. "
            "E.g. 'threshold', 'size_usd', 'lookback'. Must be a numeric "
            "parameter of the chosen strategy_type."
        ),
        examples=["threshold", "size_usd"],
    )
    start: float = Field(..., description="First value on this axis.")
    end: float = Field(..., description="Last value (inclusive).")
    steps: int = Field(
        default=5, ge=1, le=100,
        description="Number of evenly-spaced points between start and end.",
    )


class SweepRequest(BaseModel):
    strategy: dict[str, Any] = Field(
        ...,
        description=(
            "Base strategy spec (same shape as /v1/backtest). The "
            "x_axis (and y_axis if provided) override the named params; "
            "everything else stays fixed across every cell."
        ),
    )
    x_axis: SweepAxis
    y_axis: SweepAxis | None = None
    event_type: str | None = None
    ticker: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    market_limit: int = Field(default=50, le=500)


@app.post("/v1/backtest/sweep")
async def post_backtest_sweep(
    request: Request,
    response: Response,
    body: SweepRequest,
    auth: dict = Depends(authed_key),
) -> dict[str, Any]:
    """Submit a parameter-sweep job. Same async pattern as /v1/backtest —
    returns 202 + job_id, client polls GET /v1/backtest/{job_id}.

    Tier gates checked:
      * `market_limit` ≤ tier's max_market_limit (same as single backtest)
      * Total grid cell count ≤ tier's max_sweep_cells
      * Per-key in-flight cap (sweeps count against the same
        concurrent_backtests budget as single backtests)
    """
    tier_limits: TierLimits = auth["tier_limits"]

    # Tier gate 1: market_limit
    if body.market_limit > tier_limits.max_market_limit:
        raise HTTPException(
            status_code=402,
            detail=(
                f"{tier_limits.display_name} tier allows market_limit up to "
                f"{tier_limits.max_market_limit}; you requested {body.market_limit}."
            ),
        )

    # Tier gate 2: total grid size
    y_steps = body.y_axis.steps if body.y_axis else 1
    n_cells = body.x_axis.steps * y_steps
    if n_cells > tier_limits.max_sweep_cells:
        raise HTTPException(
            status_code=402,
            detail=(
                f"{tier_limits.display_name} tier allows up to "
                f"{tier_limits.max_sweep_cells} sweep cells; you requested "
                f"{body.x_axis.steps}×{y_steps}={n_cells}. Reduce steps or upgrade."
            ),
        )

    # Tier gate 3: per-key concurrency (shared budget with single backtests)
    api_key_id = str(auth["api_key_id"])
    job_store: JobStore = request.app.state.job_store
    recent = await job_store.list_for_user(api_key_id, limit=tier_limits.concurrent_backtests + 5)
    in_flight = sum(1 for j in recent if j.status in (JobStatus.QUEUED, JobStatus.RUNNING))
    if in_flight >= tier_limits.concurrent_backtests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"{tier_limits.display_name} tier allows "
                f"{tier_limits.concurrent_backtests} concurrent backtest/sweep "
                f"jobs; you have {in_flight} in flight."
            ),
            headers={"Retry-After": "5"},
        )

    params = body.model_dump(mode="json")
    record = await job_store.create(api_key_id, params)

    arq: ArqRedis = request.app.state.arq
    try:
        await arq.enqueue_job(
            "run_sweep_job",
            record.job_id,
            body.strategy,
            body.x_axis.model_dump(),
            body.y_axis.model_dump() if body.y_axis else None,
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
