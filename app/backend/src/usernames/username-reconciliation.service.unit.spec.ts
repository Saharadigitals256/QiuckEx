/**
 * Unit tests — UsernameReconciliationService (issue #193)
 *
 * Covers:
 *  - reconcileUsernameClaim: active account → confirmed
 *  - reconcileUsernameClaim: account 404 → flagged in DB
 *  - reconcileUsernameClaim: Horizon 5xx → skipped
 *  - reconcileUsernameClaim: no retry on 404 (single call)
 *  - reconcileUsernameClaim: retries on transient errors then confirms
 *  - runBatchReconciliation: processes N usernames, returns correct counts
 *  - runBatchReconciliation: empty batch → zero counts
 *  - runBatchReconciliation: cursor passed to Supabase
 *  - runBatchReconciliation: persists run report
 *  - runBatchReconciliation: feature flag disabled → ServiceUnavailableException
 *  - getReconciliationStatus: returns status row
 *  - getReconciliationStatus: unknown username → NotFoundException
 *  - unflagUsername: clears flag
 *  - unflagUsername: unknown username → NotFoundException
 *  - unflagUsername: feature flag disabled → ServiceUnavailableException
 */

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UsernameReconciliationService } from './username-reconciliation.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AppConfigService } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

const MOCK_PK = 'GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8IYWR';

const make404 = () => Object.assign(new Error('Not found'), { response: { status: 404 } });
const make500 = () => Object.assign(new Error('Server error'), { response: { status: 500 } });

describe('UsernameReconciliationService', () => {
  let service: UsernameReconciliationService;

  const mockSupabase = {
    fetchClaimedUsernames: jest.fn(),
    flagUsernameForReview: jest.fn(),
    unflagUsername: jest.fn(),
    getOwnershipStatus: jest.fn(),
    persistUsernameReconciliationRun: jest.fn(),
  };

  const mockMetrics = {
    recordExternalCall: jest.fn(),
    recordError: jest.fn(),
  };

  let flagEnabled = true;
  const mockFeatureFlags = {
    assertActionEnabled: jest.fn().mockImplementation(async () => {
      if (!flagEnabled) {
        throw new ServiceUnavailableException({ error: 'FEATURE_DISABLED' });
      }
    }),
    getFlagOrThrow: jest.fn().mockResolvedValue({
      key: 'username.claim_reconciliation',
      metadata: { batchSize: 50, retryMaxAttempts: 3, retryBaseMs: 1 }, // 1ms retries in tests
    }),
  };

  let mockLoadAccount: jest.Mock;

  beforeEach(async () => {
    flagEnabled = true;
    jest.clearAllMocks();
    mockLoadAccount = jest.fn();
    mockSupabase.persistUsernameReconciliationRun.mockResolvedValue(undefined);
    mockFeatureFlags.assertActionEnabled.mockImplementation(async () => {
      if (!flagEnabled) throw new ServiceUnavailableException({ error: 'FEATURE_DISABLED' });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsernameReconciliationService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: AppConfigService, useValue: { network: 'testnet' } },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: FeatureFlagsService, useValue: mockFeatureFlags },
      ],
    }).compile();

    service = module.get<UsernameReconciliationService>(UsernameReconciliationService);
    // Patch the private Horizon server with a mock
    (service as unknown as { server: { loadAccount: jest.Mock } }).server = {
      loadAccount: mockLoadAccount,
    };
  });

  // ── Single reconciliation ────────────────────────────────────────────────

  describe('reconcileUsernameClaim', () => {
    it('returns confirmed when account is active on Horizon', async () => {
      mockLoadAccount.mockResolvedValue({ id: MOCK_PK });

      const result = await service.reconcileUsernameClaim('alice', MOCK_PK);

      expect(result.action).toBe('confirmed');
      expect(mockSupabase.flagUsernameForReview).not.toHaveBeenCalled();
      expect(mockMetrics.recordExternalCall).toHaveBeenCalledWith('horizon', 'loadAccount', expect.any(Number));
    });

    it('returns flagged and writes to Supabase when account returns 404', async () => {
      mockLoadAccount.mockRejectedValue(make404());
      mockSupabase.flagUsernameForReview.mockResolvedValue(undefined);

      const result = await service.reconcileUsernameClaim('alice', MOCK_PK);

      expect(result.action).toBe('flagged');
      expect(result.reason).toBe('account_not_found');
      expect(mockSupabase.flagUsernameForReview).toHaveBeenCalledWith(
        'alice',
        expect.any(String),
      );
    });

    it('returns skipped on transient Horizon 5xx (after all retries)', async () => {
      mockLoadAccount.mockRejectedValue(make500());

      const result = await service.reconcileUsernameClaim('alice', MOCK_PK);

      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('horizon_unavailable');
      expect(mockMetrics.recordError).toHaveBeenCalledWith('horizon', 'loadAccount');
    });

    it('does NOT retry on 404 — only one Horizon call is made', async () => {
      mockLoadAccount.mockRejectedValue(make404());
      mockSupabase.flagUsernameForReview.mockResolvedValue(undefined);

      await service.reconcileUsernameClaim('alice', MOCK_PK);

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors and confirms on eventual success', async () => {
      mockLoadAccount
        .mockRejectedValueOnce(make500())
        .mockRejectedValueOnce(make500())
        .mockResolvedValue({ id: MOCK_PK });

      const result = await service.reconcileUsernameClaim('alice', MOCK_PK);

      expect(result.action).toBe('confirmed');
      expect(mockLoadAccount).toHaveBeenCalledTimes(3);
    });
  });

  // ── Batch reconciliation ─────────────────────────────────────────────────

  describe('runBatchReconciliation', () => {
    it('processes a batch and returns correct counts', async () => {
      mockSupabase.fetchClaimedUsernames.mockResolvedValue([
        { id: '1', username: 'alice',   public_key: MOCK_PK, created_at: '2026-01-01T00:00:00Z', last_active_at: null },
        { id: '2', username: 'bob',     public_key: MOCK_PK, created_at: '2026-01-02T00:00:00Z', last_active_at: null },
        { id: '3', username: 'charlie', public_key: MOCK_PK, created_at: '2026-01-03T00:00:00Z', last_active_at: null },
      ]);
      mockLoadAccount
        .mockResolvedValueOnce({ id: MOCK_PK }) // alice: confirmed
        .mockRejectedValueOnce(make404())        // bob:   flagged
        .mockRejectedValueOnce(make500());       // charlie: skipped

      mockSupabase.flagUsernameForReview.mockResolvedValue(undefined);

      const report = await service.runBatchReconciliation(50);

      expect(report.processed).toBe(3);
      expect(report.confirmed).toBe(1);
      expect(report.flagged).toBe(1);
      expect(report.skipped).toBe(1);
      expect(report.runId).toBeDefined();
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns empty report when no claimed usernames', async () => {
      mockSupabase.fetchClaimedUsernames.mockResolvedValue([]);

      const report = await service.runBatchReconciliation(50);

      expect(report.processed).toBe(0);
      expect(report.confirmed).toBe(0);
      expect(report.flagged).toBe(0);
      expect(report.skipped).toBe(0);
    });

    it('passes cursor to fetchClaimedUsernames', async () => {
      const cursor = '2026-06-01T00:00:00Z';
      mockSupabase.fetchClaimedUsernames.mockResolvedValue([]);

      await service.runBatchReconciliation(50, cursor);

      expect(mockSupabase.fetchClaimedUsernames).toHaveBeenCalledWith(50, cursor);
    });

    it('throws ServiceUnavailableException when feature flag is disabled', async () => {
      flagEnabled = false;
      await expect(service.runBatchReconciliation(50)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('persists the run report to Supabase asynchronously', async () => {
      mockSupabase.fetchClaimedUsernames.mockResolvedValue([]);

      await service.runBatchReconciliation(50);

      // Give the async persist a tick
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSupabase.persistUsernameReconciliationRun).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 0 }),
      );
    });

    it('does not throw if persistUsernameReconciliationRun fails', async () => {
      mockSupabase.fetchClaimedUsernames.mockResolvedValue([]);
      mockSupabase.persistUsernameReconciliationRun.mockRejectedValue(new Error('DB unavailable'));

      await expect(service.runBatchReconciliation(50)).resolves.toBeDefined();
    });
  });

  // ── Status ──────────────────────────────────────────────────────────────

  describe('getReconciliationStatus', () => {
    it('returns status row when username exists', async () => {
      mockSupabase.getOwnershipStatus.mockResolvedValue({
        ownership_status: 'claimed',
        last_active_at: '2026-09-01T00:00:00Z',
        public_key: MOCK_PK,
      });

      const result = await service.getReconciliationStatus('alice');

      expect(result.username).toBe('alice');
      expect(result.ownership_status).toBe('claimed');
      expect(result.last_active_at).toBe('2026-09-01T00:00:00Z');
    });

    it('throws NotFoundException when username does not exist', async () => {
      mockSupabase.getOwnershipStatus.mockResolvedValue(null);

      await expect(service.getReconciliationStatus('unknown')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Unflag ──────────────────────────────────────────────────────────────

  describe('unflagUsername', () => {
    it('clears the flag for a known username', async () => {
      mockSupabase.getOwnershipStatus.mockResolvedValue({
        ownership_status: 'flagged',
        last_active_at: null,
        public_key: MOCK_PK,
      });
      mockSupabase.unflagUsername.mockResolvedValue(undefined);

      await expect(service.unflagUsername('alice')).resolves.toBeUndefined();
      expect(mockSupabase.unflagUsername).toHaveBeenCalledWith('alice');
    });

    it('throws NotFoundException when username does not exist', async () => {
      mockSupabase.getOwnershipStatus.mockResolvedValue(null);

      await expect(service.unflagUsername('unknown')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ServiceUnavailableException when feature flag is disabled', async () => {
      flagEnabled = false;
      await expect(service.unflagUsername('alice')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
