"""Paper-trading DB helpers — shared between API and worker.

The API handlers (CRUD endpoints) and the paper_trader worker BOTH
need to read/write paper_strategies + paper_positions. Putting the SQL
in one place keeps them honest: schema changes only have to be
reflected once.

Design choices:
  * All times are UTC (TIMESTAMPTZ in Postgres).
  * `paper_positions` has a UNIQUE(paper_strategy_id, market_id) — a
    strategy gets at most ONE position per market, matching backtest
    engine semantics. The worker uses `INSERT ... ON CONFLICT DO NOTHING`
    so two snapshots arriving in close succession can't double-fire.
  * Settlement is a separate pass: when a market resolves, we close
    EVERY open position on that market (one row per strategy) in a
    single UPDATE.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
import json
from uuid import UUID

import asyncpg


# ---------------------------------------------------------------------------
# Strategy CRUD
# ---------------------------------------------------------------------------


async def list_strategies(
    pool: asyncpg.Pool, user_email: str, *, only_active: bool = False
) -> list[dict[str, Any]]:
    where = "WHERE user_email = $1"
    args: list[Any] = [user_email]
    if only_active:
        where += " AND active = TRUE"
    sql = f"""
        SELECT paper_strategy_id, user_email, name, strategy_spec,
               ticker, event_type, size_usd, started_at, paused_at,
               active, created_at, updated_at
          FROM paper_strategies {where}
         ORDER BY created_at DESC
    """
    rows = await pool.fetch(sql, *args)
    return [_strategy_row_to_dict(r) for r in rows]


async def get_strategy(
    pool: asyncpg.Pool, strategy_id: UUID | str, user_email: str | None = None
) -> dict[str, Any] | None:
    """Lookup by id. If `user_email` is passed, also enforces ownership
    (returns None for someone else's strategy — preserving privacy)."""
    if user_email is None:
        row = await pool.fetchrow(
            """
            SELECT paper_strategy_id, user_email, name, strategy_spec,
                   ticker, event_type, size_usd, started_at, paused_at,
                   active, created_at, updated_at
              FROM paper_strategies
             WHERE paper_strategy_id = $1
            """,
            strategy_id,
        )
    else:
        row = await pool.fetchrow(
            """
            SELECT paper_strategy_id, user_email, name, strategy_spec,
                   ticker, event_type, size_usd, started_at, paused_at,
                   active, created_at, updated_at
              FROM paper_strategies
             WHERE paper_strategy_id = $1 AND user_email = $2
            """,
            strategy_id,
            user_email,
        )
    return _strategy_row_to_dict(row) if row else None


async def create_strategy(
    pool: asyncpg.Pool,
    *,
    user_email: str,
    name: str | None,
    strategy_spec: dict[str, Any],
    ticker: str | None,
    event_type: str | None,
    size_usd: float,
    baseline_backtest_id: str | None = None,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """
        INSERT INTO paper_strategies (
            user_email, name, strategy_spec, ticker, event_type, size_usd,
            baseline_backtest_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING paper_strategy_id, user_email, name, strategy_spec,
                  ticker, event_type, size_usd, started_at, paused_at,
                  active, created_at, updated_at, baseline_backtest_id
        """,
        user_email,
        name,
        json.dumps(strategy_spec),
        ticker,
        event_type,
        size_usd,
        baseline_backtest_id,
    )
    return _strategy_row_to_dict(row)


async def set_strategy_active(
    pool: asyncpg.Pool, strategy_id: UUID | str, user_email: str, active: bool
) -> bool:
    """Pause / resume. Returns True if the row was updated, False if the
    strategy doesn't exist or doesn't belong to this user."""
    result = await pool.execute(
        """
        UPDATE paper_strategies
           SET active = $3,
               paused_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
               updated_at = NOW()
         WHERE paper_strategy_id = $1 AND user_email = $2
        """,
        strategy_id,
        user_email,
        active,
    )
    # asyncpg returns e.g. "UPDATE 1"
    return result.endswith(" 1")


async def delete_strategy(
    pool: asyncpg.Pool, strategy_id: UUID | str, user_email: str
) -> bool:
    """Hard-delete a strategy (and via FK cascade, all its positions)."""
    result = await pool.execute(
        """
        DELETE FROM paper_strategies
         WHERE paper_strategy_id = $1 AND user_email = $2
        """,
        strategy_id,
        user_email,
    )
    return result.endswith(" 1")


async def count_active_strategies(
    pool: asyncpg.Pool, user_email: str
) -> int:
    """Used for tier-gate enforcement before allowing a new strategy."""
    n = await pool.fetchval(
        "SELECT count(*) FROM paper_strategies WHERE user_email = $1 AND active = TRUE",
        user_email,
    )
    return int(n or 0)


# ---------------------------------------------------------------------------
# Position lifecycle — opened by worker on snapshot trigger, closed by
# the same worker's settlement pass.
# ---------------------------------------------------------------------------


async def open_position(
    pool: asyncpg.Pool,
    *,
    strategy_id: UUID | str,
    market_id: str,
    side: str,
    fill_price: float,
    size_usd: float,
    slippage_bps: float,
    fees: float,
    underlying_price: float | None = None,
) -> bool:
    """Insert a virtual trade. Uses ON CONFLICT to gracefully handle the
    case where the worker tries to open twice on the same market (e.g.
    two near-simultaneous snapshots both triggering the strategy).
    Returns True if a new row was inserted, False if the unique-key
    blocked it.

    `underlying_price` captures the BTC/ETH/SOL spot price at the
    moment of trigger so the dashboard can show context next to each
    fill (added in Phase J).
    """
    result = await pool.execute(
        """
        INSERT INTO paper_positions (
            paper_strategy_id, market_id, side,
            fill_price, size_usd, slippage_bps, fees, underlying_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (paper_strategy_id, market_id) DO NOTHING
        """,
        strategy_id,
        market_id,
        side,
        fill_price,
        size_usd,
        slippage_bps,
        fees,
        underlying_price,
    )
    return result.endswith(" 1")


async def settle_positions_for_market(
    pool: asyncpg.Pool,
    *,
    market_id: str,
    resolution_yes_price: float,
) -> int:
    """When a market resolves, close every open position on it.

    Pnl math is identical to backtest/engine.py:_settle_trade_pnl —
    shares = size / fill_price, payoff depends on side, pnl = payoff -
    size (for buys) or size + payoff (for shorts).
    """
    rows = await pool.fetch(
        """
        SELECT paper_position_id, side, fill_price, size_usd
          FROM paper_positions
         WHERE market_id = $1 AND closed_at IS NULL
        """,
        market_id,
    )
    if not rows:
        return 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for r in rows:
                pnl = _compute_pnl(
                    side=r["side"],
                    fill_price=float(r["fill_price"]),
                    size_usd=float(r["size_usd"]),
                    resolution_yes_price=resolution_yes_price,
                )
                await conn.execute(
                    """
                    UPDATE paper_positions
                       SET closed_at = NOW(),
                           resolution_yes_price = $2,
                           pnl = $3
                     WHERE paper_position_id = $1
                    """,
                    r["paper_position_id"],
                    resolution_yes_price,
                    pnl,
                )
    return len(rows)


async def list_positions(
    pool: asyncpg.Pool,
    strategy_id: UUID | str,
    user_email: str,
    *,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """Trades for a strategy (newest first). Joins back through
    paper_strategies for the ownership check so a user can't request
    another user's strategy positions by guessing the id."""
    rows = await pool.fetch(
        """
        SELECT p.paper_position_id, p.market_id, p.side, p.fill_price,
               p.size_usd, p.slippage_bps, p.fees, p.opened_at,
               p.closed_at, p.resolution_yes_price, p.pnl,
               p.underlying_price
          FROM paper_positions p
          JOIN paper_strategies s ON s.paper_strategy_id = p.paper_strategy_id
         WHERE p.paper_strategy_id = $1 AND s.user_email = $2
         ORDER BY p.opened_at DESC
         LIMIT $3
        """,
        strategy_id,
        user_email,
        limit,
    )
    return [_position_row_to_dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _compute_pnl(
    *, side: str, fill_price: float, size_usd: float, resolution_yes_price: float
) -> float:
    """Same math as backtest/engine.py:_settle_trade_pnl. Duplicated
    here (rather than imported) because the worker uses this hot path
    on every resolution event — keeping it inline avoids dragging the
    whole engine module into the paper-trader's import graph."""
    if fill_price <= 0:
        return -size_usd
    shares = size_usd / fill_price
    if side == "buy_yes":
        value = resolution_yes_price
    elif side == "buy_no":
        value = 1.0 - resolution_yes_price
    elif side == "sell_yes":
        value = -resolution_yes_price
    elif side == "sell_no":
        value = -(1.0 - resolution_yes_price)
    else:
        return 0.0
    payoff = shares * value
    if side in ("buy_yes", "buy_no"):
        return payoff - size_usd
    return size_usd + payoff


def _strategy_row_to_dict(row: asyncpg.Record | None) -> dict[str, Any]:
    if row is None:
        return {}
    d = dict(row)
    # JSONB comes back as a string from asyncpg by default.
    if isinstance(d.get("strategy_spec"), str):
        try:
            d["strategy_spec"] = json.loads(d["strategy_spec"])
        except json.JSONDecodeError:
            pass
    # Stringify UUID / Decimal for JSON safety upstream.
    d["paper_strategy_id"] = str(d["paper_strategy_id"])
    if d.get("size_usd") is not None:
        d["size_usd"] = float(d["size_usd"])
    for k in ("started_at", "paused_at", "created_at", "updated_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    return d


def _position_row_to_dict(row: asyncpg.Record) -> dict[str, Any]:
    d = dict(row)
    d["paper_position_id"] = str(d["paper_position_id"])
    for k in ("fill_price", "size_usd", "slippage_bps", "fees", "pnl",
              "resolution_yes_price", "underlying_price"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    for k in ("opened_at", "closed_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    return d
