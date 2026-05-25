-- Phase U.3: link a paper strategy to its baseline backtest job, so
-- the paper detail page can compare live P&L to the backtest's
-- expectation. Population is opt-in (only set when the strategy is
-- created via the new "Run as paper trade" CTA from Strategy Builder);
-- legacy paper strategies created via the form leave it NULL and the
-- UI falls back to "no baseline".
ALTER TABLE paper_strategies
    ADD COLUMN IF NOT EXISTS baseline_backtest_id TEXT;
