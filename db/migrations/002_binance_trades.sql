-- 1-minute aggregated OHLC + flow imbalance for Binance spot aggTrades.
--
-- Why pre-aggregate (vs. raw trades + materialised view):
--   * Binance BTCUSDT alone produces ~5-50 trades/sec. 3 symbols × 86400 s/day
--     ≈ 2-10 M raw rows/day. Storage is fine but query latency suffers.
--   * The only API surface we expose is OHLC, so storing one row per minute
--     per symbol (≈ 4 320/day total) is dramatically cheaper and gives the
--     <50 ms response budget more headroom.
--   * If we later want sub-minute granularity, we add a raw table separately
--     — the collector buffers in-memory so it's a small additive change.
--
-- ReplacingMergeTree on (ticker, bucket) means a re-emission of the same
-- (symbol, minute) replaces silently — useful if the collector restarts
-- mid-minute and re-flushes a partial bucket; the next flush will win.
--
-- Apply on a running stack:
--   docker exec -i stock_clickhouse clickhouse-client \
--       --user stock --password changeme --multiquery \
--       < db/migrations/002_binance_trades.sql

USE stock;

CREATE TABLE IF NOT EXISTS binance_spot_trades
(
    ticker                  LowCardinality(String),    -- 'BTC' | 'ETH' | 'SOL'
    bucket                  DateTime('UTC'),           -- minute start
    price_open              Float64,
    price_high              Float64,
    price_low               Float64,
    price_close             Float64,
    -- Base-currency volume (BTC, ETH, SOL). Multiply by price_close for USDT.
    total_volume            Float64,
    num_trades              UInt32,
    -- aggressive_buy = taker is buyer  (Binance aggTrade.m == false)
    -- aggressive_sell = taker is seller (Binance aggTrade.m == true)
    aggressive_buy_volume   Float64,
    aggressive_sell_volume  Float64,
    -- When this row was inserted (for debugging / late-arrival detection)
    inserted_at             DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(bucket)
ORDER BY (ticker, bucket);
-- NO TTL — Binance 1-min OHLC compresses extremely well (~60 bytes/row,
-- 4320 rows/day across 3 tickers). 10 years of data ≈ 1 GB. Cheap to keep.
