"""Binance spot aggTrade collector + 1-minute OHLC aggregation.

This is the "order flow" data source that PolyBackTest exposes as
/v3/{coin}/spot/trades. Each tick the exchange sends an aggTrade event
(one row per executed trade or trade-batch); we accumulate them into
per-minute, per-symbol buckets and flush completed buckets to ClickHouse.

Endpoint:
  wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade

aggTrade message shape:
  {
    "stream": "btcusdt@aggTrade",
    "data": {
      "e": "aggTrade",
      "E": 1700000000000,    # event time
      "s": "BTCUSDT",
      "p": "75000.50",       # price
      "q": "0.001",          # base-currency quantity
      "T": 1700000000000,    # trade time
      "m": true              # is buyer the market maker?
    }
  }

  m == true  → taker is SELLER → aggressive sell
  m == false → taker is BUYER  → aggressive buy

We bucket by trade time `T` (UTC minute start). When the bucket key changes
for a symbol, the completed bucket flushes to ClickHouse. A periodic
fallback flush also runs every 30s in case a symbol stops trading entirely
(rare but real — exchange maintenance windows).
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from collector.config import Settings
from collector.db import insert_binance_spot_trades
from collector.logging_setup import get_logger

log = get_logger(__name__)

BINANCE_TRADE_SYMBOLS: dict[str, str] = {
    "BTCUSDT": "BTC",
    "ETHUSDT": "ETH",
    "SOLUSDT": "SOL",
}

SPOT_STREAM_BASE = "wss://stream.binance.com:9443/stream?streams="
FLUSH_FALLBACK_INTERVAL = 30.0  # seconds — sweep stale buckets even without new trades
FIRST_MESSAGE_TIMEOUT = 30.0


def _streams_path(symbols: list[str]) -> str:
    return "/".join(f"{s.lower()}@aggTrade" for s in symbols)


def _floor_minute(ts_ms: int) -> datetime:
    """Truncate ms-since-epoch to the start of its UTC minute."""
    sec = ts_ms // 1000
    return datetime.fromtimestamp(sec - (sec % 60), tz=UTC)


class _Bucket:
    """In-memory accumulator for one (ticker, minute) bucket."""

    __slots__ = (
        "ticker",
        "bucket_ts",
        "price_open",
        "price_high",
        "price_low",
        "price_close",
        "total_volume",
        "num_trades",
        "aggressive_buy_volume",
        "aggressive_sell_volume",
    )

    def __init__(self, ticker: str, bucket_ts: datetime, first_price: float) -> None:
        self.ticker = ticker
        self.bucket_ts = bucket_ts
        self.price_open = first_price
        self.price_high = first_price
        self.price_low = first_price
        self.price_close = first_price
        self.total_volume = 0.0
        self.num_trades = 0
        self.aggressive_buy_volume = 0.0
        self.aggressive_sell_volume = 0.0

    def add(self, price: float, qty: float, taker_is_buyer: bool) -> None:
        if price > self.price_high:
            self.price_high = price
        if price < self.price_low:
            self.price_low = price
        self.price_close = price
        self.total_volume += qty
        self.num_trades += 1
        if taker_is_buyer:
            self.aggressive_buy_volume += qty
        else:
            self.aggressive_sell_volume += qty

    def to_row(self) -> tuple[Any, ...]:
        return (
            self.ticker,
            self.bucket_ts,
            self.price_open,
            self.price_high,
            self.price_low,
            self.price_close,
            self.total_volume,
            self.num_trades,
            self.aggressive_buy_volume,
            self.aggressive_sell_volume,
        )


class BinanceTradesWS:
    def __init__(self, settings: Settings, ch_client: Any) -> None:
        self.settings = settings
        self.ch_client = ch_client

        configured = {t.upper() for t in settings.collector_tickers}
        self.symbols = [
            sym for sym, ticker in BINANCE_TRADE_SYMBOLS.items() if ticker in configured
        ]
        # Per-ticker live bucket. When the minute rolls over, we flush the
        # old bucket and start a new one.
        self._buckets: dict[str, _Bucket] = {}
        self._flush_queue: list[tuple[Any, ...]] = []

    # -- aggregation ---------------------------------------------------

    def _handle_agg_trade(self, data: dict[str, Any]) -> None:
        symbol = data.get("s")
        ticker = BINANCE_TRADE_SYMBOLS.get(symbol, "")
        if not ticker:
            return
        try:
            price = float(data["p"])
            qty = float(data["q"])
            trade_time = int(data.get("T") or data.get("E") or 0)
        except (KeyError, TypeError, ValueError):
            return
        if trade_time == 0:
            return
        taker_is_buyer = not bool(data.get("m"))  # m==True → buyer is maker → taker sells
        bucket_ts = _floor_minute(trade_time)

        bucket = self._buckets.get(ticker)
        if bucket is None or bucket.bucket_ts != bucket_ts:
            # Bucket transition (or first ever): finalise the old one
            if bucket is not None:
                self._flush_queue.append(bucket.to_row())
            self._buckets[ticker] = _Bucket(ticker, bucket_ts, price)
            bucket = self._buckets[ticker]

        bucket.add(price, qty, taker_is_buyer)

    def _flush_stale(self) -> None:
        """If wall-clock has moved past a bucket's minute, finalise it.

        This catches the rare case where a symbol stops trading entirely
        (no events for >60 s); without this the last bucket would never
        flush until the next trade arrives.
        """
        now_minute = _floor_minute(int(datetime.now(tz=UTC).timestamp() * 1000))
        for ticker, bucket in list(self._buckets.items()):
            if bucket.bucket_ts < now_minute:
                self._flush_queue.append(bucket.to_row())
                del self._buckets[ticker]

    # -- flush ---------------------------------------------------------

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_FALLBACK_INTERVAL)
            self._flush_stale()
            if self._flush_queue:
                rows = self._flush_queue
                self._flush_queue = []
                try:
                    await insert_binance_spot_trades(self.ch_client, rows)
                except Exception as exc:
                    log.error(
                        "binance_trades_insert_failed",
                        error=str(exc),
                        rows=len(rows),
                    )

    # -- connect loop --------------------------------------------------

    async def _consume(self, ws: ClientConnection) -> bool:
        """Read messages until disconnect. Returns True if at least one
        message was received (for futures-style geo-block detection — not
        relevant for Binance spot, which works from Hetzner)."""
        got_first = False
        try:
            while True:
                if got_first:
                    message = await ws.recv()
                else:
                    message = await asyncio.wait_for(
                        ws.recv(), timeout=FIRST_MESSAGE_TIMEOUT
                    )
                    got_first = True
                try:
                    payload = orjson.loads(message)
                except orjson.JSONDecodeError:
                    continue
                data = payload.get("data") if "data" in payload else payload
                if isinstance(data, dict) and data.get("e") == "aggTrade":
                    self._handle_agg_trade(data)
        except asyncio.TimeoutError:
            log.warning("binance_trades_no_messages", timeout=FIRST_MESSAGE_TIMEOUT)
        return got_first

    async def run(self) -> None:
        if not self.symbols:
            log.warning("binance_trades_no_symbols_configured")
            return

        url = SPOT_STREAM_BASE + _streams_path(self.symbols)
        background = [
            asyncio.create_task(self._flush_loop(), name="binance_trades_flush"),
        ]
        backoff = 1.0
        try:
            while True:
                try:
                    log.info("binance_trades_ws_connecting", url=url)
                    async with websockets.connect(
                        url,
                        ping_interval=20,
                        ping_timeout=20,
                        max_size=4 * 1024 * 1024,
                    ) as ws:
                        log.info("binance_trades_ws_connected", symbols=self.symbols)
                        backoff = 1.0
                        await self._consume(ws)
                except (
                    websockets.ConnectionClosed,
                    websockets.WebSocketException,
                    OSError,
                ) as exc:
                    log.warning(
                        "binance_trades_disconnected",
                        error=str(exc),
                        backoff=backoff,
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                except Exception as exc:
                    log.error("binance_trades_loop_failed", error=str(exc))
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
        finally:
            for t in background:
                t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*background, return_exceptions=True)
            # Final flush of any live buckets (close them out)
            for bucket in self._buckets.values():
                self._flush_queue.append(bucket.to_row())
            if self._flush_queue:
                try:
                    await insert_binance_spot_trades(self.ch_client, self._flush_queue)
                except Exception:
                    pass
