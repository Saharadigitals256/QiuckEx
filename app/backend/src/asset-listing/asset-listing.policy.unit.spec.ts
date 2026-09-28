import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST,
  ASSET_LISTING_EVIDENCE,
  ASSET_LISTING_ERROR_HTTP,
  ASSET_LISTING_POLICY_VERSION,
  ASSET_LISTING_SERVED_STATUSES,
  ASSET_LISTING_STATUSES,
  ASSET_LISTING_SUSPENSION_MAX_DAYS,
  ASSET_LISTING_TIERS,
  ASSET_LISTING_TRANSITIONS,
  ASSET_LISTING_TRIGGERS,
  AssetListingErrorCode,
  AssetListingEvidenceRecord,
  AssetListingRecord,
} from './asset-listing.policy';
import {
  applyAssetListingDecision,
  assetKeyFor,
  evaluateAssetListing,
  requiredEvidenceForTier,
} from './asset-listing.engine';

const POLICY_JSON_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'policies',
  'data',
  'asset-listing-policy.json',
);

interface PolicyJson {
  policyVersion: string;
  coolingOffDaysBeforeRelist: number;
  suspensionMaxDays: number;
  statuses: string[];
  servedStatuses: string[];
  tiers: Record<string, string>;
  evidence: Record<string, { maxAgeDays: number; requiredForTiers: string[] }>;
  transitions: Array<{ from: string; to: string; action: string }>;
  delistingTriggers: Array<{
    id: string;
    severity: string;
    immediate: boolean;
    defaultResolution: string;
  }>;
  errorCodes: Record<string, number>;
}

function loadPolicyJson(): PolicyJson {
  return JSON.parse(readFileSync(POLICY_JSON_PATH, 'utf8')) as PolicyJson;
}

describe('asset listing policy mirror (docs/policies ↔ backend code)', () => {
  const policy = loadPolicyJson();

  it('pins the published policy version', () => {
    expect(ASSET_LISTING_POLICY_VERSION).toBe(policy.policyVersion);
  });

  it('mirrors the cool-off and suspension windows', () => {
    expect(ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST).toBe(policy.coolingOffDaysBeforeRelist);
    expect(ASSET_LISTING_SUSPENSION_MAX_DAYS).toBe(policy.suspensionMaxDays);
  });

  it('mirrors statuses and served statuses', () => {
    expect([...ASSET_LISTING_STATUSES]).toEqual(policy.statuses);
    expect([...ASSET_LISTING_SERVED_STATUSES]).toEqual(policy.servedStatuses);
  });

  it('mirrors every tier assignment', () => {
    expect(ASSET_LISTING_TIERS).toEqual(policy.tiers);
  });

  it('mirrors evidence kinds, maximum ages and required tiers', () => {
    expect(Object.keys(ASSET_LISTING_EVIDENCE).sort()).toEqual(
      Object.keys(policy.evidence).sort(),
    );
    for (const [kind, rule] of Object.entries(policy.evidence)) {
      expect(ASSET_LISTING_EVIDENCE[kind as keyof typeof ASSET_LISTING_EVIDENCE]).toEqual(rule);
    }
  });

  it('mirrors the transition table', () => {
    expect(ASSET_LISTING_TRANSITIONS).toEqual(policy.transitions);
  });

  it('mirrors every delisting trigger and its severity', () => {
    expect(ASSET_LISTING_TRIGGERS).toEqual(policy.delistingTriggers);
  });

  it('mirrors the stable error codes and HTTP statuses', () => {
    expect(ASSET_LISTING_ERROR_HTTP).toEqual(policy.errorCodes);
    for (const code of Object.values(AssetListingErrorCode)) {
      expect(policy.errorCodes[code]).toBeDefined();
    }
  });
});

describe('asset listing engine (evaluateAssetListing / applyAssetListingDecision)', () => {
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  const inDays = (days: number) => new Date(now + days * 86_400_000).toISOString();

  const usdcRecord: AssetListingRecord = {
    key: 'USDC:GA5Z',
    code: 'USDC',
    issuer: 'GA5Z',
    type: 'credit_alphanum4',
    status: 'listed',
  };

  const completeEvidence = (offset = 30): AssetListingEvidenceRecord[] => [
    { kind: 'toml_document', expiresAt: inDays(offset) },
    { kind: 'attestation_of_reserve', expiresAt: inDays(offset) },
    { kind: 'issuer_identity', expiresAt: inDays(offset + 200) },
    { kind: 'sanctions_screen', expiresAt: inDays(offset + 200) },
    { kind: 'security_review', expiresAt: inDays(offset + 400) },
  ];

  it('requires 5 evidence kinds for the verified tier and 1 for community', () => {
    expect(requiredEvidenceForTier('verified')).toHaveLength(5);
    expect(requiredEvidenceForTier('community')).toEqual(['toml_document']);
    expect(requiredEvidenceForTier('native')).toEqual([]);
  });

  it('serves a listed, fully evidenced verified asset', () => {
    const result = evaluateAssetListing({ record: usdcRecord, evidence: completeEvidence(), now });
    expect(result).toMatchObject({ status: 'listed', tier: 'verified', served: true });
    expect(result.reasons).toEqual([]);
  });

  it('treats evidence expiring exactly at now as expired (inclusive boundary)', () => {
    const boundary = completeEvidence().map((entry) =>
      entry.kind === 'toml_document' ? { ...entry, expiresAt: new Date(now).toISOString() } : entry,
    );
    const result = evaluateAssetListing({ record: usdcRecord, evidence: boundary, now });
    expect(result.status).toBe('suspended');
    expect(result.served).toBe(false);
    expect(result.reasons).toContain('evidence_expired:toml_document');
  });

  it('ages a suspension past suspensionMaxDays out to delisted', () => {
    const record: AssetListingRecord = {
      ...usdcRecord,
      status: 'suspended',
      suspendedAt: inDays(-31),
    };
    const result = evaluateAssetListing({ record, evidence: completeEvidence(), now });
    expect(result.status).toBe('delisted');
    expect(result.reasons).toContain('trigger:suspension_timeout');
  });

  it('never serves a community-tier asset, even when listed', () => {
    const record: AssetListingRecord = {
      key: 'yXLM:GARD',
      code: 'yXLM',
      issuer: 'GARD',
      type: 'credit_alphanum4',
      status: 'listed',
    };
    const result = evaluateAssetListing({
      record,
      evidence: [{ kind: 'toml_document', expiresAt: inDays(30) }],
      now,
    });
    expect(result.tier).toBe('community');
    expect(result.served).toBe(false);
  });

  it('refuses an illegal transition with a stable error code', () => {
    const outcome = applyAssetListingDecision({
      record: { ...usdcRecord, status: 'rejected' },
      action: 'list',
      evidence: completeEvidence(),
      now,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(AssetListingErrorCode.INVALID_TRANSITION);
    expect(outcome.httpStatus).toBe(422);
  });

  it('blocks re-listing during the cooling-off window and allows it after', () => {
    const delisted: AssetListingRecord = {
      ...usdcRecord,
      status: 'delisted',
      delistedAt: inDays(-1),
    };
    const early = applyAssetListingDecision({
      record: delisted,
      action: 'list',
      evidence: completeEvidence(),
      now,
    });
    expect(early.code).toBe(AssetListingErrorCode.COOLING_OFF_ACTIVE);

    const late = applyAssetListingDecision({
      record: { ...delisted, delistedAt: inDays(-31) },
      action: 'list',
      evidence: completeEvidence(),
      now,
    });
    expect(late.ok).toBe(true);
    expect(late.next?.status).toBe('listed');
    expect(late.next?.delistedAt).toBeUndefined();
  });

  it('rejects a re-listing that lacks required evidence', () => {
    const delisted: AssetListingRecord = {
      ...usdcRecord,
      status: 'delisted',
      delistedAt: inDays(-40),
    };
    const outcome = applyAssetListingDecision({ record: delisted, action: 'list', evidence: [], now });
    expect(outcome.code).toBe(AssetListingErrorCode.EVIDENCE_INCOMPLETE);
  });

  it('rejects a delisting justified by an unknown trigger', () => {
    const outcome = applyAssetListingDecision({
      record: usdcRecord,
      action: 'delist',
      trigger: 'not_a_real_trigger',
      now,
    });
    expect(outcome.code).toBe(AssetListingErrorCode.EVIDENCE_INCOMPLETE);
  });

  it('applies a governed delisting and records the timestamp', () => {
    const outcome = applyAssetListingDecision({
      record: usdcRecord,
      action: 'delist',
      trigger: 'reserve_or_peg_failure',
      now,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.next).toMatchObject({
      status: 'delisted',
      lastTrigger: 'reserve_or_peg_failure',
    });
    expect(outcome.next?.delistedAt).toBeDefined();
  });

  it('builds asset keys consistently for native and issued assets', () => {
    expect(assetKeyFor('XLM', null)).toBe('XLM');
    expect(assetKeyFor('USDC', 'GA5')).toBe('USDC:GA5');
  });
});

