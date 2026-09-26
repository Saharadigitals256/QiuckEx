-- Rollback for: 20260428000001_create_analytics_views.sql
-- Generated automatically by migration verification engine

DROP VIEW IF EXISTS organization_metrics_daily CASCADE;
DROP FUNCTION IF EXISTS refresh_analytics_views CASCADE;
