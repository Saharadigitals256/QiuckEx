-- Rollback for: 20260429010000_create_analytics_rpc_functions.sql
-- Generated automatically by migration verification engine

DROP FUNCTION IF EXISTS quickex_analytics_summary CASCADE;
DROP FUNCTION IF EXISTS quickex_analytics_asset_distribution CASCADE;
DROP FUNCTION IF EXISTS quickex_analytics_time_series CASCADE;
