-- Rollback: remove username reservation expiry and anti-squatting columns
-- Companion to 20260928000001_add_username_reservation_expiry.sql

DROP INDEX IF EXISTS usernames_squatting_scan_idx;
DROP INDEX IF EXISTS usernames_reserved_until_idx;

ALTER TABLE usernames
  DROP COLUMN IF EXISTS squatting_flagged_at,
  DROP COLUMN IF EXISTS ownership_status,
  DROP COLUMN IF EXISTS reservation_id,
  DROP COLUMN IF EXISTS reserved_by,
  DROP COLUMN IF EXISTS reserved_until;
