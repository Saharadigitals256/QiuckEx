ALTER TABLE transaction_receipts
  ADD COLUMN IF NOT EXISTS receipt_data JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS unparsed_soroban_events_archive (
  LIKE unparsed_soroban_events INCLUDING ALL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION archive_replayed_soroban_events(
  p_cutoff TIMESTAMPTZ,
  p_batch_size INTEGER DEFAULT 1000
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  WITH candidates AS (
    SELECT paging_token
      FROM unparsed_soroban_events
     WHERE status = 'replayed'
       AND updated_at < p_cutoff
     ORDER BY updated_at
     LIMIT GREATEST(1, LEAST(p_batch_size, 10000))
     FOR UPDATE SKIP LOCKED
  ), moved AS (
    INSERT INTO unparsed_soroban_events_archive
    SELECT event.*, now()
      FROM unparsed_soroban_events event
      JOIN candidates c USING (paging_token)
    ON CONFLICT (paging_token) DO NOTHING
    RETURNING paging_token
  )
  DELETE FROM unparsed_soroban_events event
   USING moved
   WHERE event.paging_token = moved.paging_token;

  GET DIAGNOSTICS archived_count = ROW_COUNT;
  RETURN archived_count;
END;
$$;
