-- Rollback: remove username reconciliation log and related indexes
-- Companion to 20260928000002_add_username_reconciliation_log.sql

DROP INDEX IF EXISTS usernames_ownership_status_claimed_idx;
DROP INDEX IF EXISTS username_reconciliation_runs_completed_at_idx;
DROP TABLE IF EXISTS username_reconciliation_runs;

-- Note: ownership_status and squatting_flagged_at columns are NOT dropped here
-- because they may have been added by migration 20260928000001 independently.
-- Roll back 20260928000001 separately if those columns also need to be removed.
