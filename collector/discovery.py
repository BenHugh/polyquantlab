"""Discover Polymarket stock Up/Down events via the Gamma REST API.

Runs on a poll loop (default every 5 minutes). For each ticker we care about,
it asks Gamma for active events matching the ticker, parses out the markets
(YES/NO tokens) underneath, and upserts both into Postgres.

The collector reads the resulting `markets` table to figure out which token
ids to subscribe to over WebSocket.

Gamma API reference:
  https://docs.polymarket.com/developers/gamma-markets-api/overview
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from typing import Any

import asyncpg
import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from collector.config import Settings
from collector.logging_setup import get_logger

log = get_logger(__name__)


# ---------------------------------------------------------------------------
# Scope: only crypto Up/Down markets (PolyBackTest's domain).
#
# Gamma does not tag events with a clean type label, so we infer from
# slug + question text. We accept an event only if BOTH conditions hold:
#   1. Slug or question references one of our tickers (btc/eth/sol)
#   2. It is an Up/Down-style market (binary daily / hourly resolution)
#
# Bracket / monthly / range markets ARE collected as a separate type so
# the API can serve them too — they're the same data shape, just different
# resolution windows.
# ---------------------------------------------------------------------------

DAILY_UP_DOWN_RE = re.compile(r"(up|down).*\bon\b.*\d{4}", re.IGNORECASE)
UP_OR_DOWN_RE = re.compile(r"up\s*or\s*down|will\s+\w+\s+(go\s+)?(up|down)", re.IGNORECASE)
CRYPTO_TOKENS = ("btc", "bitcoin", "eth", "ethereum", "sol", "solana")

# Polymarket up/down market slug pattern. Examples:
#   sol-updown-5m-1768913100
#   btc-updown-15m-1770138000
#   eth-updown-1h-1770138000
# Captures the window duration (5m, 15m, 1h, 4h, 24h, 1d).
UPDOWN_SLUG_RE = re.compile(r"-updown-(\d+[mhd])-\d+", re.IGNORECASE)


def is_crypto_event(slug: str, question: str) -> bool:
    text = f"{slug} {question}".lower()
    return any(tok in text for tok in CRYPTO_TOKENS)


def classify_event(slug: str, question: str) -> str:
    """Return the market_type tag. For up/down markets we return the window
    string ('5m'/'15m'/'1h'/'4h'/'24h') — same vocabulary PolyBackTest uses
    in their metadata response. Bracket / range / target markets get their
    own labels.
    """
    text = f"{slug} {question}".lower()
    # Up/Down with explicit window in slug — most common case.
    m = UPDOWN_SLUG_RE.search(text)
    if m:
        window = m.group(1).lower()
        # Normalise 1d → 24h to match PolyBackTest's vocabulary.
        return "24h" if window == "1d" else window
    # Bracket / range markets
    if "weekly" in text or "this week" in text:
        return "weekly_bracket"
    if "monthly" in text or "this month" in text:
        return "monthly_bracket"
    # Fall-throughs
    if DAILY_UP_DOWN_RE.search(text) or UP_OR_DOWN_RE.search(text):
        return "daily_up_down"
    if re.search(r"\bhit\b|\breach\b|\bclose\s+(above|below)\b", text):
        return "price_target"
    return "other"


def parse_resolution_unix(slug: str) -> int | None:
    """Up/down slugs end with the unix timestamp of resolution. Return
    None if the slug doesn't match the pattern."""
    m = re.search(r"-(\d{10})$", slug)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# Gamma API client
# ---------------------------------------------------------------------------


class GammaClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=20.0)

    async def close(self) -> None:
        await self._client.aclose()

    @retry(
        retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
        wait=wait_exponential(multiplier=1, min=1, max=30),
        stop=stop_after_attempt(5),
        reraise=True,
    )
    async def _fetch_page(self, offset: int, limit: int = 100) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self.base_url}/events",
            params={
                "limit": limit,
                "offset": offset,
                "active": "true",
                "closed": "false",
                "order": "endDate",
                "ascending": "true",
            },
        )
        resp.raise_for_status()
        return resp.json()

    async def list_all_crypto_events(
        self,
        max_pages: int = 60,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        """Paginate through Gamma's full active-events catalog and return
        only those whose slug/title looks crypto-relevant. Polymarket has
        ~1400 active crypto events at any moment spread across thousands
        of total events — a single page can't possibly cover them.

        We stop paginating when:
          - we receive a short page (end of catalog), or
          - we hit `max_pages` (5000 events safety ceiling).

        Server-side tag filters would be cleaner but Gamma's tag system has
        shifted ids multiple times; client-side text matching is robust.
        """
        seen_slugs: set[str] = set()
        matched: list[dict[str, Any]] = []

        for page in range(max_pages):
            try:
                data = await self._fetch_page(page * page_size, page_size)
            except Exception as exc:
                log.warning("gamma_page_failed", page=page, error=str(exc))
                break
            if not data:
                break
            for ev in data:
                slug = ev.get("slug")
                if not slug or slug in seen_slugs:
                    continue
                if not is_crypto_event(slug, ev.get("title", "")):
                    continue
                seen_slugs.add(slug)
                matched.append(ev)
            # Short page = we've reached the tail
            if len(data) < page_size:
                break
        return matched


# ---------------------------------------------------------------------------
# Upsert helpers
# ---------------------------------------------------------------------------


UPSERT_EVENT_SQL = """
INSERT INTO events (
    event_id, polymarket_slug, ticker, event_type, question,
    created_at, resolution_at, raw, discovered_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
ON CONFLICT (polymarket_slug) DO UPDATE SET
    event_type    = EXCLUDED.event_type,
    question      = EXCLUDED.question,
    resolution_at = EXCLUDED.resolution_at,
    raw           = EXCLUDED.raw,
    updated_at    = NOW()
RETURNING event_id;
"""

UPSERT_MARKET_SQL = """
INSERT INTO markets (
    market_id, event_id, outcome, yes_token_id, no_token_id,
    is_active, tick_size, discovered_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
ON CONFLICT (market_id) DO UPDATE SET
    outcome    = EXCLUDED.outcome,
    is_active  = EXCLUDED.is_active,
    updated_at = NOW();
"""


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        # Gamma returns ISO 8601, sometimes with "Z" suffix
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _extract_token_ids(market: dict[str, Any]) -> tuple[str, str] | None:
    """Polymarket markets carry a `clobTokenIds` field with two ids: YES, NO.

    The exact key has shifted historically; we accept a few variants.
    """
    raw_tokens = (
        market.get("clobTokenIds")
        or market.get("clob_token_ids")
        or market.get("tokenIds")
    )
    if isinstance(raw_tokens, str):
        try:
            raw_tokens = json.loads(raw_tokens)
        except json.JSONDecodeError:
            return None
    if not isinstance(raw_tokens, list) or len(raw_tokens) < 2:
        return None
    return str(raw_tokens[0]), str(raw_tokens[1])


async def upsert_event_and_markets(
    pool: asyncpg.Pool,
    ticker: str,
    event: dict[str, Any],
) -> int:
    """Insert/update one event and its child markets. Returns # markets upserted.

    Scope filter: skip anything that doesn't look like a crypto market.
    Gamma returns lots of unrelated noise when searching for "BTC" / "ETH"
    (NFL plays mentioning "Eth-an", etc.) — we hard-gate at insert time.
    """
    slug = event.get("slug")
    question = event.get("title") or event.get("description") or ""
    if not slug:
        return 0
    if not is_crypto_event(slug, question):
        return 0

    event_type = classify_event(slug, question)
    # Only collect tradeable Up/Down or bracket markets; "other" is noise.
    if event_type == "other":
        return 0

    created_at = _parse_timestamp(event.get("createdAt")) or datetime.utcnow()
    # Resolution time can be in endDate or, for up/down markets, encoded
    # in the slug's trailing unix timestamp.
    resolution_at = _parse_timestamp(event.get("endDate") or event.get("end_date"))
    if resolution_at is None:
        ts_unix = parse_resolution_unix(slug)
        if ts_unix:
            from datetime import timezone
            resolution_at = datetime.fromtimestamp(ts_unix, tz=timezone.utc)

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                UPSERT_EVENT_SQL,
                # event_id is generated client-side by hashing slug, so
                # parallel discovery workers don't fight over a sequence.
                _slug_to_uuid(slug),
                slug,
                ticker,
                event_type,
                question,
                created_at,
                resolution_at,
                json.dumps(event),
            )
            event_id = row["event_id"]

            count = 0
            for market in event.get("markets", []) or []:
                token_ids = _extract_token_ids(market)
                if not token_ids:
                    continue
                yes_id, no_id = token_ids
                market_id = market.get("conditionId") or market.get("condition_id")
                if not market_id:
                    continue
                outcome = market.get("outcome") or market.get("groupItemTitle") or ""
                is_active = bool(market.get("active", True)) and not bool(
                    market.get("closed", False)
                )
                tick_size = market.get("orderPriceMinTickSize")

                await conn.execute(
                    UPSERT_MARKET_SQL,
                    str(market_id),
                    event_id,
                    str(outcome),
                    yes_id,
                    no_id,
                    is_active,
                    tick_size,
                )
                count += 1
    return count


def _slug_to_uuid(slug: str) -> Any:
    """Deterministic UUID v5 from slug. Lets us idempotent-insert from
    multiple workers without race conditions."""
    import uuid

    namespace = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # DNS namespace
    return uuid.uuid5(namespace, slug)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


async def run_discovery_once(
    settings: Settings,
    pool: asyncpg.Pool,
    gamma: GammaClient,
) -> int:
    """Paginate the FULL Polymarket active-events catalog once, classify
    each crypto event to its ticker (BTC/ETH/SOL), and upsert.

    The previous per-ticker `search_events()` flow only captured the first
    100 events sorted by endDate — missing thousands of further-out
    markets. Polymarket has ~1.4 K active crypto events at any moment.
    """
    total_markets = 0

    try:
        events = await gamma.list_all_crypto_events()
    except Exception as exc:
        log.error("gamma_full_scan_failed", error=str(exc))
        return 0

    # Classify each event to a ticker from our subscribed set
    configured = {t.upper() for t in settings.collector_tickers}
    by_ticker: dict[str, int] = {}
    skipped_unknown = 0

    for ev in events:
        text = (ev.get("slug", "") + " " + ev.get("title", "")).lower()
        if "btc" in text or "bitcoin" in text:
            ticker = "BTC"
        elif "eth" in text or "ethereum" in text:
            ticker = "ETH"
        elif "sol" in text or "solana" in text:
            ticker = "SOL"
        else:
            skipped_unknown += 1
            continue
        if ticker not in configured:
            continue
        try:
            count = await upsert_event_and_markets(pool, ticker, ev)
            total_markets += count
            by_ticker[ticker] = by_ticker.get(ticker, 0) + 1
        except Exception as exc:
            log.warning(
                "upsert_failed",
                ticker=ticker,
                slug=ev.get("slug"),
                error=str(exc),
            )

    log.info(
        "discovery_scan_complete",
        crypto_events_seen=len(events),
        events_upserted_by_ticker=by_ticker,
        skipped_unknown_ticker=skipped_unknown,
        total_markets_upserted=total_markets,
    )
    return total_markets


async def run_discovery_forever(
    settings: Settings,
    pool: asyncpg.Pool,
) -> None:
    gamma = GammaClient(settings.polymarket_gamma_api)
    try:
        while True:
            try:
                n = await run_discovery_once(settings, pool, gamma)
                log.info("discovery_cycle_done", markets_upserted=n)
            except Exception as exc:
                log.error("discovery_cycle_failed", error=str(exc))
            await asyncio.sleep(settings.collector_discovery_interval)
    finally:
        await gamma.close()
