import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../supabase/supabase.service';
import { PreviewScopeService } from './preview-scope.service';
import {
  CreatePreviewScopeDto,
  DEFAULT_PREVIEW_TTL_MS,
  MIN_PREVIEW_TTL_MS,
  MAX_PREVIEW_TTL_MS,
  PREVIEW_SCOPE_ERROR_CODES,
} from './preview-scope.types';

describe('PreviewScopeService', () => {
  let service: PreviewScopeService;
  let supabase: jest.Mocked<SupabaseService>;

  const mockScopeRow = {
    id: 'scope-uuid',
    scope_id: 'pr-42',
    branch_name: 'feat/test-branch',
    github_pr_url: 'https://github.com/pulsefy/QuickEx/pull/42',
    owner_public_key: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const buildMockResponse = (data: unknown) => ({ data, error: null });

  // Returns a chainable query builder whose terminal methods resolve with the
  // given response.  Each chained method returns the builder itself.
  function createMockBuilder(response: unknown) {
    const builder: Record<string, jest.Mock> = {
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue(buildMockResponse(response)),
      maybeSingle: jest.fn().mockResolvedValue(buildMockResponse(response)),
    };

    const builderWithThen = Object.assign(
      Promise.resolve(buildMockResponse(response)),
      builder,
    ) as Record<string, jest.Mock> & PromiseLike<unknown>;

    // All builder methods should return the thenable builder
    for (const key of Object.keys(builder)) {
      (builderWithThen[key] as jest.Mock).mockReturnValue(builderWithThen);
    }

    return builderWithThen;
  }

  beforeEach(async () => {
    const mockClient = {
      from: jest.fn().mockReturnValue(createMockBuilder(mockScopeRow)),
    };

    const mockSupabase = {
      getClient: jest.fn().mockReturnValue(mockClient),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreviewScopeService,
        { provide: SupabaseService, useValue: mockSupabase },
      ],
    }).compile();

    service = module.get<PreviewScopeService>(PreviewScopeService);
    supabase = module.get(SupabaseService) as jest.Mocked<SupabaseService>;
  });

  /* ─── createScope ─────────────────────────────────────────────────────── */

  it('should create a preview scope', async () => {
    const dto: CreatePreviewScopeDto = {
      scopeId: 'pr-42',
      branchName: 'feat/test-branch',
      githubPrUrl: 'https://github.com/pulsefy/QuickEx/pull/42',
      ownerPublicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    const result = await service.createScope(dto);
    expect(result).toBeDefined();
    expect(result.scope_id).toBe('pr-42');
  });

  /* ─── getScope / isValidScope ─────────────────────────────────────────── */

  it('should return a scope by scope_id', async () => {
    const result = await service.getScope('pr-42');
    expect(result).toBeDefined();
    expect(result!.scope_id).toBe('pr-42');
  });

  it('should return null for a non-existent scope', async () => {
    const mockClient = supabase.getClient();
    (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(null));

    const result = await service.getScope('nonexistent');
    expect(result).toBeNull();
  });

  it('should return true for a valid (non-expired) scope', async () => {
    const valid = await service.isValidScope('pr-42');
    expect(valid).toBe(true);
  });

  it('should return false for an expired scope', async () => {
    const expiredRow = {
      ...mockScopeRow,
      expires_at: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago
    };

    const mockClient = supabase.getClient();
    (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(expiredRow));

    const valid = await service.isValidScope('pr-expired');
    expect(valid).toBe(false);
  });

  /* ─── extendScope ────────────────────────────────────────────────────── */

  it('should extend scope expiry', async () => {
    const result = await service.extendScope('pr-42', 86_400_000);
    expect(result).toBeDefined();
    expect(result.scope_id).toBe('pr-42');
  });

  /* ─── deleteScope ────────────────────────────────────────────────────── */

  it('should delete a scope without throwing', async () => {
    await expect(service.deleteScope('pr-42')).resolves.not.toThrow();
  });

  /* ─── getExpiredScopes ────────────────────────────────────────────────── */

  it('should return expired scopes', async () => {
    // Override response to return an array
    const mockClient = supabase.getClient();
    const builder = createMockBuilder([mockScopeRow]);
    (mockClient.from as jest.Mock).mockReturnValue(builder);

    const result = await service.getExpiredScopes();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].scope_id).toBe('pr-42');
  });

  /* ─── TTL bounding ────────────────────────────────────────────────────── */

  describe('resolveTtlMs', () => {
    it('should return the default when no TTL is requested', () => {
      expect(service.resolveTtlMs()).toBe(DEFAULT_PREVIEW_TTL_MS);
    });

    it('should return the default for a non-finite TTL', () => {
      expect(service.resolveTtlMs(Number.NaN)).toBe(DEFAULT_PREVIEW_TTL_MS);
      expect(service.resolveTtlMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PREVIEW_TTL_MS);
    });

    it('should pass through a TTL inside the supported range', () => {
      const ttl = 3 * 24 * 60 * 60 * 1000;
      expect(service.resolveTtlMs(ttl)).toBe(ttl);
    });

    it('should clamp a TTL below the minimum up to the minimum', () => {
      expect(service.resolveTtlMs(1000)).toBe(MIN_PREVIEW_TTL_MS);
      expect(service.resolveTtlMs(0)).toBe(MIN_PREVIEW_TTL_MS);
      expect(service.resolveTtlMs(-5000)).toBe(MIN_PREVIEW_TTL_MS);
    });

    it('should clamp a TTL above the maximum down to the maximum', () => {
      // A caller must not be able to mint a permanent preview.
      expect(service.resolveTtlMs(365 * 24 * 60 * 60 * 1000)).toBe(MAX_PREVIEW_TTL_MS);
    });

    it('should accept the exact boundary values unchanged', () => {
      expect(service.resolveTtlMs(MIN_PREVIEW_TTL_MS)).toBe(MIN_PREVIEW_TTL_MS);
      expect(service.resolveTtlMs(MAX_PREVIEW_TTL_MS)).toBe(MAX_PREVIEW_TTL_MS);
    });
  });

  /* ─── createScope validation ──────────────────────────────────────────── */

  describe('createScope validation', () => {
    it('should reject an empty scopeId with a stable error code', async () => {
      await expect(
        service.createScope({
          scopeId: '   ',
          branchName: 'feat/x',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow(PREVIEW_SCOPE_ERROR_CODES.INVALID);
    });

    it('should reject an expiresAt in the past with a stable error code', async () => {
      await expect(
        service.createScope({
          scopeId: 'pr-1',
          branchName: 'feat/x',
          expiresAt: new Date(Date.now() - 1000),
        }),
      ).rejects.toThrow(PREVIEW_SCOPE_ERROR_CODES.INVALID);
    });

    it('should reject an invalid expiresAt date', async () => {
      await expect(
        service.createScope({
          scopeId: 'pr-1',
          branchName: 'feat/x',
          expiresAt: new Date('not-a-date'),
        }),
      ).rejects.toThrow(PREVIEW_SCOPE_ERROR_CODES.INVALID);
    });

    it('should be idempotent: an existing scope is extended, not duplicated', async () => {
      const mockClient = supabase.getClient();
      const builder = createMockBuilder(mockScopeRow);
      (mockClient.from as jest.Mock).mockReturnValue(builder);

      // The mock returns the same row for the existence check, so createScope
      // must take the extend path rather than inserting a second row.
      const result = await service.createScope({
        scopeId: 'pr-42',
        branchName: 'feat/test-branch',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      expect(result.scope_id).toBe('pr-42');
      // No insert should have been issued on the idempotent path.
      expect(builder.insert).not.toHaveBeenCalled();
      expect(builder.update).toHaveBeenCalled();
    });

    it('should emit a structured log event on creation', async () => {
      // getScope returns null so the insert path runs.
      const mockClient = supabase.getClient();
      const existenceBuilder = createMockBuilder(null);
      const insertBuilder = createMockBuilder(mockScopeRow);
      (mockClient.from as jest.Mock)
        .mockReturnValueOnce(existenceBuilder)
        .mockReturnValue(insertBuilder);

      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      await service.createScope({
        scopeId: 'pr-new',
        branchName: 'feat/new',
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe('preview_scope.created');
      expect(payload.scopeId).toBe('pr-new');
      expect(payload.network).toBe('testnet');
      expect(typeof payload.durationMs).toBe('number');
      // Must not leak anything sensitive.
      expect(JSON.stringify(payload)).not.toMatch(/secret|password|token|key/i);

      logSpy.mockRestore();
    });
  });

  /* ─── extendScope errors ──────────────────────────────────────────────── */

  it('should throw a stable NOT_FOUND code when extending a missing scope', async () => {
    const mockClient = supabase.getClient();
    (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(null));

    await expect(service.extendScope('missing', 60_000)).rejects.toThrow(
      PREVIEW_SCOPE_ERROR_CODES.NOT_FOUND,
    );
  });

  it('should clamp the TTL when extending', async () => {
    const mockClient = supabase.getClient();
    const builder = createMockBuilder(mockScopeRow);
    (mockClient.from as jest.Mock).mockReturnValue(builder);

    await service.extendScope('pr-42', 365 * 24 * 60 * 60 * 1000);

    // The update payload must carry a bounded expiry, not the unbounded request.
    const payload = builder.update.mock.calls[0][0] as Record<string, string>;
    const delta = new Date(payload.expires_at).getTime() - Date.now();
    expect(delta).toBeLessThanOrEqual(MAX_PREVIEW_TTL_MS);
    expect(delta).toBeGreaterThan(MAX_PREVIEW_TTL_MS - 60_000);
  });

  /* ─── expiry edge cases ──────────────────────────────────────────────── */

  describe('expiry boundaries', () => {
    it('should treat a scope expiring in one millisecond as still valid', async () => {
      const nearlyExpired = {
        ...mockScopeRow,
        expires_at: new Date(Date.now() + 1).toISOString(),
      };
      const mockClient = supabase.getClient();
      (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(nearlyExpired));

      await expect(service.isValidScope('pr-edge')).resolves.toBe(true);
    });

    it('should treat a scope expiring exactly now as invalid', async () => {
      const justExpired = {
        ...mockScopeRow,
        expires_at: new Date(Date.now() - 1).toISOString(),
      };
      const mockClient = supabase.getClient();
      (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(justExpired));

      await expect(service.isValidScope('pr-edge')).resolves.toBe(false);
    });

    it('should treat an unparseable expires_at as invalid rather than valid', async () => {
      const corrupt = { ...mockScopeRow, expires_at: 'garbage' };
      const mockClient = supabase.getClient();
      (mockClient.from as jest.Mock).mockReturnValue(createMockBuilder(corrupt));

      // NaN comparisons are false, but an explicit guard documents the intent:
      // a corrupt row must never be treated as valid.
      await expect(service.isValidScope('pr-corrupt')).resolves.toBe(false);
    });
  });

  /* ─── cleanup / recovery ──────────────────────────────────────────────── */

  describe('cleanup', () => {
    it('should keep the scope row when the cleanup RPC fails, so the next run retries', async () => {
      const mockClient = supabase.getClient();
      const builder = createMockBuilder(null);
      builder.rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
      (mockClient.from as jest.Mock).mockReturnValue(builder);

      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      const results = await service.cleanupExpiredScope('pr-stuck');

      expect(results).toEqual([]);
      // The registry row must survive a failed sweep.
      expect(builder.delete).not.toHaveBeenCalled();

      const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe('preview_scope.cleanup_failed');
      expect(payload.reason).toBe('rpc_failed');
      expect(JSON.stringify(payload)).not.toMatch(/secret|password|token/i);

      errorSpy.mockRestore();
    });

    it('should delete the scope row and log a summary on a successful sweep', async () => {
      const mockClient = supabase.getClient();
      const builder = createMockBuilder(null);
      builder.rpc = jest.fn().mockResolvedValue({
        data: [
          { deleted_from: 'public.usernames', row_count: 3 },
          { deleted_from: 'public.payment_links', row_count: 5 },
        ],
        error: null,
      });
      (mockClient.from as jest.Mock).mockReturnValue(builder);

      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      const results = await service.cleanupExpiredScope('pr-done');

      expect(results).toHaveLength(2);
      expect(builder.delete).toHaveBeenCalled();

      const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe('preview_scope.expired');
      expect(payload.rowsDeleted).toBe(8);
      expect(payload.tablesTouched).toBe(2);
      expect(payload.reason).toBe('expired');

      logSpy.mockRestore();
    });

    it('should continue the sweep past a single failed scope', async () => {
      const scopes = [
        { ...mockScopeRow, scope_id: 'pr-a' },
        { ...mockScopeRow, scope_id: 'pr-b' },
        { ...mockScopeRow, scope_id: 'pr-c' },
      ];

      const mockClient = supabase.getClient();
      const builder = createMockBuilder(scopes);

      // Enumeration returns all three; the cleanup RPC fails only for pr-b.
      builder.rpc = jest.fn().mockImplementation((_fn: string, args: { p_scope_id: string }) => {
        if (args.p_scope_id === 'pr-b') {
          return Promise.resolve({ data: null, error: { message: 'locked' } });
        }
        return Promise.resolve({
          data: [{ deleted_from: 'public.usernames', row_count: 2 }],
          error: null,
        });
      });
      (mockClient.from as jest.Mock).mockReturnValue(builder);

      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      await service.cleanupExpiredScopes();

      // All three attempted: a single failure must not stop the sweep.
      expect(builder.rpc).toHaveBeenCalledTimes(3);
      const summary = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(summary).toContain('1 failed');

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should not attempt any cleanup when the datastore is unreachable', async () => {
      const builder = createMockBuilder(null);
      builder.rpc = jest.fn();
      const mockClient = supabase.getClient();

      // A transport-level failure: the client throws rather than returning an
      // error object. The sweep must abort rather than report a clean result.
      (mockClient.from as jest.Mock).mockImplementation(() => {
        throw new Error('supabase unreachable');
      });

      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      await expect(service.cleanupExpiredScopes()).resolves.toBeUndefined();

      expect(builder.rpc).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe('preview_scope.cleanup_failed');
      expect(payload.reason).toBe('enumeration_failed');

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
