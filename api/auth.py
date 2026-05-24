"""API key authentication.

Keys live in Postgres. The plaintext is shown once on creation and only the
sha256 hash is persisted. Lookups are by hash so the DB never sees the raw key.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime
from typing import Any

import asyncpg
from fastapi import Header, HTTPException, status


KEY_PREFIX = "skb_"  # "stock-backtest" — distinguishable in user-facing UI


def generate_api_key() -> tuple[str, str, str]:
    """Returns (plaintext, hash, prefix). Show plaintext once; store hash."""
    raw = secrets.token_urlsafe(32)
    plaintext = KEY_PREFIX + raw
    digest = hashlib.sha256(plaintext.encode()).hexdigest()
    return plaintext, digest, plaintext[:12]


def hash_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def lookup_api_key(
    pool: asyncpg.Pool, plaintext: str
) -> dict[str, Any] | None:
    digest = hash_key(plaintext)
    row = await pool.fetchrow(
        """
        SELECT k.api_key_id, k.user_id, k.label, k.revoked_at,
               s.tier, s.status AS sub_status
          FROM api_keys k
          LEFT JOIN subscriptions s ON s.user_id = k.user_id AND s.status = 'active'
         WHERE k.key_hash = $1
         LIMIT 1
        """,
        digest,
    )
    if not row:
        return None
    if row["revoked_at"] is not None:
        return None
    return dict(row)


async def record_usage(
    pool: asyncpg.Pool, api_key_id: Any, bytes_returned: int = 0
) -> None:
    today = datetime.utcnow().date()
    await pool.execute(
        """
        INSERT INTO api_usage_daily (api_key_id, day, request_count, bytes_returned)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (api_key_id, day) DO UPDATE SET
            request_count  = api_usage_daily.request_count + 1,
            bytes_returned = api_usage_daily.bytes_returned + EXCLUDED.bytes_returned
        """,
        api_key_id,
        today,
        bytes_returned,
    )


async def require_api_key(
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> str:
    """FastAPI dependency that extracts the raw key from headers.

    Validation against the DB happens in the route, because the DB pool
    lives on app.state.
    """
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
    elif x_api_key:
        token = x_api_key.strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key. Send 'Authorization: Bearer <key>' or X-API-Key header.",
        )
    return token
