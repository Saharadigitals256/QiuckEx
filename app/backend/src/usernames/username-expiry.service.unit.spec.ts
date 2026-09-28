/**
 * Unit tests — UsernameExpiryService (issue #194)
 *
 * Covers:
 *  - Happy path: reserve, idempotent reserve, release, status check
 *  - Conflict: username reserved by another wallet
 *  - Gone: username permanently claimed
 *  - Not found: release/status with unknown reservationId
 *  - sweepExpiredReservations: returns swept count
 *  - sweepInactiveUsernames: returns flagged count
 *  - Feature flag disabled: throws ServiceUnavailableException
 *  - Dependency failure: Supabase error propagates as ServiceUnavailableException
 */

import { ConflictException, GoneException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UsernameExpiryService } from './username-expiry.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AppConfigService } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

const MOCK_PK = 'GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8IYWR';
const MOCK_OTHER_PK = 'GDIFFERENT55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8IYWR';
const FUTURE = new Date(Date.now() + 60_000).toISOString();
const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('UsernameExpiryService', () => {
  let service: UsernameExpiryService;

  const mockSupabase = {
    reserveUsername: jest.fn(),
    releaseUsernameReservation: jest.fn(),
    getReservation: jest.fn(),
    sweepExpiredReservations: jest.fn(),
    flagInactiveUsernames: jest.fn(),
    clearSquattingFlag: jest.fn(),
  };

  const mockMetrics = {
    recordExternalCall: jest.fn(),
    recordError: jest.fn(),
  };

  let flagEnabled = true;
  const mockFeatureFlags = {
    assertActionEnabled: jest.fn().mockImplementation(async () => {
      if (!flagEnabled) {
        throw new ServiceUnavailableException({ error: 'FEATURE_DISABLED', flag: 'username.reservation_expiry' });
      }
    }),
    getFlagOrThrow: jest.fn().mockResolvedValue({
      key: 'username.reservation_expiry',
      metadata: { reservationWindowMs: 900_000, inactivityDays: 180, sweepBatchSize: 100 },
    }),
  };

  beforeEach(async () => {
    flagEnabled = true;
    jest.clearAllMocks();
    mockFeatureFlags.assertActionEnabled.mockImplementation(async () => {
      if (!flagEnabled) {
        throw new ServiceUnavailableException({ error: 'FEATURE_DISABLED', flag: 'username.reservation_expiry' });
      }
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsernameExpiryService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: AppConfigService, useValue: {} },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: FeatureFlagsService, useValue: mockFeatureFlags },
      ],
    }).compile();

    service = module.get<UsernameExpiryService>(UsernameExpiryService);
  });

  // ── Reserve ─────────────────────────────────────────────────────────────

  describe('reserveUsername', () => {
    it('creates a reservation and returns the result', async () => {
      const expected = { reservationId: UUID, username: 'alice', reservedBy: MOCK_PK, reservedUntil: FUTURE };
      mockSupabase.reserveUsername.mockResolvedValue(expected);

      const result = await service.reserveUsername('alice', MOCK_PK, UUID);

      expect(result).toEqual(expected);
      expect(mockSupabase.reserveUsername).toHaveBeenCalledWith('alice', MOCK_PK, UUID, expect.any(String));
    });

    it('returns existing reservation for the same reservationId (idempotent)', async () => {
      const existing = { reservationId: UUID, username: 'alice', reservedBy: MOCK_PK, reservedUntil: FUTURE };
      mockSupabase.reserveUsername.mockResolvedValue(existing);

      const result1 = await service.reserveUsername('alice', MOCK_PK, UUID);
      const result2 = await service.reserveUsername('alice', MOCK_PK, UUID);

      expect(result1).toEqual(existing);
      expect(result2).toEqual(existing);
    });

    it('throws ConflictException when username is reserved by another wallet', async () => {
      mockSupabase.reserveUsername.mockRejectedValue(
        new ConflictException({ code: 'RESERVATION_CONFLICT', message: 'Already reserved' }),
      );

      await expect(service.reserveUsername('alice', MOCK_OTHER_PK, UUID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws GoneException when username is permanently claimed', async () => {
      mockSupabase.reserveUsername.mockRejectedValue(
        new GoneException({ code: 'USERNAME_ALREADY_CLAIMED', message: 'Claimed' }),
      );

      await expect(service.reserveUsername('alice', MOCK_PK, UUID)).rejects.toBeInstanceOf(GoneException);
    });

    it('throws ServiceUnavailableException when feature flag is disabled', async () => {
      flagEnabled = false;
      await expect(service.reserveUsername('alice', MOCK_PK, UUID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('wraps unexpected Supabase errors as ServiceUnavailableException', async () => {
      mockSupabase.reserveUsername.mockRejectedValue(new Error('Network timeout'));
      await expect(service.reserveUsername('alice', MOCK_PK, UUID)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockMetrics.recordError).toHaveBeenCalledWith('supabase', 'reserveUsername');
    });
  });

  // ── Release ─────────────────────────────────────────────────────────────

  describe('releaseReservation', () => {
    it('releases an active reservation', async () => {
      mockSupabase.getReservation.mockResolvedValue({
        username: 'alice',
        reserved_by: MOCK_PK,
        reserved_until: FUTURE,
        reservation_id: UUID,
        ownership_status: 'reserved',
      });
      mockSupabase.releaseUsernameReservation.mockResolvedValue(undefined);

      await expect(service.releaseReservation(UUID, MOCK_PK)).resolves.toBeUndefined();
      expect(mockSupabase.releaseUsernameReservation).toHaveBeenCalledWith(UUID, MOCK_PK);
    });

    it('throws NotFoundException for unknown reservationId', async () => {
      mockSupabase.getReservation.mockResolvedValue(null);
      await expect(service.releaseReservation('unknown-id', MOCK_PK)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when reservation belongs to a different wallet', async () => {
      mockSupabase.getReservation.mockResolvedValue({
        username: 'alice',
        reserved_by: MOCK_OTHER_PK,
        reserved_until: FUTURE,
        reservation_id: UUID,
        ownership_status: 'reserved',
      });
      await expect(service.releaseReservation(UUID, MOCK_PK)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ServiceUnavailableException when feature flag is disabled', async () => {
      flagEnabled = false;
      await expect(service.releaseReservation(UUID, MOCK_PK)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  // ── Status ──────────────────────────────────────────────────────────────

  describe('getReservationStatus', () => {
    it('returns status with expired=false for an active reservation', async () => {
      mockSupabase.getReservation.mockResolvedValue({
        username: 'alice',
        reserved_by: MOCK_PK,
        reserved_until: FUTURE,
        reservation_id: UUID,
        ownership_status: 'reserved',
      });

      const result = await service.getReservationStatus(UUID);

      expect(result.expired).toBe(false);
      expect(result.username).toBe('alice');
    });

    it('returns expired=true when reserved_until is in the past', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      mockSupabase.getReservation.mockResolvedValue({
        username: 'alice',
        reserved_by: MOCK_PK,
        reserved_until: past,
        reservation_id: UUID,
        ownership_status: 'reserved',
      });

      const result = await service.getReservationStatus(UUID);
      expect(result.expired).toBe(true);
    });

    it('throws NotFoundException for unknown reservationId', async () => {
      mockSupabase.getReservation.mockResolvedValue(null);
      await expect(service.getReservationStatus('bad-id')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Expiry sweep ─────────────────────────────────────────────────────────

  describe('sweepExpiredReservations', () => {
    it('returns the count of swept rows', async () => {
      mockSupabase.sweepExpiredReservations.mockResolvedValue(7);

      const result = await service.sweepExpiredReservations();

      expect(result.swept).toBe(7);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns swept=0 when nothing to expire', async () => {
      mockSupabase.sweepExpiredReservations.mockResolvedValue(0);
      const result = await service.sweepExpiredReservations();
      expect(result.swept).toBe(0);
    });
  });

  // ── Anti-squatting sweep ─────────────────────────────────────────────────

  describe('sweepInactiveUsernames', () => {
    it('flags inactive usernames and returns the count', async () => {
      mockSupabase.flagInactiveUsernames.mockResolvedValue(3);

      const result = await service.sweepInactiveUsernames(180);

      expect(result.flagged).toBe(3);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockSupabase.flagInactiveUsernames).toHaveBeenCalledWith(
        expect.any(String), // cutoff ISO date
        100, // default batch size
      );
    });

    it('uses inactivityDaysOverride when provided', async () => {
      mockSupabase.flagInactiveUsernames.mockResolvedValue(1);
      await service.sweepInactiveUsernames(30);
      // Verify cutoff is approximately 30 days ago
      const [cutoffArg] = mockSupabase.flagInactiveUsernames.mock.calls[0] as [string, number];
      const cutoffDate = new Date(cutoffArg);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      expect(Math.abs(cutoffDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(5000);
    });

    it('returns flagged=0 when no inactive usernames', async () => {
      mockSupabase.flagInactiveUsernames.mockResolvedValue(0);
      const result = await service.sweepInactiveUsernames();
      expect(result.flagged).toBe(0);
    });

    it('throws ServiceUnavailableException when feature flag is disabled', async () => {
      flagEnabled = false;
      await expect(service.sweepInactiveUsernames()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
