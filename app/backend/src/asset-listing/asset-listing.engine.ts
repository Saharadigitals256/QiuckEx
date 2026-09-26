/**
 * Pure asset listing engine (issue #306).
 *
 * The same rules are implemented in `scripts/governance/lib/assets.mjs` for the
 * documentation gate. Both are unit tested; `asset-listing.policy.unit.spec.ts`
 * also asserts the policy data here matches the published JSON.
 */
import {
  ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST,
  ASSET_LISTING_EVIDENCE,
  ASSET_LISTING_ERROR_HTTP,
  ASSET_LISTING_SERVED_STATUSES,
  ASSET_LISTING_SERVED_TIERS,
  ASSET_LISTING_SUSPENSION_MAX_DAYS,
  ASSET_LISTING_TIERS,
  ASSET_LISTING_TRANSITIONS,
  ASSET_LISTING_TRIGGERS,
  AssetListingDecisionAction,
  AssetListingErrorCode,
  AssetListingEvaluation,
  AssetListingEvidenceRecord,
  AssetListingRecord,
  AssetListingTier,
  AssetListingTriggerId,
  DAY_MS,
  EvidenceKind,
} from './asset-listing.policy';

export function assetKeyFor(code: string, issuer: string | null): string {
  return issuer ? `${code}:${issuer}` : code;
}

export function tierForAsset(record: Pick<AssetListingRecord, 'code' | 'tier'>): AssetListingTier {
  return record.tier ?? ASSET_LISTING_TIERS[record.code] ?? 'unlisted';
}

export function requiredEvidenceForTier(tier: AssetListingTier): EvidenceKind[] {
  return (Object.entries(ASSET_LISTING_EVIDENCE) as Array<
    [EvidenceKind, { requiredForTiers: AssetListingTier[] }]
  >)
    .filter(([, rule]) => rule.requiredForTiers.includes(tier))
    .map(([kind]) => kind);
}

export function findTrigger(id: string) {
  return ASSET_LISTING_TRIGGERS.find((trigger) => trigger.id === id) ?? null;
}

/**
 * Effective status and served flag for a record at `now`.
 *
 * Evidence expiry degrades `listed` → `suspended`, and a suspension older than
 * `suspensionMaxDays` ages out to `delisted` (no silent limbo).
 */
export function evaluateAssetListing({
  record,
  evidence = [],
  now = Date.now(),
}: {
  record: AssetListingRecord;
  evidence?: AssetListingEvidenceRecord[];
  now?: number;
}): AssetListingEvaluation {
  const tier = tierForAsset(record);
  const reasons: string[] = [];
  let status = record.status;

  const byKind = new Map(evidence.map((entry) => [entry.kind, entry]));
  let earliestExpiry: number | null = null;

  for (const kind of requiredEvidenceForTier(tier)) {
    const entry = byKind.get(kind);
    if (!entry) {
      reasons.push(`evidence_missing:${kind}`);
      continue;
    }
    const expiresAt = Date.parse(entry.expiresAt);
    if (Number.isFinite(expiresAt)) {
      if (earliestExpiry === null || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
      // Boundary: evidence expiring exactly at `now` is expired (inclusive).
      if (expiresAt <= now) reasons.push(`evidence_expired:${kind}`);
    }
  }

  if (status === 'listed' && reasons.length > 0) {
    status = 'suspended';
    reasons.push('trigger:evidence_expired');
  }
  if (status === 'suspended' && record.suspendedAt) {
    const suspendedMs = now - Date.parse(record.suspendedAt);
    if (Number.isFinite(suspendedMs) && suspendedMs > ASSET_LISTING_SUSPENSION_MAX_DAYS * DAY_MS) {
      status = 'delisted';
      reasons.push('trigger:suspension_timeout');
    }
  }

  const served =
    ASSET_LISTING_SERVED_STATUSES.includes(status) && ASSET_LISTING_SERVED_TIERS.includes(tier);

  return { key: record.key, status, tier, served, reasons, expiringAt: earliestExpiry };
}

export interface DecisionOutcome {
  ok: boolean;
  code: AssetListingErrorCode | null;
  httpStatus: number | null;
  next: AssetListingRecord | null;
  reasons: string[];
}

function reject(code: AssetListingErrorCode, reasons: string[]): DecisionOutcome {
  return { ok: false, code, httpStatus: ASSET_LISTING_ERROR_HTTP[code], next: null, reasons };
}

/**
 * Apply a listing decision, enforcing the transition table, evidence rules and
 * the delisting cooling-off window.
 */
export function applyAssetListingDecision({
  record,
  action,
  trigger = null,
  evidence = [],
  now = Date.now(),
}: {
  record: AssetListingRecord;
  action: AssetListingDecisionAction;
  trigger?: AssetListingTriggerId | string | null;
  evidence?: AssetListingEvidenceRecord[];
  now?: number;
}): DecisionOutcome {
  const from = record.status;
  const transition = ASSET_LISTING_TRANSITIONS.find(
    (candidate) => candidate.from === from && candidate.action === action,
  );
  if (!transition) {
    return reject(AssetListingErrorCode.INVALID_TRANSITION, [
      `no transition for ${from} + ${action}`,
    ]);
  }

  if (action === 'list' && from === 'delisted') {
    const delistedAt = record.delistedAt ? Date.parse(record.delistedAt) : Number.NaN;
    if (!Number.isFinite(delistedAt)) {
      return reject(AssetListingErrorCode.EVIDENCE_INCOMPLETE, [
        're-listing requires a recorded delisting timestamp',
      ]);
    }
    const coolingOffMs = ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST * DAY_MS;
    if (now < delistedAt + coolingOffMs) {
      return reject(AssetListingErrorCode.COOLING_OFF_ACTIVE, [
        `cooling-off ends at ${new Date(delistedAt + coolingOffMs).toISOString()}`,
      ]);
    }
  }

  if (action === 'list') {
    const byKind = new Map(evidence.map((entry) => [entry.kind, entry]));
    const missing: string[] = [];
    const expired: string[] = [];
    for (const kind of requiredEvidenceForTier(tierForAsset(record))) {
      const entry = byKind.get(kind);
      if (!entry) {
        missing.push(kind);
      } else if (Date.parse(entry.expiresAt) <= now) {
        expired.push(kind);
      }
    }
    if (expired.length > 0) {
      return reject(
        AssetListingErrorCode.EVIDENCE_EXPIRED,
        expired.map((kind) => `evidence expired or at boundary: ${kind}`),
      );
    }
    if (missing.length > 0) {
      return reject(
        AssetListingErrorCode.EVIDENCE_INCOMPLETE,
        missing.map((kind) => `missing required evidence: ${kind}`),
      );
    }
  }

  if (trigger && !findTrigger(String(trigger))) {
    return reject(AssetListingErrorCode.EVIDENCE_INCOMPLETE, [`unknown trigger "${trigger}"`]);
  }

  const updatedAt = new Date(now).toISOString();
  const next: AssetListingRecord = {
    ...record,
    status: transition.to,
    tier: tierForAsset(record),
    lastAction: action,
    lastTrigger: (trigger as AssetListingTriggerId | null) ?? null,
    updatedAt,
  };
  if (transition.to === 'delisted') next.delistedAt = updatedAt;
  if (transition.to === 'suspended') next.suspendedAt = updatedAt;
  if (transition.to === 'listed') {
    delete next.suspendedAt;
    delete next.delistedAt;
  }

  return { ok: true, code: null, httpStatus: null, next, reasons: [] };
}
