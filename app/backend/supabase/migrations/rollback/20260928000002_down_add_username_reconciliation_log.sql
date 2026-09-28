-- Rollback: remove username reconciliation log table
-- Companion to 20260928000002_add_username_reconciliation_log.sql

DROP INDEX IF EXISTS username_reconciliation_runs_completed_at_idx;
DROP TABLE IF EXISTS username_reconciliation_runs;
