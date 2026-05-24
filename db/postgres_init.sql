-- Postgres schema for Polymarket crypto market metadata + users.
--
-- ClickHouse holds the high-volume timeseries; Postgres holds the small,
-- transactional, mutable data. Splitting them keeps both happy:
--   * ClickHouse hates UPDATEs; Postgres hates billions of inserts.
--   * Stripe webhooks need ACID; orderbook ingest does not.
--
-- Scope: BTC / ETH / SOL Up/Down + bracket markets only (PolyBackTest clone).

CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Polymarket event + market metadata.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
    event_id           UUID PRIMARY KEY,
    polymarket_slug    TEXT UNIQUE NOT NULL,
    ticker             TEXT NOT NULL,             -- 'TSLA', 'NVDA', 'GOLD' ...
    event_type         TEXT NOT NULL,             -- daily_up_down | weekly_bracket | monthly_bracket | earnings
    question           TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL,
    resolution_at      TIMESTAMPTZ,
    resolved_at        TIMESTAMPTZ,
    resolution_outcome TEXT,
    raw                JSONB,                     -- Full Gamma API payload
    discovered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_ticker_idx        ON events (ticker);
CREATE INDEX IF NOT EXISTS events_event_type_idx    ON events (event_type);
CREATE INDEX IF NOT EXISTS events_resolution_at_idx ON events (resolution_at);

CREATE TABLE IF NOT EXISTS markets (
    market_id          TEXT PRIMARY KEY,          -- Polymarket condition_id
    event_id           UUID NOT NULL REFERENCES events ON DELETE CASCADE,
    outcome            TEXT NOT NULL,             -- 'Up' | 'Down' | '$320-$330' etc.
    yes_token_id       TEXT NOT NULL,
    no_token_id        TEXT NOT NULL,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    tick_size          NUMERIC,
    discovered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS markets_event_id_idx     ON markets (event_id);
CREATE INDEX IF NOT EXISTS markets_is_active_idx    ON markets (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Users, API keys, subscriptions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    user_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email              TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT UNIQUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    api_key_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    -- We only store a SHA-256 hash of the key. The plaintext is shown once
    -- on creation and never persisted server-side.
    key_hash           TEXT UNIQUE NOT NULL,
    key_prefix         TEXT NOT NULL,             -- First 8 chars for UI display
    label              TEXT,
    last_used_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    stripe_sub_id      TEXT UNIQUE,
    tier               TEXT NOT NULL,             -- free | pro | plus | boost | premium  (see api/tiers.py)
    status             TEXT NOT NULL,             -- active | past_due | canceled | trialing
    current_period_end TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions (user_id);

-- Usage tracking (rolled up daily). Detailed per-request logs stay in Redis.
CREATE TABLE IF NOT EXISTS api_usage_daily (
    api_key_id         UUID NOT NULL REFERENCES api_keys ON DELETE CASCADE,
    day                DATE NOT NULL,
    request_count      BIGINT NOT NULL DEFAULT 0,
    bytes_returned     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, day)
);
