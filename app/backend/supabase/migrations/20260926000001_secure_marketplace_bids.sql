ALTER TABLE username_bids
  ADD COLUMN IF NOT EXISTS signature TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS username_bids_signature_unique_idx
  ON username_bids (signature)
  WHERE signature IS NOT NULL;

COMMENT ON COLUMN username_bids.signature IS
  'Ed25519 wallet signature over the canonical bid authorization message.';
