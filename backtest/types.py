"""Shared types for the backtest engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Literal


class Platform(str, Enum):
    POLYMARKET = "polymarket"
    KALSHI = "kalshi"


class Side(str, Enum):
    BUY_YES = "buy_yes"
    SELL_YES = "sell_yes"
    BUY_NO = "buy_no"
    SELL_NO = "sell_no"


@dataclass(frozen=True)
class OrderBookLevel:
    price: float            # In [0, 1]
    size: float


@dataclass(frozen=True)
class OrderBookSnapshot:
    market_id: str
    ts: datetime
    yes_bids: list[OrderBookLevel]
    yes_asks: list[OrderBookLevel]
    no_bids: list[OrderBookLevel]
    no_asks: list[OrderBookLevel]
    underlying_price: float | None
    underlying_ticker: str


@dataclass(frozen=True)
class Resolution:
    market_id: str
    resolved_at: datetime
    outcome_yes_price: float    # 1.0 if YES resolved true, 0.0 if NO


@dataclass(frozen=True)
class Trade:
    """A simulated trade executed during backtest.

    `pnl` is populated AFTER the market resolves. For an open trade
    (during replay) it's None; once the engine knows the resolution
    outcome, it rewrites the Trade with the realised P&L:

      shares      = size / price
      payoff      = shares * resolution_value   (1.0 if your side won, 0 otherwise)
      pnl         = payoff - size               (positive = profit; capped at -size)

    `fees` is the platform fee paid at fill time, separated out so the
    frontend can show net-of-fees P&L without re-computing.
    """
    ts: datetime
    market_id: str
    side: Side
    price: float           # Average fill price after walking the book
    size: float            # USD notional
    slippage_bps: float    # vs best price at decision time
    pnl: float | None = None      # gross P&L (excl. fees); None until settled
    fees: float = 0.0             # platform fee paid for this fill
    resolution_yes_price: float | None = None  # 1.0 or 0.0 once known


@dataclass
class BacktestResult:
    trades: list[Trade] = field(default_factory=list)
    total_pnl: float = 0.0
    total_fees: float = 0.0
    win_rate: float = 0.0
    sharpe: float | None = None
    max_drawdown: float = 0.0
    n_markets: int = 0

    def to_dict(self) -> dict:
        return {
            "trades": [
                {
                    "ts": t.ts.isoformat(),
                    "market_id": t.market_id,
                    "side": t.side.value,
                    "price": t.price,
                    "size": t.size,
                    "slippage_bps": t.slippage_bps,
                    "pnl": t.pnl,
                    "fees": t.fees,
                    "resolution_yes_price": t.resolution_yes_price,
                }
                for t in self.trades
            ],
            "total_pnl": self.total_pnl,
            "total_fees": self.total_fees,
            "win_rate": self.win_rate,
            "sharpe": self.sharpe,
            "max_drawdown": self.max_drawdown,
            "n_markets": self.n_markets,
            "n_trades": len(self.trades),
        }


# ---------------------------------------------------------------------------
# Strategy interface
# ---------------------------------------------------------------------------

# A strategy is a callable: (history, current_snapshot) -> action.
# history is the recent snapshots for the same market (or empty list).
# action is either None (no trade), or a tuple (Side, size_usd).

Action = tuple[Side, float] | None
Strategy = "Callable[[list[OrderBookSnapshot], OrderBookSnapshot], Action]"

# Stored strategies are parameterised dicts so users can submit them via API
# without sending Python code. The engine maps strategy_type → callable.
StrategySpec = dict[str, Literal[str, float, int, bool, list, dict]]
