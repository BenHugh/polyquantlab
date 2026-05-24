"""Standalone healthcheck HTTP endpoint.

Run alongside the collector. Returns 200 if the latest snapshot is recent,
500 otherwise. Wire to Uptime Robot / Cloudflare healthchecks.

  python -m collector.health
"""

from __future__ import annotations

import asyncio
from typing import Any

from aiohttp import web

from collector.config import get_settings
from collector.db import make_clickhouse
from collector.logging_setup import get_logger, setup_logging

log = get_logger(__name__)

MAX_LAG_SECONDS = 120  # alert if no snapshot in this many seconds


async def check(ch_client: Any) -> tuple[bool, dict[str, Any]]:
    result = await ch_client.query(
        "SELECT max(ts) AS latest, count() AS total "
        "FROM orderbook_snapshots WHERE ts > now() - INTERVAL 1 HOUR"
    )
    row = result.result_rows[0]
    latest, total = row[0], row[1]
    lag = (
        (asyncio.get_event_loop().time() - latest.timestamp())
        if latest is not None
        else None
    )
    healthy = lag is not None and lag <= MAX_LAG_SECONDS and total > 0
    return healthy, {
        "latest_snapshot": latest.isoformat() if latest else None,
        "snapshots_last_hour": total,
        "lag_seconds": lag,
        "max_lag_seconds": MAX_LAG_SECONDS,
    }


async def handle(request: web.Request) -> web.Response:
    ch = request.app["clickhouse"]
    try:
        healthy, info = await check(ch)
    except Exception as exc:
        return web.json_response({"healthy": False, "error": str(exc)}, status=500)
    return web.json_response({"healthy": healthy, **info}, status=200 if healthy else 503)


async def main() -> None:
    setup_logging()
    settings = get_settings()
    ch = await make_clickhouse(settings)

    app = web.Application()
    app["clickhouse"] = ch
    app.router.add_get("/health", handle)
    app.router.add_get("/", handle)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    log.info("health_server_started", port=8080)
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
