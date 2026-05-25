"""Condition primitives for the no-code Strategy Builder.

A strategy spec submitted from the Strategy Builder UI is a JSON tree
of conditions across three sections (entry / take-profit / stop-loss).
Within a section conditions are joined by AND.

Why AND-only in v1: AND is sufficient for the most common no-code
strategies on PolyBackTest — "Token UP price >= 0.6 AND time to
resolution <= 5 min".  AND/OR groups are a Phase M.2 polish item.
The evaluator is structured so adding OR later is purely additive.

A condition is a dict with:
  - type:  primitive name, one of TOKEN_PRICE / SPREAD / TIME_TO_RES
  - op:    one of >= > <= < == !=
  - value: numeric threshold
  - side:  "yes" | "no" (only for primitives that have a side, e.g. token_price)

The evaluator takes an OrderBookSnapshot, the market's resolution_at
timestamp, and an optional open position (for TP/SL evaluation), and
returns True / False.

Anything the evaluator can't compute (missing book side, missing
resolution_at) → returns False rather than raising, so a half-built
strategy in the UI doesn't crash the worker.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from backtest.types import OrderBookSnapshot


# Type names — kept as bare strings (not an enum) so the JSON spec
# coming from the UI stays human-readable + the spec can be saved /
# re-loaded without enum dependencies.
TYPE_TOKEN_PRICE = "token_price"
TYPE_SPREAD = "spread"
TYPE_TIME_TO_RESOLUTION = "time_to_resolution_s"
SUPPORTED_TYPES = {TYPE_TOKEN_PRICE, TYPE_SPREAD, TYPE_TIME_TO_RESOLUTION}

SUPPORTED_OPS = {">=", ">", "<=", "<", "==", "!="}

Op = Literal[">=", ">", "<=", "<", "==", "!="]


def _mid_for(snapshot: OrderBookSnapshot, side: str) -> float | None:
    """Mid of the requested side. side ∈ {'yes', 'no'}."""
    side = (side or "").lower()
    if side == "yes":
        if snapshot.yes_bids and snapshot.yes_asks:
            return (snapshot.yes_bids[0].price + snapshot.yes_asks[0].price) / 2
    elif side == "no":
        if snapshot.no_bids and snapshot.no_asks:
            return (snapshot.no_bids[0].price + snapshot.no_asks[0].price) / 2
    return None


def _spread_for(snapshot: OrderBookSnapshot, side: str) -> float | None:
    side = (side or "").lower()
    if side == "yes":
        if snapshot.yes_bids and snapshot.yes_asks:
            return snapshot.yes_asks[0].price - snapshot.yes_bids[0].price
    elif side == "no":
        if snapshot.no_bids and snapshot.no_asks:
            return snapshot.no_asks[0].price - snapshot.no_bids[0].price
    return None


def _apply_op(lhs: float, op: str, rhs: float) -> bool:
    if op == ">=": return lhs >= rhs
    if op == ">":  return lhs > rhs
    if op == "<=": return lhs <= rhs
    if op == "<":  return lhs < rhs
    if op == "==": return lhs == rhs
    if op == "!=": return lhs != rhs
    return False


def evaluate_one(
    condition: dict[str, Any],
    snapshot: OrderBookSnapshot,
    *,
    resolution_at: datetime | None,
) -> bool:
    """Evaluate a single primitive against the current snapshot.

    Returns False (not None / not raised) for any of:
      - unknown type or op
      - missing book side
      - missing resolution_at when the condition needs it
      - non-numeric value

    The caller (a section evaluator) then ANDs across conditions.
    """
    ctype = condition.get("type")
    op = condition.get("op")
    if ctype not in SUPPORTED_TYPES or op not in SUPPORTED_OPS:
        return False
    try:
        value = float(condition.get("value"))
    except (TypeError, ValueError):
        return False

    if ctype == TYPE_TOKEN_PRICE:
        lhs = _mid_for(snapshot, condition.get("side", "yes"))
    elif ctype == TYPE_SPREAD:
        lhs = _spread_for(snapshot, condition.get("side", "yes"))
    elif ctype == TYPE_TIME_TO_RESOLUTION:
        if resolution_at is None:
            return False
        # Total seconds from "now" (= snapshot timestamp) to resolution.
        # Always non-negative during a backtest replay — the engine
        # stops feeding snapshots once the market resolves.
        lhs = (resolution_at - snapshot.ts).total_seconds()
    else:
        return False

    if lhs is None:
        return False
    return _apply_op(lhs, op, value)


def evaluate_section(
    conditions: list[dict[str, Any]],
    snapshot: OrderBookSnapshot,
    *,
    resolution_at: datetime | None,
) -> bool:
    """AND across all conditions in the section.

    Empty list → False (UI never submits an entry section with no rules
    because the Run button is gated, but defensively the worker should
    refuse rather than fire on every snapshot).
    """
    if not conditions:
        return False
    for c in conditions:
        if not evaluate_one(c, snapshot, resolution_at=resolution_at):
            return False
    return True


# ---------------------------------------------------------------------------
# Plain-English summary (server-side; the UI generates its own for live
# editing, but we also produce one server-side to stamp on saved
# backtests so a result page can show what the user submitted).
# ---------------------------------------------------------------------------


@dataclass
class ReadAs:
    entry: str
    take_profit: str | None
    stop_loss: str | None
    trade_logic: str


_OP_TO_EN = {">=": "is at least", ">": "is greater than",
             "<=": "is at most",  "<": "is less than",
             "==": "equals",      "!=": "does not equal"}


def _humanise_condition(c: dict[str, Any]) -> str:
    ctype = c.get("type")
    op = c.get("op", "==")
    val = c.get("value")
    side = c.get("side", "yes").upper()
    op_en = _OP_TO_EN.get(op, op)
    if ctype == TYPE_TOKEN_PRICE:
        return f"{side} token price {op_en} {val}"
    if ctype == TYPE_SPREAD:
        return f"{side} spread {op_en} {val}"
    if ctype == TYPE_TIME_TO_RESOLUTION:
        return f"time to resolution {op_en} {val}s"
    return f"{ctype} {op} {val}"


def humanise(
    *,
    entry: list[dict[str, Any]],
    take_profit: list[dict[str, Any]] | None,
    stop_loss: list[dict[str, Any]] | None,
    trade_logic: str,
) -> ReadAs:
    entry_en = (
        " AND ".join(_humanise_condition(c) for c in entry)
        if entry
        else "no entry rules"
    )
    tp_en = (
        " AND ".join(_humanise_condition(c) for c in take_profit)
        if take_profit
        else None
    )
    sl_en = (
        " AND ".join(_humanise_condition(c) for c in stop_loss)
        if stop_loss
        else None
    )
    logic_en = "buy UP" if trade_logic == "always_up" else "buy DOWN"
    return ReadAs(entry=entry_en, take_profit=tp_en, stop_loss=sl_en, trade_logic=logic_en)
