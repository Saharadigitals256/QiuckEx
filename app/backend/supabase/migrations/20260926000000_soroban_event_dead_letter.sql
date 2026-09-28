ALTER TABLE unparsed_soroban_events
  DROP CONSTRAINT IF EXISTS unparsed_soroban_events_status_check;

ALTER TABLE unparsed_soroban_events
  ADD CONSTRAINT unparsed_soroban_events_status_check
  CHECK (status IN ('pending', 'replayed', 'dead_letter'));

CREATE OR REPLACE FUNCTION record_unparsed_soroban_replay_failure(
  p_paging_token TEXT,
  p_error_message TEXT,
  p_max_attempts INTEGER
)
RETURNS TEXT
LANGUAGE SQL
AS $$
  UPDATE unparsed_soroban_events
  SET attempts = attempts + 1,
      status = CASE
        WHEN attempts + 1 >= GREATEST(p_max_attempts, 1) THEN 'dead_letter'
        ELSE 'pending'
      END,
      error_message = p_error_message,
      updated_at = now()
  WHERE paging_token = p_paging_token
    AND status IN ('pending', 'dead_letter')
  RETURNING status;
$$;

COMMENT ON FUNCTION record_unparsed_soroban_replay_failure(TEXT, TEXT, INTEGER) IS
  'Atomically increments replay failures and moves exhausted Soroban events to the dead-letter queue.';