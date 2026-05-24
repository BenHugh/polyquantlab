from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ClickHouse
    clickhouse_host: str = "localhost"
    clickhouse_port: int = 8123
    clickhouse_user: str = "stock"
    clickhouse_password: str = "changeme"
    clickhouse_db: str = "stock"

    # Postgres
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "stock"
    postgres_password: str = "changeme"
    postgres_db: str = "stock"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Polymarket
    polymarket_gamma_api: str = "https://gamma-api.polymarket.com"
    polymarket_clob_api: str = "https://clob.polymarket.com"
    polymarket_ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

    # Binance (spot price — futures is geo-blocked from most DC IP ranges)
    binance_ws_spot: str = "wss://stream.binance.com:9443/stream"
    binance_ws_futures: str = "wss://fstream.binance.com/stream"
    binance_rest: str = "https://api.binance.com"

    # Bybit V5 (substitute for Binance futures — not geo-blocked from DC IPs)
    bybit_ws_linear: str = "wss://stream.bybit.com/v5/public/linear"

    # Collector scope: BTC/ETH/SOL only (same as the competitor PolyBackTest).
    # NoDecode prevents pydantic-settings from trying to JSON-decode the env
    # value; the field_validator below handles the "BTC,ETH,SOL" CSV form.
    collector_worker_id: str = "local-1"
    collector_tickers: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["BTC", "ETH", "SOL"]
    )
    collector_discovery_interval: int = 300

    # Alerting
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    # Shared-secret bridge for the Next.js frontend.
    # The Next.js Stripe webhook + Next.js /api/keys proxy authenticate
    # to our FastAPI by sending `X-Internal-Secret`. Both sides read the
    # same env var; rotate by changing this value in both deployments.
    # Generate with: python -c 'import secrets; print(secrets.token_urlsafe(32))'
    internal_api_secret: str = ""

    @field_validator("collector_tickers", mode="before")
    @classmethod
    def _split_csv(cls, v):
        # Accept either a real list or a "BTC,ETH,SOL" CSV string from .env
        if isinstance(v, str):
            return [s.strip().upper() for s in v.split(",") if s.strip()]
        return v

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
