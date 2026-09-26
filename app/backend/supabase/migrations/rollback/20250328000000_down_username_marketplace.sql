-- Rollback for: 20250328000000_username_marketplace.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS username_marketplace CASCADE;
DROP TABLE IF EXISTS username_bids CASCADE;
DROP FUNCTION IF EXISTS accept_username_bid CASCADE;
