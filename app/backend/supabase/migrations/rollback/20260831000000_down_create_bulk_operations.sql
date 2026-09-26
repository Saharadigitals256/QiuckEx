-- Rollback for: 20260831000000_create_bulk_operations.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS bulk_operations CASCADE;
DROP TABLE IF EXISTS bulk_operation_items CASCADE;
DROP FUNCTION IF EXISTS cleanup_expired_bulk_operations CASCADE;
