"""Global concurrency cap on backtest execution.

Backtests are the only CPU/IO-heavy endpoint we expose. A single run
can pin a vCPU for hundreds of milliseconds while it walks the book.
Without a cap, a small number of concurrent paying users could starve
the collector (which shares the same 4 vCPU box) and degrade ingest
quality, which is the product's actual core value.

Design choices:
  * Two-layer limit: a global semaphore caps platform-wide concurrency
    at GLOBAL_LIMIT, then a per-tier check (read from `api/tiers.py`)
    rejects requests where the caller already has too many in flight.
  * The wait inside the global semaphore is bounded by a timeout —
    rather than queueing for 60+ seconds we 503 fast and let the client
    retry with backoff. That keeps queue length predictable and prevents
    timed-out clients piling up against ClickHouse.
  * Per-tier counts live in a small in-memory dict guarded by an
    asyncio.Lock — we don't bother persisting them in Redis because:
      a) the cap is mostly a fairness check, not a hard quota
      b) a process restart resetting the counts is benign (worst case
         we briefly allow N+M instead of N concurrent jobs).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict


# Global cap: 6 = (4 vCPU - 1 reserved for collector) + 3 for the
# observation that ClickHouse queries are I/O-bound and overlap well.
# Below this number the system stays responsive under our measured
# query latencies (6-22 ms for reads, ~500 ms typical backtest).
GLOBAL_LIMIT = 6

# How long a request will wait for a slot before we 503 it. Picked
# small enough that timeouts cascade fast rather than slowly.
WAIT_TIMEOUT_SECONDS = 5.0


class BacktestSlotExhausted(Exception):
    """Raised when the platform is at capacity. The API layer turns
    this into 503 Service Unavailable + Retry-After."""

    def __init__(self, scope: str, limit: int) -> None:
        super().__init__(f"{scope} backtest limit reached ({limit} concurrent)")
        self.scope = scope
        self.limit = limit


class BacktestConcurrencyGate:
    """Combined global + per-tier-per-user concurrency control.

    Usage:
        gate = BacktestConcurrencyGate()
        async with gate.acquire(api_key_id, tier_concurrent_limit):
            result = await run_backtest(...)
    """

    def __init__(self, global_limit: int = GLOBAL_LIMIT) -> None:
        self._semaphore = asyncio.Semaphore(global_limit)
        self._global_limit = global_limit
        # Tracks in-flight backtests per api_key_id. Bounded by tier limit.
        self._per_key_inflight: dict[str, int] = defaultdict(int)
        self._lock = asyncio.Lock()

    @contextlib.asynccontextmanager
    async def acquire(self, api_key_id: str, per_key_limit: int):
        # Per-key check first (cheap, doesn't burn a global slot)
        async with self._lock:
            if self._per_key_inflight[api_key_id] >= per_key_limit:
                raise BacktestSlotExhausted("per-key", per_key_limit)
            self._per_key_inflight[api_key_id] += 1

        # Then the global slot — wait briefly, 503 if we can't get one.
        try:
            try:
                await asyncio.wait_for(
                    self._semaphore.acquire(), timeout=WAIT_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                # Release the per-key reservation we just made.
                async with self._lock:
                    self._per_key_inflight[api_key_id] -= 1
                raise BacktestSlotExhausted("global", self._global_limit)

            try:
                yield
            finally:
                self._semaphore.release()
        finally:
            async with self._lock:
                self._per_key_inflight[api_key_id] -= 1
                if self._per_key_inflight[api_key_id] <= 0:
                    self._per_key_inflight.pop(api_key_id, None)

    @property
    def stats(self) -> dict[str, int]:
        """For /health or admin visibility."""
        return {
            "global_limit": self._global_limit,
            "global_in_use": self._global_limit - self._semaphore._value,  # type: ignore[attr-defined]
            "keys_with_inflight": len(self._per_key_inflight),
        }
