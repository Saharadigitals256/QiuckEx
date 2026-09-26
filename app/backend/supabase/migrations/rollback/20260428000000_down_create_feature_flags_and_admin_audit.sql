-- Rollback for: 20260428000000_create_feature_flags_and_admin_audit.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS feature_flags CASCADE;
DROP TABLE IF EXISTS admin_audit_logs CASCADE;
