import {
  buildPreviewManifest,
  buildPreviewScopeId,
  PreviewManifestError,
  PREVIEW_SCOPE_ERROR_CODES,
  PREVIEW_SCOPE_HEADER,
  DEFAULT_PREVIEW_TTL_MS,
  MIN_PREVIEW_TTL_MS,
  MAX_PREVIEW_TTL_MS,
} from './preview-scope.types';

/**
 * The manifest is the reproducibility contract: the same PR and commit must
 * always yield the same scope id, so re-running provisioning is idempotent
 * rather than orphaning a previous scope's data.
 */
describe('preview manifest', () => {
  const NOW = new Date('2026-02-10T00:00:00.000Z');
  const base = {
    prNumber: 42,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    branchName: 'feat/preview',
    now: NOW,
  };

  /* ─── determinism (the "reproducible" requirement) ─────────────────────── */

  it('should produce the same scope id for the same PR and commit', () => {
    const a = buildPreviewManifest(base);
    const b = buildPreviewManifest(base);
    expect(a.scopeId).toBe(b.scopeId);
    expect(a.scopeId).toBe('pr-42-abcdef123456');
  });

  it('should produce a different scope id for a new commit on the same PR', () => {
    const a = buildPreviewManifest(base);
    const b = buildPreviewManifest({ ...base, commitSha: 'f'.repeat(40) });
    expect(a.scopeId).not.toBe(b.scopeId);
  });

  it('should produce a different scope id for the same commit on a different PR', () => {
    const a = buildPreviewManifest(base);
    const b = buildPreviewManifest({ ...base, prNumber: 43 });
    expect(a.scopeId).not.toBe(b.scopeId);
  });

  it('should normalize an uppercase sha to lowercase', () => {
    expect(buildPreviewScopeId(42, 'ABCDEF1234567890')).toBe('pr-42-abcdef123456');
  });

  it('should truncate a full sha to 12 characters', () => {
    expect(buildPreviewScopeId(42, 'a'.repeat(40))).toBe('pr-42-aaaaaaaaaaaa');
  });

  it('should expose the scope header clients must send', () => {
    const manifest = buildPreviewManifest(base);
    expect(manifest.scopeHeader).toBe(PREVIEW_SCOPE_HEADER);
    expect(manifest.scopeHeaderValue).toBe(manifest.scopeId);
  });

  /* ─── network gate ────────────────────────────────────────────────────── */

  it('should default to testnet', () => {
    expect(buildPreviewManifest(base).network).toBe('testnet');
  });

  it('should refuse a mainnet preview with a stable error code', () => {
    expect(() => buildPreviewManifest({ ...base, network: 'mainnet' })).toThrow(
      PreviewManifestError,
    );
    try {
      buildPreviewManifest({ ...base, network: 'mainnet' });
    } catch (e) {
      expect((e as PreviewManifestError).code).toBe(PREVIEW_SCOPE_ERROR_CODES.INVALID);
    }
  });

  /* ─── expiry ──────────────────────────────────────────────────────────── */

  it('should set an absolute expiry the default TTL out', () => {
    expect(buildPreviewManifest(base).expiresAt).toBe(
      new Date(NOW.getTime() + DEFAULT_PREVIEW_TTL_MS).toISOString(),
    );
  });

  it('should clamp a TTL below the minimum up to the minimum', () => {
    expect(buildPreviewManifest({ ...base, ttlMs: 1000 }).expiresAt).toBe(
      new Date(NOW.getTime() + MIN_PREVIEW_TTL_MS).toISOString(),
    );
  });

  it('should clamp a TTL above the maximum down to the maximum', () => {
    // A caller must not be able to mint a permanent preview.
    expect(buildPreviewManifest({ ...base, ttlMs: 365 * 24 * 3600 * 1000 }).expiresAt).toBe(
      new Date(NOW.getTime() + MAX_PREVIEW_TTL_MS).toISOString(),
    );
  });

  it('should honour a TTL inside the supported range', () => {
    const ttl = 3 * 24 * 3600 * 1000;
    expect(buildPreviewManifest({ ...base, ttlMs: ttl }).expiresAt).toBe(
      new Date(NOW.getTime() + ttl).toISOString(),
    );
  });

  /* ─── malformed input ─────────────────────────────────────────────────── */

  describe('malformed input', () => {
    const expectInvalid = (input: Parameters<typeof buildPreviewManifest>[0]) => {
      try {
        buildPreviewManifest(input);
        throw new Error('expected a PreviewManifestError');
      } catch (e) {
        expect(e).toBeInstanceOf(PreviewManifestError);
        expect((e as PreviewManifestError).code).toBe(PREVIEW_SCOPE_ERROR_CODES.INVALID);
      }
    };

    it('should reject a non-hex commit sha', () => {
      expectInvalid({ ...base, commitSha: 'nothex!' });
    });

    it('should reject a too-short commit sha', () => {
      expectInvalid({ ...base, commitSha: 'abc' });
    });

    it('should reject a zero PR number', () => {
      expectInvalid({ ...base, prNumber: 0 });
    });

    it('should reject a negative PR number', () => {
      expectInvalid({ ...base, prNumber: -1 });
    });

    it('should reject a non-integer PR number', () => {
      expectInvalid({ ...base, prNumber: 1.5 });
    });

    it('should reject an empty branch name', () => {
      expectInvalid({ ...base, branchName: '   ' });
    });

    it('should reject a branch name containing spaces', () => {
      expectInvalid({ ...base, branchName: 'feat/my branch' });
    });

    it('should reject a branch name over the length limit', () => {
      expectInvalid({ ...base, branchName: 'a'.repeat(101) });
    });

    it('should reject a zero TTL', () => {
      expectInvalid({ ...base, ttlMs: 0 });
    });

    it('should reject a negative TTL', () => {
      expectInvalid({ ...base, ttlMs: -1 });
    });

    it('should reject a NaN TTL', () => {
      expectInvalid({ ...base, ttlMs: Number.NaN });
    });

    it('should reject an infinite TTL', () => {
      expectInvalid({ ...base, ttlMs: Number.POSITIVE_INFINITY });
    });
  });

  /* ─── observability ───────────────────────────────────────────────────── */

  it('should not embed any secret or personal data in the manifest', () => {
    const serialized = JSON.stringify(buildPreviewManifest(base));
    expect(serialized).not.toMatch(/secret|password|token|private|mnemonic/i);
  });
});
