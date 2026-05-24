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

CRYPTO_TOKENS = ("btc", "bitcoin", "eth", "ethereum", "sol", "solana")

# Polymarket tags Gamma sets on every event. We use them as the
# authoritative source for "which time window this Up/Down market is".
#
# Scope (intentional, matches PolyBackTest):
#   - ONLY binary Up/Down crypto markets (5m / 15m / 1h / 4h / daily)
#   - NOT collected: weekly / monthly / yearly bracket markets (multiple
#     price thresholds per event — 10-34 sub-markets each — different
#     backtest math, not what our quant-focused customer base buys)
#   - NOT collected: "What price will X hit" daily targets — same
#     reason as brackets
#
# If you ever want to expand scope, add the tag → type mapping here and
# the bracket-aware backtest primitives in backtest/strategies.py.
WINDOW_TAG_TO_TYPE: dict[str, str] = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "daily": "daily_up_down",
}
CRYPTO_CATEGORY_TAGS = {"crypto", "crypto-prices", "bitcoin", "ethereum",
                        "solana"}


def _event_tag_slugs(event: dict[str, Any]) -> set[str]:
    """Return the lowercased set of tag slugs on an event.

    Polymarket returns tags as `[{"slug": "5M", "label": "5M"}, ...]`.
    We lowercase for case-insensitive matching (their casing is
    inconsistent — "5M" / "15M" / "1H" but "4h" / "daily" / "weekly")."""
    out: set[str] = set()
    for t in event.get("tags") or []:
        if isinstance(t, dict):
            s = t.get("slug") or t.get("label")
            if s:
                out.add(str(s).lower())
    return out

# Polymarket up/down market slug patterns. Polymarket uses two distinct
# conventions for crypto Up/Down markets:
#
#   1. Short-window markets (5m / 15m / 4h) — slug template:
#        {ticker}-updown-{window}-{unix_ts}
#      e.g. btc-updown-5m-1768913100, eth-updown-4h-1770138000
#
#   2. Hourly markets — slug template:
#        {ticker_full}-up-or-down-{month}-{day}-{year}-{hour}{am|pm}-et
#      e.g. bitcoin-up-or-down-may-23-2026-6pm-et
#      Each hour of the day produces one market.
#
#   3. Pure-daily markets — slug template:
#        {ticker_full}-up-or-down-on-{month}-{day}-{year}
#      e.g. solana-up-or-down-on-may-18-2026
#      One per day, settles end-of-day.
#
# The "left sidebar" on Polymarket's crypto page exposes 5m/15m/1h/4h/daily
# but they share only the FIRST pattern for the short windows; 1h and
# daily come through the natural-language pattern. The regex below
# differentiates them.
UPDOWN_SLUG_RE = re.compile(r"-updown-(\d+[mhd])-\d+", re.IGNORECASE)
HOURLY_NATURAL_RE = re.compile(
    r"-up-or-down-[a-z]+-\d+-\d{4}-\d+(am|pm)-et$", re.IGNORECASE
)
DAILY_NATURAL_RE = re.compile(
    r"-up-or-down-on-[a-z]+-\d+-\d{4}$", re.IGNORECASE
)

# A slug is binary "Up/Down" structurally if (and only if) it matches one
# of these. Bracket markets that share a time-window tag (1H, daily, etc.)
# won't match here — `-above-on-...`, `-week-...`, `-hit-...`, etc. all
# fail. That's the distinction tags alone can't make.
UPDOWN_ANY_RE = re.compile(
    r"-updown-\d+[mhd]-|-up-or-down-(on-)?[a-z]+-\d+-\d{4}", re.IGNORECASE
)


def _is_updown_structure(slug: str) -> bool:
    """True iff the slug looks like a binary Up/Down market.

    Combined with the time-window tag from Polymarket, this is enough
    to confidently classify. Tag → "what window". Slug → "what shape".
    Both must agree before we accept an event for collection.
    """
    return bool(UPDOWN_ANY_RE.search(slug.lower()))


def is_crypto_event(
    slug: str,
    question: str,
    tags: set[str] | None = None,
) -> bool:
    """Determine whether an event is in our crypto scope.

    Two signals (either is sufficient):
      1. Slug or question text contains a crypto ticker keyword
         (existing heuristic — catches `btc-updown-5m-NNN` etc.)
      2. The event carries a `crypto` / `crypto-prices` tag

    Tags are checked first because they're authoritative — Polymarket
    sets them deliberately. The keyword heuristic is the fallback for
    older events or any tag drift.
    """
    if tags and tags & CRYPTO_CATEGORY_TAGS:
        return True
    text = f"{slug} {question}".lower()
    return any(tok in text for tok in CRYPTO_TOKENS)


def classify_event(slug: str, question: str, tags: set[str] | None = None) -> str:
    """Return the market_type tag. For up/down markets we return the window
    string ('5m'/'15m'/'1h'/'4h'/'daily_up_down').

    Polymarket DOES tag every event with the window category
    (5M / 15M / 1H / 4h / daily / weekly / monthly / yearly). We prefer
    those tags when available — they're authoritative. The slug-pattern
    fallback exists for older events and any future tag drift.

    Tag → type mapping:
        '5M' / '15M' / '1H' / '4h'           → "5m" / "15m" / "1h" / "4h"
        'daily'                              → "daily_up_down"
        'weekly' / 'monthly' / 'yearly'      → "weekly_bracket" / etc.

    Slug pattern fallback:
        '-updown-{N}{unit}-NNN'              → that window
        '-up-or-down-may-23-2026-6pm-et'     → "1h"
        '-up-or-down-on-may-18-2026'         → "daily_up_down"
        'will-X-hit-Y'                       → "price_target"
        anything else                        → "other"
    """
    # ---- Pass 1: trust Polymarket's tags FOR THE WINDOW, but verify
    # the structure with the slug. Polymarket uses the same `1H` /
    # `daily` tag for both binary Up/Down markets AND price-bracket
    # markets that resolve in the same window (e.g. `bitcoin-above-
    # on-may-24-2026-5am-et` is a 1H bracket — still tagged `1H`).
    # We only want Up/Down, so require BOTH signals to agree.
    if tags:
        for tag_slug, mapped in WINDOW_TAG_TO_TYPE.items():
            if tag_slug in tags and _is_updown_structure(slug):
                return mapped

    slug_lower = slug.lower()
    text = f"{slug} {question}".lower()

    # Short-window Up/Down with structured slug (most common).
    m = UPDOWN_SLUG_RE.search(slug_lower)
    if m:
        window = m.group(1).lower()
        # Note: -updown-1d- is theoretically possible but we haven't
        # observed it in production — daily markets use pattern #3.
        return "24h" if window == "1d" else window

    # 1-hour markets — natural-language slug with explicit hour.
    if HOURLY_NATURAL_RE.search(slug_lower):
        return "1h"

    # Pure-daily — natural-language slug WITHOUT an hour suffix.
    if DAILY_NATURAL_RE.search(slug_lower):
        return "daily_up_down"

    # Bracket / price-target markets are intentionally OUT OF SCOPE.
    # They have a different shape (multiple sub-markets per event,
    # different backtest math) and PolyBackTest doesn't cover them
    # either. We return "other" so upsert_event_and_markets drops them.
    # Keep these comments here so the choice is visible at the only
    # place that would naturally re-introduce them.

    # Generic catch-all for atypical Up/Down phrasing (e.g. an event
    # tagged "daily" but with a non-standard slug).
    if re.search(r"up\s*or\s*down|will\s+\w+\s+(go\s+)?(up|down)", text):
        return "daily_up_down"
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
        max_pages: int = 200,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        """Paginate through Gamma's full active-events catalog and return
        only those whose tags / slug / title look crypto-relevant.

        Polymarket has ~9.5k active events at any moment — the previous
        cap of 6k (60 pages × 100) was leaving ~3.5k events undiscovered,
        which silently dropped weekly / monthly / yearly crypto markets.
        New cap is 20k events (200 pages); we stop early on the first
        empty / short page.

        We classify "crypto" via two signals:
          1. Tags include `crypto` / `crypto-prices` / ticker tags
             (authoritative; Polymarket sets these deliberately)
          2. Slug/title contains a crypto ticker keyword (fallback)
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
                tag_slugs = _event_tag_slugs(ev)
                if not is_crypto_event(slug, ev.get("title", ""), tag_slugs):
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
    tag_slugs = _event_tag_slugs(event)
    if not is_crypto_event(slug, question, tag_slugs):
        return 0

    event_type = classify_event(slug, question, tag_slugs)
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
