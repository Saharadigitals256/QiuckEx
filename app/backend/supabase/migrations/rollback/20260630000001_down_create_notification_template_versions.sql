-- Rollback for: 20260630000001_create_notification_template_versions.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS notification_templates CASCADE;
DROP TABLE IF EXISTS notification_template_versions CASCADE;
DROP FUNCTION IF EXISTS update_notification_templates_updated_at CASCADE;
