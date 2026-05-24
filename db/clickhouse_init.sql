-- ClickHouse schema for Polymarket stock Up/Down data collection.
--
-- Design notes:
--   * DateTime64(3) gives millisecond precision (sub-second snapshots).
--   * PARTITION BY toYYYYMM(ts) keeps each month in its own partition,
--     enabling cheap drop / export of old data.
--   * orderbook_snapshots uses MergeTree; trades uses ReplacingMergeTree
--     keyed on trade_id so the two-worker setup can dedupe automatically.
--   * underlying_price is stored redundantly on snapshots to eliminate joins
--     in the most common query path (backtest user wants both price feeds
--     aligned in time).
--   * LowCardinality(String) wins ~10x compression on enum-like columns.

CREATE DATABASE IF NOT EXISTS stock;

CREATE TABLE IF NOT EXISTS stock.orderbook_snapshots
(
    market_id          String,
    ts                 DateTime64(3, 'UTC'),
    -- Each *_bids / *_asks column is a JSON-encoded array of
    --   [{"price": 0.45, "size": 1200}, ...]
    -- Stored as String + ZSTD compression. We keep up to 10 levels per side.
    yes_bids           String CODEC(ZSTD(3)),
    yes_asks           String CODEC(ZSTD(3)),
    no_bids            String CODEC(ZSTD(3)),
    no_asks            String CODEC(ZSTD(3)),
    -- Pre-computed convenience columns so the API does not need to parse JSON
    -- for the most common queries.
    best_yes_bid       Nullable(Float64),
    best_yes_ask       Nullable(Float64),
    mid_yes            Nullable(Float64),
    spread_yes         Nullable(Float64),
    -- Underlying asset price at the same ts (from Binance). Denormalised so
    -- range queries do not need to JOIN against underlying_prices.
    underlying_ticker  LowCardinality(String),
    underlying_price   Nullable(Float64),
    -- How this snapshot was produced (websocket update vs periodic resync).
    source             LowCardinality(String) DEFAULT 'ws'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (market_id, ts);
-- NO TTL — retain all snapshots forever. Disk grows ~272 MB/day at
-- current ~100 row/sec rate; 150 GB disk holds 12-15 months. Upgrade
-- (Hetzner Volume) once usage crosses ~80 % of disk. Long retention is
-- our primary differentiation vs PolyBackTest's 60-day cap.

CREATE TABLE IF NOT EXISTS stock.trades
(
    trade_id           String,
    market_id          String,
    ts                 DateTime64(3, 'UTC'),
    side               LowCardinality(String),    -- 'BUY_YES' | 'SELL_YES' | 'BUY_NO' | 'SELL_NO'
    price              Float64,
    size               Float64,
    maker_address      String,
    taker_address      String,
    tx_hash            String
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (market_id, ts, trade_id);
-- NO TTL — see orderbook_snapshots note above.

CREATE TABLE IF NOT EXISTS stock.underlying_prices
(
    ticker             LowCardinality(String),
    ts                 DateTime64(3, 'UTC'),
    price              Float64,
    confidence         Nullable(Float64),         -- reserved (Pyth conf interval; unused for Binance)
    source             LowCardinality(String) DEFAULT 'binance_spot'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (ticker, ts);
-- NO TTL — see orderbook_snapshots note above.

-- Heartbeat table: one row per worker per minute. Used by the healthcheck
-- endpoint to verify the collector is actually writing recent data.
CREATE TABLE IF NOT EXISTS stock.collector_heartbeats
(
    worker_id          LowCardinality(String),
    ts                 DateTime('UTC'),
    markets_tracked    UInt32,
    messages_received  UInt64,
    last_error         String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (worker_id, ts)
TTL ts + INTERVAL 30 DAY;
