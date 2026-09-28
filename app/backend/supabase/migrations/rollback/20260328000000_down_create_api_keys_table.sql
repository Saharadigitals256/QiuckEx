-- Rollback for: 20260328000000_create_api_keys_table.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS api_keys CASCADE;
DROP FUNCTION IF EXISTS increment_api_key_usage CASCADE;
