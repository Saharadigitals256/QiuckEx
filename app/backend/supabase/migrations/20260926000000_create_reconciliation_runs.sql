CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id UUID PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL,
  divergence_count INTEGER NOT NULL DEFAULT 0 CHECK (divergence_count >= 0),
  divergence_rate DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (divergence_rate >= 0),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_completed_at_idx
  ON reconciliation_runs (completed_at DESC);

COMMENT ON TABLE reconciliation_runs IS
  'Durable summaries and divergence details for operator reconciliation dashboards.';
