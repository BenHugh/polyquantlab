-- Migration 004: add underlying_price column to paper_positions.
--
-- Motivation: the dashboard wants to show "BTC was $67,500 when this
-- paper trade fired" next to the Polymarket fill. Capturing it at
-- trigger time (rather than re-querying ClickHouse at render time)
-- means the column is correct even if the spot history later gets
-- compacted.
--
-- Forward-compat: NULL allowed because all existing rows pre-date this
-- change. The paper trader worker populates it for any new trade.

ALTER TABLE paper_positions
    ADD COLUMN IF NOT EXISTS underlying_price NUMERIC(20, 8);
