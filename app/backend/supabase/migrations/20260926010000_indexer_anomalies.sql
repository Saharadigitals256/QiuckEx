create table if not exists public.indexer_anomalies (
  id uuid primary key default gen_random_uuid(),
  contract_id text not null,
  anomaly_type text not null check (anomaly_type in ('gap', 'reorg', 'duplicate', 'out_of_order')),
  ledger bigint,
  previous_ledger bigint,
  paging_token text,
  details jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now()
);

create index if not exists indexer_anomalies_contract_detected_idx
  on public.indexer_anomalies (contract_id, detected_at desc);

create index if not exists indexer_anomalies_type_idx
  on public.indexer_anomalies (anomaly_type, detected_at desc);