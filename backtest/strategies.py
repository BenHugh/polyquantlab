"""Built-in strategy primitives.

Users submit a strategy as a dict spec (no Python code from clients). The
engine maps the spec to one of these built-in callables.

This is the same model as QuantConnect Lean's "indicator strategies" or
Coinrule's "rules" — safer than executing arbitrary user code, and good
enough for the 90% of strategies people actually want to test.
"""

from __future__ import annotations

from typing import Any

from backtest.types import Action, OrderBookSnapshot, Side


def _mid(snapshot: OrderBookSnapshot) -> float | None:
    if snapshot.yes_bids and snapshot.yes_asks:
        return (snapshot.yes_bids[0].price + snapshot.yes_asks[0].price) / 2
    return None


# ---------------------------------------------------------------------------
# Threshold entry: buy YES if implied probability crosses a threshold
# ---------------------------------------------------------------------------


def threshold_entry(
    history: list[OrderBookSnapshot],
    current: OrderBookSnapshot,
    *,
    threshold: float,
    direction: str = "below",
    side: str = "buy_yes",
    size_usd: float = 100.0,
) -> Action:
    """Enter a position when YES mid price crosses `threshold`.

    Args:
        threshold: e.g. 0.30 — fire when YES drops below 30%
        direction: "below" or "above"
        side: which way to trade once triggered
        size_usd: notional position size
    """
    mid = _mid(current)
    if mid is None:
        return None
    triggered = (direction == "below" and mid < threshold) or (
        direction == "above" and mid > threshold
    )
    if not triggered:
        return None
    return Side(side), size_usd


# ---------------------------------------------------------------------------
# Mean reversion: buy YES when mid is N standard deviations below the
# rolling mean of the last lookback minutes
# ---------------------------------------------------------------------------


def mean_reversion(
    history: list[OrderBookSnapshot],
    current: OrderBookSnapshot,
    *,
    lookback: int = 30,
    z_threshold: float = 2.0,
    size_usd: float = 100.0,
) -> Action:
    if len(history) < lookback:
        return None
    recent = history[-lookback:]
    mids = [m for m in (_mid(s) for s in recent) if m is not None]
    if len(mids) < 5:
        return None
    mean = sum(mids) / len(mids)
    var = sum((m - mean) ** 2 for m in mids) / len(mids)
    std = var**0.5
    if std == 0:
        return None
    current_mid = _mid(current)
    if current_mid is None:
        return None
    z = (current_mid - mean) / std
    if z <= -z_threshold:
        return Side.BUY_YES, size_usd
    if z >= z_threshold:
        return Side.BUY_NO, size_usd
    return None


# ---------------------------------------------------------------------------
# Time-based: enter X minutes before resolution
# ---------------------------------------------------------------------------


def time_before_resolution(
    history: list[OrderBookSnapshot],
    current: OrderBookSnapshot,
    *,
    minutes_before: int = 60,
    minutes_window: int = 5,
    side: str = "buy_yes",
    size_usd: float = 100.0,
    resolution_at: Any = None,
) -> Action:
    if resolution_at is None:
        return None
    delta_minutes = (resolution_at - current.ts).total_seconds() / 60.0
    if minutes_before - minutes_window <= delta_minutes <= minutes_before + minutes_window:
        return Side(side), size_usd
    return None


# ---------------------------------------------------------------------------
# Registry — strategy_type from API spec → callable
# ---------------------------------------------------------------------------

STRATEGY_REGISTRY = {
    "threshold_entry": threshold_entry,
    "mean_reversion": mean_reversion,
    "time_before_resolution": time_before_resolution,
}


def build_strategy(spec: dict[str, Any]):
    """Turn a JSON spec into a partial(callable, **kwargs).

    Example spec:
      {"type": "threshold_entry", "threshold": 0.30, "direction": "below",
       "side": "buy_yes", "size_usd": 100}
    """
    import functools

    strategy_type = spec.get("type")
    if strategy_type not in STRATEGY_REGISTRY:
        raise ValueError(f"Unknown strategy type: {strategy_type}")
    fn = STRATEGY_REGISTRY[strategy_type]
    kwargs = {k: v for k, v in spec.items() if k != "type"}
    return functools.partial(fn, **kwargs)
