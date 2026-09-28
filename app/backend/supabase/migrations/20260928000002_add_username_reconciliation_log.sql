-- Migration: Add username reconciliation run log table
-- Issue #193 — Complete on-chain username claim reconciliation
--
-- Stores a persistent audit trail of every batch reconciliation run so
-- operators can review divergence counts, latency, and cursor positions
-- without re-running queries against Horizon.

CREATE TABLE IF NOT EXISTS username_reconciliation_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       TEXT        NOT NULL UNIQUE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  processed    INTEGER     NOT NULL DEFAULT 0,
  confirmed    INTEGER     NOT NULL DEFAULT 0,
  flagged      INTEGER     NOT NULL DEFAULT 0,
  skipped      INTEGER     NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  report       JSONB
);

CREATE INDEX IF NOT EXISTS username_reconciliation_runs_completed_at_idx
  ON username_reconciliation_runs (completed_at DESC);

COMMENT ON TABLE username_reconciliation_runs IS
  'Audit log of username on-chain claim reconciliation runs (issue #193).';
COMMENT ON COLUMN username_reconciliation_runs.run_id IS
  'UUID assigned to each reconciliation run; used as an idempotency key.';
COMMENT ON COLUMN username_reconciliation_runs.processed IS
  'Total usernames checked in this run.';
COMMENT ON COLUMN username_reconciliation_runs.confirmed IS
  'Usernames whose owning Stellar account is confirmed active on Horizon.';
COMMENT ON COLUMN username_reconciliation_runs.flagged IS
  'Usernames whose account returned 404 and were flagged for admin review.';
COMMENT ON COLUMN username_reconciliation_runs.skipped IS
  'Usernames skipped due to transient Horizon errors; safe to retry.';
COMMENT ON COLUMN username_reconciliation_runs.report IS
  'Full JSON report payload for diagnostics.';
