"""Binance WebSocket client.

Matches what PolyBackTest uses as the underlying price source. Two streams:

  Spot trades:
    wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade
    Message: {"stream": "btcusdt@trade",
              "data": {"e": "trade", "s": "BTCUSDT", "p": "75000.00", "q": "0.001",
                       "T": 1700000000000, "t": 12345, "m": false, ...}}

  Futures mark price (1s update frequency):
    wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s/ethusdt@markPrice@1s/solusdt@markPrice@1s
    Message: {"stream": "btcusdt@markPrice@1s",
              "data": {"e": "markPriceUpdate", "s": "BTCUSDT", "p": "75000.00",
                       "T": 1700000000000, ...}}

We write every received message to ClickHouse `underlying_prices` with
`source` = "binance_spot" or "binance_futures", and update the in-memory
UnderlyingPriceCache so the Polymarket WS collector can stamp every orderbook
snapshot with a fresh underlying.

Combined-streams endpoint means one connection per market type (spot vs
futures), not one per symbol — keeps connection count constant.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import UTC, datetime
from typing import Any

import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from collector.config import Settings
from collector.db import insert_underlying_prices
from collector.logging_setup import get_logger
from collector.polymarket_ws import UnderlyingPriceCache

log = get_logger(__name__)


# Symbol → ticker map. Add new symbols here if Polymarket adds them.
BINANCE_SYMBOLS: dict[str, str] = {
    "BTCUSDT": "BTC",
    "ETHUSDT": "ETH",
    "SOLUSDT": "SOL",
}


def _streams_path(symbols: list[str], suffix: str) -> str:
    """Build the combined-streams query path: btcusdt@trade/ethusdt@trade/..."""
    return "/".join(f"{s.lower()}@{suffix}" for s in symbols)


SPOT_BASE = "wss://stream.binance.com:9443/stream?streams="
FUTURES_BASE = "wss://fstream.binance.com/stream?streams="


class BinanceWS:
    def __init__(
        self,
        settings: Settings,
        ch_client: Any,
        price_cache: UnderlyingPriceCache,
    ) -> None:
        self.settings = settings
        self.ch_client = ch_client
        self.price_cache = price_cache

        # Only subscribe to symbols whose ticker appears in collector_tickers
        configured = {t.upper() for t in settings.collector_tickers}
        self.symbols = [
            sym for sym, ticker in BINANCE_SYMBOLS.items() if ticker in configured
        ]
        self.write_buffer: list[tuple[Any, ...]] = []

    # -- flush loop --------------------------------------------------------

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(10.0)
            if self.write_buffer:
                rows = self.write_buffer
                self.write_buffer = []
                try:
                    await insert_underlying_prices(self.ch_client, rows)
                except Exception as exc:
                    log.error("binance_insert_failed", error=str(exc), rows=len(rows))

    # -- message handling --------------------------------------------------

    def _handle_spot_trade(self, data: dict[str, Any]) -> None:
        symbol = data.get("s")
        ticker = BINANCE_SYMBOLS.get(symbol, "")
        if not ticker:
            return
        try:
            price = float(data["p"])
            ts_ms = int(data.get("T") or data.get("E") or 0)
        except (KeyError, TypeError, ValueError):
            return
        ts = (
            datetime.fromtimestamp(ts_ms / 1000, tz=UTC)
            if ts_ms
            else datetime.now(tz=UTC)
        )
        # Cache: prefer spot (it's higher frequency)
        self.price_cache.set(ticker, price, ts.timestamp())
        self.write_buffer.append((ticker, ts, price, None, "binance_spot"))

    def _handle_futures_markprice(self, data: dict[str, Any]) -> None:
        symbol = data.get("s")
        ticker = BINANCE_SYMBOLS.get(symbol, "")
        if not ticker:
            return
        try:
            price = float(data["p"])
            ts_ms = int(data.get("E") or data.get("T") or 0)
        except (KeyError, TypeError, ValueError):
            return
        ts = (
            datetime.fromtimestamp(ts_ms / 1000, tz=UTC)
            if ts_ms
            else datetime.now(tz=UTC)
        )
        # Don't overwrite spot in cache; futures is for the storage row only.
        self.write_buffer.append((ticker, ts, price, None, "binance_futures"))

    def _route(self, stream_kind: str, payload: dict[str, Any]) -> None:
        data = payload.get("data") if "data" in payload else payload
        if not isinstance(data, dict):
            return
        event_type = data.get("e")
        if stream_kind == "spot":
            if event_type == "trade":
                self._handle_spot_trade(data)
        else:  # futures
            if event_type == "markPriceUpdate":
                self._handle_futures_markprice(data)

    # -- connection loops --------------------------------------------------

    async def _run_one(self, stream_kind: str, url: str) -> None:
        backoff = 1.0
        first_message_timeout = 30.0  # if no msg in 30s, treat as geo-blocked
        consecutive_silent_connects = 0
        while True:
            try:
                log.info("binance_ws_connecting", kind=stream_kind)
                async with websockets.connect(
                    url, ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024
                ) as ws:
                    log.info("binance_ws_connected", kind=stream_kind)
                    backoff = 1.0
                    got_message = await self._consume(
                        ws, stream_kind, first_message_timeout
                    )
                if not got_message:
                    consecutive_silent_connects += 1
                    if consecutive_silent_connects >= 2 and stream_kind == "futures":
                        # Binance futures is geo-blocked in some regions (US, JP).
                        # Don't keep reconnecting forever — give up and rely on spot.
                        log.warning(
                            "binance_futures_unreachable_disabling",
                            reason="no messages received from fstream — likely geo-blocked",
                        )
                        return
                else:
                    consecutive_silent_connects = 0
            except (
                websockets.ConnectionClosed,
                websockets.WebSocketException,
                OSError,
            ) as exc:
                log.warning(
                    "binance_disconnected",
                    kind=stream_kind,
                    error=str(exc),
                    backoff=backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
            except Exception as exc:
                log.error("binance_loop_failed", kind=stream_kind, error=str(exc))
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _consume(
        self,
        ws: ClientConnection,
        stream_kind: str,
        first_message_timeout: float,
    ) -> bool:
        """Return True if we received at least one message before the
        connection closed; False otherwise."""
        got_first = False
        try:
            while True:
                if got_first:
                    message = await ws.recv()
                else:
                    message = await asyncio.wait_for(
                        ws.recv(), timeout=first_message_timeout
                    )
                    got_first = True
                try:
                    payload = orjson.loads(message)
                except orjson.JSONDecodeError:
                    continue
                self._route(stream_kind, payload)
        except asyncio.TimeoutError:
            log.warning(
                "binance_no_messages",
                kind=stream_kind,
                timeout=first_message_timeout,
            )
        return got_first

    async def run(self) -> None:
        if not self.symbols:
            log.warning("binance_no_symbols_configured")
            return

        spot_url = SPOT_BASE + _streams_path(self.symbols, "trade")
        # Mark price stream with 1s update frequency. Some symbols also support
        # @markPrice (3s) — we pick 1s for tighter alignment with snapshots.
        futures_url = FUTURES_BASE + _streams_path(self.symbols, "markPrice@1s")

        tasks = [
            asyncio.create_task(self._flush_loop(), name="binance_flush"),
            asyncio.create_task(self._run_one("spot", spot_url), name="binance_spot"),
            asyncio.create_task(
                self._run_one("futures", futures_url), name="binance_futures"
            ),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*tasks, return_exceptions=True)
            # Final flush
            if self.write_buffer:
                try:
                    await insert_underlying_prices(self.ch_client, self.write_buffer)
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# Optional: REST snapshot for bootstrap / gap-fill
# ---------------------------------------------------------------------------


async def fetch_latest_spot_prices(
    settings: Settings,
) -> dict[str, float]:
    """One-shot REST call for current spot prices. Useful at startup
    before WS deliver the first messages."""
    import aiohttp

    symbols = [s for s in BINANCE_SYMBOLS]
    out: dict[str, float] = {}
    url = "https://api.binance.com/api/v3/ticker/price"
    async with aiohttp.ClientSession() as s:
        for sym in symbols:
            try:
                async with s.get(
                    url, params={"symbol": sym}, timeout=aiohttp.ClientTimeout(total=10)
                ) as r:
                    if r.status == 200:
                        data = await r.json()
                        out[BINANCE_SYMBOLS[sym]] = float(data["price"])
            except Exception as exc:
                log.warning("binance_rest_failed", symbol=sym, error=str(exc))
    _ = settings  # currently unused, accept for future configurability
    return out
