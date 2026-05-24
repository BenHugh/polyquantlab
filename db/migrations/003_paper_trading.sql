-- =============================================================================
-- Migration 003: paper trading
--
-- Two new tables that let users save a strategy spec and have a worker
-- continuously replay it against incoming live snapshots. The strategy
-- itself never touches real money; we just record what WOULD have
-- happened.
--
-- Why this matters: backtest results suffer from look-ahead and
-- overfitting bias. Paper trading is the only way to validate a
-- strategy on genuinely out-of-sample data (the future). Customers
-- who watch their paper P&L for 30 days and see it match their
-- backtest are way more confident handing over real money — and way
-- stickier subscribers.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- paper_strategies — one row per saved strategy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_strategies (
    paper_strategy_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Owner. Joins to nothing structurally — we key on the same email
    -- the rest of the system uses (api_keys, profiles, subscriptions).
    -- The application-layer auth ensures cross-user reads can't happen.
    user_email         TEXT NOT NULL,

    -- Display name (optional). "BTC 1h reversal" etc.
    name               TEXT,

    -- The strategy spec (same shape as POST /v1/backtest's `strategy`).
    -- JSONB so we can index later if needed.
    strategy_spec      JSONB NOT NULL,

    -- Universe filter — which markets this strategy applies to.
    -- NULL ticker means "any of BTC/ETH/SOL"; NULL event_type means
    -- "any window". Both NULL = run on every snapshot (rarely useful).
    ticker             TEXT,
    event_type         TEXT,

    -- USD notional per virtual trade. Pinned at create time so that
    -- changes to the spec don't retroactively change historical
    -- positions.
    size_usd           NUMERIC(12, 2) NOT NULL DEFAULT 10,

    -- Lifecycle. The worker only processes strategies with active=true.
    -- `started_at` exists so the worker can ignore snapshots OLDER
    -- than when the strategy was created — we don't backfill paper
    -- trades for historical markets, we only "look forward".
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paused_at          TIMESTAMPTZ,
    active             BOOLEAN     NOT NULL DEFAULT TRUE,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_strategies_user_active_idx
    ON paper_strategies (user_email, active);

-- ---------------------------------------------------------------------------
-- paper_positions — one row per simulated trade
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_positions (
    paper_position_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_strategy_id     UUID NOT NULL
        REFERENCES paper_strategies (paper_strategy_id) ON DELETE CASCADE,

    -- The Polymarket market this virtual trade was placed on
    market_id             TEXT NOT NULL,

    -- Trade execution (mirrors backtest.types.Trade)
    -- side: "buy_yes" / "buy_no" / "sell_yes" / "sell_no"
    side                  TEXT NOT NULL,
    fill_price            NUMERIC(8, 6) NOT NULL,    -- $/share, in [0,1]
    size_usd              NUMERIC(12, 2) NOT NULL,
    slippage_bps          NUMERIC(10, 2) NOT NULL DEFAULT 0,
    fees                  NUMERIC(12, 2) NOT NULL DEFAULT 0,

    -- Lifecycle. Opens immediately on trigger, closes when the market
    -- resolves (set by the settlement loop, not the entry path).
    opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at             TIMESTAMPTZ,

    -- Resolution outcome and resulting P&L. NULL until closed.
    resolution_yes_price  NUMERIC(4, 3),    -- 1.000 = Up won, 0.000 = Down won
    pnl                   NUMERIC(12, 2),   -- gross (before fees)

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most queries are scoped by strategy (the dashboard shows one
-- strategy's trades) and then sorted by time.
CREATE INDEX IF NOT EXISTS paper_positions_strategy_opened_idx
    ON paper_positions (paper_strategy_id, opened_at DESC);

-- The settlement loop wants "all open positions on market X" quickly
-- when a market resolves. Partial index keeps the open-set tiny.
CREATE INDEX IF NOT EXISTS paper_positions_open_on_market_idx
    ON paper_positions (market_id)
    WHERE closed_at IS NULL;

-- Prevent the same strategy from opening multiple positions on the
-- same market — matches the v0 backtest engine semantics ("open and
-- hold to resolution"). If we ever support multi-entry strategies, we
-- drop this and add a position-number column.
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_strategy_market_uq
    ON paper_positions (paper_strategy_id, market_id);
