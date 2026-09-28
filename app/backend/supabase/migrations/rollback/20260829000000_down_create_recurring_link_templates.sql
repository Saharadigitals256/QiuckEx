-- Rollback for: 20260829000000_create_recurring_link_templates.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS recurring_link_templates CASCADE;
DROP TABLE IF EXISTS recurring_link_template_versions CASCADE;
DROP TABLE IF EXISTS recurring_link_template_executions CASCADE;
DROP FUNCTION IF EXISTS update_recurring_link_template_updated_at CASCADE;
DROP FUNCTION IF EXISTS render_template_variable CASCADE;
DROP FUNCTION IF EXISTS validate_cron_expression CASCADE;
DROP FUNCTION IF EXISTS get_next_template_execution CASCADE;
