export interface PreviewScope {
  id: string;
  scope_id: string;
  branch_name: string;
  github_pr_url: string | null;
  owner_public_key: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePreviewScopeDto {
  scopeId: string;
  branchName: string;
  githubPrUrl?: string;
  ownerPublicKey?: string;
  expiresAt: Date;
}

export const PREVIEW_SCOPE_HEADER = 'x-preview-scope';
export const DEFAULT_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hard ceiling on a preview scope's lifetime, regardless of what a caller
 * requests. Previews are disposable; a scope that lives longer than this stops
 * being a preview and becomes unowned infrastructure.
 */
export const MAX_PREVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Minimum TTL. Below this a preview cannot be useful: the provisioning
 * workflow alone routinely takes several minutes.
 */
export const MIN_PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Error codes surfaced to clients. Stable — do not reword. */
export const PREVIEW_SCOPE_ERROR_CODES = {
  UNAUTHORIZED: 'PREVIEW_SCOPE_UNAUTHORIZED',
  NOT_FOUND: 'PREVIEW_SCOPE_NOT_FOUND',
  EXPIRED: 'PREVIEW_SCOPE_EXPIRED',
  INVALID: 'PREVIEW_SCOPE_INVALID',
  DEPENDENCY_FAILURE: 'PREVIEW_SCOPE_DEPENDENCY_FAILURE',
} as const;

export type PreviewScopeErrorCode =
  (typeof PREVIEW_SCOPE_ERROR_CODES)[keyof typeof PREVIEW_SCOPE_ERROR_CODES];

/** Structured, non-identifying log shape. Never includes keys or user data. */
export interface PreviewScopeLogEvent {
  event: 'preview_scope.created' | 'preview_scope.extended' | 'preview_scope.expired' | 'preview_scope.cleanup_failed';
  scopeId: string;
  network: 'testnet' | 'mainnet';
  durationMs?: number;
  rowsDeleted?: number;
  tablesTouched?: number;
  /** Never a secret. Free-form reason, e.g. "expired", "ttl_out_of_range". */
  reason?: string;
}

export function logPreviewScopeEvent(event: PreviewScopeLogEvent): PreviewScopeLogEvent {
  return event;
}

/**
 * A preview environment descriptor. Everything needed to provision the same
 * preview twice, producing the same scope and the same data partition.
 */
export interface PreviewManifest {
  /** Deterministic. Same PR + same commit => same scope id. */
  scopeId: string;
  branchName: string;
  commitSha: string;
  prNumber: number;
  /** Only 'testnet' is supported. Mainnet previews are refused. */
  network: 'testnet' | 'mainnet';
  /** ISO-8601. Absolute, so expiry is not a function of when it is read. */
  expiresAt: string;
  /** Header clients must send to address this scope. */
  scopeHeader: string;
  scopeHeaderValue: string;
}

export class PreviewManifestError extends Error {
  constructor(
    readonly code: PreviewScopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewManifestError';
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]+$/;
const MAX_BRANCH_LENGTH = 100;
const MAX_PR_NUMBER = 1_000_000;

/**
 * Derive the deterministic scope id for a preview.
 *
 * The id is `pr-<number>-<short sha>`. Determinism is the whole point: the
 * provisioning workflow can re-run for the same commit (a re-run, a retry, a
 * manual dispatch) and land on the same scope rather than creating a second
 * one and orphaning the first's data. The commit is in the id so that a new
 * push gets a fresh scope with fresh data, while a re-run of the *same* commit
 * is idempotent.
 *
 * Throws PreviewManifestError with a stable code on malformed input rather
 * than silently producing a scope id that could collide with another PR's.
 */
export function buildPreviewScopeId(prNumber: number, commitSha: string): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0 || prNumber > MAX_PR_NUMBER) {
    throw new PreviewManifestError(
      PREVIEW_SCOPE_ERROR_CODES.INVALID,
      `prNumber must be an integer in 1..${MAX_PR_NUMBER}, got ${prNumber}`,
    );
  }

  const sha = commitSha.trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    throw new PreviewManifestError(
      PREVIEW_SCOPE_ERROR_CODES.INVALID,
      'commitSha must be 7-40 lowercase hex characters',
    );
  }

  return `pr-${prNumber}-${sha.slice(0, 12)}`;
}

/**
 * Build a complete, reproducible preview manifest.
 *
 * Rejects mainnet: the Soroban contract has no mainnet deployment, so a mainnet
 * preview would be a shell pointing at an address that cannot exist
 * (ADR 0002). Refusing here is the feature gate for #299 — the capability is
 * implemented end to end for testnet and explicitly unavailable for mainnet.
 */
export function buildPreviewManifest(input: {
  prNumber: number;
  commitSha: string;
  branchName: string;
  network?: 'testnet' | 'mainnet';
  ttlMs?: number;
  now?: Date;
}): PreviewManifest {
  const {
    prNumber,
    commitSha,
    branchName,
    network = 'testnet',
    ttlMs = DEFAULT_PREVIEW_TTL_MS,
    now = new Date(),
  } = input;

  if (network !== 'testnet') {
    throw new PreviewManifestError(
      PREVIEW_SCOPE_ERROR_CODES.INVALID,
      'previews are testnet-only; mainnet is not supported',
    );
  }

  const branch = branchName.trim();
  if (branch.length === 0 || branch.length > MAX_BRANCH_LENGTH || !BRANCH_RE.test(branch)) {
    throw new PreviewManifestError(
      PREVIEW_SCOPE_ERROR_CODES.INVALID,
      `branchName must be 1-${MAX_BRANCH_LENGTH} chars of [A-Za-z0-9._/-]`,
    );
  }

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new PreviewManifestError(
      PREVIEW_SCOPE_ERROR_CODES.INVALID,
      'ttlMs must be a positive finite number',
    );
  }

  const boundedTtl = Math.min(Math.max(ttlMs, MIN_PREVIEW_TTL_MS), MAX_PREVIEW_TTL_MS);
  const scopeId = buildPreviewScopeId(prNumber, commitSha);

  return {
    scopeId,
    branchName: branch,
    commitSha: commitSha.trim().toLowerCase(),
    prNumber,
    network,
    expiresAt: new Date(now.getTime() + boundedTtl).toISOString(),
    scopeHeader: PREVIEW_SCOPE_HEADER,
    scopeHeaderValue: scopeId,
  };
}

