-- Rollback for: 20260829000001_template_version_functions.sql
-- Generated automatically by migration verification engine

DROP FUNCTION IF EXISTS activate_template_version CASCADE;
DROP FUNCTION IF EXISTS get_next_cron_execution CASCADE;
DROP FUNCTION IF EXISTS validate_template_variables CASCADE;
DROP FUNCTION IF EXISTS render_template_field CASCADE;
DROP FUNCTION IF EXISTS get_template_execution_stats CASCADE;
DROP FUNCTION IF EXISTS cleanup_old_template_executions CASCADE;
