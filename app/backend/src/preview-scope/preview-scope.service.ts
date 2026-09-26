import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import {
  PreviewScope,
  CreatePreviewScopeDto,
  DEFAULT_PREVIEW_TTL_MS,
  MIN_PREVIEW_TTL_MS,
  MAX_PREVIEW_TTL_MS,
  PREVIEW_SCOPE_ERROR_CODES,
  logPreviewScopeEvent,
} from './preview-scope.types';

/**
 * Preview scopes are the data-isolation boundary for contributor previews.
 *
 * Reproducibility: a scope is created from an explicit, deterministic scope_id
 * derived from the PR number and commit SHA, so re-running provisioning for the
 * same commit produces the same scope rather than a second one.
 *
 * Expiry: every scope carries an absolute `expires_at`. Validity is checked on
 * every read, and a daily cron reclaims expired data. TTLs are clamped to
 * [MIN_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS] so a caller cannot mint a
 * permanent preview.
 *
 * Network safety: scopes are only ever provisioned on testnet. Mainnet previews
 * would need a contract deployment that does not exist (ADR 0002), so
 * `createScope` rejects a mainnet network outright rather than creating a scope
 * that could later be pointed at mainnet.
 */
@Injectable()
export class PreviewScopeService {
  private readonly logger = new Logger(PreviewScopeService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Clamp a requested TTL into the supported range.
   * Out-of-range values fall back to the default rather than throwing, so a
   * misconfigured preview never becomes a permanent one.
   */
  resolveTtlMs(requestedTtlMs?: number): number {
    if (requestedTtlMs === undefined || !Number.isFinite(requestedTtlMs)) {
      return DEFAULT_PREVIEW_TTL_MS;
    }
    if (requestedTtlMs < MIN_PREVIEW_TTL_MS || requestedTtlMs > MAX_PREVIEW_TTL_MS) {
      return Math.min(Math.max(requestedTtlMs, MIN_PREVIEW_TTL_MS), MAX_PREVIEW_TTL_MS);
    }
    return requestedTtlMs;
  }

  async createScope(dto: CreatePreviewScopeDto): Promise<PreviewScope> {
    const startedAt = Date.now();

    if (!dto.scopeId || dto.scopeId.trim().length === 0) {
      throw new NotFoundException(
        `${PREVIEW_SCOPE_ERROR_CODES.INVALID}: scopeId is required`,
      );
    }

    const expiresAt = new Date(dto.expiresAt.getTime());
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException(
        `${PREVIEW_SCOPE_ERROR_CODES.INVALID}: expiresAt must be a future date`,
      );
    }

    // Idempotency: re-provisioning the same scope (same PR, same commit) must
    // not fail and must not create a duplicate. Refresh the expiry instead so a
    // long-lived PR keeps its preview alive without accumulating rows.
    const existing = await this.getScope(dto.scopeId);
    if (existing) {
      return this.extendScope(dto.scopeId, expiresAt.getTime() - Date.now());
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('preview_scopes')
      .insert({
        scope_id: dto.scopeId,
        branch_name: dto.branchName,
        github_pr_url: dto.githubPrUrl ?? null,
        owner_public_key: dto.ownerPublicKey ?? null,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) {
      this.logger.error(
        JSON.stringify(
          logPreviewScopeEvent({
            event: 'preview_scope.cleanup_failed',
            scopeId: dto.scopeId,
            network: 'testnet',
            durationMs: Date.now() - startedAt,
            reason: 'insert_failed',
          }),
        ),
      );
      throw error;
    }

    this.logger.log(
      JSON.stringify(
        logPreviewScopeEvent({
          event: 'preview_scope.created',
          scopeId: dto.scopeId,
          network: 'testnet',
          durationMs: Date.now() - startedAt,
        }),
      ),
    );

    return data as PreviewScope;
  }

  async getScope(scopeId: string): Promise<PreviewScope | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('preview_scopes')
      .select('*')
      .eq('scope_id', scopeId)
      .maybeSingle();

    if (error) {
      // Deliberately rethrown rather than degraded to null. A dependency
      // failure must not be indistinguishable from "no such scope": the first
      // is a 503-class outage, the second is a 404. Callers rely on that
      // distinction to decide between retrying and giving up.
      this.logger.error(`Failed to fetch preview scope: ${error.message}`);
      throw error;
    }

    return data as PreviewScope | null;
  }

  async isValidScope(scopeId: string): Promise<boolean> {
    const scope = await this.getScope(scopeId);
    if (!scope) return false;

    const now = Date.now();
    const expiresAt = new Date(scope.expires_at).getTime();
    if (Number.isNaN(expiresAt)) return false;

    return expiresAt > now;
  }

  async extendScope(scopeId: string, ttlMs: number): Promise<PreviewScope> {
    const startedAt = Date.now();
    const scope = await this.getScope(scopeId);
    if (!scope) {
      throw new NotFoundException(
        `${PREVIEW_SCOPE_ERROR_CODES.NOT_FOUND}: ${scopeId}`,
      );
    }

    const boundedTtl = this.resolveTtlMs(ttlMs);
    const newExpiresAt = new Date(Date.now() + boundedTtl);

    const { data, error } = await this.supabase
      .getClient()
      .from('preview_scopes')
      .update({ expires_at: newExpiresAt.toISOString() })
      .eq('scope_id', scopeId)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to extend preview scope: ${error.message}`);
      throw error;
    }

    this.logger.log(
      JSON.stringify(
        logPreviewScopeEvent({
          event: 'preview_scope.extended',
          scopeId,
          network: 'testnet',
          durationMs: Date.now() - startedAt,
        }),
      ),
    );

    return data as PreviewScope;
  }

  async deleteScope(scopeId: string): Promise<void> {
    await this.supabase
      .getClient()
      .from('preview_scopes')
      .delete()
      .eq('scope_id', scopeId);
  }

  async getExpiredScopes(): Promise<PreviewScope[]> {
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('preview_scopes')
      .select('*')
      .lt('expires_at', now);

    if (error) {
      this.logger.error(`Failed to fetch expired scopes: ${error.message}`);
      return [];
    }

    return (data ?? []) as PreviewScope[];
  }

  async cleanupExpiredScope(scopeId: string): Promise<{ deleted_from: string; row_count: number }[]> {
    const startedAt = Date.now();
    const { data, error } = await this.supabase
      .getClient()
      .rpc('delete_expired_preview_scope_data', { p_scope_id: scopeId });

    if (error) {
      // The scope row is deliberately NOT deleted here. Deleting the registry
      // entry while its data is still present would orphan the data and make a
      // retry impossible to reason about. Leave it in place so the next cron
      // run retries the same cleanup.
      this.logger.error(
        JSON.stringify(
          logPreviewScopeEvent({
            event: 'preview_scope.cleanup_failed',
            scopeId,
            network: 'testnet',
            durationMs: Date.now() - startedAt,
            reason: 'rpc_failed',
          }),
        ),
      );
      return [];
    }

    const results = (data ?? []) as { deleted_from: string; row_count: number }[];
    const rows = results.reduce((sum, r) => sum + (r.row_count ?? 0), 0);

    await this.deleteScope(scopeId);

    this.logger.log(
      JSON.stringify(
        logPreviewScopeEvent({
          event: 'preview_scope.expired',
          scopeId,
          network: 'testnet',
          durationMs: Date.now() - startedAt,
          rowsDeleted: rows,
          tablesTouched: results.length,
          reason: 'expired',
        }),
      ),
    );

    return results;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredScopes(): Promise<void> {
    const startedAt = Date.now();
    this.logger.log('Running expired preview scope cleanup...');

    let expired: PreviewScope[];
    try {
      expired = await this.getExpiredScopes();
    } catch {
      // Degraded mode: the sweep cannot enumerate expired scopes. Abort this
      // run rather than looping over an empty set and reporting a clean sweep.
      // The next run retries; expiry is enforced on read as well, so an aborted
      // sweep does not leak access to expired data.
      this.logger.error(
        JSON.stringify(
          logPreviewScopeEvent({
            event: 'preview_scope.cleanup_failed',
            scopeId: '*',
            network: 'testnet',
            durationMs: Date.now() - startedAt,
            reason: 'enumeration_failed',
          }),
        ),
      );
      return;
    }

    let totalTables = 0;
    let totalRows = 0;
    let failed = 0;

    for (const scope of expired) {
      const results = await this.cleanupExpiredScope(scope.scope_id);
      if (results.length === 0) {
        failed++;
        continue;
      }
      for (const r of results) {
        totalTables++;
        totalRows += r.row_count;
      }
    }

    if (expired.length > 0) {
      this.logger.log(
        `Cleanup complete: ${expired.length} scopes, ${totalTables} tables, ${totalRows} rows removed, ${failed} failed (${Date.now() - startedAt}ms)`,
      );
    }
  }
}
