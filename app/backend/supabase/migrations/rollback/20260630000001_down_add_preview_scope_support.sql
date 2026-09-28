-- Rollback for: 20260630000001_add_preview_scope_support.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS preview_scopes CASCADE;
DROP FUNCTION IF EXISTS trigger_preview_scopes_set_updated_at CASCADE;
DROP FUNCTION IF EXISTS delete_expired_preview_scope_data CASCADE;
