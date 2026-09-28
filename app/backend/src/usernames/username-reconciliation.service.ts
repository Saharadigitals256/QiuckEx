/**
 * UsernameReconciliationService — on-chain username claim reconciliation.
 *
 * Issue #193.
 *
 * Verifies that every `claimed` username in Supabase has its owning Stellar
 * account still active on Horizon. Accounts that return 404 are flagged for
 * admin review (`ownership_status = 'flagged'`). Transient Horizon errors
 * result in `skipped` counts so the sweep can be safely retried.
 *
 * Self-custody contract: this service is read-only against Horizon. It never
 * signs transactions, never holds keys, and never moves funds.
 *
 * Feature gate: `username.claim_reconciliation` (dev/test only by default).
 */

import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';

import { AppConfigService } from '../config';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../metrics/metrics.service';
import { SupabaseService } from '../supabase/supabase.service';

export interface ReconciliationRunReport {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  processed: number;
  confirmed: number;
  flagged: number;
  skipped: number;
}

export type ReconciliationAction = 'confirmed' | 'flagged' | 'skipped';

export interface ReconciliationItemResult {
  action: ReconciliationAction;
  reason?: string;
}

@Injectable()
export class UsernameReconciliationService {
  private readonly logger = new Logger(UsernameReconciliationService.name);
  private readonly server: Horizon.Server;

  constructor(
    private readonly config: AppConfigService,
    private readonly supabase: SupabaseService,
    private readonly metrics: MetricsService,
    private readonly featureFlags: FeatureFlagsService,
  ) {
    const horizonUrl =
      config.network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';
    this.server = new Horizon.Server(horizonUrl);
  }

  // ---------------------------------------------------------------------------
  // Single-username reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Reconcile a single claimed username against Horizon.
   *
   * - If the account exists: `confirmed` (no action taken).
   * - If the account returns 404: `flagged` (ownership_status updated in Supabase).
   * - On transient Horizon errors: `skipped` (caller should retry the batch).
   *
   * The feature flag is asserted by batch callers; this method is intentionally
   * not gated so it can be tested in isolation.
   */
  async reconcileUsernameClaim(
    username: string,
    publicKey: string,
  ): Promise<ReconciliationItemResult> {
    const startMs = Date.now();

    try {
      await this.loadAccountWithRetry(publicKey);
      const latencyMs = Date.now() - startMs;
      this.metrics.recordExternalCall('horizon', 'loadAccount', latencyMs / 1000);
      this.logger.log(
        JSON.stringify({
          event: 'username.reconcile.result',
          username,
          status: 'active',
          action: 'confirmed',
          latencyMs,
        }),
      );
      return { action: 'confirmed' };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const horizonErr = err as { response?: { status?: number } };

      if (horizonErr?.response?.status === 404) {
        // Account no longer exists on-chain → flag for admin review.
        await this.supabase.flagUsernameForReview(
          username,
          'Stellar account not found on-chain during reconciliation',
        );
        this.metrics.recordExternalCall('horizon', 'loadAccount', latencyMs / 1000);
        this.logger.warn(
          JSON.stringify({
            event: 'username.reconcile.result',
            username,
            status: 'not_found',
            action: 'flagged',
            latencyMs,
          }),
        );
        return { action: 'flagged', reason: 'account_not_found' };
      }

      // Transient Horizon error — skip and let the batch retry.
      this.metrics.recordError('horizon', 'loadAccount');
      this.logger.warn(
        JSON.stringify({
          event: 'username.reconcile.result',
          username,
          status: 'error',
          action: 'skipped',
          error: (err as Error).message,
          latencyMs,
        }),
      );
      return { action: 'skipped', reason: 'horizon_unavailable' };
    }
  }

  // ---------------------------------------------------------------------------
  // Batch reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Run a bounded batch reconciliation over claimed usernames.
   *
   * @param batchSize - Max rows to process in this run.
   * @param cursor    - ISO `created_at` timestamp to continue from a previous run.
   */
  async runBatchReconciliation(
    batchSize: number,
    cursor?: string,
  ): Promise<ReconciliationRunReport> {
    await this.featureFlags.assertActionEnabled('username.claim_reconciliation');

    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    let processed = 0;
    let confirmed = 0;
    let flagged = 0;
    let skipped = 0;

    const rows = await this.supabase.fetchClaimedUsernames(batchSize, cursor);

    for (const row of rows) {
      processed++;
      const result = await this.reconcileUsernameClaim(row.username, row.public_key).catch(
        (err: Error) => {
          this.logger.error(
            `[${runId}] Unexpected reconciliation error for username '${row.username}': ${err.message}`,
          );
          return { action: 'skipped' as const, reason: 'unexpected_error' };
        },
      );

      if (result.action === 'confirmed') confirmed++;
      else if (result.action === 'flagged') flagged++;
      else skipped++;
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const report: ReconciliationRunReport = {
      runId,
      startedAt,
      completedAt,
      durationMs,
      processed,
      confirmed,
      flagged,
      skipped,
    };

    // Persist run report asynchronously; failure must not surface to the caller.
    this.supabase.persistUsernameReconciliationRun(report).catch((err: Error) => {
      this.logger.error(`Failed to persist reconciliation run ${runId}: ${err.message}`);
    });

    this.logger.log(
      JSON.stringify({
        event: 'username.reconcile.batch.complete',
        runId,
        processed,
        confirmed,
        flagged,
        skipped,
        durationMs,
      }),
    );

    return report;
  }

  // ---------------------------------------------------------------------------
  // Status & admin actions
  // ---------------------------------------------------------------------------

  /**
   * Fetch the current ownership/reconciliation status for a single username.
   * Throws `NotFoundException` when the username is not registered.
   */
  async getReconciliationStatus(username: string): Promise<{
    username: string;
    ownership_status: string;
    last_active_at: string | null;
  }> {
    const row = await this.supabase.getOwnershipStatus(username);
    if (!row) {
      throw new NotFoundException({
        code: 'RECONCILE_USERNAME_NOT_FOUND',
        message: `Username '${username}' not found`,
      });
    }
    return { username, ...row };
  }

  /**
   * Clear a squatting/review flag after an admin has manually verified the username.
   *
   * Throws `NotFoundException` when the username is not registered.
   */
  async unflagUsername(username: string): Promise<void> {
    await this.featureFlags.assertActionEnabled('username.claim_reconciliation');

    const row = await this.supabase.getOwnershipStatus(username);
    if (!row) {
      throw new NotFoundException({
        code: 'RECONCILE_USERNAME_NOT_FOUND',
        message: `Username '${username}' not found`,
      });
    }

    await this.supabase.unflagUsername(username);
    this.logger.log(JSON.stringify({ event: 'username.unflagged', username }));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load a Stellar account with exponential backoff on transient errors.
   * Immediately re-throws 404 errors (account not found) without retrying.
   */
  private async loadAccountWithRetry(
    publicKey: string,
    attempt = 0,
  ): Promise<Horizon.ServerApi.AccountRecord> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err) {
      const horizonErr = err as { response?: { status?: number } };
      // 404 is definitive — do not retry.
      if (horizonErr?.response?.status === 404) throw err;

      const maxAttempts = await this.getMaxRetryAttempts();
      if (attempt < maxAttempts - 1) {
        const baseMs = await this.getRetryBaseMs();
        const delay = baseMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.loadAccountWithRetry(publicKey, attempt + 1);
      }
      throw err;
    }
  }

  private async getMaxRetryAttempts(): Promise<number> {
    try {
      const flag = await this.featureFlags.getFlagOrThrow('username.claim_reconciliation');
      const meta = flag.metadata as Record<string, unknown> | undefined;
      const val = meta?.retryMaxAttempts;
      if (typeof val === 'number' && val > 0) return val;
    } catch {
      // fall through
    }
    return 3;
  }

  private async getRetryBaseMs(): Promise<number> {
    try {
      const flag = await this.featureFlags.getFlagOrThrow('username.claim_reconciliation');
      const meta = flag.metadata as Record<string, unknown> | undefined;
      const val = meta?.retryBaseMs;
      if (typeof val === 'number' && val > 0) return val;
    } catch {
      // fall through
    }
    return 500;
  }
}
