"""Paper-trading API endpoints (`/v1/paper/...`).

User-facing CRUD over the paper_strategies + paper_positions tables.
Auth uses the same `authed_key` dependency as the rest of the public
API surface — the internal-secret shortcut works here too (the
dashboard goes through it).

The actual trading logic lives in `worker/paper_trader.py`; this file
just exposes the state for the UI.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field

from api import paper_db
from api.tiers import TierLimits, resolve_tier

router = APIRouter(prefix="/v1/paper", tags=["paper"])


# ---------------------------------------------------------------------------
# Auth-and-identify helper. Dashboard users come in via internal-secret
# and we read their email from the X-User-Email header that the Next.js
# proxy adds. API-key users... currently can't create paper strategies
# (no email associated with API keys yet — that's a Phase F improvement).
# For v0 we keep this simple: internal-secret path only.
# ---------------------------------------------------------------------------


async def _resolve_user_email(request: Request) -> str:
    """Pull the dashboard user's email from a trusted Next.js header.

    The Next.js proxy reads the Supabase session, knows who the user
    is, and forwards X-User-Email alongside X-Internal-Secret. We trust
    that header because the only way to reach this endpoint without it
    is via an API-key path, which we reject for paper trading (for now).
    """
    # The authed_key dependency runs BEFORE this; it has already
    # validated either an API key OR internal-secret. We layer on the
    # email requirement on top.
    email = request.headers.get("X-User-Email")
    if not email:
        raise HTTPException(
            status_code=400,
            detail=(
                "Paper trading is currently only available via the "
                "dashboard. Programmatic API support is on the roadmap."
            ),
        )
    return email.strip().lower()


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------


class CreatePaperStrategyRequest(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    strategy_spec: dict[str, Any]
    ticker: str | None = Field(default=None, examples=["BTC", "ETH", "SOL"])
    event_type: str | None = Field(default=None, examples=["5m", "15m", "1h", "4h", "daily_up_down"])
    size_usd: float = Field(default=10, ge=1, le=10_000)
    # Phase U.3 — populated when the "Run as paper trade" CTA in
    # Strategy Builder simultaneously submits a backtest with the same
    # spec. Powers the backtest-vs-paper comparison on the detail page.
    baseline_backtest_id: str | None = Field(default=None, max_length=64)


# ---------------------------------------------------------------------------
# Strategy CRUD
# ---------------------------------------------------------------------------


@router.get("/strategies")
async def list_strategies(
    request: Request,
    response: Response,
    only_active: bool = Query(default=False),
) -> dict[str, Any]:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    strategies = await paper_db.list_strategies(pool, email, only_active=only_active)
    return {"strategies": strategies, "count": len(strategies)}


@router.post("/strategies", status_code=status.HTTP_201_CREATED)
async def create_strategy(
    request: Request,
    response: Response,
    body: CreatePaperStrategyRequest,
) -> dict[str, Any]:
    from api.main import authed_key
    auth = await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg

    # Tier gate: cap number of *active* paper strategies per user.
    # For dashboard callers, authed_key returned premium tier — we want
    # the USER's real tier, so look it up by email.
    user_row = await pool.fetchrow(
        """
        SELECT s.tier
          FROM users u
          LEFT JOIN subscriptions s ON s.user_id = u.user_id
         WHERE u.email = $1
        """,
        email,
    )
    tier_key = (user_row["tier"] if user_row else None) or "free"
    tier_limits: TierLimits = resolve_tier(tier_key)
    active_count = await paper_db.count_active_strategies(pool, email)
    if active_count >= tier_limits.max_paper_strategies:
        raise HTTPException(
            status_code=402,
            detail=(
                f"{tier_limits.display_name} tier allows up to "
                f"{tier_limits.max_paper_strategies} active paper "
                f"strategies; you have {active_count}. Upgrade or pause "
                f"an existing strategy."
            ),
        )

    # Basic strategy_spec sanity — it must declare a `type` from the
    # registry. Phase M added "condition_based" alongside the three
    # legacy presets; the worker now handles all four.
    if not isinstance(body.strategy_spec, dict) or "type" not in body.strategy_spec:
        raise HTTPException(
            status_code=400,
            detail="strategy_spec must be a JSON object with a 'type' key.",
        )
    ALLOWED_TYPES = {
        "threshold_entry",
        "mean_reversion",
        "time_before_resolution",
        "condition_based",
    }
    if body.strategy_spec.get("type") not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"strategy_spec.type must be one of {sorted(ALLOWED_TYPES)}; "
                f"got {body.strategy_spec.get('type')!r}."
            ),
        )

    created = await paper_db.create_strategy(
        pool,
        user_email=email,
        name=body.name,
        strategy_spec=body.strategy_spec,
        ticker=body.ticker,
        event_type=body.event_type,
        size_usd=body.size_usd,
        baseline_backtest_id=body.baseline_backtest_id,
    )
    return created


@router.get("/strategies/{strategy_id}")
async def get_strategy(
    request: Request,
    response: Response,
    strategy_id: str,
) -> dict[str, Any]:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    record = await paper_db.get_strategy(pool, strategy_id, user_email=email)
    if not record:
        raise HTTPException(404, "Paper strategy not found")
    return record


@router.patch("/strategies/{strategy_id}/pause")
async def pause_strategy(
    request: Request,
    response: Response,
    strategy_id: str,
) -> dict[str, Any]:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    ok = await paper_db.set_strategy_active(pool, strategy_id, email, active=False)
    if not ok:
        raise HTTPException(404, "Paper strategy not found")
    return {"ok": True, "paper_strategy_id": strategy_id, "active": False}


@router.patch("/strategies/{strategy_id}/resume")
async def resume_strategy(
    request: Request,
    response: Response,
    strategy_id: str,
) -> dict[str, Any]:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    ok = await paper_db.set_strategy_active(pool, strategy_id, email, active=True)
    if not ok:
        raise HTTPException(404, "Paper strategy not found")
    return {"ok": True, "paper_strategy_id": strategy_id, "active": True}


@router.delete("/strategies/{strategy_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_strategy(
    request: Request,
    response: Response,
    strategy_id: str,
) -> Response:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    ok = await paper_db.delete_strategy(pool, strategy_id, email)
    if not ok:
        raise HTTPException(404, "Paper strategy not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Positions + equity curve
# ---------------------------------------------------------------------------


@router.get("/strategies/{strategy_id}/positions")
async def list_positions(
    request: Request,
    response: Response,
    strategy_id: str,
    limit: int = Query(default=1000, le=10_000),
) -> dict[str, Any]:
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg
    positions = await paper_db.list_positions(pool, strategy_id, email, limit=limit)
    return {"positions": positions, "count": len(positions)}


@router.get("/strategies/{strategy_id}/equity")
async def equity_curve(
    request: Request,
    response: Response,
    strategy_id: str,
) -> dict[str, Any]:
    """Cumulative net P&L over time, derived from closed positions.

    Only closed positions count — open positions have no realised PnL
    yet. The frontend can compute drawdowns / Sharpe from this series.
    """
    from api.main import authed_key
    await authed_key(request, response)
    email = await _resolve_user_email(request)
    pool = request.app.state.pg

    rows = await pool.fetch(
        """
        SELECT p.closed_at, p.pnl, p.fees
          FROM paper_positions p
          JOIN paper_strategies s ON s.paper_strategy_id = p.paper_strategy_id
         WHERE p.paper_strategy_id = $1
           AND s.user_email = $2
           AND p.closed_at IS NOT NULL
         ORDER BY p.closed_at
        """,
        strategy_id,
        email,
    )

    cumulative = 0.0
    points: list[dict[str, Any]] = []
    for r in rows:
        gross = float(r["pnl"] or 0)
        fees = float(r["fees"] or 0)
        cumulative += gross - fees
        points.append(
            {
                "ts": r["closed_at"].isoformat(),
                "cumulative_net_pnl": cumulative,
                "trade_net_pnl": gross - fees,
            }
        )
    return {
        "paper_strategy_id": strategy_id,
        "n_closed_positions": len(rows),
        "final_net_pnl": cumulative,
        "points": points,
    }
