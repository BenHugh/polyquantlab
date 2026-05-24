"""Internal endpoints — server-to-server bridge from the Next.js frontend.

These routes are NOT meant to be called by end users. They authenticate
via a shared secret (`INTERNAL_API_SECRET` env var) sent in the
`X-Internal-Secret` request header. The Next.js side reads the same env
var and passes it on every internal call.

What lives here:
  * `POST /v1/internal/sync-subscription` — Stripe webhook (handled by
    Next.js) calls this whenever a subscription is created / updated /
    cancelled. We upsert the user + subscription rows so the API
    server's tier lookup (in `api/auth.py:lookup_api_key`) sees the
    fresh tier.

  * `POST /v1/internal/users/{email}/keys` — Next.js dashboard calls
    this on behalf of an authenticated user to mint a new API key.
    Returns the plaintext key once; the DB only ever stores the hash.

  * `GET  /v1/internal/users/{email}/keys` — dashboard listing.

  * `DELETE /v1/internal/users/{email}/keys/{api_key_id}` — revoke.

By NOT exposing these as `/v1/me/...` we make it impossible for someone
to call them with a normal API key — only the Next.js process holding
the internal secret can hit them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.auth import generate_api_key
from api.tiers import TIERS, resolve_tier
from collector.config import get_settings
from collector.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/v1/internal", tags=["internal"])


def require_internal_secret(
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> None:
    """FastAPI dependency. 401 if the shared secret doesn't match.

    We compare against `Settings.internal_api_secret` rather than env
    directly so a single config source of truth is in use. If the
    secret env var is unset, we fail closed (`==""` won't match a
    valid incoming string), preventing accidentally-open prod.
    """
    expected = get_settings().internal_api_secret
    if not expected or not x_internal_secret or x_internal_secret != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Internal secret missing or invalid",
        )


# ---------------------------------------------------------------------------
# Subscription sync — called by Next.js Stripe webhook
# ---------------------------------------------------------------------------


class SyncSubscriptionRequest(BaseModel):
    email: str
    tier: str = Field(
        ...,
        description="One of: free | pro | plus | boost | premium.",
    )
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None
    status: str = Field(default="active", description="active | canceled | past_due")
    current_period_end: datetime | None = None


@router.post("/sync-subscription", status_code=status.HTTP_200_OK)
async def sync_subscription(
    body: SyncSubscriptionRequest,
    request: Request,
    _auth: None = Depends(require_internal_secret),
) -> dict[str, Any]:
    """Upsert user + subscription. Idempotent — safe for Stripe webhook
    retries (which Stripe does aggressively on 5xx).
    """
    tier_key = body.tier.strip().lower()
    if tier_key not in TIERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown tier {body.tier!r}; valid: {list(TIERS)}",
        )

    pool: asyncpg.Pool = request.app.state.pg
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Upsert user by email — Stripe is the source of identity here.
            user_row = await conn.fetchrow(
                """
                INSERT INTO users (email, stripe_customer_id)
                VALUES ($1, $2)
                ON CONFLICT (email) DO UPDATE
                  SET stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, users.stripe_customer_id)
                RETURNING user_id
                """,
                body.email,
                body.stripe_customer_id,
            )
            user_id = user_row["user_id"]

            # Upsert subscription. The unique key is (user_id) — we keep
            # one "active" row per user. New subscriptions replace any
            # existing row for that user.
            await conn.execute(
                """
                INSERT INTO subscriptions (
                    user_id, stripe_sub_id, tier, status, current_period_end
                ) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (stripe_sub_id) DO UPDATE
                  SET tier = EXCLUDED.tier,
                      status = EXCLUDED.status,
                      current_period_end = EXCLUDED.current_period_end,
                      updated_at = NOW()
                """,
                user_id,
                body.stripe_subscription_id,
                tier_key,
                body.status,
                body.current_period_end,
            )
    log.info(
        "sync_subscription",
        email=body.email,
        tier=tier_key,
        status=body.status,
    )
    return {"ok": True, "user_id": str(user_id), "tier": tier_key}


# ---------------------------------------------------------------------------
# API key management — called by Next.js dashboard on user's behalf
# ---------------------------------------------------------------------------


class CreateKeyRequest(BaseModel):
    label: str = Field(default="dashboard-created", max_length=128)


@router.post("/users/{email}/keys", status_code=status.HTTP_201_CREATED)
async def create_user_key(
    email: str,
    body: CreateKeyRequest,
    request: Request,
    _auth: None = Depends(require_internal_secret),
) -> dict[str, Any]:
    """Mint a new API key for the user. Returns plaintext ONCE — the
    dashboard MUST display it to the user immediately. We only persist
    the SHA-256 hash so the plaintext is unrecoverable after this
    response is consumed."""
    pool: asyncpg.Pool = request.app.state.pg
    plaintext, key_hash, key_prefix = generate_api_key()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
            SELECT user_id, $2, $3, $4 FROM users WHERE email = $1
            RETURNING api_key_id, created_at
            """,
            email,
            key_hash,
            key_prefix,
            body.label,
        )
        if row is None:
            raise HTTPException(404, detail="User not found")
    return {
        "api_key_id": str(row["api_key_id"]),
        "key": plaintext,        # <- show this ONCE
        "key_prefix": key_prefix,
        "label": body.label,
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/users/{email}/keys")
async def list_user_keys(
    email: str,
    request: Request,
    _auth: None = Depends(require_internal_secret),
) -> dict[str, Any]:
    pool: asyncpg.Pool = request.app.state.pg
    rows = await pool.fetch(
        """
        SELECT api_key_id, key_prefix, label, created_at, last_used_at, revoked_at
          FROM api_keys
         WHERE user_id = (SELECT user_id FROM users WHERE email = $1)
         ORDER BY created_at DESC
        """,
        email,
    )
    return {
        "keys": [
            {
                "api_key_id": str(r["api_key_id"]),
                "key_prefix": r["key_prefix"],
                "label": r["label"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "last_used_at": r["last_used_at"].isoformat() if r["last_used_at"] else None,
                "revoked_at": r["revoked_at"].isoformat() if r["revoked_at"] else None,
            }
            for r in rows
        ]
    }


@router.delete("/users/{email}/keys/{api_key_id}")
async def revoke_user_key(
    email: str,
    api_key_id: str,
    request: Request,
    _auth: None = Depends(require_internal_secret),
) -> dict[str, Any]:
    """Soft-delete (sets revoked_at). The auth path in `api/auth.py`
    already refuses keys with non-null `revoked_at`."""
    pool: asyncpg.Pool = request.app.state.pg
    result = await pool.execute(
        """
        UPDATE api_keys SET revoked_at = NOW()
         WHERE api_key_id = $1
           AND user_id = (SELECT user_id FROM users WHERE email = $2)
           AND revoked_at IS NULL
        """,
        api_key_id,
        email,
    )
    affected = int(result.split()[-1]) if result.startswith("UPDATE") else 0
    if affected == 0:
        raise HTTPException(404, detail="Key not found or already revoked")
    return {"ok": True, "api_key_id": api_key_id, "revoked": True}


# ---------------------------------------------------------------------------
# Current subscription / user view — used by dashboard to render tier card
# ---------------------------------------------------------------------------


@router.get("/users/{email}/subscription")
async def get_user_subscription(
    email: str,
    request: Request,
    _auth: None = Depends(require_internal_secret),
) -> dict[str, Any]:
    pool: asyncpg.Pool = request.app.state.pg
    row = await pool.fetchrow(
        """
        SELECT u.user_id, u.email, u.stripe_customer_id,
               s.tier, s.status, s.current_period_end, s.stripe_sub_id
          FROM users u
          LEFT JOIN subscriptions s ON s.user_id = u.user_id
         WHERE u.email = $1
        """,
        email,
    )
    if row is None:
        # User has signed up via Next.js but not yet been synced (no
        # purchase). Treat as Free tier — same view as logged-in free.
        free = resolve_tier("free")
        return {
            "email": email,
            "tier": "free",
            "tier_display": free.display_name,
            "status": "active",
            "limits": _tier_summary(free),
        }
    tier_obj = resolve_tier(row["tier"])
    return {
        "user_id": str(row["user_id"]),
        "email": row["email"],
        "stripe_customer_id": row["stripe_customer_id"],
        "tier": row["tier"] or "free",
        "tier_display": tier_obj.display_name,
        "status": row["status"] or "active",
        "current_period_end": row["current_period_end"].isoformat() if row["current_period_end"] else None,
        "stripe_subscription_id": row["stripe_sub_id"],
        "limits": _tier_summary(tier_obj),
    }


def _tier_summary(t) -> dict[str, Any]:
    """Subset of tier limits safe to expose to the dashboard."""
    return {
        "rps": t.rps,
        "rpm": t.rpm,
        "concurrent_backtests": t.concurrent_backtests,
        "max_market_limit": t.max_market_limit,
        "history_days": t.history_days,
        "monthly_price_usd": t.monthly_price_usd,
    }
