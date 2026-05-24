"""Bybit V5 linear futures ticker stream.

Substitute for Binance futures, which is geo-blocked from most data-center
IP ranges (including Hetzner DE). Bybit V5 has no such restriction on its
public market data feeds.

Endpoint:
  wss://stream.bybit.com/v5/public/linear

Subscription:
  {"op": "subscribe", "args": ["tickers.BTCUSDT", "tickers.ETHUSDT", "tickers.SOLUSDT"]}

Message format:
  Snapshot (first message per symbol, full state):
    {"topic": "tickers.BTCUSDT", "type": "snapshot",
     "data": {"symbol": "BTCUSDT", "lastPrice": "75000.50",
              "markPrice": "75001.20", "indexPrice": "74999.80",
              "fundingRate": "0.0001", ...}, "ts": 1700000000000}

  Delta (incremental updates, only changed fields):
    {"topic": "tickers.BTCUSDT", "type": "delta",
     "data": {"symbol": "BTCUSDT", "markPrice": "75001.50"},
     "ts": 1700000001000}

We persist a row only when markPrice is present in the message (snapshot or
delta). Other deltas (lastPrice / fundingRate / openInterest only) are
ignored — they're useful but not what we promise to deliver as the
"underlying futures price" series.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any

import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from collector.config import Settings
from collector.db import insert_underlying_prices
from collector.logging_setup import get_logger

log = get_logger(__name__)


BYBIT_SYMBOLS: dict[str, str] = {
    "BTCUSDT": "BTC",
    "ETHUSDT": "ETH",
    "SOLUSDT": "SOL",
}


class BybitWS:
    def __init__(self, settings: Settings, ch_client: Any) -> None:
        self.settings = settings
        self.ch_client = ch_client

        configured = {t.upper() for t in settings.collector_tickers}
        self.symbols = [
            sym for sym, ticker in BYBIT_SYMBOLS.items() if ticker in configured
        ]
        self.write_buffer: list[tuple[Any, ...]] = []

    # -- flush ----------------------------------------------------------

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(10.0)
            if self.write_buffer:
                rows = self.write_buffer
                self.write_buffer = []
                try:
                    await insert_underlying_prices(self.ch_client, rows)
                except Exception as exc:
                    log.error("bybit_insert_failed", error=str(exc), rows=len(rows))

    # -- message handling ----------------------------------------------

    def _handle_ticker(self, payload: dict[str, Any]) -> None:
        data = payload.get("data")
        if not isinstance(data, dict):
            return

        symbol = data.get("symbol")
        ticker = BYBIT_SYMBOLS.get(symbol, "")
        if not ticker:
            return

        # Only emit a row if markPrice is present in this update. Delta
        # messages without markPrice are skipped (Bybit pushes deltas for
        # any changed field, but we only care about markPrice for the
        # "futures price" series).
        mark_raw = data.get("markPrice")
        if mark_raw is None:
            return
        try:
            price = float(mark_raw)
        except (TypeError, ValueError):
            return

        ts_ms = payload.get("ts") or 0
        try:
            ts_ms = int(ts_ms)
        except (TypeError, ValueError):
            ts_ms = 0
        ts = (
            datetime.fromtimestamp(ts_ms / 1000, tz=UTC)
            if ts_ms
            else datetime.now(tz=UTC)
        )

        self.write_buffer.append((ticker, ts, price, None, "bybit_linear"))

    def _route(self, message: dict[str, Any]) -> None:
        # Subscription ack / status messages
        op = message.get("op")
        if op:
            if op == "subscribe":
                if message.get("success") is not True:
                    log.warning("bybit_subscribe_failed", data=message)
            return

        topic = message.get("topic", "")
        if topic.startswith("tickers."):
            self._handle_ticker(message)

    # -- connect loop --------------------------------------------------

    async def _subscribe(self, ws: ClientConnection) -> None:
        payload = {
            "op": "subscribe",
            "args": [f"tickers.{sym}" for sym in self.symbols],
        }
        await ws.send(orjson.dumps(payload).decode())
        log.info("bybit_subscribed", count=len(self.symbols))

    async def _consume(self, ws: ClientConnection) -> None:
        async for message in ws:
            try:
                payload = orjson.loads(message)
            except orjson.JSONDecodeError:
                continue
            self._route(payload)

    async def run(self) -> None:
        if not self.symbols:
            log.warning("bybit_no_symbols_configured")
            return

        background = [asyncio.create_task(self._flush_loop(), name="bybit_flush")]
        backoff = 1.0
        try:
            while True:
                try:
                    log.info("bybit_ws_connecting", url=self.settings.bybit_ws_linear)
                    async with websockets.connect(
                        self.settings.bybit_ws_linear,
                        ping_interval=20,
                        ping_timeout=20,
                        max_size=4 * 1024 * 1024,
                    ) as ws:
                        log.info("bybit_ws_connected")
                        await self._subscribe(ws)
                        backoff = 1.0
                        await self._consume(ws)
                except (
                    websockets.ConnectionClosed,
                    websockets.WebSocketException,
                    OSError,
                ) as exc:
                    log.warning(
                        "bybit_disconnected", error=str(exc), backoff=backoff
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                except Exception as exc:
                    log.error("bybit_loop_failed", error=str(exc))
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
        finally:
            for t in background:
                t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*background, return_exceptions=True)
            # Final flush
            if self.write_buffer:
                try:
                    await insert_underlying_prices(self.ch_client, self.write_buffer)
                except Exception:
                    pass
