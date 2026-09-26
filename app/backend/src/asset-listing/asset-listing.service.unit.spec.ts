import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AssetListingService } from './asset-listing.service';
import {
  ASSET_LISTING_POLICY_VERSION,
  AssetListingErrorCode,
  AssetListingEvidenceRecord,
  AssetListingRecord,
} from './asset-listing.policy';
import { InMemoryAssetListingStore } from './asset-listing.store';

type AuditLike = { log: jest.Mock };
type FlagsLike = { evaluateFlag: jest.Mock };
type MetricsLike = Record<string, jest.Mock>;

async function buildHarness(options: {
  records?: AssetListingRecord[];
  evidence?: Record<string, AssetListingEvidenceRecord[]>;
  enforcement?: boolean;
  decisions?: boolean;
  failingStore?: boolean;
}) {
  const records = options.records ?? [];
  const store = new InMemoryAssetListingStore(records);
  if (options.evidence) {
    for (const [key, entry] of Object.entries(options.evidence)) {
      await store.saveEvidence(key, entry);
    }
  }
  if (options.failingStore) {
    store.listRecords = jest.fn().mockRejectedValue(new Error('boom'));
    store.listEvidence = jest.fn().mockRejectedValue(new Error('boom'));
  }

  const audit: AuditLike = { log: jest.fn().mockResolvedValue(undefined) };
  const flags: FlagsLike = {
    evaluateFlag: jest.fn(async (key: string) => ({
      key,
      enabled:
        key === 'assets.listing_policy'
          ? options.enforcement ?? true
          : options.decisions ?? true,
      reason: 'test',
      source: 'test',
    })),
  };
  const metrics: MetricsLike = {
    recordAssetListingDecision: jest.fn(),
    recordAssetListingPolicyDenial: jest.fn(),
    setAssetListingServedAssets: jest.fn(),
    recordAssetListingSuspendedAsset: jest.fn(),
  };

  const service = new AssetListingService(
    store,
    audit as never,
    flags as never,
    metrics as never,
  );
  return { service, store, audit, flags, metrics };
}

const listedUsdc: AssetListingRecord = {
  key: 'USDC:GA5',
  code: 'USDC',
  issuer: 'GA5',
  type: 'credit_alphanum4',
  status: 'listed',
};

const delistedAqua: AssetListingRecord = {
  key: 'AQUA:GBNZ',
  code: 'AQUA',
  issuer: 'GBNZ',
  type: 'credit_alphanum4',
  status: 'delisted',
  delistedAt: '2026-09-01T00:00:00.000Z',
};

const xlm: AssetListingRecord = {
  key: 'XLM',
  code: 'XLM',
  issuer: null,
  type: 'native',
  status: 'listed',
};

const usdcEvidence: AssetListingEvidenceRecord[] = [
  { kind: 'toml_document', expiresAt: '2026-12-01T00:00:00.000Z' },
  { kind: 'attestation_of_reserve', expiresAt: '2026-12-01T00:00:00.000Z' },
  { kind: 'issuer_identity', expiresAt: '2027-06-01T00:00:00.000Z' },
  { kind: 'sanctions_screen', expiresAt: '2027-06-01T00:00:00.000Z' },
  { kind: 'security_review', expiresAt: '2028-03-01T00:00:00.000Z' },
];

describe('AssetListingService', () => {
  it('exposes the published policy version and feature flags', async () => {
    const { service } = await buildHarness({});
    const policy = service.getPolicy();
    expect(policy.policyVersion).toBe(ASSET_LISTING_POLICY_VERSION);
    expect(policy.featureFlags.enforcement).toBe('assets.listing_policy');
    expect(policy.featureFlags.decisions).toBe('assets.listing_decisions');
  });

  describe('filterServed', () => {
    it('is a no-op when the enforcement flag is off (pre-policy behaviour)', async () => {
      const { service } = await buildHarness({
        enforcement: false,
        records: [listedUsdc, delistedAqua],
      });
      const result = await service.filterServed([listedUsdc, delistedAqua]);
      expect(result.policyApplied).toBe(false);
      expect(result.records).toHaveLength(2);
    });

    it('drops delisted assets when enforcement is on', async () => {
      const { service } = await buildHarness({
        records: [listedUsdc, delistedAqua, xlm],
        evidence: { 'USDC:GA5': usdcEvidence },
      });
      const result = await service.filterServed([listedUsdc, delistedAqua, xlm]);
      expect(result.policyApplied).toBe(true);
      expect(result.records.map((record) => record.code).sort()).toEqual(['USDC', 'XLM']);
    });

    it('never fails open: registry outage without a cache is a stable 503', async () => {
      const { service } = await buildHarness({ failingStore: true });
      await expect(service.filterServed([listedUsdc])).rejects.toMatchObject({
        response: { code: AssetListingErrorCode.REGISTRY_UNAVAILABLE },
      });
    });

    it('serves the last known good set with degraded=true after an outage', async () => {
      const { service, store } = await buildHarness({
        records: [listedUsdc, xlm],
        evidence: { 'USDC:GA5': usdcEvidence },
      });
      const warm = await service.filterServed([listedUsdc, xlm]);
      expect(warm.records).toHaveLength(2);

      store.listRecords = jest.fn().mockRejectedValue(new Error('boom'));
      store.listEvidence = jest.fn().mockRejectedValue(new Error('boom'));

      const degraded = await service.filterServed([listedUsdc, xlm]);
      expect(degraded.degraded).toBe(true);
      expect(degraded.records.map((record) => record.code).sort()).toEqual(['USDC', 'XLM']);
    });
  });

  describe('decide', () => {
    it('applies a delisting, persists it and writes an audit record', async () => {
      const { service, store, audit, metrics } = await buildHarness({
        records: [listedUsdc],
        evidence: { 'USDC:GA5': usdcEvidence },
      });

      const decision = await service.decide({
        action: 'delist',
        code: 'USDC',
        issuer: 'GA5',
        trigger: 'reserve_or_peg_failure',
        evidenceRef: 'INC-1',
        idempotencyKey: 'idem-1',
        actor: 'api-key:test',
      });

      expect(decision.fromStatus).toBe('listed');
      expect(decision.toStatus).toBe('delisted');
      expect(decision.idempotent).toBe(false);
      expect((await store.getRecord('USDC:GA5'))?.status).toBe('delisted');
      expect(audit.log).toHaveBeenCalledWith(
        'api-key:test',
        'asset_listing.delist',
        'USDC:GA5',
        expect.objectContaining({ fromStatus: 'listed', toStatus: 'delisted' }),
        undefined,
      );
      expect(metrics.recordAssetListingDecision).toHaveBeenCalledWith(
        'delist',
        'applied',
        'verified',
        expect.any(Number),
      );
    });

    it('replays an idempotent decision without applying it twice', async () => {
      const { service, audit } = await buildHarness({ records: [listedUsdc] });
      const input = {
        action: 'delist',
        code: 'USDC',
        issuer: 'GA5',
        trigger: 'issuer_requested',
        idempotencyKey: 'idem-2',
        actor: 'api-key:test',
      } as const;

      const first = await service.decide(input);
      const second = await service.decide(input);

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.id).toBe(first.id);
      expect(audit.log).toHaveBeenCalledTimes(1);
    });

    it('rejects the same idempotency key with a different payload (409)', async () => {
      const { service } = await buildHarness({ records: [listedUsdc] });
      await service.decide({
        action: 'delist',
        code: 'USDC',
        issuer: 'GA5',
        trigger: 'issuer_requested',
        idempotencyKey: 'idem-3',
        actor: 'api-key:test',
      });

      await expect(
        service.decide({
          action: 'delist',
          code: 'USDC',
          issuer: 'GA5',
          trigger: 'sanctions_or_legal_order',
          idempotencyKey: 'idem-3',
          actor: 'api-key:test',
        }),
      ).rejects.toMatchObject({
        response: { code: AssetListingErrorCode.IDEMPOTENCY_CONFLICT },
      });
    });

    it('refuses decisions while the feature flag is off (mainnet default)', async () => {
      const { service } = await buildHarness({ records: [listedUsdc], decisions: false });
      await expect(
        service.decide({ action: 'delist', code: 'USDC', issuer: 'GA5', actor: 'api-key:test' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns a stable 404 for an unknown asset', async () => {
      const { service } = await buildHarness({ records: [] });
      await expect(
        service.decide({ action: 'delist', code: 'ZZZZ', issuer: 'GXX', actor: 'api-key:test' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a stable 422 for an invalid transition', async () => {
      const { service } = await buildHarness({ records: [{ ...listedUsdc, status: 'rejected' }] });
      await expect(
        service.decide({ action: 'list', code: 'USDC', issuer: 'GA5', actor: 'api-key:test' }),
      ).rejects.toMatchObject({
        response: { code: AssetListingErrorCode.INVALID_TRANSITION },
      });
    });

    it('maps a registry failure during a decision to a stable 503', async () => {
      const { service, store } = await buildHarness({ records: [listedUsdc] });
      store.getRecord = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(
        service.decide({ action: 'delist', code: 'USDC', issuer: 'GA5', actor: 'api-key:test' }),
      ).rejects.toMatchObject({
        response: { code: AssetListingErrorCode.REGISTRY_UNAVAILABLE },
      });
    });
  });
});

