"""Realistic fill simulation by walking the order book.

This is the most-important component of the backtest engine. Naive backtests
use mid-price and look great on paper, then lose money in production. Walking
the book gives users the same answer they'd see live.

Polymarket fees are 0 (the platform makes money on UMA resolution + spread).
Kalshi charges a maker/taker fee around 0.07 / 1.0% depending on contract.
"""

from __future__ import annotations

from backtest.types import OrderBookLevel, OrderBookSnapshot, Side


# Fees (decimal, applied per side of the trade)
POLYMARKET_FEE = 0.0
KALSHI_FEE_BPS = 7.0  # 7 bps maker, conservative


def _book_for_side(snapshot: OrderBookSnapshot, side: Side) -> list[OrderBookLevel]:
    """Return the order book levels that the trader will hit."""
    if side == Side.BUY_YES:
        return snapshot.yes_asks
    if side == Side.SELL_YES:
        return snapshot.yes_bids
    if side == Side.BUY_NO:
        return snapshot.no_asks
    if side == Side.SELL_NO:
        return snapshot.no_bids
    raise ValueError(f"Unknown side: {side}")


def _best_price(snapshot: OrderBookSnapshot, side: Side) -> float | None:
    levels = _book_for_side(snapshot, side)
    return levels[0].price if levels else None


def walk_book(
    snapshot: OrderBookSnapshot,
    side: Side,
    size_usd: float,
) -> tuple[float, float, float] | None:
    """Walk the book to simulate a real fill.

    Returns (avg_fill_price, filled_size_usd, slippage_bps), or None if the
    book is too thin to fill the trade.

    For Up/Down binary markets, the contract is priced in [0, 1] and 1 share
    pays out $1 at resolution. So size_usd / price = number of shares.
    """
    levels = _book_for_side(snapshot, side)
    if not levels:
        return None

    best = levels[0].price
    if best <= 0 or best >= 1:
        return None

    remaining_usd = size_usd
    total_cost = 0.0
    total_shares = 0.0
    filled_usd = 0.0

    for level in levels:
        # USD value available at this level = price * size (size in shares)
        level_usd_available = level.price * level.size
        if remaining_usd <= level_usd_available:
            # Partial fill at this level
            shares = remaining_usd / level.price
            total_cost += remaining_usd
            total_shares += shares
            filled_usd += remaining_usd
            remaining_usd = 0
            break
        # Take the whole level, continue to next
        total_cost += level_usd_available
        total_shares += level.size
        filled_usd += level_usd_available
        remaining_usd -= level_usd_available

    if total_shares == 0:
        return None

    avg_price = total_cost / total_shares
    # Slippage vs the best price at decision time, in basis points of the
    # binary contract price (a 0.50 → 0.52 fill = 200 bps slippage)
    slippage_bps = abs(avg_price - best) * 10000.0
    return avg_price, filled_usd, slippage_bps


def settlement_payoff(
    side: Side,
    avg_fill_price: float,
    filled_usd: float,
    yes_resolved_price: float,
) -> float:
    """PnL at settlement for one trade.

    yes_resolved_price is 1.0 if YES wins, 0.0 if NO wins (or a fraction for
    scalar markets, though Up/Down is always binary).

    For BUY_YES at price P with N shares:
      cost = N*P
      payoff at resolution = N * yes_resolved_price
      pnl = N * (yes_resolved_price - P)
    """
    shares = filled_usd / avg_fill_price if avg_fill_price > 0 else 0.0
    if side == Side.BUY_YES:
        return shares * (yes_resolved_price - avg_fill_price)
    if side == Side.SELL_YES:
        # Shorting YES = synthetic BUY_NO. PnL = N * (P_yes - resolved_yes_price)
        return shares * (avg_fill_price - yes_resolved_price)
    if side == Side.BUY_NO:
        no_resolved_price = 1.0 - yes_resolved_price
        return shares * (no_resolved_price - avg_fill_price)
    if side == Side.SELL_NO:
        no_resolved_price = 1.0 - yes_resolved_price
        return shares * (avg_fill_price - no_resolved_price)
    raise ValueError(f"Unknown side: {side}")


def platform_fee(platform: str, notional_usd: float) -> float:
    if platform == "kalshi":
        return notional_usd * KALSHI_FEE_BPS / 10000.0
    return notional_usd * POLYMARKET_FEE
