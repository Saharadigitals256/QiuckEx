/**
 * Deletion request lifecycle (issue #307).
 *
 * Self-custody proof: the subject signs a server-issued challenge with their
 * Stellar key (ADR-0001) — there is no account, email or password to verify.
 * Only a salted subject hash is persisted with the request.
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { AuditService } from '../../audit/audit.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { MetricsService } from '../../metrics/metrics.service';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsernamesService } from '../../usernames/usernames.service';
import { RetentionService, DAY_MS } from '../retention/retention.service';
import {
  DELETION_SLA,
  RETENTION_ERROR_HTTP,
  RETENTION_FEATURE_FLAGS,
  RetentionErrorCode,
} from '../retention/retention-schedule';

export type DeletionSubjectKind = 'public_key' | 'username';
export type DeletionRequestStatus = 'pending' | 'executing' | 'completed' | 'cancelled';

export interface DeletionChallenge {
  id: string;
  subjectHash: string;
  subjectKind: DeletionSubjectKind;
  publicKey: string;
  purpose: string;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
}

export interface DeletionRequestRecord {
  id: string;
  idempotencyKey: string;
  subjectHash: string;
  subjectKind: DeletionSubjectKind;
  status: DeletionRequestStatus;
  coolingOffEndsAt: string;
  executeBy: string;
  cancelledAt?: string;
  completedAt?: string;
  lastError?: string | null;
  /** Fingerprint of the original payload, used for idempotency-conflict detection. */
  payloadFingerprint: string;
  outcomes: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface DeletionRequestRepository {
  saveChallenge(challenge: DeletionChallenge): Promise<void>;
  getChallenge(id: string): Promise<DeletionChallenge | null>;
  markChallengeConsumed(id: string): Promise<void>;
  /** Best-effort removal of expired challenges (keeps the table small). */
  purgeExpiredChallenges(nowIso: string): Promise<void>;
  saveRequest(request: DeletionRequestRecord): Promise<void>;
  updateRequest(request: DeletionRequestRecord): Promise<void>;
  findByIdempotencyKey(key: string): Promise<DeletionRequestRecord | null>;
  findById(id: string): Promise<DeletionRequestRecord | null>;
  findLiveBySubjectHash(subjectHash: string): Promise<DeletionRequestRecord | null>;
}

export const DELETION_REQUEST_REPOSITORY = Symbol('DELETION_REQUEST_REPOSITORY');

/** In-memory repository: unit tests and single-instance local runs. */
export class InMemoryDeletionRequestRepository implements DeletionRequestRepository {
  private readonly challenges = new Map<string, DeletionChallenge>();
  private readonly requests = new Map<string, DeletionRequestRecord>();

  async saveChallenge(challenge: DeletionChallenge): Promise<void> {
    this.challenges.set(challenge.id, challenge);
  }

  async getChallenge(id: string): Promise<DeletionChallenge | null> {
    return this.challenges.get(id) ?? null;
  }

  async markChallengeConsumed(id: string): Promise<void> {
    const challenge = this.challenges.get(id);
    if (challenge) challenge.consumed = true;
  }

  async purgeExpiredChallenges(nowIso: string): Promise<void> {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= nowIso) this.challenges.delete(id);
    }
  }

  async saveRequest(request: DeletionRequestRecord): Promise<void> {
    this.requests.set(request.id, { ...request });
  }

  async updateRequest(request: DeletionRequestRecord): Promise<void> {
    this.requests.set(request.id, { ...request });
  }

  async findByIdempotencyKey(key: string): Promise<DeletionRequestRecord | null> {
    for (const request of this.requests.values()) {
      if (request.idempotencyKey === key) return request;
    }
    return null;
  }

  async findById(id: string): Promise<DeletionRequestRecord | null> {
    return this.requests.get(id) ?? null;
  }

  async findLiveBySubjectHash(subjectHash: string): Promise<DeletionRequestRecord | null> {
    for (const request of this.requests.values()) {
      if (request.subjectHash === subjectHash && (request.status === 'pending' || request.status === 'executing')) {
        return request;
      }
    }
    return null;
  }
}

/** Supabase-backed repository (production). Tables: `privacy_deletion_requests`, `privacy_deletion_challenges`. */
@Injectable()
export class SupabaseDeletionRequestRepository implements DeletionRequestRepository {
  private readonly logger = new Logger(SupabaseDeletionRequestRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  private get client() {
    return this.supabase.getClient();
  }

  async saveChallenge(challenge: DeletionChallenge): Promise<void> {
    const { error } = await this.client.from('privacy_deletion_challenges').insert({
      id: challenge.id,
      subject_hash: challenge.subjectHash,
      subject_kind: challenge.subjectKind,
      public_key: challenge.publicKey,
      purpose: challenge.purpose,
      issued_at: challenge.issuedAt,
      expires_at: challenge.expiresAt,
      consumed: challenge.consumed,
    });
    if (error) {
      this.logger.warn(`challenge persist failed: ${error.message}`);
      throw new Error('RETENTION_STORE_UNAVAILABLE');
    }
  }

  async getChallenge(id: string): Promise<DeletionChallenge | null> {
    const { data, error } = await this.client
      .from('privacy_deletion_challenges')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      id: String(row.id),
      subjectHash: String(row.subject_hash),
      subjectKind: row.subject_kind as DeletionSubjectKind,
      publicKey: String(row.public_key),
      purpose: String(row.purpose),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      consumed: Boolean(row.consumed),
    };
  }

  async markChallengeConsumed(id: string): Promise<void> {
    const { error } = await this.client
      .from('privacy_deletion_challenges')
      .update({ consumed: true })
      .eq('id', id);
    if (error) throw new Error('RETENTION_STORE_UNAVAILABLE');
  }

  async purgeExpiredChallenges(nowIso: string): Promise<void> {
    const { error } = await this.client
      .from('privacy_deletion_challenges')
      .delete()
      .lt('expires_at', nowIso);
    if (error) {
      this.logger.warn(`challenge purge failed: ${error.message}`);
    }
  }

  async saveRequest(request: DeletionRequestRecord): Promise<void> {
    const { error } = await this.client
      .from('privacy_deletion_requests')
      .insert(this.toRow(request));
    if (error) {
      if (error.code === '23505') {
        throw new Error('DELETION_REQUEST_DUPLICATE');
      }
      this.logger.warn(`deletion request persist failed: ${error.message}`);
      throw new Error('RETENTION_STORE_UNAVAILABLE');
    }
  }

  async updateRequest(request: DeletionRequestRecord): Promise<void> {
    const { error } = await this.client
      .from('privacy_deletion_requests')
      .update(this.toRow(request))
      .eq('id', request.id);
    if (error) throw new Error('RETENTION_STORE_UNAVAILABLE');
  }

  async findByIdempotencyKey(key: string): Promise<DeletionRequestRecord | null> {
    const { data, error } = await this.client
      .from('privacy_deletion_requests')
      .select('*')
      .eq('idempotency_key', key)
      .maybeSingle();
    if (error || !data) return null;
    return this.fromRow(data as Record<string, unknown>);
  }

  async findById(id: string): Promise<DeletionRequestRecord | null> {
    const { data, error } = await this.client
      .from('privacy_deletion_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return this.fromRow(data as Record<string, unknown>);
  }

  async findLiveBySubjectHash(subjectHash: string): Promise<DeletionRequestRecord | null> {
    const { data, error } = await this.client
      .from('privacy_deletion_requests')
      .select('*')
      .eq('subject_hash', subjectHash)
      .in('status', ['pending', 'executing'])
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return this.fromRow(data[0] as Record<string, unknown>);
  }

  private toRow(request: DeletionRequestRecord): Record<string, unknown> {
    return {
      id: request.id,
      idempotency_key: request.idempotencyKey,
      subject_hash: request.subjectHash,
      subject_kind: request.subjectKind,
      status: request.status,
      cooling_off_ends_at: request.coolingOffEndsAt,
      execute_by: request.executeBy,
      cancelled_at: request.cancelledAt ?? null,
      completed_at: request.completedAt ?? null,
      last_error: request.lastError ?? null,
      outcomes: request.outcomes,
      payload_fingerprint: request.payloadFingerprint,
      created_at: request.createdAt,
      updated_at: request.updatedAt,
    };
  }

  private fromRow(row: Record<string, unknown>): DeletionRequestRecord {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      subjectHash: String(row.subject_hash),
      subjectKind: row.subject_kind as DeletionSubjectKind,
      status: row.status as DeletionRequestStatus,
      coolingOffEndsAt: String(row.cooling_off_ends_at),
      executeBy: String(row.execute_by),
      cancelledAt: (row.cancelled_at as string) ?? undefined,
      completedAt: (row.completed_at as string) ?? undefined,
      lastError: (row.last_error as string) ?? null,
      outcomes: Array.isArray(row.outcomes) ? row.outcomes : [],
      payloadFingerprint: String(row.payload_fingerprint ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export interface DeletionRequestAccepted {
  requestId: string;
  status: DeletionRequestStatus;
  acknowledgedWithinBusinessDays: number;
  coolingOffEndsAt: string;
  executeBy: string;
  executeByWithHold: string;
  coolingOffDays: number;
  categories: unknown[];
  idempotent: boolean;
}

@Injectable()
export class DeletionRequestService {
  private readonly logger = new Logger(DeletionRequestService.name);

  constructor(
    @Inject(DELETION_REQUEST_REPOSITORY) private readonly repository: DeletionRequestRepository,
    private readonly retentionService: RetentionService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly metrics: MetricsService,
    private readonly auditService: AuditService,
    @Optional() private readonly usernamesService?: UsernamesService,
  ) {}

  getPolicy() {
    return this.retentionService.getPolicy();
  }

  private fail(code: RetentionErrorCode, message: string, details?: Record<string, unknown>): never {
    throw new HttpException(
      { code, message, ...(details ? { details } : {}) },
      RETENTION_ERROR_HTTP[code],
    );
  }

  private get subjectSalt(): string {
    const configured = process.env.PRIVACY_SUBJECT_HASH_SALT;
    if (configured) return configured;
    if (process.env.NODE_ENV === 'production') {
      this.fail(
        RetentionErrorCode.POLICY_UNAVAILABLE,
        'PRIVACY_SUBJECT_HASH_SALT must be configured in production; refusing to store an unsalted subject hash.',
      );
    }
    return 'quickex-dev-salt';
  }

  private hashSubject(publicKey: string): string {
    return createHash('sha256').update(`${this.subjectSalt}:${publicKey}`).digest('hex');
  }

  /** Canonical challenge string the subject must sign. Deterministic from stored fields. */
  private challengeValue(challenge: DeletionChallenge): string {
    return [
      challenge.purpose,
      challenge.publicKey,
      challenge.id,
      challenge.issuedAt,
      challenge.expiresAt,
    ].join('|');
  }

  private async assertIntakeEnabled(): Promise<void> {
    const evaluation = await this.featureFlags.evaluateFlag(
      RETENTION_FEATURE_FLAGS.deletionRequests,
    );
    if (!evaluation.enabled) {
      this.fail(
        RetentionErrorCode.INTAKE_DISABLED,
        'Deletion request intake is disabled on this network (privacy.deletion_requests flag).',
      );
    }
  }

  private async resolvePublicKey(
    subject: string | undefined,
    kind: DeletionSubjectKind,
  ): Promise<string> {
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      this.fail(RetentionErrorCode.SUBJECT_NOT_FOUND, 'A subject reference is required.');
    }
    const trimmed = subject.trim();
    if (kind === 'public_key') {
      if (!StrKey.isValidEd25519PublicKey(trimmed)) {
        this.fail(
          RetentionErrorCode.SUBJECT_NOT_FOUND,
          'Subject is not a valid Stellar public key (expected a 56-character G… strkey).',
        );
      }
      return trimmed;
    }
    if (!this.usernamesService) {
      this.fail(
        RetentionErrorCode.SUBJECT_NOT_FOUND,
        'Username subjects are unavailable on this instance; use the Stellar public key.',
      );
    }
    let profile: { publicKey?: string } | null = null;
    try {
      profile = (await this.usernamesService.getProfileByUsername(trimmed)) as {
        publicKey?: string;
      } | null;
    } catch {
      profile = null;
    }
    if (!profile?.publicKey || !StrKey.isValidEd25519PublicKey(profile.publicKey)) {
      this.fail(
        RetentionErrorCode.SUBJECT_NOT_FOUND,
        'No public key is registered for that username.',
      );
    }
    return profile.publicKey;
  }

  /** Issue a single-use challenge bound to the subject's key (TTL: challengeTtlSeconds). */
  async issueChallenge(input: {
    subject?: string;
    subjectKind?: DeletionSubjectKind;
    now?: number;
  }): Promise<{ challengeId: string; challenge: string; expiresAt: string; purpose: string }> {
    await this.assertIntakeEnabled();
    const now = input.now ?? Date.now();
    const kind: DeletionSubjectKind =
      input.subjectKind ?? (input.subject?.startsWith('G') ? 'public_key' : 'username');
    const publicKey = await this.resolvePublicKey(input.subject, kind);

    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + DELETION_SLA.challengeTtlSeconds * 1000).toISOString();
    const challenge: DeletionChallenge = {
      id: randomUUID(),
      subjectHash: this.hashSubject(publicKey),
      subjectKind: kind,
      publicKey,
      purpose: DELETION_SLA.proofPurpose,
      issuedAt,
      expiresAt,
      consumed: false,
    };
    await this.repository.saveChallenge(challenge);
    await this.repository.purgeExpiredChallenges(new Date(now).toISOString());

    return {
      challengeId: challenge.id,
      challenge: this.challengeValue(challenge),
      expiresAt,
      purpose: challenge.purpose,
    };
  }

  /** Fetch + validate a challenge and its signature. Throws stable errors. */
  private async verifyProof(
    challengeId: string | undefined,
    signature: string | undefined,
    now: number,
  ): Promise<DeletionChallenge> {
    if (!challengeId) {
      this.fail(RetentionErrorCode.CHALLENGE_UNKNOWN, 'challengeId is required.');
    }
    const challenge = await this.repository.getChallenge(challengeId);
    if (!challenge) {
      this.metrics.recordDeletionProofFailure('unknown');
      this.fail(RetentionErrorCode.CHALLENGE_UNKNOWN, 'Unknown or already purged challenge.');
    }
    if (Date.parse(challenge.expiresAt) <= now) {
      this.metrics.recordDeletionProofFailure('expired');
      this.fail(RetentionErrorCode.CHALLENGE_EXPIRED, 'Challenge has expired; request a new one.');
    }
    if (challenge.consumed) {
      this.metrics.recordDeletionProofFailure('unknown');
      this.fail(RetentionErrorCode.REQUEST_DUPLICATE, 'Challenge was already used.', {
        challengeId,
      });
    }
    if (!signature || typeof signature !== 'string') {
      this.metrics.recordDeletionProofFailure('invalid_signature');
      this.fail(RetentionErrorCode.SIGNATURE_INVALID, 'A base64 ed25519 signature is required.');
    }

    let valid = false;
    try {
      valid = Keypair.fromPublicKey(challenge.publicKey).verify(
        Buffer.from(this.challengeValue(challenge), 'utf8'),
        Buffer.from(signature, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      this.metrics.recordDeletionProofFailure('invalid_signature');
      this.fail(
        RetentionErrorCode.SIGNATURE_INVALID,
        'Signature does not verify against the subject key.',
      );
    }
    return challenge;
  }

  private accepted(request: DeletionRequestRecord, idempotent: boolean): DeletionRequestAccepted {
    return {
      requestId: request.id,
      status: request.status,
      acknowledgedWithinBusinessDays: DELETION_SLA.acknowledgeBusinessDays,
      coolingOffEndsAt: request.coolingOffEndsAt,
      executeBy: request.executeBy,
      executeByWithHold: new Date(
        Date.parse(request.createdAt) + DELETION_SLA.executeDaysWithHold * DAY_MS,
      ).toISOString(),
      coolingOffDays: DELETION_SLA.coolingOffDays,
      categories: request.outcomes,
      idempotent,
    };
  }

  /**
   * Create a deletion request (202) from a verified challenge signature.
   *
   * Order: flag gate → idempotent replay → proof → duplicate live request →
   * persist. Proof failures never log the signature or the raw subject.
   */
  async createRequest(input: {
    subject?: string;
    subjectKind?: DeletionSubjectKind;
    challengeId?: string;
    signature?: string;
    idempotencyKey?: string | null;
    actor: string;
    correlationId?: string;
    now?: number;
  }): Promise<DeletionRequestAccepted> {
    const startedAt = process.hrtime.bigint();
    await this.assertIntakeEnabled();
    const now = input.now ?? Date.now();
    const fingerprint = createHash('sha256')
      .update(`create:${input.challengeId ?? ''}`)
      .digest('hex');

    if (input.idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.payloadFingerprint === fingerprint) {
          return this.accepted(existing, true);
        }
        this.fail(
          RetentionErrorCode.IDEMPOTENCY_CONFLICT,
          'Idempotency-Key was reused with a different payload.',
          { requestId: existing.id },
        );
      }
    }

    const challenge = await this.verifyProof(input.challengeId, input.signature, now);

    const live = await this.repository.findLiveBySubjectHash(challenge.subjectHash);
    if (live) {
      this.fail(RetentionErrorCode.REQUEST_DUPLICATE, 'A deletion request is already in progress for this subject.', {
        requestId: live.id,
      });
    }

    await this.repository.markChallengeConsumed(challenge.id);

    const createdAt = new Date(now).toISOString();
    const sla = this.retentionService.slaFor(new Date(now));
    const request: DeletionRequestRecord = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey ?? `deletion:${challenge.id}`,
      payloadFingerprint: fingerprint,
      subjectHash: challenge.subjectHash,
      subjectKind: challenge.subjectKind,
      status: 'pending',
      coolingOffEndsAt: sla.coolingOffEndsAt,
      executeBy: sla.executeBy,
      outcomes: this.retentionService.subjectOutcomes(),
      createdAt,
      updatedAt: createdAt,
    };

    try {
      await this.repository.saveRequest(request);
    } catch (error) {
      if ((error as Error).message === 'DELETION_REQUEST_DUPLICATE') {
        const duplicate = await this.repository.findLiveBySubjectHash(challenge.subjectHash);
        this.fail(
          RetentionErrorCode.REQUEST_DUPLICATE,
          'A deletion request is already in progress for this subject.',
          duplicate ? { requestId: duplicate.id } : undefined,
        );
      }
      this.fail(
        RetentionErrorCode.STORE_UNAVAILABLE,
        'The deletion request store is unavailable; nothing was persisted. Retry with the same Idempotency-Key.',
      );
    }

    const proofDuration = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.metrics.observeDeletionRequestPhase('proof', proofDuration / 1000);
    this.metrics.observeDeletionRequestPhase('schedule', proofDuration / 1000);
    this.metrics.recordDeletionRequest('pending', 'signed_proof');

    this.logger.log(
      JSON.stringify({
        event: 'privacy.deletion_request',
        requestId: request.id,
        subjectHash: `sha256:${challenge.subjectHash.slice(0, 16)}…`,
        subjectKind: challenge.subjectKind,
        status: request.status,
        categories: request.outcomes.map((entry) => ({
          id: (entry as { id: string }).id,
          action: (entry as { action: string }).action,
          hold: (entry as { hold: string[] | null }).hold,
        })),
        actor: input.actor,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: input.correlationId ?? null,
        outcome: 'accepted',
      }),
    );
    await this.auditService.log(
      input.actor,
      'privacy.deletion_request.created',
      request.id,
      {
        subjectHash: challenge.subjectHash,
        subjectKind: challenge.subjectKind,
        coolingOffEndsAt: request.coolingOffEndsAt,
        executeBy: request.executeBy,
        idempotencyKey: request.idempotencyKey,
      },
      input.correlationId,
    );

    return this.accepted(request, false);
  }

  /** Cancel a pending request during its cooling-off window (rollback path). */
  async cancelRequest(input: {
    requestId?: string;
    challengeId?: string;
    signature?: string;
    actor: string;
    correlationId?: string;
    now?: number;
  }): Promise<{ requestId: string; status: DeletionRequestStatus; idempotent: boolean }> {
    const now = input.now ?? Date.now();
    const request = input.requestId ? await this.repository.findById(input.requestId) : null;
    if (!request) {
      this.fail(RetentionErrorCode.CHALLENGE_UNKNOWN, 'Unknown deletion request.', {
        requestId: input.requestId ?? null,
      });
    }
    if (request.status === 'cancelled') {
      return { requestId: request.id, status: 'cancelled', idempotent: true };
    }
    if (request.status === 'completed') {
      this.fail(
        RetentionErrorCode.ALREADY_EXECUTED,
        'The request already completed; cancellation is no longer possible.',
      );
    }
    if (request.status !== 'pending' || now > Date.parse(request.coolingOffEndsAt)) {
      this.fail(
        RetentionErrorCode.NOT_CANCELLABLE,
        'Cancellation is only possible during the cooling-off window, before execution begins.',
      );
    }

    const challenge = await this.verifyProof(input.challengeId, input.signature, now);
    if (challenge.subjectHash !== request.subjectHash) {
      this.fail(
        RetentionErrorCode.SIGNATURE_INVALID,
        'Challenge proof does not belong to this deletion request.',
      );
    }

    await this.repository.markChallengeConsumed(challenge.id);
    const updatedAt = new Date(now).toISOString();
    await this.repository.updateRequest({
      ...request,
      status: 'cancelled',
      cancelledAt: updatedAt,
      updatedAt,
    });
    this.metrics.recordDeletionRequest('cancelled', 'signed_proof');
    await this.auditService.log(
      input.actor,
      'privacy.deletion_request.cancelled',
      request.id,
      { subjectHash: request.subjectHash },
      input.correlationId,
    );

    return { requestId: request.id, status: 'cancelled', idempotent: false };
  }

  /** Status lookup (admin scoped). Returns only the salted subject hash. */
  async getRequest(requestId: string): Promise<DeletionRequestRecord> {
    const request = await this.repository.findById(requestId);
    if (!request) {
      this.fail(RetentionErrorCode.CHALLENGE_UNKNOWN, 'Unknown deletion request.', {
        requestId,
      });
    }
    return request;
  }
}



