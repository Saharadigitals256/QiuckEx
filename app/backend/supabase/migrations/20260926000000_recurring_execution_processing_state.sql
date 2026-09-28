-- Persist the scheduler's atomic claim while a recurring payment job is queued/running.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_type_idempotency_key_idx
  ON jobs (type, idempotency_key);

ALTER TABLE recurring_payment_links
  ADD COLUMN IF NOT EXISTS payer_public_key TEXT;

ALTER TABLE recurring_payment_executions
  DROP CONSTRAINT IF EXISTS recurring_payment_executions_status_check;

ALTER TABLE recurring_payment_executions
  ADD CONSTRAINT recurring_payment_executions_status_check
  CHECK (status IN ('pending', 'processing', 'success', 'failed', 'skipped'));

CREATE INDEX IF NOT EXISTS recurring_executions_processing_idx
  ON recurring_payment_executions (status, scheduled_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION record_recurring_payment_success(
  p_execution_id UUID,
  p_transaction_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution_record recurring_payment_executions%ROWTYPE;
  link_record recurring_payment_links%ROWTYPE;
  next_count INTEGER;
BEGIN
  SELECT * INTO execution_record
  FROM recurring_payment_executions
  WHERE id = p_execution_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recurring execution not found: %', p_execution_id;
  END IF;

  IF execution_record.status = 'success' THEN
    IF execution_record.transaction_hash IS DISTINCT FROM p_transaction_hash THEN
      RAISE EXCEPTION 'Recurring execution already completed with a different transaction hash';
    END IF;
    RETURN;
  END IF;

  IF execution_record.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Recurring execution cannot complete from status %', execution_record.status;
  END IF;

  SELECT * INTO link_record
  FROM recurring_payment_links
  WHERE id = execution_record.recurring_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recurring link not found: %', execution_record.recurring_link_id;
  END IF;

  next_count := link_record.executed_count + 1;

  UPDATE recurring_payment_executions
  SET status = 'success',
      executed_at = now(),
      transaction_hash = p_transaction_hash,
      failure_reason = NULL
  WHERE id = p_execution_id;

  UPDATE recurring_payment_links
  SET executed_count = next_count,
      next_execution_date = calculate_next_execution_date(next_execution_date, frequency),
      status = CASE
        WHEN (total_periods IS NOT NULL AND next_count >= total_periods)
          OR (end_date IS NOT NULL AND end_date <= now())
        THEN 'completed'
        ELSE status
      END
  WHERE id = execution_record.recurring_link_id;
END;
$$;
