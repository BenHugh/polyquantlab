"""Polymarket CLOB WebSocket client.

Subscribes to the `market` channel for a dynamic set of token ids and writes
every orderbook update + trade into ClickHouse.

Endpoint:
  wss://ws-subscriptions-clob.polymarket.com/ws/market

Subscription payload (per Polymarket CLOB docs):
  {
    "type": "Market",
    "assets_ids": ["<token_id_1>", "<token_id_2>", ...]
  }

Message types we care about:
  * "book"           — full orderbook snapshot for an asset
  * "price_change"   — incremental update to one or more price levels
  * "last_trade_price" — a trade just happened
  * "tick_size_change" — tick size update (rare)

This v0 implementation:
  * Pulls the active token id set from Postgres every N seconds
  * Reconnects with exponential backoff on disconnect
  * Re-subscribes on reconnect
  * Buffers writes to ClickHouse (flush every 1s or 100 rows)
  * Records a heartbeat every 30s into collector_heartbeats

What's intentionally NOT in v0:
  * Incremental orderbook reconstruction from price_change deltas.
    We persist the snapshot directly; later versions can reconstruct deeper
    books from deltas if needed.
  * REST gap-fill after a disconnect. The next "book" message gives us a
    fresh snapshot, so short outages self-heal; longer outages will leave a
    gap that we'll address when adding the second worker.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import UTC, datetime
from typing import Any

import asyncpg
import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from collector.config import Settings
from collector.db import (
    insert_heartbeat,
    insert_orderbook_snapshots,
    insert_trades,
)
from collector.logging_setup import get_logger

log = get_logger(__name__)

SUBSCRIPTION_REFRESH_INTERVAL = 60  # seconds
HEARTBEAT_INTERVAL = 30             # seconds
# Flush every 10 s instead of every 1 s. ClickHouse creates one new part
# per insert; at our ~140 row/s rate, 1 s flushes produce ~86k parts/day,
# which overruns the background merger and bloats disk 9× with inactive
# parts pending GC. 10 s flushes → ~1400 rows/part → roughly the
# 50k-row-target ClickHouse recommends for healthy merge throughput,
# at a 10 s data-visibility latency that doesn't matter for backtests.
FLUSH_INTERVAL = 10.0
# Hard cap so a high-volume burst can still flush early — protects RAM.
FLUSH_BATCH_SIZE = 5000
PASSIVE_SNAPSHOT_INTERVAL = 60      # seconds — minute-by-minute fallback record
# Per-market write strategy: event-driven with adaptive throttling.
#
#   * `book` events  → ALWAYS emit (full snapshots are informative; rare).
#   * `price_change` → emit if EITHER
#                        (a) >= EMIT_THROTTLE_SECONDS since last emit, OR
#                        (b) YES mid-price moved >= SIGNIFICANT_MOVE_FRAC
#                            since last emit (meaningful change captured
#                            instantly, micro-flicker suppressed).
#   * passive 60 s   → fallback for markets that emitted nothing recently.
#
# 0.125 s = 8 snapshots/sec cap per market, matching PolyBackTest's stated
# "8 snapshots per second per market" rate (reverse-engineered from
# 474M total snapshots / 71k markets / 837s avg lifetime ≈ 8/sec/market).
# This is now an UPPER BOUND on event-driven emission, not a sampling
# interval — idle markets write nothing in between (no forced periodic
# sampling). The 60 s passive snapshot loop still provides a coarse
# fallback for markets that never fire any WS event.
EMIT_THROTTLE_SECONDS = 0.125
# Set to 0 to capture every meaningful book change (no significance filter).
# Combined with the 125 ms throttle, this means: write every event-driven
# update, but no more than 8 per second per market. Sub-cent flicker still
# emits a row — it's the same model as PolyBackTest.
SIGNIFICANT_MOVE_ABS = 0.0
# Resolution-time filter — DISABLED to subscribe to every active market.
# Empty books contribute zero rows (the WS server just doesn't push events
# for them and the passive loop skips empty books). The cost of a wider
# subscription is bandwidth, not storage. Mirroring PolyBackTest's 71k
# markets / 60 days coverage means we have to follow markets from creation,
# not just the last 6h before resolution.
SUBSCRIBE_WITHIN_HOURS = None
SUBSCRIBE_LONG_TERM_AFTER_DAYS = None


# ---------------------------------------------------------------------------
# Token-id → (market_id, side, underlying_ticker) lookup
# ---------------------------------------------------------------------------


async def load_active_tokens(
    pool: asyncpg.Pool,
    *,
    within_hours: float | None = SUBSCRIBE_WITHIN_HOURS,
    long_term_after_days: float | None = SUBSCRIBE_LONG_TERM_AFTER_DAYS,
) -> dict[str, dict[str, str]]:
    """Return token_id → metadata mapping for every active market.

    By default (within_hours=None, long_term_after_days=None) we subscribe to
    ALL active markets. Empty-book markets cost 0 storage — Polymarket WS
    pushes nothing for them and the passive loop skips them. Subscribing
    early lets us follow a market through its entire lifecycle from
    creation to resolution, matching PolyBackTest's broad coverage.
    """
    if within_hours is None and long_term_after_days is None:
        rows = await pool.fetch(
            """
            SELECT m.market_id, m.yes_token_id, m.no_token_id, e.ticker
              FROM markets m
              JOIN events  e ON e.event_id = m.event_id
             WHERE m.is_active = TRUE
            """,
        )
    else:
        rows = await pool.fetch(
            """
            SELECT m.market_id, m.yes_token_id, m.no_token_id, e.ticker
              FROM markets m
              JOIN events  e ON e.event_id = m.event_id
             WHERE m.is_active = TRUE
               AND (
                      e.resolution_at IS NULL
                   OR e.resolution_at <  NOW() + ($1 || ' hours')::interval
                   OR e.resolution_at >  NOW() + ($2 || ' days')::interval
               )
            """,
            str(within_hours) if within_hours is not None else "0",
            str(long_term_after_days) if long_term_after_days is not None else "36500",
        )
    result: dict[str, dict[str, str]] = {}
    for r in rows:
        result[r["yes_token_id"]] = {
            "market_id": r["market_id"],
            "side": "YES",
            "ticker": r["ticker"],
        }
        result[r["no_token_id"]] = {
            "market_id": r["market_id"],
            "side": "NO",
            "ticker": r["ticker"],
        }
    return result


# ---------------------------------------------------------------------------
# Orderbook state — one entry per market_id
# ---------------------------------------------------------------------------


class MarketBook:
    """Holds the latest YES/NO order book sides so we can emit a unified row.

    Internally stores each side as a dict {price: size} so price_change
    deltas can be applied in O(1). Sorted lists are produced on demand
    when emitting to ClickHouse.
    """

    __slots__ = (
        "market_id",
        "ticker",
        "_yes_bids",
        "_yes_asks",
        "_no_bids",
        "_no_asks",
    )

    def __init__(self, market_id: str, ticker: str) -> None:
        self.market_id = market_id
        self.ticker = ticker
        # Each is {price (float): size (float)}. size == 0 ⇒ price level
        # has been deleted by an exchange operation.
        self._yes_bids: dict[float, float] = {}
        self._yes_asks: dict[float, float] = {}
        self._no_bids: dict[float, float] = {}
        self._no_asks: dict[float, float] = {}

    def _book_for(self, asset_side: str, order_side: str) -> dict[float, float]:
        """Resolve which of the four internal dicts a (asset, BUY/SELL) hits.

        Polymarket convention:
          - BUY order on YES = bid into yes_bids
          - SELL order on YES = ask in yes_asks
          - Same for NO
        """
        order_side = (order_side or "").upper()
        if asset_side == "YES":
            return self._yes_bids if order_side == "BUY" else self._yes_asks
        return self._no_bids if order_side == "BUY" else self._no_asks

    def replace_full_book(
        self,
        asset_side: str,
        bids: list[dict[str, Any]],
        asks: list[dict[str, Any]],
    ) -> None:
        """Full snapshot replacement (event_type == "book")."""
        bids_dict = {float(b["price"]): float(b["size"]) for b in bids}
        asks_dict = {float(a["price"]): float(a["size"]) for a in asks}
        if asset_side == "YES":
            self._yes_bids = bids_dict
            self._yes_asks = asks_dict
        else:
            self._no_bids = bids_dict
            self._no_asks = asks_dict

    def apply_delta(
        self,
        asset_side: str,
        order_side: str,
        price: float,
        size: float,
    ) -> None:
        """Incremental update (event_type == "price_change").

        size == 0 means the level was emptied — remove it. Otherwise the
        new size *replaces* the existing size at that price (Polymarket
        deltas are absolute, not relative).
        """
        book = self._book_for(asset_side, order_side)
        if size <= 0:
            book.pop(price, None)
        else:
            book[price] = size

    @staticmethod
    def _sorted_levels(book: dict[float, float], *, descending: bool) -> list[dict[str, Any]]:
        items = sorted(book.items(), key=lambda kv: kv[0], reverse=descending)
        return [{"price": p, "size": s} for p, s in items[:10]]

    def current_mid_yes(self) -> float | None:
        """Best-effort YES mid-price from the live in-memory book. Used by
        the throttle to detect 'significant-move' bypass candidates."""
        if not self._yes_bids or not self._yes_asks:
            return None
        best_bid = max(self._yes_bids)
        best_ask = min(self._yes_asks)
        return (best_bid + best_ask) / 2

    def to_row(self, ts: datetime, underlying_price: float | None) -> tuple[Any, ...]:
        yes_bids = self._sorted_levels(self._yes_bids, descending=True)
        yes_asks = self._sorted_levels(self._yes_asks, descending=False)
        no_bids = self._sorted_levels(self._no_bids, descending=True)
        no_asks = self._sorted_levels(self._no_asks, descending=False)

        best_yes_bid = yes_bids[0]["price"] if yes_bids else None
        best_yes_ask = yes_asks[0]["price"] if yes_asks else None
        mid_yes = (
            (best_yes_bid + best_yes_ask) / 2
            if best_yes_bid is not None and best_yes_ask is not None
            else None
        )
        spread_yes = (
            best_yes_ask - best_yes_bid
            if best_yes_bid is not None and best_yes_ask is not None
            else None
        )
        return (
            self.market_id,
            ts,
            orjson.dumps(yes_bids).decode(),
            orjson.dumps(yes_asks).decode(),
            orjson.dumps(no_bids).decode(),
            orjson.dumps(no_asks).decode(),
            best_yes_bid,
            best_yes_ask,
            mid_yes,
            spread_yes,
            self.ticker,
            underlying_price,
            "ws",
        )


# ---------------------------------------------------------------------------
# Underlying price cache (filled by the Pyth client, read here)
# ---------------------------------------------------------------------------


class UnderlyingPriceCache:
    """In-memory ticker → latest price. Pyth client writes, WS client reads."""

    def __init__(self) -> None:
        self._prices: dict[str, tuple[float, float]] = {}  # ticker -> (price, ts)

    def set(self, ticker: str, price: float, ts: float) -> None:
        self._prices[ticker] = (price, ts)

    def get(self, ticker: str) -> float | None:
        entry = self._prices.get(ticker)
        if entry is None:
            return None
        price, ts = entry
        # Refuse stale prices (> 10s old) so backtests don't see misaligned data
        if time.time() - ts > 10:
            return None
        return price


# ---------------------------------------------------------------------------
# WebSocket consumer
# ---------------------------------------------------------------------------


class PolymarketWS:
    def __init__(
        self,
        settings: Settings,
        pg_pool: asyncpg.Pool,
        ch_client: Any,
        price_cache: UnderlyingPriceCache,
    ) -> None:
        self.settings = settings
        self.pg_pool = pg_pool
        self.ch_client = ch_client
        self.price_cache = price_cache

        self.tokens: dict[str, dict[str, str]] = {}
        self.books: dict[str, MarketBook] = {}
        self.snapshot_buffer: list[tuple[Any, ...]] = []
        self.trade_buffer: list[tuple[Any, ...]] = []
        self.messages_received: int = 0
        self.last_error: str = ""
        # Active WS reference so the refresh loop can force-close it
        # when the subscription set changes.
        self._active_ws: ClientConnection | None = None
        # Per-market emit bookkeeping. `_last_emit_ts` records the unix
        # epoch seconds of the last row written; `_last_emit_mid` records
        # the YES mid price at that moment. Together they implement the
        # adaptive throttle: emit if N seconds elapsed OR mid moved by a
        # meaningful fraction.
        self._last_emit_ts: dict[str, float] = {}
        self._last_emit_mid: dict[str, float] = {}

    # -- bootstrap ----------------------------------------------------------

    async def refresh_tokens(self) -> bool:
        """Reload active tokens from Postgres. Returns True if the set changed.

        When the set changes mid-run, we close the current WS so the outer
        reconnect loop opens a new one with the updated subscription.
        """
        new_tokens = await load_active_tokens(self.pg_pool)
        changed = new_tokens.keys() != self.tokens.keys()
        if changed:
            log.info(
                "tokens_changed",
                old=len(self.tokens),
                new=len(new_tokens),
            )
        self.tokens = new_tokens
        # Ensure a book object exists for every market
        for meta in self.tokens.values():
            mid = meta["market_id"]
            if mid not in self.books:
                self.books[mid] = MarketBook(mid, meta["ticker"])
        return changed

    async def wait_for_initial_tokens(self, poll_interval: float = 5.0) -> None:
        """Block until at least one token is discovered. Runs at startup so
        we never open a WS that has nothing to subscribe to."""
        while True:
            await self.refresh_tokens()
            if self.tokens:
                return
            log.info("waiting_for_initial_tokens", count=0)
            await asyncio.sleep(poll_interval)

    # -- message handling ---------------------------------------------------

    def _market_id_for(self, asset_id: str) -> tuple[str, str, str] | None:
        meta = self.tokens.get(asset_id)
        if meta is None:
            return None
        return meta["market_id"], meta["side"], meta["ticker"]

    def _should_emit(
        self,
        market_id: str,
        book: MarketBook | None = None,
        *,
        force: bool = False,
    ) -> bool:
        """Adaptive per-market emit decision.

        Returns True if the caller should write a snapshot row now.
        Three reasons to emit:
          1. `force=True` — caller insists (e.g. `book` full snapshot).
          2. >= EMIT_THROTTLE_SECONDS since last emit (time floor).
          3. Significant YES mid move since last emit — even within the
             throttle window, a meaningful change is captured immediately.

        All three paths also refresh the last-emit ts and mid bookkeeping.
        """
        now = time.time()
        current_mid = book.current_mid_yes() if book is not None else None

        def _record() -> None:
            self._last_emit_ts[market_id] = now
            if current_mid is not None:
                self._last_emit_mid[market_id] = current_mid

        if force:
            _record()
            return True

        last_ts = self._last_emit_ts.get(market_id, 0.0)
        elapsed = now - last_ts

        if elapsed >= EMIT_THROTTLE_SECONDS:
            _record()
            return True

        # Significant-move bypass: capture the change immediately even
        # within the throttle window if YES mid moved by >= configured
        # absolute threshold. Set SIGNIFICANT_MOVE_ABS to 0 (or negative) to
        # disable the bypass entirely — useful when you want a hard time
        # cap with no escape hatch.
        if SIGNIFICANT_MOVE_ABS > 0 and current_mid is not None:
            last_mid = self._last_emit_mid.get(market_id)
            if last_mid is not None:
                if abs(current_mid - last_mid) >= SIGNIFICANT_MOVE_ABS:
                    _record()
                    return True

        return False

    def _ts_from(self, message: dict[str, Any]) -> datetime:
        # Polymarket sends "timestamp" as ms-since-epoch string. Fall back to now.
        raw = message.get("timestamp") or message.get("time")
        if raw:
            try:
                return datetime.fromtimestamp(int(raw) / 1000, tz=UTC)
            except (ValueError, TypeError):
                pass
        return datetime.now(tz=UTC)

    def _parse_levels(self, raw: Any) -> list[dict[str, Any]]:
        """Polymarket sends [{price, size}, ...] but field names vary."""
        if not isinstance(raw, list):
            return []
        levels: list[dict[str, Any]] = []
        for item in raw[:10]:
            if not isinstance(item, dict):
                continue
            price = item.get("price") or item.get("p")
            size = item.get("size") or item.get("s")
            if price is None or size is None:
                continue
            try:
                levels.append({"price": float(price), "size": float(size)})
            except (ValueError, TypeError):
                continue
        return levels

    async def handle_message(self, raw: bytes | str) -> None:
        try:
            data = orjson.loads(raw)
        except orjson.JSONDecodeError:
            return

        # Some servers send list-of-events; normalise to a flat iterator
        events = data if isinstance(data, list) else [data]
        for ev in events:
            await self._handle_event(ev)

    async def _handle_event(self, ev: dict[str, Any]) -> None:
        self.messages_received += 1
        ev_type = ev.get("event_type") or ev.get("type")
        ts = self._ts_from(ev)
        top_asset_id = ev.get("asset_id") or ev.get("assetId")

        if ev_type == "book":
            if not top_asset_id:
                return
            lookup = self._market_id_for(top_asset_id)
            if lookup is None:
                return
            market_id, side, ticker = lookup
            bids = self._parse_levels(ev.get("bids") or ev.get("buys"))
            asks = self._parse_levels(ev.get("asks") or ev.get("sells"))
            book = self.books.setdefault(market_id, MarketBook(market_id, ticker))
            book.replace_full_book(side, bids, asks)
            # `book` events are rare full snapshots — always persist them.
            if self._should_emit(market_id, book, force=True):
                self.snapshot_buffer.append(
                    book.to_row(ts, self.price_cache.get(ticker))
                )

        elif ev_type == "price_change":
            # Apply all deltas to the in-memory book regardless of throttle —
            # state must stay current. Then emit at most one row per touched
            # market, gated by the 5 s throttle.
            changes = ev.get("price_changes") or ev.get("changes") or []
            touched_books: set[str] = set()
            for change in changes:
                if not isinstance(change, dict):
                    continue
                aid = change.get("asset_id") or change.get("assetId") or top_asset_id
                if not aid:
                    continue
                lookup = self._market_id_for(aid)
                if lookup is None:
                    continue
                market_id, side, ticker = lookup
                try:
                    price = float(change.get("price"))
                    size = float(change.get("size"))
                except (TypeError, ValueError):
                    continue
                order_side = change.get("side") or ""
                book = self.books.setdefault(market_id, MarketBook(market_id, ticker))
                book.apply_delta(side, order_side, price, size)
                touched_books.add(market_id)
            for mid in touched_books:
                book = self.books[mid]
                if not self._should_emit(mid, book):
                    continue
                self.snapshot_buffer.append(
                    book.to_row(ts, self.price_cache.get(book.ticker))
                )

        elif ev_type == "last_trade_price" or ev_type == "trade":
            if not top_asset_id:
                return
            lookup = self._market_id_for(top_asset_id)
            if lookup is None:
                return
            market_id, side, _ = lookup
            price = ev.get("price")
            size = ev.get("size") or ev.get("quantity")
            trade_side = (ev.get("side") or "").upper()
            full_side = f"{trade_side}_{side}" if trade_side else side
            trade_id = (
                ev.get("trade_id")
                or ev.get("tradeId")
                or f"{market_id}-{ts.timestamp()}"
            )
            try:
                price_f = float(price) if price is not None else None
                size_f = float(size) if size is not None else None
            except (ValueError, TypeError):
                return
            if price_f is None or size_f is None:
                return
            self.trade_buffer.append(
                (
                    str(trade_id),
                    market_id,
                    ts,
                    full_side,
                    price_f,
                    size_f,
                    str(ev.get("maker_address") or ev.get("maker") or ""),
                    str(ev.get("taker_address") or ev.get("taker") or ""),
                    str(ev.get("tx_hash") or ev.get("txHash") or ""),
                )
            )

    # -- flushing -----------------------------------------------------------

    async def flush(self) -> None:
        if self.snapshot_buffer:
            snapshots = self.snapshot_buffer
            self.snapshot_buffer = []
            try:
                await insert_orderbook_snapshots(self.ch_client, snapshots)
            except Exception as exc:
                self.last_error = f"snapshot_insert: {exc}"
                log.error("snapshot_insert_failed", error=str(exc), rows=len(snapshots))
        if self.trade_buffer:
            trades = self.trade_buffer
            self.trade_buffer = []
            try:
                await insert_trades(self.ch_client, trades)
            except Exception as exc:
                self.last_error = f"trade_insert: {exc}"
                log.error("trade_insert_failed", error=str(exc), rows=len(trades))

    async def _flush_loop(self) -> None:
        """Time-based flush every FLUSH_INTERVAL seconds, with an early
        flush if either buffer crosses FLUSH_BATCH_SIZE rows (RAM safety).
        Larger batches mean fewer/larger ClickHouse parts and lower merge
        pressure — see comment on the constants for the trade-off."""
        while True:
            await asyncio.sleep(1.0)  # check every second
            if (
                len(self.snapshot_buffer) >= FLUSH_BATCH_SIZE
                or len(self.trade_buffer) >= FLUSH_BATCH_SIZE
            ):
                await self.flush()
                continue
            # Time-based flush (anything in buffer, every FLUSH_INTERVAL s)
            self._flush_tick = getattr(self, "_flush_tick", 0) + 1
            if self._flush_tick >= int(FLUSH_INTERVAL):
                self._flush_tick = 0
                if self.snapshot_buffer or self.trade_buffer:
                    await self.flush()

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                await insert_heartbeat(
                    self.ch_client,
                    self.settings.collector_worker_id,
                    datetime.now(tz=UTC).replace(microsecond=0),
                    len(self.books),
                    self.messages_received,
                    self.last_error,
                )
            except Exception as exc:
                log.warning("heartbeat_failed", error=str(exc))

    async def _refresh_loop(self) -> None:
        """Periodically reload tokens from Postgres. If the set changed,
        close the active WS so the outer loop reconnects + re-subscribes."""
        while True:
            await asyncio.sleep(SUBSCRIPTION_REFRESH_INTERVAL)
            try:
                changed = await self.refresh_tokens()
            except Exception as exc:
                log.warning("token_refresh_failed", error=str(exc))
                continue
            if changed and self._active_ws is not None:
                log.info("forcing_resubscribe_via_reconnect")
                try:
                    await self._active_ws.close()
                except Exception:
                    pass

    async def _passive_snapshot_loop(self) -> None:
        """Emit a snapshot row for every tracked market once per minute as a
        fallback for markets quiet enough that no WS event fired. The 5 s
        per-market throttle still applies — a passive emit is suppressed
        if we already wrote a row for that market within the last 5 s.
        """
        await asyncio.sleep(PASSIVE_SNAPSHOT_INTERVAL)
        while True:
            try:
                ts = datetime.now(tz=UTC)
                count = 0
                for market_id, book in self.books.items():
                    # Skip empty books (no data point would be informative)
                    if not (
                        book._yes_bids
                        or book._yes_asks
                        or book._no_bids
                        or book._no_asks
                    ):
                        continue
                    if not self._should_emit(market_id, book):
                        continue
                    self.snapshot_buffer.append(
                        book.to_row(ts, self.price_cache.get(book.ticker))
                    )
                    count += 1
                if count:
                    log.debug("passive_snapshots_emitted", count=count)
            except Exception as exc:
                log.warning("passive_snapshot_failed", error=str(exc))
            await asyncio.sleep(PASSIVE_SNAPSHOT_INTERVAL)

    # -- main connect loop --------------------------------------------------

    async def _subscribe(self, ws: ClientConnection) -> None:
        if not self.tokens:
            log.warning("no_tokens_to_subscribe")
            return
        payload = {
            "type": "Market",
            "assets_ids": list(self.tokens.keys()),
        }
        await ws.send(orjson.dumps(payload).decode())
        log.info("subscribed", count=len(self.tokens))

    async def _consume(self, ws: ClientConnection) -> None:
        async for message in ws:
            await self.handle_message(message)

    async def run(self) -> None:
        # Don't open the WS until discovery has populated at least one market.
        # Avoids the race where the collector and discovery start concurrently
        # and the WS opens with an empty subscription set.
        await self.wait_for_initial_tokens()

        background = [
            asyncio.create_task(self._flush_loop()),
            asyncio.create_task(self._heartbeat_loop()),
            asyncio.create_task(self._refresh_loop()),
            asyncio.create_task(self._passive_snapshot_loop()),
        ]

        backoff = 1.0
        try:
            while True:
                try:
                    log.info("ws_connecting", url=self.settings.polymarket_ws_url)
                    async with websockets.connect(
                        self.settings.polymarket_ws_url,
                        ping_interval=20,
                        ping_timeout=20,
                        max_size=8 * 1024 * 1024,
                    ) as ws:
                        self._active_ws = ws
                        log.info("ws_connected")
                        await self._subscribe(ws)
                        backoff = 1.0
                        await self._consume(ws)
                except (
                    websockets.ConnectionClosed,
                    websockets.WebSocketException,
                    OSError,
                ) as exc:
                    log.warning("ws_disconnected", error=str(exc), backoff=backoff)
                    self.last_error = f"ws_disconnect: {exc}"
                    self._active_ws = None
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                except Exception as exc:
                    log.error("ws_loop_failed", error=str(exc))
                    self.last_error = f"ws_unexpected: {exc}"
                    self._active_ws = None
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
        finally:
            for t in background:
                t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(*background, return_exceptions=True)
            await self.flush()
