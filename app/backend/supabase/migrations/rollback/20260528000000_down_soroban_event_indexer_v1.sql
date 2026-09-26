-- Rollback for: 20260528000000_soroban_event_indexer_v1.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS indexer_checkpoints CASCADE;
DROP TABLE IF EXISTS privacy_events CASCADE;
DROP TABLE IF EXISTS admin_events CASCADE;
DROP TABLE IF EXISTS stealth_events CASCADE;
