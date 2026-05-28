"""Chainlink price oracle collector.

Polymarket uses Chainlink price feeds (on Polygon) as one of its
reference sources for crypto Up/Down market resolution. PolyBackTest
has shipped Chainlink parity since Feb 2026 — we've been blind to it.

We poll Polygon RPC every ~10s for three USD-pair aggregators:
  BTC / USD: 0xc907E116054Ad103354f2D350FD2514433D57F6f
  ETH / USD: 0xF9680D99D6C9589e2a93a78A04A279e509205945
  SOL / USD: 0x10C8264C0935b3B9870013e057f330Ff3e9C56dC

`latestRoundData()` returns (roundId, answer, startedAt, updatedAt,
answeredInRound). We use:
  - `answer` (int256, 8 decimals — Chainlink USD convention)
  - `updatedAt` (uint256, unix seconds) — when the aggregator last
    posted; we write this as `ts`, NOT poll time.

Writes go to `underlying_prices` with source='chainlink' so the arb
engine + Strategy Builder can later cross-check Binance vs Chainlink
in real time (Phase BC.4 multi-oracle conditions depend on this).

Why httpx, not web3.py? `eth_call` is just a JSON-RPC POST with a
4-byte selector. Dropping web3.py saves ~10MB of transitive deps
(eth-abi, eth-hash, pycryptodome, ...) and a real chunk of startup.

Polling cadence: 10s. Chainlink heartbeats ~once / 30s when the
price hasn't moved enough to trigger a deviation update — polling
faster than that just sees the same updatedAt repeatedly.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any

import httpx

from collector.config import Settings
from collector.db import insert_underlying_prices
from collector.logging_setup import get_logger

log = get_logger(__name__)


# Public Polygon RPCs (PublicNode primary, dRPC fallback). The
# "official" polygon-rpc.com now requires an API key (returns 401),
# so we use community-run nodes. Both confirmed returning identical
# round IDs in our setup tests, so they're sourced from real
# Polygon validators (no man-in-the-middle risk).
# At 3 calls / 10s = 18/min we're well under their public limits.
DEFAULT_RPC_URLS: tuple[str, ...] = (
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
)

# Canonical USD-pair aggregator proxies on Polygon mainnet.
# Verified via https://data.chain.link/feeds (Polygon network).
AGGREGATORS: dict[str, str] = {
    "BTC": "0xc907E116054Ad103354f2D350FD2514433D57F6f",
    "ETH": "0xF9680D99D6C9589e2a93a78A04A279e509205945",
    "SOL": "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC",
}

# `latestRoundData()` 4-byte selector — keccak256(sig)[:4]
LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c"

POLL_INTERVAL_SEC = 10
FLUSH_INTERVAL_SEC = 30  # same cadence as Bybit batch flush


def _decode_latest_round_data(hex_result: str) -> tuple[int, float, int] | None:
    """Decode a `latestRoundData()` ABI return.
    Returns (round_id, price_usd, updated_at_unix) or None on parse failure.

    Layout (5 × 32-byte slots after '0x'):
      [0]  roundId        uint80   (padded to 32 bytes)
      [1]  answer         int256
      [2]  startedAt      uint256
      [3]  updatedAt      uint256
      [4]  answeredInRound uint80  (padded to 32 bytes)
    """
    if not hex_result or not hex_result.startswith("0x"):
        return None
    raw = hex_result[2:]
    if len(raw) < 320:  # 5 × 64 hex chars
        return None
    try:
        round_id = int(raw[0:64], 16)
        answer_hex = raw[64:128]
        answer = int(answer_hex, 16)
        # int256: handle two's complement for negative values
        # (shouldn't happen for a price feed, but be safe).
        if answer >= 2**255:
            answer -= 2**256
        updated_at = int(raw[192:256], 16)
    except ValueError:
        return None
    if answer <= 0 or updated_at <= 0:
        return None
    # Chainlink USD pairs use 8 decimals
    price = answer / 1e8
    return round_id, price, updated_at


class ChainlinkOracle:
    def __init__(
        self,
        settings: Settings,
        ch_client: Any,
        rpc_urls: tuple[str, ...] = DEFAULT_RPC_URLS,
    ) -> None:
        self.settings = settings
        self.ch_client = ch_client
        self.rpc_urls = rpc_urls
        # Honour the same ticker scope as the other collectors.
        configured = {t.upper() for t in settings.collector_tickers}
        self.aggregators = {
            ticker: addr
            for ticker, addr in AGGREGATORS.items()
            if ticker in configured
        }
        # Dedupe by updatedAt — Chainlink only posts a new round when
        # price moves past the deviation threshold OR on heartbeat.
        # Writing the same updatedAt twice is harmless but wasteful.
        self._last_updated_at: dict[str, int] = {}
        self.write_buffer: list[tuple[Any, ...]] = []

    async def _eth_call(
        self, client: httpx.AsyncClient, addr: str
    ) -> tuple[int, float, int] | None:
        """Try each RPC in order; first success wins. Returns None only
        if every RPC failed (rare — fall back to zero ticks this poll)."""
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [
                {"to": addr, "data": LATEST_ROUND_DATA_SELECTOR},
                "latest",
            ],
        }
        last_err: str | None = None
        for url in self.rpc_urls:
            try:
                r = await client.post(url, json=body, timeout=8.0)
                r.raise_for_status()
                payload = r.json()
            except (httpx.HTTPError, ValueError) as e:
                last_err = f"{url}: {e}"
                continue
            if "error" in payload:
                last_err = f"{url}: {payload['error']}"
                continue
            decoded = _decode_latest_round_data(payload.get("result", ""))
            if decoded is not None:
                return decoded
            last_err = f"{url}: bad payload"
        log.warning("chainlink_rpc_failed", addr=addr, error=last_err)
        return None

    async def _poll_once(self, client: httpx.AsyncClient) -> int:
        """Poll all configured aggregators once. Returns count of NEW
        ticks (excludes duplicates of an already-seen updatedAt)."""
        new = 0
        for ticker, addr in self.aggregators.items():
            decoded = await self._eth_call(client, addr)
            if decoded is None:
                continue
            _, price, updated_at = decoded
            if self._last_updated_at.get(ticker) == updated_at:
                continue
            self._last_updated_at[ticker] = updated_at
            ts = datetime.fromtimestamp(updated_at, tz=UTC)
            self.write_buffer.append((ticker, ts, price, None, "chainlink"))
            new += 1
        return new

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL_SEC)
            if not self.write_buffer:
                continue
            batch = self.write_buffer
            self.write_buffer = []
            try:
                await insert_underlying_prices(self.ch_client, batch)
                log.info("chainlink_flushed", rows=len(batch))
            except Exception as e:
                # Put rows back so the next flush retries — at most we
                # drop on shutdown, which is acceptable.
                log.error(
                    "chainlink_flush_failed", error=str(e), rows=len(batch)
                )
                self.write_buffer = batch + self.write_buffer

    async def run(self) -> None:
        if not self.aggregators:
            log.info("chainlink_oracle_skipped_no_tickers")
            return
        log.info(
            "chainlink_oracle_started",
            tickers=list(self.aggregators.keys()),
            rpc_urls=list(self.rpc_urls),
            interval_s=POLL_INTERVAL_SEC,
        )
        flush_task = asyncio.create_task(
            self._flush_loop(), name="chainlink_flush"
        )
        try:
            async with httpx.AsyncClient() as client:
                while True:
                    try:
                        n = await self._poll_once(client)
                        if n > 0:
                            log.info("chainlink_poll", new_ticks=n)
                    except Exception as e:
                        # Never let one bad poll kill the loop.
                        log.error("chainlink_poll_crashed", error=str(e))
                    await asyncio.sleep(POLL_INTERVAL_SEC)
        finally:
            flush_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await flush_task
            # Final best-effort flush.
            if self.write_buffer:
                with contextlib.suppress(Exception):
                    await insert_underlying_prices(
                        self.ch_client, self.write_buffer
                    )
