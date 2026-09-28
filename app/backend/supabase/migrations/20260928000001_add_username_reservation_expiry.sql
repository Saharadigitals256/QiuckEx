-- Migration: Add username reservation expiry and anti-squatting safeguards
-- Issue #194
-- Adds reservation state (reserved_until, reserved_by) and an inactivity
-- tombstone column to the usernames table so the expiry service can:
--   1. Reserve a username for a wallet for a bounded window (default 15 min).
--   2. Expire stale reservations automatically via the sweep job.
--   3. Flag inactive usernames for the anti-squatting review queue.

-- ── Reservation state ──────────────────────────────────────────────────────
-- A NULL reserved_until means the username is either unclaimed or permanently
-- owned.  A non-NULL value means the row is in the RESERVED state; the expiry
-- sweep resets it once the wall clock exceeds this timestamp.
ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS reserved_until  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reserved_by     TEXT,        -- public key holding the reservation
  ADD COLUMN IF NOT EXISTS reservation_id  UUID;        -- client-supplied idempotency key

-- ── Ownership status ───────────────────────────────────────────────────────
-- Discriminates between:
--   'available'  – username has never been claimed (initial seed rows not used
--                  by this system, kept for completeness)
--   'reserved'   – temporarily held; expires at reserved_until
--   'claimed'    – permanently owned after a successful on-chain claim
--   'expired'    – reservation lapsed without an on-chain claim (searchable,
--                  reclaimable)
--   'flagged'    – anti-squatting review queue
ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS ownership_status TEXT NOT NULL DEFAULT 'claimed'
    CONSTRAINT usernames_ownership_status_valid
    CHECK (ownership_status IN ('available','reserved','claimed','expired','flagged'));

-- Back-fill: every existing row is already a permanent claim.
UPDATE usernames SET ownership_status = 'claimed' WHERE ownership_status = 'claimed';

-- ── Anti-squatting inactivity marker ──────────────────────────────────────
-- Set by the expiry sweep when last_active_at is older than the configured
-- inactivity threshold (default 180 days).  Cleared automatically when the
-- owner transacts again.
ALTER TABLE usernames
  ADD COLUMN IF NOT EXISTS squatting_flagged_at TIMESTAMPTZ;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Fast lookup for the expiry sweep (find all rows whose reservation has lapsed).
CREATE INDEX IF NOT EXISTS usernames_reserved_until_idx
  ON usernames (reserved_until)
  WHERE reserved_until IS NOT NULL;

-- Fast lookup for the anti-squatting sweep (find rows that have not been
-- active recently and are not already flagged).
CREATE INDEX IF NOT EXISTS usernames_squatting_scan_idx
  ON usernames (last_active_at)
  WHERE ownership_status = 'claimed' AND squatting_flagged_at IS NULL;

COMMENT ON COLUMN usernames.reserved_until IS
  'UTC timestamp after which the reservation lapses and the name becomes reclaimable.';
COMMENT ON COLUMN usernames.reserved_by IS
  'Stellar public key that holds the current reservation.';
COMMENT ON COLUMN usernames.reservation_id IS
  'Client-supplied UUID used for idempotent reservation requests.';
COMMENT ON COLUMN usernames.ownership_status IS
  'Lifecycle state: available | reserved | claimed | expired | flagged.';
COMMENT ON COLUMN usernames.squatting_flagged_at IS
  'Timestamp when this username was added to the anti-squatting review queue.';
