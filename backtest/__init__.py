"""Backtest engine for prediction market Up/Down strategies.

Reads historical orderbook snapshots + resolution outcomes from ClickHouse,
replays strategies with realistic slippage, returns per-trade and aggregate
PnL.

This is the actual product. The collector is infrastructure.
"""
