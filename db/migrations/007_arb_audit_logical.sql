-- =============================================================================
-- Migration 007: extend arb_audit_log to record logical arbitrage
--
-- Phase BB.5 adds a third arb_type alongside the existing probability-
-- based arb: "logical arbitrage" — when yes_ask + no_ask < $1.00, you
-- can BUY BOTH sides for a mathematically guaranteed payoff at
-- resolution (regardless of outcome). This is risk-free in the strict
-- sense — no model assumption can fail.
--
-- Schema changes:
--   - `tier`: add "logical" to the allowed set
--   - `direction`: add "BUY_BOTH" to the allowed set
-- =============================================================================

ALTER TABLE arb_audit_log
    DROP CONSTRAINT IF EXISTS arb_audit_log_tier_check;
ALTER TABLE arb_audit_log
    ADD CONSTRAINT arb_audit_log_tier_check
    CHECK (tier IN ('stable', 'stale', 'logical'));

ALTER TABLE arb_audit_log
    DROP CONSTRAINT IF EXISTS arb_audit_log_direction_check;
ALTER TABLE arb_audit_log
    ADD CONSTRAINT arb_audit_log_direction_check
    CHECK (direction IN ('BUY_YES', 'BUY_NO', 'BUY_BOTH'));
