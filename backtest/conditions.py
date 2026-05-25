"""Condition primitives for the no-code Strategy Builder.

A strategy spec submitted from the Strategy Builder UI is a JSON tree
of conditions across three sections (entry / take-profit / stop-loss).
Within a section conditions are joined by AND. (AND/OR groups would
be straightforward to add later — the section evaluator is structured
so it's an additive change.)

A condition is a dict with:
  - type:       primitive name (see PARAM_SPECS)
  - op:         one of >= > <= < == != crosses_above crosses_below
  - value:      numeric threshold
  - side:       "yes" | "no"  (only for primitives that have a side)
  - window_sec: lookback window in seconds (only for volatility primitives)

Each primitive declares its valid operators and any extra fields it
needs — see PARAM_SPECS. The evaluator dispatches to a per-primitive
function. Anything an evaluator can't compute (missing data, missing
context) → returns False; never raises.

Context: the engine passes `ctx` with whatever it has (market_open
snapshot, history). Primitives use only what they need.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from backtest.types import OrderBookSnapshot


# Operator constants ────────────────────────────────────────────────────
OP_GTE = ">="
OP_GT = ">"
OP_LTE = "<="
OP_LT = "<"
OP_EQ = "=="
OP_NEQ = "!="
OP_CROSSES_ABOVE = "crosses_above"
OP_CROSSES_BELOW = "crosses_below"

BASIC_OPS = {OP_GTE, OP_GT, OP_LTE, OP_LT, OP_EQ, OP_NEQ}
CROSS_OPS = {OP_CROSSES_ABOVE, OP_CROSSES_BELOW}
ALL_OPS = BASIC_OPS | CROSS_OPS

# Parameter type constants ──────────────────────────────────────────────
TYPE_TOKEN_PRICE = "token_price"
TYPE_SPREAD = "spread"
TYPE_TIME_TO_RESOLUTION = "time_to_resolution_s"
TYPE_TIME_SINCE_OPEN = "time_since_market_open_s"
TYPE_COIN_MOVE_USD = "coin_move_since_open_usd"
TYPE_COIN_MOVE_PCT = "coin_move_since_open_pct"
TYPE_COIN_VOLATILITY = "coin_price_volatility"
TYPE_TOKEN_VOLATILITY = "token_price_volatility"


# ---------------------------------------------------------------------------
# Parameter specs: a registry of primitives. Frontend ConditionRow reads
# the same spec shape (re-declared in TS) to drive UI behaviour — keep
# this list in sync with web/components/StrategyBuilder.tsx
# ---------------------------------------------------------------------------


@dataclass
class ParamSpec:
    type: str
    valid_ops: set[str]
    has_side: bool = False
    needs_window: bool = False


PARAM_SPECS: dict[str, ParamSpec] = {
    TYPE_TOKEN_PRICE: ParamSpec(
        type=TYPE_TOKEN_PRICE,
        valid_ops=BASIC_OPS | CROSS_OPS,
        has_side=True,
    ),
    TYPE_SPREAD: ParamSpec(
        type=TYPE_SPREAD,
        valid_ops={OP_GTE, OP_GT, OP_LTE, OP_LT},
        has_side=True,
    ),
    TYPE_TIME_TO_RESOLUTION: ParamSpec(
        type=TYPE_TIME_TO_RESOLUTION,
        valid_ops={OP_GTE, OP_GT, OP_LTE, OP_LT},
    ),
    TYPE_TIME_SINCE_OPEN: ParamSpec(
        type=TYPE_TIME_SINCE_OPEN,
        valid_ops={OP_GTE, OP_GT, OP_LTE, OP_LT},
    ),
    TYPE_COIN_MOVE_USD: ParamSpec(
        type=TYPE_COIN_MOVE_USD,
        valid_ops=BASIC_OPS | CROSS_OPS,
    ),
    TYPE_COIN_MOVE_PCT: ParamSpec(
        type=TYPE_COIN_MOVE_PCT,
        valid_ops=BASIC_OPS | CROSS_OPS,
    ),
    TYPE_COIN_VOLATILITY: ParamSpec(
        type=TYPE_COIN_VOLATILITY,
        valid_ops={OP_GTE, OP_GT, OP_LTE, OP_LT},
        needs_window=True,
    ),
    TYPE_TOKEN_VOLATILITY: ParamSpec(
        type=TYPE_TOKEN_VOLATILITY,
        valid_ops={OP_GTE, OP_GT, OP_LTE, OP_LT},
        has_side=True,
        needs_window=True,
    ),
}


# ---------------------------------------------------------------------------
# Per-primitive value extractors. Each returns a *float* (current LHS)
# or None when the value can't be computed for this snapshot.
# ---------------------------------------------------------------------------


def _mid_for(snapshot: OrderBookSnapshot, side: str) -> float | None:
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


def _underlying_price(snapshot: OrderBookSnapshot) -> float | None:
    return snapshot.underlying_price if snapshot.underlying_price is not None else None


def _market_open_underlying(ctx: dict[str, Any]) -> float | None:
    mo = ctx.get("market_open")
    return mo.underlying_price if mo and mo.underlying_price is not None else None


def _market_open_ts(ctx: dict[str, Any]) -> datetime | None:
    mo = ctx.get("market_open")
    return mo.ts if mo else None


def _eval_token_price(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    return _mid_for(snap, c.get("side", "yes"))


def _eval_spread(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    return _spread_for(snap, c.get("side", "yes"))


def _eval_time_to_resolution(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    res = ctx.get("resolution_at")
    if res is None:
        return None
    return (res - snap.ts).total_seconds()


def _eval_time_since_open(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    open_ts = _market_open_ts(ctx)
    if open_ts is None:
        return None
    return (snap.ts - open_ts).total_seconds()


def _eval_coin_move_usd(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    cur = _underlying_price(snap)
    start = _market_open_underlying(ctx)
    if cur is None or start is None:
        return None
    return cur - start


def _eval_coin_move_pct(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    cur = _underlying_price(snap)
    start = _market_open_underlying(ctx)
    if cur is None or start is None or start == 0:
        return None
    return (cur - start) / start * 100.0


def _stddev_over_window(
    snap: OrderBookSnapshot,
    history: list[OrderBookSnapshot],
    window_sec: float,
    value_fn: Callable[[OrderBookSnapshot], float | None],
) -> float | None:
    """Population stddev of value_fn over snapshots within window_sec of
    the current snapshot, walking backwards through history. Returns
    None if fewer than 2 samples are available — caller treats it as
    "condition unmet" so we don't fire on noise."""
    values: list[float] = []
    cur_v = value_fn(snap)
    if cur_v is not None:
        values.append(cur_v)
    for past in reversed(history):
        dt = (snap.ts - past.ts).total_seconds()
        if dt > window_sec:
            break
        v = value_fn(past)
        if v is not None:
            values.append(v)
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    var = sum((x - mean) ** 2 for x in values) / len(values)
    return var ** 0.5


def _eval_coin_volatility(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    try:
        window = float(c.get("window_sec", 60))
    except (TypeError, ValueError):
        return None
    history = ctx.get("history") or []
    return _stddev_over_window(snap, history, window, _underlying_price)


def _eval_token_volatility(c: dict, snap: OrderBookSnapshot, ctx: dict) -> float | None:
    try:
        window = float(c.get("window_sec", 60))
    except (TypeError, ValueError):
        return None
    history = ctx.get("history") or []
    side = c.get("side", "yes")
    return _stddev_over_window(snap, history, window, lambda s: _mid_for(s, side))


EVALUATORS: dict[str, Callable[[dict, OrderBookSnapshot, dict], float | None]] = {
    TYPE_TOKEN_PRICE: _eval_token_price,
    TYPE_SPREAD: _eval_spread,
    TYPE_TIME_TO_RESOLUTION: _eval_time_to_resolution,
    TYPE_TIME_SINCE_OPEN: _eval_time_since_open,
    TYPE_COIN_MOVE_USD: _eval_coin_move_usd,
    TYPE_COIN_MOVE_PCT: _eval_coin_move_pct,
    TYPE_COIN_VOLATILITY: _eval_coin_volatility,
    TYPE_TOKEN_VOLATILITY: _eval_token_volatility,
}


# ---------------------------------------------------------------------------
# Operator application — handles basic comparisons + crosses_above/below.
# Crosses ops need a previous-value reference, which the section
# evaluator threads in via `prev_value` (a dict keyed by a condition
# fingerprint so multiple cross-conditions in one section don't trample
# each other's state).
# ---------------------------------------------------------------------------


def _apply_basic_op(lhs: float, op: str, rhs: float) -> bool:
    if op == OP_GTE: return lhs >= rhs
    if op == OP_GT:  return lhs > rhs
    if op == OP_LTE: return lhs <= rhs
    if op == OP_LT:  return lhs < rhs
    if op == OP_EQ:  return lhs == rhs
    if op == OP_NEQ: return lhs != rhs
    return False


def _condition_key(condition: dict) -> str:
    """Stable fingerprint so cross-state is per-condition, not shared
    across the section. (type|side|window|op|value)"""
    return "|".join(
        str(condition.get(k, "")) for k in ("type", "side", "window_sec", "op", "value")
    )


def evaluate_one(
    condition: dict[str, Any],
    snapshot: OrderBookSnapshot,
    *,
    resolution_at: datetime | None = None,
    market_open: OrderBookSnapshot | None = None,
    history: list[OrderBookSnapshot] | None = None,
    cross_state: dict[str, float] | None = None,
) -> bool:
    """Evaluate a single primitive against the current snapshot."""
    ctype = condition.get("type")
    op = condition.get("op")
    spec = PARAM_SPECS.get(ctype)
    if spec is None or op not in spec.valid_ops:
        return False
    try:
        value = float(condition.get("value"))
    except (TypeError, ValueError):
        return False

    evaluator = EVALUATORS.get(ctype)
    if evaluator is None:
        return False

    ctx = {
        "resolution_at": resolution_at,
        "market_open": market_open,
        "history": history or [],
    }
    lhs = evaluator(condition, snapshot, ctx)
    if lhs is None:
        return False

    if op in BASIC_OPS:
        return _apply_basic_op(lhs, op, value)

    # Crosses ops require a previous lhs value to detect the transition.
    # First evaluation has no prior reference → return False, just record.
    if cross_state is None:
        return False
    key = _condition_key(condition)
    prev = cross_state.get(key)
    cross_state[key] = lhs
    if prev is None:
        return False
    if op == OP_CROSSES_ABOVE:
        return prev < value <= lhs
    if op == OP_CROSSES_BELOW:
        return prev > value >= lhs
    return False


def evaluate_section(
    conditions: list[dict[str, Any]],
    snapshot: OrderBookSnapshot,
    *,
    resolution_at: datetime | None = None,
    market_open: OrderBookSnapshot | None = None,
    history: list[OrderBookSnapshot] | None = None,
    cross_state: dict[str, float] | None = None,
) -> bool:
    """AND across all conditions in the section."""
    if not conditions:
        return False
    for c in conditions:
        if not evaluate_one(
            c, snapshot,
            resolution_at=resolution_at,
            market_open=market_open,
            history=history,
            cross_state=cross_state,
        ):
            return False
    return True


# ---------------------------------------------------------------------------
# Plain-English summary (server-side; UI computes its own for live
# editing). Stamped on saved backtests so a result page shows what was
# submitted in human terms.
# ---------------------------------------------------------------------------


@dataclass
class ReadAs:
    entry: str
    take_profit: str | None
    stop_loss: str | None
    trade_logic: str


_OP_TO_EN = {
    OP_GTE: "is at least",
    OP_GT: "is greater than",
    OP_LTE: "is at most",
    OP_LT: "is less than",
    OP_EQ: "equals",
    OP_NEQ: "does not equal",
    OP_CROSSES_ABOVE: "crosses above",
    OP_CROSSES_BELOW: "crosses below",
}


def _humanise_condition(c: dict[str, Any]) -> str:
    ctype = c.get("type")
    op = c.get("op", OP_EQ)
    val = c.get("value")
    side = (c.get("side") or "").upper()
    op_en = _OP_TO_EN.get(op, op)
    if ctype == TYPE_TOKEN_PRICE:
        return f"{side} token price {op_en} {val}"
    if ctype == TYPE_SPREAD:
        return f"{side} spread {op_en} {val}"
    if ctype == TYPE_TIME_TO_RESOLUTION:
        return f"time to resolution {op_en} {val}s"
    if ctype == TYPE_TIME_SINCE_OPEN:
        return f"time since open {op_en} {val}s"
    if ctype == TYPE_COIN_MOVE_USD:
        return f"coin move since open {op_en} ${val}"
    if ctype == TYPE_COIN_MOVE_PCT:
        return f"coin move since open {op_en} {val}%"
    if ctype == TYPE_COIN_VOLATILITY:
        return f"coin price σ over {c.get('window_sec', 60)}s {op_en} {val}"
    if ctype == TYPE_TOKEN_VOLATILITY:
        return f"{side} token σ over {c.get('window_sec', 60)}s {op_en} {val}"
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
