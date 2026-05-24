"""Database clients: ClickHouse (timeseries) + Postgres (metadata)."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import asyncpg
import clickhouse_connect
from clickhouse_connect.driver.asyncclient import AsyncClient

from collector.config import Settings


async def make_clickhouse(settings: Settings) -> AsyncClient:
    return await clickhouse_connect.get_async_client(
        host=settings.clickhouse_host,
        port=settings.clickhouse_port,
        username=settings.clickhouse_user,
        password=settings.clickhouse_password,
        database=settings.clickhouse_db,
        compress="zstd",
    )


async def make_postgres_pool(settings: Settings) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn=settings.postgres_dsn,
        min_size=1,
        max_size=4,
        command_timeout=15,
    )


async def insert_orderbook_snapshots(
    ch: AsyncClient,
    rows: Iterable[tuple[Any, ...]],
) -> None:
    """Bulk insert orderbook snapshots.

    Column order must match the CREATE TABLE in db/clickhouse_init.sql.
    """
    column_names = [
        "market_id",
        "ts",
        "yes_bids",
        "yes_asks",
        "no_bids",
        "no_asks",
        "best_yes_bid",
        "best_yes_ask",
        "mid_yes",
        "spread_yes",
        "underlying_ticker",
        "underlying_price",
        "source",
    ]
    await ch.insert(
        table="orderbook_snapshots",
        data=list(rows),
        column_names=column_names,
    )


async def insert_trades(
    ch: AsyncClient,
    rows: Iterable[tuple[Any, ...]],
) -> None:
    column_names = [
        "trade_id",
        "market_id",
        "ts",
        "side",
        "price",
        "size",
        "maker_address",
        "taker_address",
        "tx_hash",
    ]
    await ch.insert(
        table="trades",
        data=list(rows),
        column_names=column_names,
    )


async def insert_underlying_prices(
    ch: AsyncClient,
    rows: Iterable[tuple[Any, ...]],
) -> None:
    column_names = ["ticker", "ts", "price", "confidence", "source"]
    await ch.insert(
        table="underlying_prices",
        data=list(rows),
        column_names=column_names,
    )


async def insert_binance_spot_trades(
    ch: AsyncClient,
    rows: Iterable[tuple[Any, ...]],
) -> None:
    column_names = [
        "ticker",
        "bucket",
        "price_open",
        "price_high",
        "price_low",
        "price_close",
        "total_volume",
        "num_trades",
        "aggressive_buy_volume",
        "aggressive_sell_volume",
    ]
    await ch.insert(
        table="binance_spot_trades",
        data=list(rows),
        column_names=column_names,
    )


async def insert_heartbeat(
    ch: AsyncClient,
    worker_id: str,
    ts: Any,
    markets_tracked: int,
    messages_received: int,
    last_error: str = "",
) -> None:
    await ch.insert(
        table="collector_heartbeats",
        data=[(worker_id, ts, markets_tracked, messages_received, last_error)],
        column_names=[
            "worker_id",
            "ts",
            "markets_tracked",
            "messages_received",
            "last_error",
        ],
    )
