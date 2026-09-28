/**
 * Retention schedule — runtime mirror of docs/policies/data/retention-schedule.json
 *
 * Document of record: docs/policies/DATA-RETENTION-PRIVACY-POLICY.md
 * Governance gate:    node scripts/governance/check.mjs --only retention
 *
 * `retention.service.unit.spec.ts` reads the JSON from disk and asserts these
 * constants stay equal, so the published policy, its data and this code cannot
 * drift. Issue #307.
 */

export const RETENTION_POLICY_VERSION = '1.0.0';
export const RETENTION_POLICY_ID = 'quickex.data-retention';
export const INDEFINITE_RETENTION = -1;

export type DeletionMethod =
  | 'hard_delete'
  | 'pseudonymize'
  | 'redact'
  | 'aggregate_only'
  | 'not_deletable'
  | 'device_local'
  | 'retain';

export type RetentionHoldId =
  | 'legal_obligation'
  | 'regulatory_defense'
  | 'forensic_audit'
  | 'security_incident_active';

export interface RetentionCategory {
  id: string;
  storage: string;
  windowDays: number;
  windowFrom: string;
  method: DeletionMethod;
  containsPersonalData: boolean | 'possible';
  holdable: boolean;
  note?: string;
}

export interface RetentionHold {
  id: RetentionHoldId;
  maxDays: number;
  reason: string;
}

export const DELETION_SLA = {
  acknowledgeBusinessDays: 5,
  executeDays: 30,
  executeDaysWithHold: 45,
  coolingOffDays: 7,
  challengeTtlSeconds: 900,
  proofPurpose: 'quickex.data-deletion',
} as const;

export const RETENTION_HOLDS: readonly RetentionHold[] = [
  {
    id: 'legal_obligation',
    maxDays: 2555,
    reason: 'tax/accounting retention for financial records',
  },
  {
    id: 'regulatory_defense',
    maxDays: 1825,
    reason: 'defend listing/sanctions decisions',
  },
  {
    id: 'forensic_audit',
    maxDays: INDEFINITE_RETENTION,
    reason: 'prove where funds were directed (ADR-0006)',
  },
  {
    id: 'security_incident_active',
    maxDays: INDEFINITE_RETENTION,
    reason: 'active abuse/security investigation',
  },
];

export const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  { id: 'payment_link_metadata', storage: 'supabase:payment_links', windowDays: 30, windowFrom: 'link_expiry_or_deletion', method: 'hard_delete', containsPersonalData: 'possible', holdable: false },
  { id: 'link_analytics_events', storage: 'supabase:analytics_views', windowDays: 400, windowFrom: 'event_time', method: 'aggregate_only', containsPersonalData: 'possible', holdable: false },
  { id: 'transaction_index', storage: 'supabase:soroban_events', windowDays: 400, windowFrom: 'ledger_time', method: 'redact', containsPersonalData: 'possible', holdable: false, note: 'chain data is public; only off-chain memo/counterparty enrichment is redacted' },
  { id: 'financial_records', storage: 'supabase:receipts,refunds,reconciliation', windowDays: 2555, windowFrom: 'record_creation', method: 'pseudonymize', containsPersonalData: 'possible', holdable: true },
  { id: 'audit_logs', storage: 'supabase:admin_audit_logs', windowDays: 1095, windowFrom: 'record_creation', method: 'redact', containsPersonalData: 'possible', holdable: true },
  { id: 'api_keys', storage: 'supabase:api_keys', windowDays: 90, windowFrom: 'revocation', method: 'hard_delete', containsPersonalData: false, holdable: false, note: 'secrets are stored hashed; no plaintext key exists to delete' },
  { id: 'webhook_deliveries', storage: 'supabase:webhook_deliveries,dlq', windowDays: 30, windowFrom: 'delivery_time', method: 'redact', containsPersonalData: 'possible', holdable: false },
  { id: 'notifications', storage: 'supabase:notifications', windowDays: 90, windowFrom: 'record_creation', method: 'hard_delete', containsPersonalData: 'possible', holdable: false },
  { id: 'support_bundles', storage: 'supabase:support_bundle_references', windowDays: 30, windowFrom: 'bundle_creation', method: 'hard_delete', containsPersonalData: 'possible', holdable: false },
  { id: 'crash_reports', storage: 'sentry', windowDays: 90, windowFrom: 'event_time', method: 'redact', containsPersonalData: 'possible', holdable: false, note: 'scrubbing rules run before send; see app/backend/src/crash-reporting' },
  { id: 'abuse_signals', storage: 'supabase:abuse_signals', windowDays: 180, windowFrom: 'signal_time', method: 'hard_delete', containsPersonalData: false, holdable: true },
  { id: 'scam_alerts', storage: 'supabase:scam_alerts', windowDays: 365, windowFrom: 'alert_time', method: 'redact', containsPersonalData: 'possible', holdable: true },
  { id: 'asset_listing_evidence', storage: 'supabase:asset_listing_evidence', windowDays: 730, windowFrom: 'delisting', method: 'redact', containsPersonalData: false, holdable: true },
  { id: 'verified_assets', storage: 'supabase:verified_assets', windowDays: 730, windowFrom: 'delisting', method: 'redact', containsPersonalData: false, holdable: true },
  { id: 'contract_registry_history', storage: 'supabase:deployment_artifacts', windowDays: INDEFINITE_RETENTION, windowFrom: 'publish_time', method: 'not_deletable', containsPersonalData: false, holdable: true, note: 'audit trail of where funds were directed; deletion would destroy ADR-0006 forensic evidence' },
  { id: 'privacy_deletion_requests', storage: 'supabase:privacy_deletion_requests', windowDays: 730, windowFrom: 'request_completion', method: 'pseudonymize', containsPersonalData: false, holdable: true, note: 'stores only a salted subject hash plus the decision trail' },
  { id: 'telegram_link_mappings', storage: 'supabase:telegram_bot_tables', windowDays: 30, windowFrom: 'unlink', method: 'hard_delete', containsPersonalData: true, holdable: false },
  { id: 'dashboard_feed_cache', storage: 'redis', windowDays: 7, windowFrom: 'cache_write', method: 'hard_delete', containsPersonalData: false, holdable: false },
  { id: 'job_replay_log', storage: 'supabase:job_replay_log', windowDays: 90, windowFrom: 'record_creation', method: 'hard_delete', containsPersonalData: false, holdable: false },
  { id: 'device_local_mobile_data', storage: 'mobile:AsyncStorage,SecureStore', windowDays: 0, windowFrom: 'user_action', method: 'device_local', containsPersonalData: true, holdable: false, note: 'never sent to the backend; deleted by the user via app settings or uninstall' },
  { id: 'onchain_escrow_state', storage: 'stellar:soroban', windowDays: INDEFINITE_RETENTION, windowFrom: 'ledger_time', method: 'not_deletable', containsPersonalData: false, holdable: true, note: 'public chain state; deletion requests cannot reach it (documented in policy §6)' },
];

export enum RetentionErrorCode {
  SUBJECT_NOT_FOUND = 'DELETION_SUBJECT_NOT_FOUND',
  CHALLENGE_UNKNOWN = 'DELETION_CHALLENGE_UNKNOWN',
  CHALLENGE_EXPIRED = 'DELETION_CHALLENGE_EXPIRED',
  SIGNATURE_INVALID = 'DELETION_SIGNATURE_INVALID',
  ALREADY_EXECUTED = 'DELETION_ALREADY_EXECUTED',
  REQUEST_DUPLICATE = 'DELETION_REQUEST_DUPLICATE',
  IDEMPOTENCY_CONFLICT = 'DELETION_IDEMPOTENCY_CONFLICT',
  INTAKE_DISABLED = 'DELETION_INTAKE_DISABLED',
  HOLD_ACTIVE = 'DELETION_HOLD_ACTIVE',
  NOT_CANCELLABLE = 'DELETION_NOT_CANCELLABLE',
  SWEEP_DISABLED = 'RETENTION_SWEEP_DISABLED',
  STORE_UNAVAILABLE = 'RETENTION_STORE_UNAVAILABLE',
  POLICY_UNAVAILABLE = 'RETENTION_POLICY_UNAVAILABLE',
}

export const RETENTION_ERROR_HTTP: Record<RetentionErrorCode, number> = {
  [RetentionErrorCode.SUBJECT_NOT_FOUND]: 404,
  [RetentionErrorCode.CHALLENGE_UNKNOWN]: 404,
  [RetentionErrorCode.CHALLENGE_EXPIRED]: 410,
  [RetentionErrorCode.SIGNATURE_INVALID]: 401,
  [RetentionErrorCode.ALREADY_EXECUTED]: 409,
  [RetentionErrorCode.REQUEST_DUPLICATE]: 409,
  [RetentionErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [RetentionErrorCode.INTAKE_DISABLED]: 403,
  [RetentionErrorCode.HOLD_ACTIVE]: 409,
  [RetentionErrorCode.NOT_CANCELLABLE]: 409,
  [RetentionErrorCode.SWEEP_DISABLED]: 403,
  [RetentionErrorCode.STORE_UNAVAILABLE]: 503,
  [RetentionErrorCode.POLICY_UNAVAILABLE]: 503,
};

export const RETENTION_FEATURE_FLAGS = {
  deletionRequests: 'privacy.deletion_requests',
  retentionSweep: 'privacy.retention_sweep',
} as const;

export const RETENTION_METRICS = [
  'deletion_requests_total',
  'deletion_request_duration_seconds',
  'deletion_proof_failures_total',
  'retention_sweep_records_total',
  'retention_sweep_duration_seconds',
  'retention_records_due',
] as const;

/** Machine-readable policy view returned by `GET /privacy/retention-policy`. */
export function retentionPolicyView() {
  return {
    policyId: RETENTION_POLICY_ID,
    policyVersion: RETENTION_POLICY_VERSION,
    deletionServiceLevel: DELETION_SLA,
    holds: RETENTION_HOLDS,
    categories: RETENTION_CATEGORIES,
    errorCodes: RETENTION_ERROR_HTTP,
    featureFlags: RETENTION_FEATURE_FLAGS,
    onChainDataDeletable: false,
  };
}

// ── Pure planning helpers (no framework imports — unit tested directly) ─────

export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

/** Due timestamp for a record, or null when retention is indefinite / not yet due. */
export function dueAtFor(
  category: Pick<RetentionCategory, 'windowDays'>,
  windowStart: string | Date,
  now: number = Date.now(),
): string | null {
  if (category.windowDays === INDEFINITE_RETENTION) return null;
  const start = windowStart instanceof Date ? windowStart.getTime() : Date.parse(windowStart);
  if (!Number.isFinite(start)) return null;
  const dueAt = start + category.windowDays * RETENTION_DAY_MS;
  return dueAt <= now ? new Date(dueAt).toISOString() : null;
}

export function isDue(
  category: Pick<RetentionCategory, 'windowDays'>,
  windowStart: string | Date,
  now: number = Date.now(),
): boolean {
  return dueAtFor(category, windowStart, now) !== null;
}

/**
 * Effective method under active holds (policy §4):
 *  - hold + holdable + `hard_delete` → `pseudonymize` (financial invariants survive)
 *  - hold + non-holdable             → `retain` (blocked for the hold period)
 */
export function effectiveMethodFor(
  category: Pick<RetentionCategory, 'method' | 'holdable'>,
  activeHolds: RetentionHoldId[],
): { method: DeletionMethod; retained: boolean; holds: RetentionHoldId[] } {
  if (activeHolds.length === 0) {
    return { method: category.method, retained: false, holds: [] };
  }
  if (!category.holdable) {
    return { method: 'retain', retained: true, holds: activeHolds };
  }
  const degraded = category.method === 'hard_delete' ? 'pseudonymize' : category.method;
  return { method: degraded, retained: degraded === 'retain', holds: activeHolds };
}

/** SLA dates for a deletion request created at `createdAt`. */
export function deletionSlaFor(createdAt: Date) {
  return {
    acknowledgedWithinBusinessDays: DELETION_SLA.acknowledgeBusinessDays,
    coolingOffEndsAt: new Date(
      createdAt.getTime() + DELETION_SLA.coolingOffDays * RETENTION_DAY_MS,
    ).toISOString(),
    executeBy: new Date(
      createdAt.getTime() + DELETION_SLA.executeDays * RETENTION_DAY_MS,
    ).toISOString(),
    executeByWithHold: new Date(
      createdAt.getTime() + DELETION_SLA.executeDaysWithHold * RETENTION_DAY_MS,
    ).toISOString(),
    coolingOffDays: DELETION_SLA.coolingOffDays,
    challengeTtlSeconds: DELETION_SLA.challengeTtlSeconds,
    proofPurpose: DELETION_SLA.proofPurpose,
  };
}

