"""Collector entry point — PolyQuantLab (Polymarket crypto data layer).

Six concurrent loops:
  1. Discovery:         poll Gamma every 5 min for active crypto Up/Down events
  2. Polymarket WS:     stream CLOB orderbook + trades (sub-second + price_change)
  3. Binance spot WS:   tick-by-tick prices for the UnderlyingPriceCache +
                         binance_spot rows in underlying_prices
  4. Binance trades WS: aggTrade → 1-minute OHLC + aggressive buy/sell volume
                         (order-flow data, written to binance_spot_trades)
  5. Bybit linear WS:   V5 markPrice for BTC/ETH/SOL — replaces geo-blocked
                         Binance futures
  6. Chainlink oracle:  Polygon RPC poll every 10s for the Chainlink USD
                         aggregators Polymarket references for crypto Up/Down
                         resolution (Phase BC.2 — parity with PolyBackTest)

  python -m collector.main
"""

from __future__ import annotations

import asyncio
import signal

from collector.binance_trades_ws import BinanceTradesWS
from collector.binance_ws import BinanceWS
from collector.bybit_ws import BybitWS
from collector.chainlink_oracle import ChainlinkOracle
from collector.config import get_settings
from collector.db import make_clickhouse, make_postgres_pool
from collector.discovery import run_discovery_forever
from collector.logging_setup import get_logger, setup_logging
from collector.polymarket_ws import PolymarketWS, UnderlyingPriceCache
from collector.reclassify import run_reclassify_forever
from collector.resolution_sync import run_resolution_sync_forever

log = get_logger(__name__)


async def main() -> None:
    setup_logging()
    settings = get_settings()

    log.info(
        "collector_starting",
        worker_id=settings.collector_worker_id,
        tickers=settings.collector_tickers,
    )

    pool = await make_postgres_pool(settings)
    ch = await make_clickhouse(settings)
    price_cache = UnderlyingPriceCache()

    binance = BinanceWS(settings, ch, price_cache)
    binance_trades = BinanceTradesWS(settings, ch)
    bybit = BybitWS(settings, ch)
    chainlink = ChainlinkOracle(settings, ch)
    poly = PolymarketWS(settings, pool, ch, price_cache)

    stop_event = asyncio.Event()

    def _stop(*_: object) -> None:
        log.info("shutdown_signal")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _stop)

    tasks = [
        asyncio.create_task(run_discovery_forever(settings, pool), name="discovery"),
        asyncio.create_task(
            run_resolution_sync_forever(settings, pool), name="resolution_sync"
        ),
        # Hourly self-audit: catches event_type drift after any classifier
        # change. Cheap (~3k row read + tiny UPDATE batch) and protects
        # us from the kind of silent mislabeling we hit with 1h markets.
        # See collector/reclassify.py for rationale.
        asyncio.create_task(
            run_reclassify_forever(pool, interval_s=3600), name="reclassify"
        ),
        asyncio.create_task(binance.run(), name="binance_ws"),
        asyncio.create_task(binance_trades.run(), name="binance_trades_ws"),
        asyncio.create_task(bybit.run(), name="bybit_ws"),
        asyncio.create_task(chainlink.run(), name="chainlink_oracle"),
        asyncio.create_task(poly.run(), name="polymarket_ws"),
    ]
    stop_task = asyncio.create_task(stop_event.wait(), name="stop")

    try:
        done, _pending = await asyncio.wait(
            [*tasks, stop_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in done:
            if t.get_name() != "stop" and t.exception():
                log.error("task_crashed", name=t.get_name(), error=str(t.exception()))
    finally:
        log.info("shutting_down")
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()
        await ch.close()
        log.info("shutdown_complete")


if __name__ == "__main__":
    asyncio.run(main())
