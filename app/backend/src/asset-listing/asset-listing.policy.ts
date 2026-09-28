/**
 * Asset listing policy — runtime mirror of docs/policies/data/asset-listing-policy.json
 *
 * Document of record: docs/policies/ASSET-LISTING-POLICY.md
 * Governance gate:    node scripts/governance/check.mjs --only assets
 *
 * `asset-listing.policy.unit.spec.ts` reads the JSON from disk and asserts these
 * constants stay equal, so documentation, policy data and code cannot drift.
 *
 * Issue #306.
 */

export const ASSET_LISTING_POLICY_VERSION = '1.0.0';
export const ASSET_LISTING_POLICY_ID = 'quickex.asset-listing';

export type AssetListingStatus = 'pending' | 'listed' | 'suspended' | 'delisted' | 'rejected';
export type AssetListingTier = 'native' | 'verified' | 'community' | 'unlisted';
export type AssetListingDecisionAction = 'list' | 'reject' | 'suspend' | 'delist';
export type AssetListingTriggerId =
  | 'issuer_key_compromised'
  | 'reserve_or_peg_failure'
  | 'sanctions_or_legal_order'
  | 'fraud_or_scam_reports'
  | 'metadata_divergence'
  | 'evidence_expired'
  | 'issuer_requested'
  | 'network_mismatch'
  | 'policy_violation';
export type EvidenceKind =
  | 'toml_document'
  | 'attestation_of_reserve'
  | 'issuer_identity'
  | 'sanctions_screen'
  | 'security_review';

export interface AssetListingEvidenceRecord {
  kind: EvidenceKind;
  expiresAt: string;
}

export interface AssetListingRecord {
  /** `CODE:ISSUER` for issued assets, `XLM` for the native asset. */
  key: string;
  code: string;
  issuer: string | null;
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  status: AssetListingStatus;
  tier?: AssetListingTier;
  delistedAt?: string;
  suspendedAt?: string;
  lastAction?: AssetListingDecisionAction;
  lastTrigger?: AssetListingTriggerId | null;
  updatedAt?: string;
}

export interface AssetListingEvaluation {
  key: string;
  status: AssetListingStatus;
  tier: AssetListingTier;
  served: boolean;
  reasons: string[];
  expiringAt: number | null;
}

export const ASSET_LISTING_STATUSES: readonly AssetListingStatus[] = [
  'pending',
  'listed',
  'suspended',
  'delisted',
  'rejected',
];

export const ASSET_LISTING_SERVED_STATUSES: readonly AssetListingStatus[] = ['listed'];
export const ASSET_LISTING_SERVED_TIERS: readonly AssetListingTier[] = ['native', 'verified'];

export const ASSET_LISTING_MIN_ISSUER_ACCOUNT_AGE_DAYS = 180;
export const ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST = 30;
export const ASSET_LISTING_SUSPENSION_MAX_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Tier assignment for the assets seeded by the verified_assets migration. */
export const ASSET_LISTING_TIERS: Record<string, AssetListingTier> = {
  XLM: 'native',
  USDC: 'verified',
  AQUA: 'verified',
  yXLM: 'community',
};

export const ASSET_LISTING_EVIDENCE: Record<
  EvidenceKind,
  { maxAgeDays: number; requiredForTiers: AssetListingTier[] }
> = {
  toml_document: { maxAgeDays: 92, requiredForTiers: ['verified', 'community'] },
  attestation_of_reserve: { maxAgeDays: 92, requiredForTiers: ['verified'] },
  issuer_identity: { maxAgeDays: 365, requiredForTiers: ['verified'] },
  sanctions_screen: { maxAgeDays: 365, requiredForTiers: ['verified'] },
  security_review: { maxAgeDays: 730, requiredForTiers: ['verified'] },
};

export const ASSET_LISTING_TRIGGERS: ReadonlyArray<{
  id: AssetListingTriggerId;
  severity: 'critical' | 'high' | 'medium';
  immediate: boolean;
  defaultResolution: AssetListingStatus;
}> = [
  { id: 'issuer_key_compromised', severity: 'critical', immediate: true, defaultResolution: 'delisted' },
  { id: 'reserve_or_peg_failure', severity: 'critical', immediate: true, defaultResolution: 'delisted' },
  { id: 'sanctions_or_legal_order', severity: 'critical', immediate: true, defaultResolution: 'delisted' },
  { id: 'fraud_or_scam_reports', severity: 'high', immediate: false, defaultResolution: 'delisted' },
  { id: 'metadata_divergence', severity: 'medium', immediate: false, defaultResolution: 'suspended' },
  { id: 'evidence_expired', severity: 'medium', immediate: true, defaultResolution: 'suspended' },
  { id: 'issuer_requested', severity: 'high', immediate: false, defaultResolution: 'delisted' },
  { id: 'network_mismatch', severity: 'high', immediate: true, defaultResolution: 'delisted' },
  { id: 'policy_violation', severity: 'high', immediate: false, defaultResolution: 'suspended' },
];

export const ASSET_LISTING_TRANSITIONS: ReadonlyArray<{
  from: AssetListingStatus;
  to: AssetListingStatus;
  action: AssetListingDecisionAction;
}> = [
  { from: 'pending', to: 'listed', action: 'list' },
  { from: 'pending', to: 'rejected', action: 'reject' },
  { from: 'listed', to: 'suspended', action: 'suspend' },
  { from: 'listed', to: 'delisted', action: 'delist' },
  { from: 'suspended', to: 'listed', action: 'list' },
  { from: 'suspended', to: 'delisted', action: 'delist' },
  { from: 'delisted', to: 'listed', action: 'list' },
];

export enum AssetListingErrorCode {
  UNAUTHORIZED = 'ASSET_LISTING_UNAUTHORIZED',
  NOT_FOUND = 'ASSET_NOT_FOUND',
  EVIDENCE_INCOMPLETE = 'ASSET_LISTING_EVIDENCE_INCOMPLETE',
  EVIDENCE_EXPIRED = 'ASSET_LISTING_EVIDENCE_EXPIRED',
  INVALID_TRANSITION = 'ASSET_LISTING_INVALID_TRANSITION',
  COOLING_OFF_ACTIVE = 'ASSET_LISTING_COOLING_OFF_ACTIVE',
  IDEMPOTENCY_CONFLICT = 'ASSET_LISTING_IDEMPOTENCY_CONFLICT',
  DECISIONS_DISABLED = 'ASSET_LISTING_DECISIONS_DISABLED',
  REGISTRY_UNAVAILABLE = 'ASSET_LISTING_REGISTRY_UNAVAILABLE',
}

export const ASSET_LISTING_ERROR_HTTP: Record<AssetListingErrorCode, number> = {
  [AssetListingErrorCode.UNAUTHORIZED]: 403,
  [AssetListingErrorCode.NOT_FOUND]: 404,
  [AssetListingErrorCode.EVIDENCE_INCOMPLETE]: 422,
  [AssetListingErrorCode.EVIDENCE_EXPIRED]: 422,
  [AssetListingErrorCode.INVALID_TRANSITION]: 422,
  [AssetListingErrorCode.COOLING_OFF_ACTIVE]: 409,
  [AssetListingErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [AssetListingErrorCode.DECISIONS_DISABLED]: 403,
  [AssetListingErrorCode.REGISTRY_UNAVAILABLE]: 503,
};

export const ASSET_LISTING_FEATURE_FLAGS = {
  enforcement: 'assets.listing_policy',
  decisions: 'assets.listing_decisions',
  /** Environments where the policy is enabled by default (mainnet is gated off). */
  defaultEnabledEnvironments: ['development', 'test', 'local'],
  defaultDisabledEnvironments: ['production', 'mainnet'],
} as const;

export const ASSET_LISTING_METRICS = [
  'asset_listing_decisions_total',
  'asset_listing_decision_duration_seconds',
  'asset_listing_assets_served',
  'asset_listing_assets_suspended',
  'asset_listing_policy_denials_total',
] as const;

/** Machine-readable policy view returned by `GET /asset-listing/policy`. */
export function assetListingPolicyView() {
  return {
    policyId: ASSET_LISTING_POLICY_ID,
    policyVersion: ASSET_LISTING_POLICY_VERSION,
    tiers: ASSET_LISTING_TIERS,
    statuses: ASSET_LISTING_STATUSES,
    servedStatuses: ASSET_LISTING_SERVED_STATUSES,
    transitions: ASSET_LISTING_TRANSITIONS,
    evidence: ASSET_LISTING_EVIDENCE,
    delistingTriggers: ASSET_LISTING_TRIGGERS,
    minIssuerAccountAgeDays: ASSET_LISTING_MIN_ISSUER_ACCOUNT_AGE_DAYS,
    coolingOffDaysBeforeRelist: ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST,
    suspensionMaxDays: ASSET_LISTING_SUSPENSION_MAX_DAYS,
    errorCodes: ASSET_LISTING_ERROR_HTTP,
    featureFlags: ASSET_LISTING_FEATURE_FLAGS,
  };
}

