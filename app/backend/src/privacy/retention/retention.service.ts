/**
 * Retention service (issue #307).
 *
 * Owns sweep planning and execution for docs/policies/DATA-RETENTION-PRIVACY-POLICY.md:
 * dry-run by default, holds evaluated before any destructive step, idempotent
 * per record so a retry after a partial failure never double-deletes.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

import { AuditService } from '../../audit/audit.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  DELETION_SLA,
  DeletionMethod,
  INDEFINITE_RETENTION,
  RETENTION_CATEGORIES,
  RETENTION_ERROR_HTTP,
  RETENTION_FEATURE_FLAGS,
  RETENTION_HOLDS,
  RetentionCategory,
  RetentionErrorCode,
  RetentionHoldId,
  deletionSlaFor,
  effectiveMethodFor,
  retentionPolicyView,
} from './retention-schedule';

export const RETENTION_DRIVER = Symbol('RETENTION_DRIVER');
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DueRecord {
  id: string;
  windowStart: string;
}

export interface RetentionDriver {
  listRecordsDue(
    category: RetentionCategory,
    cutoffIso: string,
    limit: number,
  ): Promise<DueRecord[]>;
  /** Must be idempotent per record id: deleting a missing record is a success. */
  deleteRecord(
    category: RetentionCategory,
    id: string,
    method: DeletionMethod,
  ): Promise<void>;
}

/** Non-durable driver used by unit tests and local development. */
export class InMemoryRetentionDriver implements RetentionDriver {
  private readonly rows = new Map<string, Array<{ id: string; windowStart: string }>>();
  private readonly deleted: Array<{ category: string; id: string; method: string }> = [];
  private failing = false;

  seed(category: string, rows: Array<{ id: string; windowStart: string }>): void {
    this.rows.set(category, rows);
  }

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  get deletedRows() {
    return this.deleted;
  }

  async listRecordsDue(
    category: RetentionCategory,
    cutoffIso: string,
    limit: number,
  ): Promise<DueRecord[]> {
    if (this.failing) {
      throw new Error('RETENTION_STORE_UNAVAILABLE');
    }
    const cutoff = Date.parse(cutoffIso);
    return (this.rows.get(category.id) ?? [])
      .filter((row) => Date.parse(row.windowStart) <= cutoff)
      .slice(0, limit);
  }

  async deleteRecord(
    category: RetentionCategory,
    id: string,
    method: DeletionMethod,
  ): Promise<void> {
    if (this.failing) {
      throw new Error('RETENTION_STORE_UNAVAILABLE');
    }
    this.deleted.push({ category: category.id, id, method });
  }
}

/** Default hold → category bindings (policy §4), extendable by env override. */
export const DEFAULT_HOLD_SCOPE: Record<RetentionHoldId, string[]> = {
  legal_obligation: ['financial_records', 'audit_logs'],
  regulatory_defense: ['asset_listing_evidence', 'verified_assets', 'scam_alerts'],
  forensic_audit: ['contract_registry_history'],
  security_incident_active: [],
};

/**
 * Effective method under active holds — see `effectiveMethodFor` in
 * ./retention-schedule (pure, unit tested there).
 */
export interface SweepRunResult {
  runId: string;
  mode: 'dry_run' | 'apply';
  planned: Array<{
    category: string;
    due: number;
    action: DeletionMethod;
    hold: RetentionHoldId[] | null;
  }>;
  failed: Array<{ category: string; error: string }>;
  recordsProcessed: number;
  completed: boolean;
  durationMs: number;
  idempotent?: boolean;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly runs = new Map<string, SweepRunResult>();

  constructor(
    @Inject(RETENTION_DRIVER) private readonly driver: RetentionDriver,
    private readonly auditService: AuditService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly metrics: MetricsService,
  ) {}

  getPolicy() {
    return retentionPolicyView();
  }

  /** Holds in force for a category: defaults + `PRIVACY_HOLD_OVERRIDES_JSON`. */
  activeHoldsFor(categoryId: string): RetentionHoldId[] {
    const active = new Set<RetentionHoldId>();
    const category = RETENTION_CATEGORIES.find((entry) => entry.id === categoryId);
    for (const [holdId, categories] of Object.entries(DEFAULT_HOLD_SCOPE)) {
      if (categories.includes(categoryId)) active.add(holdId as RetentionHoldId);
    }
    try {
      const raw = process.env.PRIVACY_HOLD_OVERRIDES_JSON;
      if (raw) {
        const overrides = JSON.parse(raw) as Record<string, string[]>;
        for (const [holdId, categories] of Object.entries(overrides)) {
          if (categories.includes(categoryId)) active.add(holdId as RetentionHoldId);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Ignoring malformed PRIVACY_HOLD_OVERRIDES_JSON: ${(error as Error).message}`,
      );
    }
    // A hold can only be honoured on a category the policy marks holdable.
    if (category && !category.holdable) return [];
    return [...active];
  }

  /** Per-category outcomes for a subject deletion request (policy §3.1). */
  subjectOutcomes() {
    return RETENTION_CATEGORIES.map((category) => {
      const holds = this.activeHoldsFor(category.id);
      const effective = effectiveMethodFor(category, holds);
      return {
        id: category.id,
        storage: category.storage,
        method: category.method,
        action: effective.method,
        retained: effective.retained,
        hold: effective.holds.length > 0 ? effective.holds : null,
        windowDays: category.windowDays,
      };
    });
  }

  /** SLA dates for a request created at `createdAt` (pure helper: retention-schedule). */
  slaFor(createdAt: Date) {
    return deletionSlaFor(createdAt);
  }

  /**
   * Plan (and optionally execute) a retention sweep.
   *
   * - dry-run by default: `apply: false` returns what *would* be processed
   * - gated by `privacy.retention_sweep` (disabled on mainnet by default)
   * - idempotent: replays of the same `idempotencyKey` return the original run
   * - fail-safe: a driver error stops the run and marks it incomplete; a run is
   *   never reported as completed with partial deletions
   */
  async sweep(input: {
    apply?: boolean;
    actor: string;
    idempotencyKey?: string | null;
    correlationId?: string;
    batchSize?: number;
    now?: number;
  }): Promise<SweepRunResult> {
    const startedAt = process.hrtime.bigint();
    const now = input.now ?? Date.now();
    const mode: 'dry_run' | 'apply' = input.apply ? 'apply' : 'dry_run';

    if (!(await this.featureFlags.evaluateFlag(RETENTION_FEATURE_FLAGS.retentionSweep)).enabled) {
      this.metrics.recordRetentionSweepRecord('all', 'disabled', 'failed');
      throw new ForbiddenException({
        code: RetentionErrorCode.SWEEP_DISABLED,
        message:
          'The retention sweep is disabled on this network (privacy.retention_sweep flag). Dry-run reports remain available from GET /privacy/retention-policy.',
      });
    }

    if (input.idempotencyKey) {
      const replay = this.runs.get(input.idempotencyKey);
      if (replay) return { ...replay, idempotent: true };
    }

    const runId = `sweep-${new Date(now).toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
    const planned: SweepRunResult['planned'] = [];
    const failed: SweepRunResult['failed'] = [];
    let recordsProcessed = 0;
    let completed = true;
    const batchSize = input.batchSize ?? Number(process.env.PRIVACY_SWEEP_BATCH_SIZE ?? 500);

    for (const category of RETENTION_CATEGORIES) {
      if (category.windowDays === INDEFINITE_RETENTION) continue;
      if (category.method === 'not_deletable' || category.method === 'device_local') continue;

      const cutoffIso = new Date(now - category.windowDays * DAY_MS).toISOString();
      let due: DueRecord[];
      try {
        due = await this.driver.listRecordsDue(category, cutoffIso, batchSize);
      } catch (error) {
        const message = (error as Error).message ?? 'unknown';
        this.metrics.recordRetentionSweepRecord(category.id, category.method, 'failed');
        this.logger.error(
          JSON.stringify({
            event: 'privacy.retention_sweep',
            runId,
            mode,
            category: category.id,
            outcome: 'failed',
            error: message,
          }),
        );
        failed.push({ category: category.id, error: message });
        completed = false;
        break;
      }

      this.metrics.setRetentionRecordsDue(category.id, due.length);
      if (due.length === 0) continue;

      const holds = this.activeHoldsFor(category.id);
      const effective = effectiveMethodFor(category, holds);
      planned.push({
        category: category.id,
        due: due.length,
        action: effective.method,
        hold: effective.holds.length > 0 ? effective.holds : null,
      });

      if (mode === 'dry_run') continue;

      let categoryFailed = false;
      for (const row of due) {
        if (effective.retained) {
          this.metrics.recordRetentionSweepRecord(category.id, category.method, 'retained');
          continue;
        }
        try {
          await this.driver.deleteRecord(category, row.id, effective.method);
          recordsProcessed += 1;
          this.metrics.recordRetentionSweepRecord(
            category.id,
            effective.method,
            effective.method === category.method ? 'deleted' : 'narrowed',
          );
        } catch (error) {
          this.metrics.recordRetentionSweepRecord(category.id, effective.method, 'failed');
          failed.push({ category: category.id, error: (error as Error).message ?? 'unknown' });
          categoryFailed = true;
          break;
        }
      }
      if (categoryFailed) {
        completed = false;
        break;
      }
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.metrics.observeRetentionSweepDuration(mode, durationMs / 1000);
    const result: SweepRunResult = {
      runId,
      mode,
      planned,
      failed,
      recordsProcessed,
      completed,
      durationMs: Math.round(durationMs * 100) / 100,
    };

    this.logger.log(
      JSON.stringify({
        event: 'privacy.retention_sweep',
        runId,
        mode,
        due: planned.map((entry) => ({ category: entry.category, count: entry.due })),
        deleted: recordsProcessed,
        failed,
        durationMs: result.durationMs,
        outcome: completed ? 'ok' : 'incomplete',
        actor: input.actor,
        correlationId: input.correlationId ?? null,
      }),
    );
    await this.auditService.log(
      input.actor,
      'retention.sweep',
      runId,
      {
        mode,
        planned,
        failed,
        recordsProcessed,
        completed,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      input.correlationId,
    );

    if (input.idempotencyKey) {
      this.runs.set(input.idempotencyKey, result);
    }
    return result;
  }
}

