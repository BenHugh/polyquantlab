-- Candle aggregations: 5m / 15m / 1h / 4h / 24h OHLC of YES mid-price.
--
-- One materialized view per timeframe. They all read from orderbook_snapshots
-- and write into a separate table maintained by ClickHouse (the AMT engine
-- merges partial aggregates incrementally).
--
-- Reading a candle:
--   SELECT market_id, bucket,
--          argMinMerge(open_state)  AS open,
--          maxMerge(high_state)     AS high,
--          minMerge(low_state)      AS low,
--          argMaxMerge(close_state) AS close,
--          countMerge(n_state)      AS n_snapshots
--   FROM   candles_5m
--   WHERE  market_id = '<id>' AND bucket >= '<start>' AND bucket < '<end>'
--   GROUP  BY market_id, bucket
--   ORDER  BY bucket;
--
-- This is the surface the /v1/candles endpoint hits. Equivalent to PolyBackTest's
-- 5m/15m/1h/4h/24h timeframe parameter.

-- Apply with:
--   docker exec stock_clickhouse clickhouse-client --user stock --password changeme \
--     < db/migrations/001_candles.sql

USE stock;


-- ---- 5-minute candles -----------------------------------------------------

CREATE TABLE IF NOT EXISTS candles_5m_data
(
    market_id    String,
    bucket       DateTime('UTC'),
    open_state   AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
    high_state   AggregateFunction(max, Float64),
    low_state    AggregateFunction(min, Float64),
    close_state  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
    n_state      AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (market_id, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_5m TO candles_5m_data AS
SELECT
    market_id,
    toStartOfInterval(ts, INTERVAL 5 MINUTE) AS bucket,
    argMinState(assumeNotNull(mid_yes), ts) AS open_state,
    maxState(assumeNotNull(mid_yes))        AS high_state,
    minState(assumeNotNull(mid_yes))        AS low_state,
    argMaxState(assumeNotNull(mid_yes), ts) AS close_state,
    countState()             AS n_state
FROM orderbook_snapshots
WHERE mid_yes IS NOT NULL
GROUP BY market_id, bucket;


-- ---- 15-minute candles ----------------------------------------------------

CREATE TABLE IF NOT EXISTS candles_15m_data
(
    market_id    String,
    bucket       DateTime('UTC'),
    open_state   AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
    high_state   AggregateFunction(max, Float64),
    low_state    AggregateFunction(min, Float64),
    close_state  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
    n_state      AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (market_id, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_15m TO candles_15m_data AS
SELECT
    market_id,
    toStartOfInterval(ts, INTERVAL 15 MINUTE) AS bucket,
    argMinState(assumeNotNull(mid_yes), ts) AS open_state,
    maxState(assumeNotNull(mid_yes))        AS high_state,
    minState(assumeNotNull(mid_yes))        AS low_state,
    argMaxState(assumeNotNull(mid_yes), ts) AS close_state,
    countState()             AS n_state
FROM orderbook_snapshots
WHERE mid_yes IS NOT NULL
GROUP BY market_id, bucket;


-- ---- 1-hour candles -------------------------------------------------------

CREATE TABLE IF NOT EXISTS candles_1h_data
(
    market_id    String,
    bucket       DateTime('UTC'),
    open_state   AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
    high_state   AggregateFunction(max, Float64),
    low_state    AggregateFunction(min, Float64),
    close_state  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
    n_state      AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (market_id, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_1h TO candles_1h_data AS
SELECT
    market_id,
    toStartOfInterval(ts, INTERVAL 1 HOUR) AS bucket,
    argMinState(assumeNotNull(mid_yes), ts) AS open_state,
    maxState(assumeNotNull(mid_yes))        AS high_state,
    minState(assumeNotNull(mid_yes))        AS low_state,
    argMaxState(assumeNotNull(mid_yes), ts) AS close_state,
    countState()             AS n_state
FROM orderbook_snapshots
WHERE mid_yes IS NOT NULL
GROUP BY market_id, bucket;


-- ---- 4-hour candles -------------------------------------------------------

CREATE TABLE IF NOT EXISTS candles_4h_data
(
    market_id    String,
    bucket       DateTime('UTC'),
    open_state   AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
    high_state   AggregateFunction(max, Float64),
    low_state    AggregateFunction(min, Float64),
    close_state  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
    n_state      AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (market_id, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_4h TO candles_4h_data AS
SELECT
    market_id,
    toStartOfInterval(ts, INTERVAL 4 HOUR) AS bucket,
    argMinState(assumeNotNull(mid_yes), ts) AS open_state,
    maxState(assumeNotNull(mid_yes))        AS high_state,
    minState(assumeNotNull(mid_yes))        AS low_state,
    argMaxState(assumeNotNull(mid_yes), ts) AS close_state,
    countState()             AS n_state
FROM orderbook_snapshots
WHERE mid_yes IS NOT NULL
GROUP BY market_id, bucket;


-- ---- 24-hour candles ------------------------------------------------------

CREATE TABLE IF NOT EXISTS candles_24h_data
(
    market_id    String,
    bucket       DateTime('UTC'),
    open_state   AggregateFunction(argMin, Float64, DateTime64(3, 'UTC')),
    high_state   AggregateFunction(max, Float64),
    low_state    AggregateFunction(min, Float64),
    close_state  AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
    n_state      AggregateFunction(count)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (market_id, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS candles_24h TO candles_24h_data AS
SELECT
    market_id,
    toStartOfInterval(ts, INTERVAL 1 DAY) AS bucket,
    argMinState(assumeNotNull(mid_yes), ts) AS open_state,
    maxState(assumeNotNull(mid_yes))        AS high_state,
    minState(assumeNotNull(mid_yes))        AS low_state,
    argMaxState(assumeNotNull(mid_yes), ts) AS close_state,
    countState()             AS n_state
FROM orderbook_snapshots
WHERE mid_yes IS NOT NULL
GROUP BY market_id, bucket;
