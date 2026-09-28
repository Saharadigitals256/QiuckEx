-- Rollback for: 20250225000001_create_notification_tables.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS notification_preferences CASCADE;
DROP TABLE IF EXISTS notification_log CASCADE;
DROP FUNCTION IF EXISTS update_notification_preferences_updated_at CASCADE;
