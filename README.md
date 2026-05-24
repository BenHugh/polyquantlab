# PolyQuantLab — Polymarket Crypto Research Workbench

Sub-second orderbook collector + walk-the-book backtest engine + REST API
+ Next.js dashboard for Polymarket BTC / ETH / SOL Up/Down markets.

API surface is schema-compatible with [polybacktest.com](https://polybacktest.com)
for drop-in use, with an interactive web UI (markets browser, backtest
builder, results) on top.

> Status: **v0.** Backend running 24×7 on Hetzner. Frontend complete in
> dev; not yet on a public domain.

## Scope (intentionally narrow)

| | |
|---|---|
| Platform | Polymarket only |
| Assets | BTC, ETH, SOL (Up/Down + bracket markets) |
| Underlying price source | Binance spot trades + futures markPrice (1s) |
| Precision | sub-second WebSocket, includes `price_change` deltas |
| Aggregations | OHLC candles at 5m / 15m / 1h / 4h / 24h |
| Surface | REST API (web dashboard later) |

What's **NOT** in scope: Kalshi, macro events (FOMC/CPI/NFP), stock markets,
cross-platform aggregation. All of that code has been removed from this branch.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  api/                                                             │
│    FastAPI: /v1/markets/resolved /v1/snapshots /v1/candles       │
│              /v1/underlying /v1/backtest                          │
│    API key auth (sha256-hashed), Stripe slots open               │
├─────────────────────────────────────────────────────────────────┤
│  backtest/                                                        │
│    Replay engine: walks the book, simulates fills, applies fees, │
│    aggregates PnL / win-rate / Sharpe / max drawdown             │
│    Strategies (JSON spec): threshold_entry, mean_reversion, ...  │
├─────────────────────────────────────────────────────────────────┤
│  collector/                                                       │
│    Three concurrent loops:                                        │
│      1. discovery   — Gamma poll, crypto-only filter             │
│      2. polymarket_ws — CLOB book + price_change + trades        │
│      3. binance_ws  — spot trade + futures markPrice (1s)        │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│  ClickHouse                                                       │
│    orderbook_snapshots   — sub-second, ZSTD-compressed JSON      │
│    trades                — every fill, ReplacingMergeTree dedupe │
│    underlying_prices     — Binance spot + futures, source-tagged │
│    candles_5m / 15m / 1h / 4h / 24h  (AggregatingMergeTree MVs)  │
│  Postgres                                                         │
│    events, markets       — Polymarket metadata + resolution      │
│    users, api_keys, subscriptions                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# 1. Env + infra
cp .env.example .env
docker compose up -d

# 2. Python env (3.11+ required)
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[api]"

# 3. Run collector (terminal 1) — data clock starts now
python -m collector.main

# 4. Run API (terminal 2) — once you see snapshots landing
uvicorn api.main:app --host 0.0.0.0 --port 8000

# 5. Verify
curl http://localhost:8000/health
```

Within 30s you should see log lines:

```json
{"event": "ws_connected",                 "logger": "collector.polymarket_ws"}
{"event": "binance_ws_connected",         "kind": "spot"}
{"event": "binance_ws_connected",         "kind": "futures"}
{"event": "discovery_cycle_done",         "markets_upserted": <n>}
```

## Issuing yourself an API key (local dev)

```bash
docker exec stock_postgres psql -U stock -d stock -c \
  "INSERT INTO users (email) VALUES ('me@local') RETURNING user_id;"

python -c "
from api.auth import generate_api_key
plain, h, prefix = generate_api_key()
print(f'KEY={plain}')
print(f'HASH={h}')
print(f'PREFIX={prefix}')
"

docker exec stock_postgres psql -U stock -d stock -c \
  "INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
   VALUES ('<user_id>', '<HASH>', '<PREFIX>', 'dev');"
```

## Example API calls

```bash
# List BTC markets that have already resolved
curl 'http://localhost:8000/v1/markets/resolved?ticker=BTC&limit=20' \
  -H "Authorization: Bearer $KEY"

# Get sub-second snapshots for one market in a 1-hour window
curl 'http://localhost:8000/v1/snapshots?market_id=...&start=2026-05-21T13:00:00Z&end=2026-05-21T14:00:00Z' \
  -H "Authorization: Bearer $KEY"

# Get 5-minute candles for one market over a day
curl 'http://localhost:8000/v1/candles?market_id=...&timeframe=5m&start=2026-05-21T00:00:00Z&end=2026-05-22T00:00:00Z' \
  -H "Authorization: Bearer $KEY"

# Get Binance BTC spot prices in same window
curl 'http://localhost:8000/v1/underlying?ticker=BTC&source=binance_spot&start=2026-05-21T13:00:00Z&end=2026-05-21T14:00:00Z' \
  -H "Authorization: Bearer $KEY"

# Run a backtest: buy YES when implied prob drops below 30%
curl -X POST http://localhost:8000/v1/backtest \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "strategy": {
      "type": "threshold_entry",
      "threshold": 0.30,
      "direction": "below",
      "side": "buy_yes",
      "size_usd": 100
    },
    "ticker": "BTC",
    "market_limit": 20
  }'
```

Backtest returns realistic fills (walks the book), Polymarket fees, and PnL
at resolution.

## Project layout

```
collector/
  config.py          pydantic-settings (BTC/ETH/SOL only)
  logging_setup.py   structlog JSON logs
  db.py              ClickHouse + asyncpg + insert helpers
  discovery.py       Gamma poller with hard crypto-only filter
  polymarket_ws.py   CLOB WS: book + price_change deltas + trades
  binance_ws.py      Binance spot + futures markPrice WS
  health.py          aiohttp /health endpoint
  main.py            entry point, 3 concurrent loops

backtest/            (market-type-agnostic, reusable)
  types.py
  slippage.py        Walk-the-book fills + Polymarket fees
  strategies.py      threshold_entry, mean_reversion, ...
  data_loader.py
  engine.py

api/
  auth.py            API key issue + lookup
  main.py            FastAPI app

db/
  clickhouse_init.sql              orderbook_snapshots / trades / underlying_prices
  postgres_init.sql                events / markets / users / api_keys / subscriptions
  migrations/001_candles.sql       5 AggregatingMergeTree materialized views

docker-compose.yml   ClickHouse + Postgres + Redis
pyproject.toml
```

## Known gotchas

1. **No back-fill** after a WS disconnect. The next `book` message self-heals
   current state, but `trades` during the outage are lost. Add REST gap-fill
   before charging customers.
2. **Single worker** only. A 30-minute outage = 30-minute gap. The
   `ReplacingMergeTree` engine on `trades` is already set up to dedupe
   between workers — just need to run two collectors in different regions.
3. **Polymarket `clobTokenIds` field name** has shifted historically. If
   discovery finds events but no markets, check
   `collector/discovery.py:_extract_token_ids`.
4. **Binance symbol map** (`BINANCE_SYMBOLS` in `binance_ws.py`) covers
   BTCUSDT / ETHUSDT / SOLUSDT only. Add more if Polymarket starts listing
   other crypto Up/Down markets.

## Realistic expectations

PolyBackTest does ~$8k MRR after 5 months. They are the incumbent with an
existing X audience in the Polymarket/quant community. Cloning a leader in
their home turf with no audience advantage is hard.

| Month | Expected MRR |
|---|---|
| 1-3   | $0-300 (data accumulation phase) |
| 4-6   | $300-1k (first paying customers) |
| 7-12  | $500-2k (if SEO + content compounds) |
| 13-18 | $1.5k-4k (if Polymarket crypto ecosystem keeps growing) |
| Ceiling | ~$6k (unlikely to exceed the original) |

**The only thing that genuinely matters early**: keep the collector running.
Every day of data is one day of head start you can never get back later.
