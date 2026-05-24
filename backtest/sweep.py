"""Parameter sweep — run a strategy over a grid of parameter values.

The naive implementation would be `for cell in grid: run_backtest(...)`,
but each run_backtest re-loads the same market data from ClickHouse. For
a 400-cell sweep that's 400× the I/O cost of a single backtest.

This module separates the two costs:
  - "Load universe" — happens ONCE per sweep (the expensive part).
  - "Replay strategy on cached snapshots" — happens once per CELL
    (pure Python, ~50ms each).

The cache lives entirely in the worker process memory; for a 200-market
universe with 5min markets it's about 100 MB peak. Single-machine workers
trivially handle it.

Output: 2D grid of summary stats per cell (PnL / Sharpe / win rate /
drawdown / n_trades / n_markets). We deliberately do NOT keep per-cell
trade lists — for a 2500-cell Premium sweep that would be 25-100 MB of
JSON to ship to the browser. If the user wants trade detail for a
specific cell, they re-run a single backtest with those params.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime
from typing import Any, Iterable

import asyncpg
from clickhouse_connect.driver.asyncclient import AsyncClient

from backtest.data_loader import (
    list_resolved_markets,
    load_resolution,
    load_snapshots,
)
from backtest.engine import (
    _max_drawdown,
    _replay_single_market,
    _sharpe_ratio,
)
from backtest.strategies import build_strategy


# Concurrency cap for the universe-load phase. Same as run_backtest —
# ClickHouse + Postgres easily handle 50 parallel queries on our VPS.
_LOAD_CONCURRENCY = 50

# Hard cap on cells per sweep. Tier-specific caps in the API layer; this
# is a safety belt against an internal-secret caller asking for 1M cells.
_MAX_CELLS_HARD = 5000


def _axis_values(axis: dict[str, Any] | None) -> list[float] | list[None]:
    """Generate the numeric values for one axis of the grid.

    The axis spec is `{param: "threshold", start: 0.1, end: 0.5, steps: 5}`.
    A `None` axis (caller passed nothing) yields a single-element list so
    callers can treat 1D sweeps as degenerate 2D ones without branching.
    """
    if axis is None:
        return [None]
    start = float(axis["start"])
    end = float(axis["end"])
    steps = int(axis.get("steps", 5))
    if steps < 1:
        steps = 1
    if steps == 1:
        return [start]
    # Evenly spaced inclusive of both endpoints.
    step = (end - start) / (steps - 1)
    return [start + i * step for i in range(steps)]


async def _load_universe_cache(
    ch: AsyncClient,
    pg_pool: asyncpg.Pool,
    universe: list[dict[str, Any]],
    since: datetime | None,
) -> list[tuple[dict[str, Any], Any, list[Any]]]:
    """Pre-load (market, resolution, snapshots) tuples for every market.

    Markets that have no resolution or no snapshots get filtered out
    here — there's no point letting them re-fail on every cell.
    """
    sem = asyncio.Semaphore(_LOAD_CONCURRENCY)

    async def _one(m: dict[str, Any]):
        market_id = m["market_id"]
        async with sem:
            try:
                resolution = await load_resolution(pg_pool, market_id)
                if resolution is None:
                    return None
                start = since or resolution.resolved_at.replace(hour=0, minute=0)
                snapshots = await load_snapshots(
                    ch,
                    market_id=market_id,
                    start=start,
                    end=resolution.resolved_at,
                )
                if not snapshots:
                    return None
                return (m, resolution, snapshots)
            except Exception:  # noqa: BLE001
                return None

    results = await asyncio.gather(*[_one(m) for m in universe])
    return [r for r in results if r is not None]


def _replay_grid_cell(
    cached: list[tuple[dict[str, Any], Any, list[Any]]],
    strategy,
) -> dict[str, Any]:
    """Run one strategy across the cached universe; return summary stats."""
    total_pnl = 0.0
    total_fees = 0.0
    n_trades = 0
    wins = 0
    losses = 0
    per_market_pnls: list[float] = []

    for m, resolution, snapshots in cached:
        trades, pnl, fees = _replay_single_market(
            snapshots,
            strategy,
            m["resolution_at"],
            resolution.outcome_yes_price,
        )
        if not trades:
            continue
        total_pnl += pnl
        total_fees += fees
        n_trades += len(trades)
        per_market_pnls.append(pnl - fees)
        if pnl > fees:
            wins += 1
        else:
            losses += 1

    win_rate = wins / (wins + losses) if (wins + losses) > 0 else 0.0
    return {
        "total_pnl": total_pnl,
        "total_fees": total_fees,
        "net_pnl": total_pnl - total_fees,
        "win_rate": win_rate,
        "sharpe": _sharpe_ratio(per_market_pnls),
        "max_drawdown": _max_drawdown(per_market_pnls),
        "n_trades": n_trades,
        "n_markets": wins + losses,
    }


async def run_sweep(
    *,
    ch: AsyncClient,
    pg_pool: asyncpg.Pool,
    base_strategy_spec: dict[str, Any],
    x_axis: dict[str, Any],
    y_axis: dict[str, Any] | None,
    event_type: str | None,
    ticker: str | None,
    since: datetime | None,
    until: datetime | None,
    market_limit: int,
) -> dict[str, Any]:
    """Run a parameter sweep. Returns a 2D (or 1D-as-degenerate-2D) grid
    of summary stats keyed by axis index.

    See module docstring for the architectural shape. The expensive part
    is `_load_universe_cache`; everything after is pure CPU work in
    Python (a few ms per cell for typical sweeps).
    """
    x_values = _axis_values(x_axis)
    y_values: Iterable[Any] = _axis_values(y_axis) if y_axis else [None]
    n_cells = len(x_values) * len(list(y_values))
    if n_cells > _MAX_CELLS_HARD:
        raise ValueError(
            f"Sweep too large: {n_cells} cells exceeds the hard ceiling of "
            f"{_MAX_CELLS_HARD}. Reduce axis steps."
        )

    # Phase 1: universe load (ONCE)
    universe = await list_resolved_markets(
        pg_pool,
        event_type=event_type,
        ticker=ticker,
        since=since,
        until=until,
        limit=market_limit,
    )
    cached = await _load_universe_cache(ch, pg_pool, universe, since)

    # Phase 2: per-cell replay (pure Python, no I/O)
    y_values_list = _axis_values(y_axis) if y_axis else [None]
    cells: list[list[dict[str, Any]]] = []
    for yv in y_values_list:
        row: list[dict[str, Any]] = []
        for xv in x_values:
            spec = dict(base_strategy_spec)
            spec[x_axis["param"]] = xv
            if y_axis is not None and yv is not None:
                spec[y_axis["param"]] = yv
            try:
                strategy = build_strategy(spec)
                summary = _replay_grid_cell(cached, strategy)
            except Exception as exc:  # noqa: BLE001
                # One bad cell shouldn't poison the whole sweep — record
                # the error and continue. UI will render an X on that
                # cell.
                summary = {
                    "error": f"{type(exc).__name__}: {exc}",
                    "total_pnl": 0.0,
                    "net_pnl": 0.0,
                    "win_rate": 0.0,
                    "sharpe": None,
                    "max_drawdown": 0.0,
                    "n_trades": 0,
                    "n_markets": 0,
                }
            row.append(summary)
        cells.append(row)

    # Identify "best" cell for each metric — frontend uses this to draw a
    # marker. We pick the cell that maximises `net_pnl` (post-fees) by
    # default; the UI can recompute "best" for any other metric since the
    # full grid is in the response.
    best_x, best_y, best_val = 0, 0, -math.inf
    for yi, row in enumerate(cells):
        for xi, cell in enumerate(row):
            v = cell.get("net_pnl")
            if v is not None and v > best_val:
                best_val = v
                best_x, best_y = xi, yi

    return {
        "x_axis": {
            "param": x_axis["param"],
            "values": x_values,
            "steps": len(x_values),
        },
        "y_axis": (
            {
                "param": y_axis["param"],
                "values": y_values_list,
                "steps": len(y_values_list),
            }
            if y_axis is not None
            else None
        ),
        "cells": cells,
        "best": {"x_idx": best_x, "y_idx": best_y, "net_pnl": best_val},
        "n_cells": n_cells,
        "n_markets_in_universe": len(cached),
        "n_markets_requested": len(universe),
    }
