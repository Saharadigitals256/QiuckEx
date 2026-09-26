-- Rollback for: 20260328000001_create_telegram_bot_tables.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS telegram_user_mappings CASCADE;
DROP TABLE IF EXISTS telegram_notification_log CASCADE;
DROP FUNCTION IF EXISTS update_telegram_user_mappings_updated_at CASCADE;
