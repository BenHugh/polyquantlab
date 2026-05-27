-- =============================================================================
-- Migration 006: arb opportunity audit log
--
-- One row per (market_id × first-detection) where the Arb Scanner
-- identified a positive-EV opportunity. The tracker worker writes the
-- detection-time snapshot of the model's belief (fill_price, model_yes_prob,
-- model_ev, sigma) and ON CONFLICT DO NOTHING so we never overwrite the
-- "first impression" — that's the meaningful prediction.
--
-- A separate settler updates resolved_outcome + realized_pnl_per_share
-- when the underlying market resolves. This gives us the "model EV vs
-- realised PnL" cohort we need to validate the engine and surface to
-- paying users as proof that the signal is real.
--
-- Why a dedicated table (not paper_positions):
--   - Different lifecycle: insert once on detection, update once on
--     resolution. No multi-snapshot evaluation loop.
--   - Different metadata: model_yes_prob, sigma_annual, expected_pnl
--     are arb-specific and would clutter paper_positions for users
--     who don't run arb.
--   - Different aggregation: the "calibration report" comparing model
--     vs realised is the whole point — wants its own queries.
-- =============================================================================

CREATE TABLE IF NOT EXISTS arb_audit_log (
    id                       BIGSERIAL PRIMARY KEY,
    detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Polymarket market that the engine flagged
    market_id                TEXT NOT NULL,
    ticker                   TEXT NOT NULL,
    event_type               TEXT NOT NULL,

    -- Trade hint at detection
    tier                     TEXT NOT NULL CHECK (tier IN ('stable', 'stale')),
    direction                TEXT NOT NULL CHECK (direction IN ('BUY_YES', 'BUY_NO')),
    fill_price               NUMERIC(8, 6) NOT NULL,
    fill_spread              NUMERIC(8, 6) NOT NULL,

    -- Model state at detection
    spot_at_detection        NUMERIC(20, 8) NOT NULL,
    strike_price             NUMERIC(20, 8) NOT NULL,
    seconds_to_resolution    NUMERIC(12, 2) NOT NULL,
    sigma_annual             NUMERIC(10, 6) NOT NULL,
    sigma_tau                NUMERIC(10, 6) NOT NULL,
    model_yes_prob           NUMERIC(8, 6) NOT NULL,
    model_ev_per_share       NUMERIC(8, 6) NOT NULL,
    est_fee_per_share        NUMERIC(8, 6) NOT NULL,

    -- Resolution outcome (NULL until the market resolves)
    resolution_at            TIMESTAMPTZ NOT NULL,
    resolved_at              TIMESTAMPTZ,
    resolved_outcome         TEXT CHECK (resolved_outcome IN ('yes_won', 'no_won')),

    -- Realised per-share PnL after entry fee (computed at resolution).
    -- Sign convention matches model_ev_per_share so the comparison is
    -- apples-to-apples: positive means the trade made money.
    realized_pnl_per_share   NUMERIC(8, 6),

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One row per market — we record the FIRST detection so model_ev is
    -- the engine's initial prediction, not later iterations. Later scans
    -- of the same market are no-ops via ON CONFLICT DO NOTHING.
    UNIQUE (market_id)
);

-- Worker queries:
-- 1. "Open audit rows that have a resolution_at in the past" → settler picks them up
-- 2. "Detections in the last N days, grouped by ticker × tier" → calibration report
CREATE INDEX IF NOT EXISTS arb_audit_unresolved_idx
    ON arb_audit_log (resolution_at)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS arb_audit_detected_idx
    ON arb_audit_log (detected_at DESC);

CREATE INDEX IF NOT EXISTS arb_audit_ticker_tier_idx
    ON arb_audit_log (ticker, tier, detected_at DESC);
