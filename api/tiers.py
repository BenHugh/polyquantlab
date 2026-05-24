"""Tier configuration — single source of truth for rate limits, backtest
caps, and historical-data windows per subscription tier.

Values are picked to match PolyBackTest's published pricing
(<https://polybacktest.com/#pricing>), with one additional Premium tier
we use as differentiation (longer history + higher concurrency).

A subscription's `tier` column in Postgres maps directly to one of the
keys below. Anything not recognised falls back to the free tier — fail
closed rather than fail open.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TierLimits:
    # Per-API-key sustained throughput
    rps: int                # requests per second (token bucket capacity)
    rpm: int                # requests per minute (rolling window)
    # Backtest-specific caps (backtest is the only CPU-heavy endpoint;
    # everything else is read-only ClickHouse / Postgres queries).
    concurrent_backtests: int   # how many backtest jobs this key may have running at once
    max_market_limit: int       # max value the client can pass for `market_limit`
    # How far back the user is allowed to query historical data, in days.
    history_days: int
    # Display-only — what we show in the dashboard / pricing page.
    display_name: str
    monthly_price_usd: float


# Order matters for fallthrough logic — listed cheapest to most expensive.
TIERS: dict[str, TierLimits] = {
    "free": TierLimits(
        rps=1,
        rpm=60,
        concurrent_backtests=1,
        max_market_limit=5,
        history_days=31,
        display_name="Free",
        monthly_price_usd=0.0,
    ),
    "pro": TierLimits(
        rps=10,
        rpm=300,
        concurrent_backtests=2,
        max_market_limit=20,
        history_days=31,
        display_name="Pro",
        monthly_price_usd=19.90,
    ),
    "plus": TierLimits(
        rps=25,
        rpm=1_000,
        concurrent_backtests=3,
        max_market_limit=50,
        history_days=60,
        display_name="Plus",
        monthly_price_usd=39.90,
    ),
    "boost": TierLimits(
        rps=30,
        rpm=1_225,
        concurrent_backtests=4,
        max_market_limit=100,
        history_days=60,
        display_name="Boost",
        monthly_price_usd=47.90,
    ),
    # Our differentiation — longer history than PolyBackTest offers, higher
    # concurrency for shops running many strategies in parallel.
    "premium": TierLimits(
        rps=50,
        rpm=2_000,
        concurrent_backtests=6,
        max_market_limit=200,
        history_days=120,
        display_name="Premium",
        monthly_price_usd=99.90,
    ),
}


# Aliases for backward-compat with old subscriptions.tier values that
# existed before we standardised the naming.
LEGACY_TIER_ALIASES: dict[str, str] = {
    "individual": "pro",
    "team":       "plus",
    "commercial": "boost",
}


def resolve_tier(tier_name: str | None) -> TierLimits:
    """Look up a tier by name, with legacy alias support and a safe fallback.

    Unknown / null tiers map to `free`. Fail-closed is the right default
    here — we'd rather rate-limit too tightly than expose unlimited access
    because of a typo in the database.
    """
    if not tier_name:
        return TIERS["free"]
    key = tier_name.strip().lower()
    key = LEGACY_TIER_ALIASES.get(key, key)
    return TIERS.get(key, TIERS["free"])


def tier_name(tier_name: str | None) -> str:
    """Return the canonical tier key (after alias resolution).

    Useful when you need a stable string for Redis keys or logging.
    """
    if not tier_name:
        return "free"
    key = tier_name.strip().lower()
    return LEGACY_TIER_ALIASES.get(key, key) if key in TIERS or key in LEGACY_TIER_ALIASES else "free"
