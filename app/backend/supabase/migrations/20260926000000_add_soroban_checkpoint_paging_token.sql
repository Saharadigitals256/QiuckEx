ALTER TABLE indexer_checkpoints
  ADD COLUMN IF NOT EXISTS paging_token TEXT;

COMMENT ON COLUMN indexer_checkpoints.paging_token IS
  'Horizon cursor for resuming within a ledger when an event page ends mid-ledger.';