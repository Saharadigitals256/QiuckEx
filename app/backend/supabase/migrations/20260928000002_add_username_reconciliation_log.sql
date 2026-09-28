-- Migration: Add username reconciliation run log table
-- Issue #193 — Complete on-chain username claim reconciliation
--
-- Stores a persistent audit trail of every batch reconciliation run so
-- operators can review divergence counts, latency, and cursor positions
-- without re-running queries against Horizon.
--
-- Depends on: the ownership_status column added by the username reservation
-- expiry migration (20260928000001) or an equivalent ALTER TABLE statement.
-- If running standalone, ensure ownership_status exists on the usernames table:
--   ALTER TABLE usernames
--     ADD COLUMN IF NOT EXISTS ownership_status TEXT NOT NULL DEFAULT 'claimed'
--     CONSTRAINT usernames_ownership_status_valid
--     CHECK (ownership_status IN ('available','reserved','claimed','expired','flagged'));
--   ALTER TABLE usernames
--     ADD COLUMN IF NOT EXISTS squatting_flagged_at TIMESTAMPTZ;

-- ── Reconciliation run log ─────────────────────────────────────────────────
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

-- ── Ensure ownership columns exist (safe if #194 migration already ran) ───
ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS ownership_status TEXT NOT NULL DEFAULT 'claimed'
    CONSTRAINT usernames_ownership_status_valid
    CHECK (ownership_status IN ('available','reserved','claimed','expired','flagged'));

ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS squatting_flagged_at TIMESTAMPTZ;

-- Fast lookup for the reconciliation sweep (find all currently-claimed rows).
CREATE INDEX IF NOT EXISTS usernames_ownership_status_claimed_idx
  ON usernames (created_at)
  WHERE ownership_status = 'claimed';

COMMENT ON COLUMN usernames.ownership_status IS
  'Lifecycle state: available | reserved | claimed | expired | flagged.';
COMMENT ON COLUMN usernames.squatting_flagged_at IS
  'Timestamp when this username was added to the anti-squatting / review queue.';
