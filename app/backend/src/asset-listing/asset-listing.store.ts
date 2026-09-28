/**
 * Asset listing persistence (issue #306).
 *
 * Decisions and evidence are a durable audit trail, stored in Supabase
 * (`asset_listing_decisions`, `asset_listing_evidence`, plus registry columns
 * added to `verified_assets`). The in-memory store exists for unit tests and
 * single-instance local runs; it is never a substitute on mainnet.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  AssetListingDecisionAction,
  AssetListingEvidenceRecord,
  AssetListingRecord,
  AssetListingStatus,
  AssetListingTier,
  AssetListingTriggerId,
  EvidenceKind,
} from './asset-listing.policy';

export interface AssetListingDecisionRecord {
  id: string;
  idempotencyKey: string;
  assetKey: string;
  action: AssetListingDecisionAction;
  fromStatus: AssetListingStatus;
  toStatus: AssetListingStatus;
  trigger: AssetListingTriggerId | null;
  evidenceRef: string | null;
  actor: string;
  reasons: string[];
  createdAt: string;
}

export interface AssetListingStore {
  listRecords(): Promise<AssetListingRecord[]>;
  getRecord(assetKey: string): Promise<AssetListingRecord | null>;
  upsertRecord(record: AssetListingRecord): Promise<void>;
  listEvidence(assetKey: string): Promise<AssetListingEvidenceRecord[]>;
  saveEvidence(assetKey: string, evidence: AssetListingEvidenceRecord[]): Promise<void>;
  findDecisionByIdempotencyKey(key: string): Promise<AssetListingDecisionRecord | null>;
  saveDecision(decision: AssetListingDecisionRecord): Promise<void>;
  listDecisions(limit: number): Promise<AssetListingDecisionRecord[]>;
}

export const ASSET_LISTING_STORE = Symbol('ASSET_LISTING_STORE');

/** Non-durable store: unit tests and single-instance local development only. */
export class InMemoryAssetListingStore implements AssetListingStore {
  private readonly records = new Map<string, AssetListingRecord>();
  private readonly evidence = new Map<string, AssetListingEvidenceRecord[]>();
  private readonly decisions = new Map<string, AssetListingDecisionRecord>();

  constructor(seed: AssetListingRecord[] = []) {
    for (const record of seed) this.records.set(record.key, record);
  }

  async listRecords(): Promise<AssetListingRecord[]> {
    return [...this.records.values()];
  }

  async getRecord(assetKey: string): Promise<AssetListingRecord | null> {
    return this.records.get(assetKey) ?? null;
  }

  async upsertRecord(record: AssetListingRecord): Promise<void> {
    this.records.set(record.key, record);
  }

  async listEvidence(assetKey: string): Promise<AssetListingEvidenceRecord[]> {
    return this.evidence.get(assetKey) ?? [];
  }

  async saveEvidence(assetKey: string, evidence: AssetListingEvidenceRecord[]): Promise<void> {
    this.evidence.set(assetKey, evidence);
  }

  async findDecisionByIdempotencyKey(key: string): Promise<AssetListingDecisionRecord | null> {
    return this.decisions.get(key) ?? null;
  }

  async saveDecision(decision: AssetListingDecisionRecord): Promise<void> {
    this.decisions.set(decision.idempotencyKey, decision);
  }

  async listDecisions(limit: number): Promise<AssetListingDecisionRecord[]> {
    return [...this.decisions.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }
}

interface VerifiedAssetRow {
  code: string;
  issuer: string | null;
  type: AssetListingRecord['type'];
  listing_status?: AssetListingStatus | null;
  listing_tier?: AssetListingTier | null;
  delisted_at?: string | null;
  suspended_at?: string | null;
}

/** Supabase-backed store (production). */
@Injectable()
export class SupabaseAssetListingStore implements AssetListingStore {
  private readonly logger = new Logger(SupabaseAssetListingStore.name);

  constructor(private readonly supabase: SupabaseService) {}

  private get client() {
    return this.supabase.getClient();
  }

  private toRecord(row: VerifiedAssetRow): AssetListingRecord {
    return {
      key: row.issuer ? `${row.code}:${row.issuer}` : row.code,
      code: row.code,
      issuer: row.issuer,
      type: row.type,
      status: row.listing_status ?? 'pending',
      tier: row.listing_tier ?? undefined,
      delistedAt: row.delisted_at ?? undefined,
      suspendedAt: row.suspended_at ?? undefined,
    };
  }

  async listRecords(): Promise<AssetListingRecord[]> {
    const { data, error } = await this.client
      .from('verified_assets')
      .select('code,issuer,type,listing_status,listing_tier,delisted_at,suspended_at');
    if (error) {
      this.logger.warn(`asset listing registry read failed: ${error.message}`);
      throw new Error('ASSET_LISTING_REGISTRY_UNAVAILABLE');
    }
    return (data ?? []).map((row) => this.toRecord(row as VerifiedAssetRow));
  }

  async getRecord(assetKey: string): Promise<AssetListingRecord | null> {
    const records = await this.listRecords();
    return records.find((record) => record.key === assetKey) ?? null;
  }

  async upsertRecord(record: AssetListingRecord): Promise<void> {
    const base = this.client
      .from('verified_assets')
      .update({
        listing_status: record.status,
        listing_tier: record.tier ?? null,
        delisted_at: record.delistedAt ?? null,
        suspended_at: record.suspendedAt ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('code', record.code);
    const { error } = await (record.issuer
      ? base.eq('issuer', record.issuer)
      : base.is('issuer', null));
    if (error) throw new Error('ASSET_LISTING_REGISTRY_UNAVAILABLE');
  }

  async listEvidence(assetKey: string): Promise<AssetListingEvidenceRecord[]> {
    const { data, error } = await this.client
      .from('asset_listing_evidence')
      .select('kind,expires_at')
      .eq('asset_key', assetKey);
    if (error) throw new Error('ASSET_LISTING_REGISTRY_UNAVAILABLE');
    return (data ?? []).map((row) => {
      const entry = row as { kind: EvidenceKind; expires_at: string };
      return { kind: entry.kind, expiresAt: entry.expires_at };
    });
  }

  async saveEvidence(assetKey: string, evidence: AssetListingEvidenceRecord[]): Promise<void> {
    if (evidence.length === 0) return;
    const { error } = await this.client.from('asset_listing_evidence').upsert(
      evidence.map((entry) => ({
        asset_key: assetKey,
        kind: entry.kind,
        expires_at: entry.expiresAt,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'asset_key,kind' },
    );
    if (error) throw new Error('ASSET_LISTING_REGISTRY_UNAVAILABLE');
  }

  async findDecisionByIdempotencyKey(key: string): Promise<AssetListingDecisionRecord | null> {
    const { data, error } = await this.client
      .from('asset_listing_decisions')
      .select('*')
      .eq('idempotency_key', key)
      .maybeSingle();
    if (error || !data) return null;
    return this.mapDecision(data as Record<string, unknown>);
  }

  async saveDecision(decision: AssetListingDecisionRecord): Promise<void> {
    const { error } = await this.client.from('asset_listing_decisions').insert({
      id: decision.id,
      idempotency_key: decision.idempotencyKey,
      asset_key: decision.assetKey,
      action: decision.action,
      from_status: decision.fromStatus,
      to_status: decision.toStatus,
      trigger: decision.trigger,
      evidence_ref: decision.evidenceRef,
      actor: decision.actor,
      reasons: decision.reasons,
      created_at: decision.createdAt,
    });
    if (error) throw new Error('ASSET_LISTING_REGISTRY_UNAVAILABLE');
  }

  async listDecisions(limit: number): Promise<AssetListingDecisionRecord[]> {
    const { data, error } = await this.client
      .from('asset_listing_decisions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []).map((row) => this.mapDecision(row as Record<string, unknown>));
  }

  private mapDecision(row: Record<string, unknown>): AssetListingDecisionRecord {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      assetKey: String(row.asset_key),
      action: row.action as AssetListingDecisionAction,
      fromStatus: row.from_status as AssetListingStatus,
      toStatus: row.to_status as AssetListingStatus,
      trigger: (row.trigger as AssetListingTriggerId) ?? null,
      evidenceRef: (row.evidence_ref as string) ?? null,
      actor: String(row.actor ?? 'unknown'),
      reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
      createdAt: String(row.created_at),
    };
  }
}
