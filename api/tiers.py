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
    # Parameter-sweep size cap. A sweep loads the universe ONCE and replays
    # the strategy N times in-memory, so the cost scales mainly with cell
    # count, not market_limit. Empirically a 400-cell sweep over 100
    # markets is ~30s; 2500-cell ~3min. Caps below leave Premium ~3 min
    # max wait, Free ~15s.
    max_sweep_cells: int        # max product(x_steps * y_steps) for /v1/backtest/sweep
    # Paper-trading: how many strategies a user can keep RUNNING at
    # once. Each strategy consumes a small amount of worker CPU on
    # every snapshot, so this caps our infra cost.
    max_paper_strategies: int
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
        max_sweep_cells=25,        # 5×5
        max_paper_strategies=1,
        history_days=31,
        display_name="Free",
        monthly_price_usd=0.0,
    ),
    "pro": TierLimits(
        rps=10,
        rpm=300,
        concurrent_backtests=2,
        max_market_limit=20,
        max_sweep_cells=100,       # 10×10
        max_paper_strategies=3,
        history_days=31,
        display_name="Pro",
        monthly_price_usd=19.90,
    ),
    "plus": TierLimits(
        rps=25,
        rpm=1_000,
        concurrent_backtests=3,
        max_market_limit=50,
        max_sweep_cells=400,       # 20×20
        max_paper_strategies=10,
        history_days=60,
        display_name="Plus",
        monthly_price_usd=39.90,
    ),
    "boost": TierLimits(
        rps=30,
        rpm=1_225,
        concurrent_backtests=4,
        max_market_limit=100,
        max_sweep_cells=900,       # 30×30
        max_paper_strategies=25,
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
        max_sweep_cells=2500,      # 50×50
        max_paper_strategies=100,
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
