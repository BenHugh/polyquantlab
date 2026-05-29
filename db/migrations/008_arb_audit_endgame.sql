-- =============================================================================
-- Migration 008: extend arb_audit_log to record endgame-sniper detections
--
-- Phase BD adds a fourth tier alongside stable / stale / logical:
-- "endgame" — the book-lag edge in the final 0-120s of a short market.
-- When the underlying is many σ away from the strike with seconds left,
-- the outcome is near-deterministic, yet Polymarket's thin book is slow
-- to price the near-certain side to ~$1.00. Buying that side below its
-- true probability is a real, measurable edge (verified in a 250-market
-- replay: dist 50-150 + tau<120s → 100% win, +$0.028/share).
--
-- A 5m-market replay also discovered the dangerous opposite corner:
-- when |dist| < 50 (under ~1σ at 60s) the near side wins only ~80%, so
-- the detector gates hard on a σ-scaled distance + dual-oracle
-- agreement (Binance AND Chainlink both far on the same side).
--
-- direction stays BUY_YES / BUY_NO (we buy the single near-certain
-- side), so no direction-constraint change is needed — the existing
-- settler already computes realised PnL for those correctly.
-- =============================================================================

ALTER TABLE arb_audit_log
    DROP CONSTRAINT IF EXISTS arb_audit_log_tier_check;
ALTER TABLE arb_audit_log
    ADD CONSTRAINT arb_audit_log_tier_check
    CHECK (tier IN ('stable', 'stale', 'logical', 'endgame'));

-- A short market resolves in 300s (5m). The probability-arb scan logs it
-- while tau >= 180s (first ~2 min after open); the endgame scan logs it
-- while tau is 25-120s (final ~1.5 min). These are the SAME market_id at
-- different times, so the old UNIQUE(market_id) would silently drop the
-- endgame detection as a conflict. Widen the key to (market_id, tier) so
-- each detector keeps its own first-detection row per market.
--
-- Side effect: the existing probability arb can now log both a 'stable'
-- and a 'stale' row for one market if its fill price crosses the 0.30
-- tier boundary between scans. That's rare and, for an audit, strictly
-- more honest (each distinct belief recorded) — acceptable.
ALTER TABLE arb_audit_log
    DROP CONSTRAINT IF EXISTS arb_audit_log_market_id_key;
ALTER TABLE arb_audit_log
    ADD CONSTRAINT arb_audit_log_market_id_tier_key
    UNIQUE (market_id, tier);
