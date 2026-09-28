/**
 * Asset listing service (issue #306).
 *
 * Enforces docs/policies/ASSET-LISTING-POLICY.md at runtime:
 *  - filters the served asset list by policy status (`assets.listing_policy`)
 *  - applies governed list/suspend/delist/re-list decisions with idempotency,
 *    audit records, metrics and stable error codes (`assets.listing_decisions`)
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { AuditService } from '../audit/audit.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  applyAssetListingDecision,
  assetKeyFor,
  evaluateAssetListing,
} from './asset-listing.engine';
import {
  ASSET_LISTING_ERROR_HTTP,
  ASSET_LISTING_FEATURE_FLAGS,
  AssetListingDecisionAction,
  AssetListingErrorCode,
  AssetListingEvaluation,
  AssetListingEvidenceRecord,
  AssetListingRecord,
  AssetListingTriggerId,
  assetListingPolicyView,
} from './asset-listing.policy';
import {
  ASSET_LISTING_STORE,
  AssetListingDecisionRecord,
  AssetListingStore,
} from './asset-listing.store';

export interface AssetListingDecisionInput {
  action: AssetListingDecisionAction;
  code: string;
  issuer?: string | null;
  trigger?: AssetListingTriggerId | string | null;
  evidenceRef?: string | null;
  evidence?: AssetListingEvidenceRecord[];
  idempotencyKey?: string | null;
  actor: string;
  correlationId?: string;
}

export interface ServedFilterResult<T> {
  records: T[];
  degraded: boolean;
  policyApplied: boolean;
  suspended: number;
  evaluations: AssetListingEvaluation[];
}

@Injectable()
export class AssetListingService {
  private readonly logger = new Logger(AssetListingService.name);
  /** Last known good served set, used as the documented degraded mode. */
  private lastKnownGoodKeys: Set<string> | null = null;

  constructor(
    @Inject(ASSET_LISTING_STORE) private readonly store: AssetListingStore,
    private readonly auditService: AuditService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly metrics: MetricsService,
  ) {}

  getPolicy() {
    return assetListingPolicyView();
  }

  async isEnforcementEnabled(): Promise<boolean> {
    const evaluation = await this.featureFlags.evaluateFlag(ASSET_LISTING_FEATURE_FLAGS.enforcement);
    return evaluation.enabled;
  }

  async isDecisionEnabled(): Promise<boolean> {
    const evaluation = await this.featureFlags.evaluateFlag(ASSET_LISTING_FEATURE_FLAGS.decisions);
    return evaluation.enabled;
  }

  /** Evaluate every registry record (registry + evidence read). */
  async evaluateAll(now: number = Date.now()): Promise<AssetListingEvaluation[]> {
    const records = await this.store.listRecords();
    const evaluations: AssetListingEvaluation[] = [];
    for (const record of records) {
      const evidence = await this.store.listEvidence(record.key);
      evaluations.push(evaluateAssetListing({ record, evidence, now }));
    }
    return evaluations;
  }

  /**
   * Filter a set of registry records down to the served list.
   *
   * Never fails open: when the registry is unavailable the last known good set
   * is served with `degraded: true`; with no cached set the request fails with
   * `ASSET_LISTING_REGISTRY_UNAVAILABLE`.
   */
  async filterServed<T extends { code: string; issuer: string | null }>(
    records: T[],
    now: number = Date.now(),
  ): Promise<ServedFilterResult<T>> {
    const enforcement = await this.isEnforcementEnabled();
    if (!enforcement) {
      return { records, degraded: false, policyApplied: false, suspended: 0, evaluations: [] };
    }

    try {
      const evaluations = await this.evaluateAll(now);
      const servedKeys = new Set(
        evaluations.filter((evaluation) => evaluation.served).map((evaluation) => evaluation.key),
      );
      this.lastKnownGoodKeys = servedKeys;
      this.publishGauges(evaluations);

      const filtered = records.filter((record) =>
        servedKeys.has(assetKeyFor(record.code, record.issuer ?? null)),
      );
      return {
        records: filtered,
        degraded: false,
        policyApplied: true,
        suspended: evaluations.filter((evaluation) => evaluation.status === 'suspended').length,
        evaluations,
      };
    } catch (error) {
      this.logger.warn(
        `asset listing registry unavailable: ${(error as Error).message ?? 'unknown error'}`,
      );
      this.metrics.recordAssetListingPolicyDenial('registry_unavailable');
      if (this.lastKnownGoodKeys) {
        const cached = this.lastKnownGoodKeys;
        return {
          records: records.filter((record) => cached.has(assetKeyFor(record.code, record.issuer ?? null))),
          degraded: true,
          policyApplied: true,
          suspended: 0,
          evaluations: [],
        };
      }
      throw new ServiceUnavailableException({
        code: AssetListingErrorCode.REGISTRY_UNAVAILABLE,
        message:
          'Asset listing registry is unavailable; no cached asset list exists, refusing to serve an unverified list.',
      });
    }
  }

  private publishGauges(evaluations: AssetListingEvaluation[]): void {
    const servedByTier = new Map<string, number>();
    for (const evaluation of evaluations) {
      if (evaluation.served) {
        servedByTier.set(evaluation.tier, (servedByTier.get(evaluation.tier) ?? 0) + 1);
      }
      if (evaluation.status === 'suspended') {
        const trigger =
          evaluation.reasons.find((reason) => reason === 'trigger:evidence_expired') ??
          'trigger:suspension_timeout';
        this.metrics.recordAssetListingSuspendedAsset(trigger);
      }
    }
    for (const [tier, count] of servedByTier) {
      this.metrics.setAssetListingServedAssets(tier, count);
    }
  }

  /** Registry view for operators (read-only, safe on mainnet). */
  async listRegistry() {
    const records = await this.store.listRecords();
    const evaluations = await this.evaluateAll();
    const byKey = new Map(evaluations.map((evaluation) => [evaluation.key, evaluation]));
    return records.map((record) => ({
      ...record,
      effectiveStatus: byKey.get(record.key)?.status ?? record.status,
      served: byKey.get(record.key)?.served ?? false,
      reasons: byKey.get(record.key)?.reasons ?? [],
    }));
  }

  async listDecisions(limit = 50): Promise<AssetListingDecisionRecord[]> {
    return this.store.listDecisions(limit);
  }

  /**
   * Apply a governed listing decision.
   *
   * Order of checks matters: idempotent replay is honoured **before** the flag
   * gate so a retry after a flag flip still returns the original record, and the
   * policy engine validates the transition before anything is persisted.
   */
  async decide(
    input: AssetListingDecisionInput,
  ): Promise<AssetListingDecisionRecord & { idempotent: boolean }> {
    const startedAt = process.hrtime.bigint();
    const assetKey = assetKeyFor(input.code, input.issuer ?? null);
    const evidenceRef = input.evidenceRef ?? null;
    const trigger = (input.trigger as AssetListingTriggerId | null) ?? null;

    if (input.idempotencyKey) {
      const existing = await this.store.findDecisionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const samePayload =
          existing.assetKey === assetKey &&
          existing.action === input.action &&
          (existing.trigger ?? null) === trigger &&
          (existing.evidenceRef ?? null) === evidenceRef;
        if (samePayload) return { ...existing, idempotent: true };
        this.metrics.recordAssetListingPolicyDenial('idempotency_conflict');
        throw new ConflictException({
          code: AssetListingErrorCode.IDEMPOTENCY_CONFLICT,
          message: 'Idempotency-Key was reused with a different payload.',
          details: { requestId: existing.id },
        });
      }
    }

    if (!(await this.isDecisionEnabled())) {
      this.metrics.recordAssetListingPolicyDenial('decisions_disabled');
      throw new ForbiddenException({
        code: AssetListingErrorCode.DECISIONS_DISABLED,
        message:
          'Asset listing decisions are disabled on this network. Enable the "assets.listing_decisions" flag after the policy review sign-off.',
      });
    }

    let record: AssetListingRecord | null;
    try {
      record = await this.store.getRecord(assetKey);
    } catch (error) {
      this.metrics.recordAssetListingPolicyDenial('registry_unavailable');
      this.logger.error(
        JSON.stringify({
          event: 'asset_listing.decision',
          assetKey,
          action: input.action,
          outcome: 'failed',
          reason: 'registry_unavailable',
          error: (error as Error).message,
        }),
      );
      throw new HttpException(
        {
          code: AssetListingErrorCode.REGISTRY_UNAVAILABLE,
          message: 'Asset listing registry is unavailable; the decision was not applied.',
        },
        ASSET_LISTING_ERROR_HTTP[AssetListingErrorCode.REGISTRY_UNAVAILABLE],
      );
    }
    if (!record) {
      throw new NotFoundException({
        code: AssetListingErrorCode.NOT_FOUND,
        message: `Unknown asset "${assetKey}".`,
      });
    }

    const evidence = input.evidence ?? (await this.store.listEvidence(assetKey));
    const outcome = applyAssetListingDecision({
      record,
      action: input.action,
      trigger,
      evidence,
    });

    if (!outcome.ok || !outcome.next) {
      const code = outcome.code ?? AssetListingErrorCode.INVALID_TRANSITION;
      this.metrics.recordAssetListingPolicyDenial(code);
      throw new HttpException(
        {
          code,
          message: 'The asset listing policy rejected this decision.',
          reasons: outcome.reasons,
        },
        outcome.httpStatus ?? ASSET_LISTING_ERROR_HTTP[code],
      );
    }

    if (input.evidence) {
      await this.store.saveEvidence(assetKey, input.evidence);
    }
    try {
      await this.store.upsertRecord(outcome.next);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'asset_listing.decision',
          assetKey,
          action: input.action,
          outcome: 'failed',
          reason: 'persist_failed',
          error: (error as Error).message,
        }),
      );
      throw new HttpException(
        {
          code: AssetListingErrorCode.REGISTRY_UNAVAILABLE,
          message: 'Failed to persist the decision; no state was changed.',
        },
        ASSET_LISTING_ERROR_HTTP[AssetListingErrorCode.REGISTRY_UNAVAILABLE],
      );
    }

    const createdAt = outcome.next.updatedAt ?? new Date().toISOString();
    const decision: AssetListingDecisionRecord = {
      id: randomUUID(),
      idempotencyKey:
        input.idempotencyKey ?? `decision:${assetKey}:${input.action}:${createdAt}`,
      assetKey,
      action: input.action,
      fromStatus: record.status,
      toStatus: outcome.next.status,
      trigger,
      evidenceRef,
      actor: input.actor,
      reasons: outcome.reasons,
      createdAt,
    };
    await this.store.saveDecision(decision);

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.metrics.recordAssetListingDecision(
      input.action,
      'applied',
      outcome.next.tier ?? 'unlisted',
      durationMs / 1000,
    );
    this.logger.log(
      JSON.stringify({
        event: 'asset_listing.decision',
        assetKey,
        action: input.action,
        from: record.status,
        to: outcome.next.status,
        tier: outcome.next.tier,
        trigger,
        actor: input.actor,
        idempotencyKey: decision.idempotencyKey,
        correlationId: input.correlationId ?? null,
        durationMs: Math.round(durationMs * 1000) / 1000,
        outcome: 'applied',
      }),
    );
    await this.auditService.log(
      input.actor,
      `asset_listing.${input.action}`,
      assetKey,
      {
        fromStatus: record.status,
        toStatus: outcome.next.status,
        trigger,
        evidenceRef,
        idempotencyKey: decision.idempotencyKey,
        reasons: outcome.reasons,
      },
      input.correlationId,
    );

    return { ...decision, idempotent: false };
  }
}
