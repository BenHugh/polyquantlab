"""Redis-backed token bucket rate limiter, per API key, per tier.

Why a custom limiter (instead of slowapi):
  * slowapi only supports per-IP / per-route limits driven by a fixed
    config; we need limits that change at runtime based on which user's
    API key was presented.
  * We need TWO simultaneous buckets per key (rps for burst protection,
    rpm for sustained throughput) — slowapi handles single-axis limits.
  * The check + decrement must be atomic across concurrent requests to
    the same key. A Lua script run inside Redis is the standard pattern.

Algorithm:
  Token bucket per (api_key_id, granularity). The bucket starts full
  (= configured limit). Every request decrements by 1. The TTL is set
  to the window length, so when no requests arrive for `window` seconds
  the key expires and the next request starts fresh.

  This is *not* a leaky bucket — refill is instant at window expiry.
  That's the same model slowapi and most cloud APIs use; it's simpler
  to reason about than a continuous refill rate and good enough for
  protecting the VPS from a misbehaving client.

Returns:
  RateLimitDecision dataclass that the middleware turns into HTTP
  response headers (X-RateLimit-Limit / -Remaining / -Reset) and
  optionally a 429 with Retry-After.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import redis.asyncio as aioredis

from api.tiers import TierLimits


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int           # the cap this bucket enforces
    remaining: int       # tokens left in the bucket after this check
    reset_seconds: int   # seconds until the bucket resets (TTL of the key)
    granularity: str     # "rps" | "rpm" — which bucket triggered (when not allowed)


# Lua script: atomically decrement a counter. If the key doesn't exist
# yet, initialise it to (limit - 1) with the given TTL.
#
# Returns: (allowed, remaining, ttl_seconds)
#   allowed     = 1 if request is within budget, 0 if exhausted
#   remaining   = tokens left in the bucket (>= 0); for the request that
#                 was *just* allowed, this is the count AFTER decrement
#   ttl_seconds = how long until the bucket resets
_LUA_TOKEN_BUCKET = """
local key       = KEYS[1]
local limit     = tonumber(ARGV[1])
local window    = tonumber(ARGV[2])

local current = redis.call('GET', key)
if not current then
    -- First request in this window: initialise the bucket.
    redis.call('SET', key, limit - 1, 'EX', window)
    return {1, limit - 1, window}
end

current = tonumber(current)
if current <= 0 then
    -- Bucket empty.
    local ttl = redis.call('TTL', key)
    if ttl < 0 then ttl = window end
    return {0, 0, ttl}
end

redis.call('DECR', key)
local ttl = redis.call('TTL', key)
if ttl < 0 then ttl = window end
return {1, current - 1, ttl}
"""


class RateLimiter:
    """Wraps a Redis client and the compiled Lua script."""

    def __init__(self, redis_url: str) -> None:
        self._redis: aioredis.Redis = aioredis.from_url(
            redis_url,
            decode_responses=False,  # raw bytes — Lua returns native types
            socket_timeout=2.0,
            socket_connect_timeout=2.0,
            retry_on_timeout=True,
        )
        # `register_script` returns a callable that injects the script SHA
        # on each call and falls back to EVAL if the cache evicted it.
        self._consume = self._redis.register_script(_LUA_TOKEN_BUCKET)

    async def close(self) -> None:
        try:
            await self._redis.aclose()
        except Exception:  # noqa: BLE001 — best-effort shutdown
            pass

    async def check(
        self,
        api_key_id: str,
        limits: TierLimits,
    ) -> RateLimitDecision:
        """Run both the per-second and per-minute checks for this key.

        We always evaluate both; whichever runs out first triggers the
        429. We report the tighter remaining count back so the client
        sees how close to the wall it is.
        """
        rps_decision = await self._consume_one(
            f"ratelimit:rps:{api_key_id}", limits.rps, 1
        )
        # If the burst bucket is already exhausted, short-circuit — no
        # point burning a token from the per-minute bucket.
        if not rps_decision.allowed:
            return rps_decision

        rpm_decision = await self._consume_one(
            f"ratelimit:rpm:{api_key_id}", limits.rpm, 60
        )
        if not rpm_decision.allowed:
            return rpm_decision

        # Both passed — report the bucket with the tighter remaining
        # count so clients can pace themselves intelligently.
        if rps_decision.remaining <= rpm_decision.remaining:
            return rps_decision
        return rpm_decision

    async def _consume_one(
        self,
        key: str,
        limit: int,
        window_seconds: int,
    ) -> RateLimitDecision:
        try:
            result: list[Any] = await self._consume(
                keys=[key],
                args=[limit, window_seconds],
            )
        except Exception:  # noqa: BLE001
            # Fail open when Redis is unreachable — we'd rather let
            # traffic through than 503 every request. The other layers
            # (semaphore, ClickHouse rate) still protect the VPS.
            return RateLimitDecision(
                allowed=True,
                limit=limit,
                remaining=limit,
                reset_seconds=window_seconds,
                granularity="rps" if window_seconds == 1 else "rpm",
            )
        allowed_int, remaining, ttl = result
        return RateLimitDecision(
            allowed=bool(int(allowed_int)),
            limit=limit,
            remaining=int(remaining),
            reset_seconds=int(ttl),
            granularity="rps" if window_seconds == 1 else "rpm",
        )
