/**
 * UsernameExpiryService — username reservation expiry and anti-squatting safeguards.
 *
 * Issue #194.
 *
 * Responsibilities:
 *  1. Reserve a username for a wallet for a bounded window (default 15 min).
 *  2. Release/cancel an active reservation.
 *  3. Sweep expired reservations back to `expired` status (scheduler-callable).
 *  4. Sweep inactive `claimed` usernames into the anti-squatting review queue.
 *
 * All write operations are gated by the `username.reservation_expiry` feature flag
 * (enabled only in development and test by default).
 *
 * Self-custody contract: this service manipulates only off-chain Supabase metadata.
 * It never touches Stellar accounts, private keys, or on-chain balances.
 */

import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { AppConfigService } from '../config';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../metrics/metrics.service';
import { SupabaseService } from '../supabase/supabase.service';

/** Default reservation window in milliseconds (15 minutes). */
const DEFAULT_RESERVATION_WINDOW_MS = 15 * 60 * 1000;

/** Default inactivity threshold in days before anti-squatting flag is raised. */
const DEFAULT_INACTIVITY_DAYS = 180;

/** Default batch size for the expiry sweep. */
const DEFAULT_SWEEP_BATCH_SIZE = 100;

export interface ReserveUsernameResult {
  reservationId: string;
  username: string;
  reservedBy: string;
  reservedUntil: string;
}

export interface ExpirySweeepResult {
  swept: number;
  durationMs: number;
}

export interface SquattingSweepResult {
  flagged: number;
  durationMs: number;
}

@Injectable()
export class UsernameExpiryService {
  private readonly logger = new Logger(UsernameExpiryService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly supabase: SupabaseService,
    private readonly metrics: MetricsService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reserve
  // ---------------------------------------------------------------------------

  /**
   * Reserve a username for a wallet for a bounded window.
   *
   * Idempotent: supplying the same `reservationId` for the same (username, publicKey)
   * returns the existing reservation without error.
   *
   * Throws:
   *  - `ServiceUnavailableException` — feature flag disabled (FEATURE_DISABLED)
   *  - `ConflictException`           — username reserved by another wallet (RESERVATION_CONFLICT)
   *  - `GoneException`               — username permanently claimed (USERNAME_ALREADY_CLAIMED)
   */
  async reserveUsername(
    username: string,
    publicKey: string,
    reservationId?: string,
  ): Promise<ReserveUsernameResult> {
    await this.featureFlags.assertActionEnabled('username.reservation_expiry');

    const resolvedId = reservationId ?? uuidv4();
    const windowMs = await this.getReservationWindowMs();
    const reservedUntil = new Date(Date.now() + windowMs).toISOString();
    const startMs = Date.now();

    try {
      const result = await this.supabase.reserveUsername(
        username,
        publicKey,
        resolvedId,
        reservedUntil,
      );

      const latencyMs = Date.now() - startMs;
      this.metrics.recordExternalCall('supabase', 'reserveUsername', latencyMs / 1000);
      this.logger.log(
        JSON.stringify({
          event: 'username.reservation.created',
          username,
          reservationId: resolvedId,
          reservedUntil,
          latencyMs,
        }),
      );

      return result;
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      this.metrics.recordExternalCall('supabase', 'reserveUsername', latencyMs / 1000);

      if (err instanceof ConflictException || err instanceof GoneException) {
        this.logger.warn(
          JSON.stringify({
            event: 'username.reservation.conflict',
            username,
            latencyMs,
          }),
        );
        throw err;
      }

      this.metrics.recordError('supabase', 'reserveUsername');
      this.logger.error(
        JSON.stringify({
          event: 'username.reservation.error',
          username,
          error: (err as Error).message,
          latencyMs,
        }),
      );
      throw new ServiceUnavailableException({
        code: 'RESERVATION_DEPENDENCY_FAILURE',
        message: 'Reservation service temporarily unavailable',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Release
  // ---------------------------------------------------------------------------

  /**
   * Cancel/release an active reservation.
   *
   * Idempotent: releasing an already-expired reservation succeeds silently.
   *
   * Throws:
   *  - `ServiceUnavailableException` — feature flag disabled
   *  - `NotFoundException`           — reservationId unknown (RESERVATION_NOT_FOUND)
   */
  async releaseReservation(reservationId: string, publicKey: string): Promise<void> {
    await this.featureFlags.assertActionEnabled('username.reservation_expiry');

    const startMs = Date.now();
    const existing = await this.supabase.getReservation(reservationId);

    if (!existing) {
      throw new NotFoundException({
        code: 'RESERVATION_NOT_FOUND',
        message: `Reservation '${reservationId}' not found`,
      });
    }

    if (existing.reserved_by !== publicKey) {
      throw new NotFoundException({
        code: 'RESERVATION_NOT_FOUND',
        message: `Reservation '${reservationId}' not found`,
      });
    }

    await this.supabase.releaseUsernameReservation(reservationId, publicKey);

    const latencyMs = Date.now() - startMs;
    this.logger.log(
      JSON.stringify({
        event: 'username.reservation.released',
        reservationId,
        latencyMs,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Returns current reservation details by reservationId.
   *
   * Throws `NotFoundException` when the reservationId is unknown or already expired.
   */
  async getReservationStatus(reservationId: string): Promise<{
    reservationId: string;
    username: string;
    reservedBy: string;
    reservedUntil: string;
    expired: boolean;
  }> {
    const row = await this.supabase.getReservation(reservationId);
    if (!row) {
      throw new NotFoundException({
        code: 'RESERVATION_NOT_FOUND',
        message: `Reservation '${reservationId}' not found`,
      });
    }

    const expired = row.reserved_until != null && new Date(row.reserved_until) < new Date();
    return {
      reservationId: row.reservation_id!,
      username: row.username,
      reservedBy: row.reserved_by!,
      reservedUntil: row.reserved_until!,
      expired,
    };
  }

  // ---------------------------------------------------------------------------
  // Expiry sweep
  // ---------------------------------------------------------------------------

  /**
   * Sweep all rows whose reservation window has lapsed.
   *
   * Sets `ownership_status = 'expired'` and clears `reserved_until`, `reserved_by`,
   * `reservation_id`.
   *
   * Safe to call repeatedly (idempotent).
   */
  async sweepExpiredReservations(): Promise<ExpirySweeepResult> {
    const startMs = Date.now();
    const swept = await this.supabase.sweepExpiredReservations();
    const durationMs = Date.now() - startMs;

    this.logger.log(
      JSON.stringify({
        event: 'username.expiry.sweep.complete',
        swept,
        durationMs,
      }),
    );
    this.metrics.recordExternalCall('supabase', 'sweepExpiredReservations', durationMs / 1000);

    return { swept, durationMs };
  }

  // ---------------------------------------------------------------------------
  // Anti-squatting sweep
  // ---------------------------------------------------------------------------

  /**
   * Flag `claimed` usernames that have been inactive for more than `inactivityDays`.
   *
   * Flags up to `batchSize` rows per call (default from feature flag metadata).
   */
  async sweepInactiveUsernames(
    inactivityDaysOverride?: number,
  ): Promise<SquattingSweepResult> {
    await this.featureFlags.assertActionEnabled('username.reservation_expiry');

    const inactivityDays = inactivityDaysOverride ?? (await this.getInactivityDays());
    const batchSize = await this.getSweepBatchSize();
    const cutoff = new Date(Date.now() - inactivityDays * 24 * 60 * 60 * 1000).toISOString();

    const startMs = Date.now();
    const flagged = await this.supabase.flagInactiveUsernames(cutoff, batchSize);
    const durationMs = Date.now() - startMs;

    this.logger.log(
      JSON.stringify({
        event: 'username.squatting.sweep.complete',
        flagged,
        inactivityDays,
        cutoff,
        durationMs,
      }),
    );
    this.metrics.recordExternalCall('supabase', 'flagInactiveUsernames', durationMs / 1000);

    return { flagged, durationMs };
  }

  /**
   * Clear an anti-squatting flag for a username (admin action after manual review).
   */
  async clearSquattingFlag(username: string, publicKey: string): Promise<void> {
    await this.featureFlags.assertActionEnabled('username.reservation_expiry');
    await this.supabase.clearSquattingFlag(username, publicKey);
    this.logger.log(JSON.stringify({ event: 'username.squatting.flag.cleared', username }));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getReservationWindowMs(): Promise<number> {
    try {
      const flag = await this.featureFlags.getFlagOrThrow('username.reservation_expiry');
      const meta = flag.metadata as Record<string, unknown> | undefined;
      const val = meta?.reservationWindowMs;
      if (typeof val === 'number' && val > 0) return val;
    } catch {
      // fall through to default
    }
    return DEFAULT_RESERVATION_WINDOW_MS;
  }

  private async getInactivityDays(): Promise<number> {
    try {
      const flag = await this.featureFlags.getFlagOrThrow('username.reservation_expiry');
      const meta = flag.metadata as Record<string, unknown> | undefined;
      const val = meta?.inactivityDays;
      if (typeof val === 'number' && val > 0) return val;
    } catch {
      // fall through to default
    }
    return DEFAULT_INACTIVITY_DAYS;
  }

  private async getSweepBatchSize(): Promise<number> {
    try {
      const flag = await this.featureFlags.getFlagOrThrow('username.reservation_expiry');
      const meta = flag.metadata as Record<string, unknown> | undefined;
      const val = meta?.sweepBatchSize;
      if (typeof val === 'number' && val > 0) return val;
    } catch {
      // fall through to default
    }
    return DEFAULT_SWEEP_BATCH_SIZE;
  }
}
