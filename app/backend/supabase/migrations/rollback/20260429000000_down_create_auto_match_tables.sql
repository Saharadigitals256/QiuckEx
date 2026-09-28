-- Rollback for: 20260429000000_create_auto_match_tables.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS payment_links CASCADE;
DROP TABLE IF EXISTS unmatched_transactions CASCADE;
DROP FUNCTION IF EXISTS trigger_payment_links_set_updated_at CASCADE;
