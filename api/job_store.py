"""Job state + result storage in Redis.

ARQ already persists the QUEUE (pending tasks waiting for a worker).
What ARQ doesn't do well is expose the LIFECYCLE to API callers:
  * "what's the status of job xyz?"  (queued | running | done | failed)
  * "give me my last 20 jobs"        (per-user history listing)
  * "fetch the actual result blob"   (we want it cached for 24h, not GC'd)

This module owns those concerns. ARQ kicks off the job; we record
its state transitions and the final result here, keyed by job_id.

Storage layout:
  job:{job_id}              HASH — status, ts fields, result_json, error
  user_jobs:{api_key_id}    ZSET — score = submitted_at_ms, member = job_id
                                   (used by /v1/backtest list endpoint)

We don't try to be a real workflow engine. If the worker process dies
mid-job the job stays "running" forever until manually cleaned — fine
at our scale, can add a heartbeat reaper later.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import redis.asyncio as aioredis


# How long completed results survive in Redis before being GC'd.
# 24h is enough for a user to come back the next day and see their
# overnight backtest result. Longer would be nice but Redis is RAM —
# not free, and the underlying market data is still in ClickHouse so
# they can re-run.
RESULT_TTL_SECONDS = 86_400      # 24h
RUNNING_TTL_SECONDS = 3_600      # 1h — kills zombie "running" jobs


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class JobRecord:
    job_id: str
    api_key_id: str
    status: JobStatus
    submitted_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    # Original request body (so the user can see what they asked for)
    params: dict[str, Any] = field(default_factory=dict)
    # Backtest result, only populated when status == COMPLETED
    result: dict[str, Any] | None = None
    # Human-readable error, only populated when status == FAILED
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k in ("submitted_at", "started_at", "completed_at"):
            v = d.get(k)
            d[k] = v.isoformat() if isinstance(v, datetime) else v
        d["status"] = self.status.value if isinstance(self.status, JobStatus) else self.status
        return d


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def new_job_id() -> str:
    """Public, URL-friendly identifier — short prefix lets us shard
    later if needed, the 16-byte random tail prevents enumeration."""
    return "bt_" + secrets.token_urlsafe(16)


class JobStore:
    def __init__(self, redis_url: str) -> None:
        self._redis: aioredis.Redis = aioredis.from_url(
            redis_url, decode_responses=True
        )

    async def close(self) -> None:
        try:
            await self._redis.aclose()
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _key(job_id: str) -> str:
        return f"job:{job_id}"

    @staticmethod
    def _user_key(api_key_id: str) -> str:
        return f"user_jobs:{api_key_id}"

    async def create(self, api_key_id: str, params: dict[str, Any]) -> JobRecord:
        rec = JobRecord(
            job_id=new_job_id(),
            api_key_id=api_key_id,
            status=JobStatus.QUEUED,
            submitted_at=_now(),
            params=params,
        )
        await self._write(rec, ttl=RUNNING_TTL_SECONDS)
        # Add to user's listing — score = unix ms so newest sorts first
        await self._redis.zadd(
            self._user_key(api_key_id),
            {rec.job_id: rec.submitted_at.timestamp() * 1000},
        )
        # Trim to last 500 jobs per user so the zset doesn't grow forever
        await self._redis.zremrangebyrank(self._user_key(api_key_id), 0, -501)
        return rec

    async def mark_running(self, job_id: str) -> None:
        rec = await self.get(job_id)
        if rec is None or rec.status not in (JobStatus.QUEUED,):
            return
        rec.status = JobStatus.RUNNING
        rec.started_at = _now()
        await self._write(rec, ttl=RUNNING_TTL_SECONDS)

    async def mark_completed(self, job_id: str, result: dict[str, Any]) -> None:
        rec = await self.get(job_id)
        if rec is None:
            return
        rec.status = JobStatus.COMPLETED
        rec.completed_at = _now()
        rec.result = result
        await self._write(rec, ttl=RESULT_TTL_SECONDS)

    async def mark_failed(self, job_id: str, error: str) -> None:
        rec = await self.get(job_id)
        if rec is None:
            return
        rec.status = JobStatus.FAILED
        rec.completed_at = _now()
        rec.error = error
        await self._write(rec, ttl=RESULT_TTL_SECONDS)

    async def get(self, job_id: str) -> JobRecord | None:
        raw = await self._redis.get(self._key(job_id))
        if raw is None:
            return None
        return self._deserialise(raw)

    async def list_for_user(
        self, api_key_id: str, limit: int = 50, offset: int = 0
    ) -> list[JobRecord]:
        # ZSET stores newest-first because higher score = newer. We use
        # ZREVRANGE to get them in that order.
        ids = await self._redis.zrevrange(
            self._user_key(api_key_id),
            offset,
            offset + limit - 1,
        )
        if not ids:
            return []
        # Pipeline the multi-get to avoid N round-trips
        async with self._redis.pipeline(transaction=False) as pipe:
            for jid in ids:
                pipe.get(self._key(jid))
            raws = await pipe.execute()
        out: list[JobRecord] = []
        for raw in raws:
            if not raw:
                continue
            out.append(self._deserialise(raw))
        return out

    # ---- serde -----------------------------------------------------------

    async def _write(self, rec: JobRecord, *, ttl: int) -> None:
        await self._redis.set(self._key(rec.job_id), json.dumps(rec.to_dict()), ex=ttl)

    def _deserialise(self, raw: str) -> JobRecord:
        d = json.loads(raw)
        for k in ("submitted_at", "started_at", "completed_at"):
            if d.get(k):
                d[k] = datetime.fromisoformat(d[k])
        d["status"] = JobStatus(d["status"])
        return JobRecord(**d)
