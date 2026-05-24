"""ARQ backtest worker.

Runs in a separate systemd service. Pulls jobs off the ARQ queue (Redis),
runs the existing `backtest.engine.run_backtest`, writes the result back
to the JobStore that the API server reads from.

Start with:
    arq worker.backtest_worker.WorkerSettings

Or via systemd (see deploy/05_install_worker.sh).
"""

from __future__ import annotations

import traceback
from datetime import datetime
from typing import Any

from arq.connections import RedisSettings

from api.job_store import JobStore
from backtest.engine import run_backtest
from collector.config import get_settings
from collector.db import make_clickhouse, make_postgres_pool
from collector.logging_setup import get_logger, setup_logging

log = get_logger(__name__)


async def startup(ctx: dict) -> None:
    """Run once when each worker process starts. Long-lived DB clients
    live in `ctx` and are shared across all jobs this worker handles."""
    setup_logging()
    settings = get_settings()
    ctx["settings"] = settings
    ctx["pg"] = await make_postgres_pool(settings)
    ctx["ch"] = await make_clickhouse(settings)
    ctx["job_store"] = JobStore(settings.redis_url)
    log.info("worker_started")


async def shutdown(ctx: dict) -> None:
    await ctx["pg"].close()
    await ctx["ch"].close()
    await ctx["job_store"].close()
    log.info("worker_stopped")


async def run_backtest_job(
    ctx: dict,
    job_id: str,
    strategy_spec: dict[str, Any],
    event_type: str | None,
    ticker: str | None,
    since: str | None,
    until: str | None,
    market_limit: int,
) -> dict[str, Any]:
    """The actual unit of work. Wrapped in mark_running / mark_completed /
    mark_failed so the API server can observe the state transition
    through Redis even though we never return anything over ARQ.

    Datetime params arrive as ISO strings (ARQ serialises with JSON);
    we parse them back here.
    """
    store: JobStore = ctx["job_store"]
    await store.mark_running(job_id)

    def _parse_dt(v: str | None) -> datetime | None:
        return datetime.fromisoformat(v) if v else None

    try:
        result = await run_backtest(
            ch=ctx["ch"],
            pg_pool=ctx["pg"],
            strategy_spec=strategy_spec,
            event_type=event_type,
            ticker=ticker,
            since=_parse_dt(since),
            until=_parse_dt(until),
            market_limit=market_limit,
        )
        payload = result.to_dict()
        await store.mark_completed(job_id, payload)
        log.info(
            "backtest_done",
            job_id=job_id,
            n_trades=len(payload.get("trades", [])),
            pnl=payload.get("total_pnl"),
        )
        return payload
    except Exception as exc:  # noqa: BLE001 — surface anything to caller
        # Keep the trace in the API's reach so devs can diagnose, but
        # truncate so we don't bloat Redis. Real fixes go via logs.
        tb = traceback.format_exc()
        err = f"{type(exc).__name__}: {exc}\n{tb[-1500:]}"
        await store.mark_failed(job_id, err)
        log.error("backtest_failed", job_id=job_id, error=str(exc))
        raise


# ---------------------------------------------------------------------------
# ARQ entry point — `arq worker.backtest_worker.WorkerSettings`
# ---------------------------------------------------------------------------


def _redis_settings_from_url(url: str) -> RedisSettings:
    """Bridge our `redis://host:port/db` config to ARQ's struct form."""
    from urllib.parse import urlparse

    p = urlparse(url)
    return RedisSettings(
        host=p.hostname or "localhost",
        port=p.port or 6379,
        database=int(p.path.lstrip("/") or 0),
        password=p.password,
    )


class WorkerSettings:
    functions = [run_backtest_job]
    on_startup = startup
    on_shutdown = shutdown
    # 6 concurrent jobs per worker process. With ARQ each job is a
    # coroutine sharing the event loop, so even one worker can run 6
    # backtests in parallel as long as they overlap on ClickHouse I/O.
    # If CPU becomes the bottleneck later we add more worker processes
    # (systemd template unit) instead of cranking this higher.
    max_jobs = 6
    job_timeout = 30  # seconds — kill any backtest that runs longer
    keep_result = 0   # we persist results in our own JobStore, not ARQ's
    redis_settings = _redis_settings_from_url(get_settings().redis_url)
