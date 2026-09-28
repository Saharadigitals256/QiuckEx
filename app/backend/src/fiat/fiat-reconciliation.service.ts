import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Stable error codes for fiat reconciliation. These are part of the documented
 * backend client contract (see docs/BACKEND-CLIENT-CONTRACT-MAP.md and
 * app/backend/docs/ERROR-CODES.md) and must not change without a contract bump.
 */
export const FiatReconciliationError = {
  UNAUTHORIZED: 'FIAT_RECON_UNAUTHORIZED',
  DUPLICATE: 'FIAT_RECON_DUPLICATE',
  EXPIRED: 'FIAT_RECON_EXPIRED',
  MALFORMED: 'FIAT_RECON_MALFORMED',
  DEPENDENCY_FAILURE: 'FIAT_RECON_DEPENDENCY_FAILURE',
  FEATURE_DISABLED: 'FIAT_RECON_FEATURE_DISABLED',
} as const;

export type FiatReconciliationErrorCode =
  (typeof FiatReconciliationError)[keyof typeof FiatReconciliationError];

export class FiatReconciliationException extends Error {
  constructor(
    public readonly code: FiatReconciliationErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'FiatReconciliationException';
  }
}

export type FiatDirection = 'deposit' | 'withdrawal';
export type FiatStatus = 'pending' | 'settled' | 'failed' | 'reversed';

export interface ProviderCallback {
  /** Provider-side event id; used for idempotency. */
  eventId: string;
  /** Provider-side transaction reference. */
  providerRef: string;
  direction: FiatDirection;
  status: FiatStatus;
  /** Minor units (e.g. cents) to avoid float drift. */
  amountMinor: number;
  currency: string;
  /** ISO-8601 timestamp of the provider event. */
  occurredAt: string;
  /** Raw signature header supplied by the provider. */
  signature: string;
}

export interface ReconcileResult {
  providerRef: string;
  status: FiatStatus;
  applied: boolean;
  /** True when the callback was a duplicate and was safely ignored. */
  duplicate: boolean;
}

/**
 * Minimal persistence port. The owning module supplies the concrete adapter so
 * this service stays free of ORM concerns and remains unit-testable.
 */
export interface FiatReconciliationStore {
  /** Returns true when the event id was already processed (idempotency guard). */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  recordEvent(eventId: string, providerRef: string): Promise<void>;
  getTransaction(providerRef: string): Promise<{ status: FiatStatus } | null>;
  applyStatus(providerRef: string, status: FiatStatus): Promise<void>;
}

/**
 * Reconciles fiat deposits and withdrawals against provider callbacks.
 *
 * Self-custody is preserved: this service never moves user funds or holds
 * keys. It only mirrors provider settlement state onto the internal ledger so
 * that outage recovery can replay callbacks deterministically.
 */
@Injectable()
export class FiatReconciliationService {
  private readonly logger = new Logger(FiatReconciliationService.name);
  private readonly maxCallbackAgeMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly store: FiatReconciliationStore,
  ) {
    this.maxCallbackAgeMs =
      Number(this.config.get<string>('FIAT_CALLBACK_MAX_AGE_MS')) || 5 * 60 * 1000;
  }

  /**
   * Feature gate: fiat ramps are only enabled on the supported network and
   * must be explicitly turned on before mainnet rollout.
   */
  isEnabled(): boolean {
    return this.config.get<string>('FIAT_RAMPS_ENABLED') === 'true';
  }

  /**
   * Handle a provider callback. Idempotent, signature-verified, and safe to
   * replay during outage recovery.
   */
  async handleCallback(callback: ProviderCallback): Promise<ReconcileResult> {
    if (!this.isEnabled()) {
      throw new FiatReconciliationException(
        FiatReconciliationError.FEATURE_DISABLED,
        'Fiat ramps are not enabled on this network',
      );
    }

    this.assertWellFormed(callback);
    this.assertAuthorized(callback);
    this.assertFresh(callback);

    if (await this.store.hasProcessedEvent(callback.eventId)) {
      this.logger.log(
        `fiat.reconcile.duplicate providerRef=${callback.providerRef} eventId=${callback.eventId}`,
      );
      return {
        providerRef: callback.providerRef,
        status: callback.status,
        applied: false,
        duplicate: true,
      };
    }

    const existing = await this.store.getTransaction(callback.providerRef);
    if (!existing) {
      throw new FiatReconciliationException(
        FiatReconciliationError.MALFORMED,
        `Unknown provider reference ${callback.providerRef}`,
      );
    }

    if (existing.status === callback.status) {
      await this.store.recordEvent(callback.eventId, callback.providerRef);
      return {
        providerRef: callback.providerRef,
        status: callback.status,
        applied: false,
        duplicate: true,
      };
    }

    try {
      await this.store.applyStatus(callback.providerRef, callback.status);
      await this.store.recordEvent(callback.eventId, callback.providerRef);
    } catch (err) {
      this.logger.error(
        `fiat.reconcile.dependency_failure providerRef=${callback.providerRef} eventId=${callback.eventId}`,
      );
      throw new FiatReconciliationException(
        FiatReconciliationError.DEPENDENCY_FAILURE,
        'Failed to persist reconciliation result',
        true,
      );
    }

    this.logger.log(
      `fiat.reconcile.applied providerRef=${callback.providerRef} direction=${callback.direction} status=${callback.status}`,
    );

    return {
      providerRef: callback.providerRef,
      status: callback.status,
      applied: true,
      duplicate: false,
    };
  }

  /**
   * Outage recovery: replay a batch of callbacks. Individual failures are
   * isolated so one bad event cannot block the rest of the batch.
   */
  async recover(callbacks: ProviderCallback[]): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const callback of callbacks) {
      try {
        results.push(await this.handleCallback(callback));
      } catch (err) {
        const code =
          err instanceof FiatReconciliationException
            ? err.code
            : FiatReconciliationError.DEPENDENCY_FAILURE;
        this.logger.warn(
          `fiat.reconcile.recovery_skipped providerRef=${callback.providerRef} code=${code}`,
        );
      }
    }
    return results;
  }

  private assertWellFormed(callback: ProviderCallback): void {
    const valid =
      !!callback &&
      typeof callback.eventId === 'string' &&
      callback.eventId.length > 0 &&
      typeof callback.providerRef === 'string' &&
      callback.providerRef.length > 0 &&
      (callback.direction === 'deposit' || callback.direction === 'withdrawal') &&
      ['pending', 'settled', 'failed', 'reversed'].includes(callback.status) &&
      Number.isInteger(callback.amountMinor) &&
      callback.amountMinor > 0 &&
      typeof callback.currency === 'string' &&
      callback.currency.length === 3;

    if (!valid) {
      throw new FiatReconciliationException(
        FiatReconciliationError.MALFORMED,
        'Malformed provider callback payload',
      );
    }
  }

  private assertAuthorized(callback: ProviderCallback): void {
    const secret = this.config.get<string>('FIAT_PROVIDER_WEBHOOK_SECRET');
    if (!secret || typeof callback.signature !== 'string') {
      throw new FiatReconciliationException(
        FiatReconciliationError.UNAUTHORIZED,
        'Missing provider signature',
      );
    }

    const expected = createHmac('sha256', secret)
      .update(`${callback.eventId}.${callback.providerRef}.${callback.status}`)
      .digest('hex');

    const provided = Buffer.from(callback.signature, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      provided.length !== expectedBuf.length ||
      !timingSafeEqual(provided, expectedBuf)
    ) {
      throw new FiatReconciliationException(
        FiatReconciliationError.UNAUTHORIZED,
        'Invalid provider signature',
      );
    }
  }

  private assertFresh(callback: ProviderCallback): void {
    const occurredAt = Date.parse(callback.occurredAt);
    if (Number.isNaN(occurredAt)) {
      throw new FiatReconciliationException(
        FiatReconciliationError.MALFORMED,
        'Invalid occurredAt timestamp',
      );
    }
    if (Date.now() - occurredAt > this.maxCallbackAgeMs) {
      throw new FiatReconciliationException(
        FiatReconciliationError.EXPIRED,
        'Provider callback is older than the accepted window',
      );
    }
  }
}
