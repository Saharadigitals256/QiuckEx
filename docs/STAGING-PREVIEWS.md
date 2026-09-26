# Reproducible Staging Previews

A staging preview is an isolated, disposable deployment of a contributor's branch:
its own data partition, its own URLs, and an expiry date that is enforced by the
backend rather than hoped for by CI.

Three properties define it, and each has a specific mechanism below.

| Property | Mechanism | Enforced in |
|---|---|---|
| **Reproducible** | Scope id is `pr-<number>-<short sha>` — a pure function of the PR and commit | `buildPreviewScopeId` |
| **Isolated** | Every scope is a separate data partition, addressed by the `x-preview-scope` header | `PreviewScopeService` + `PreviewScopeGuard` |
| **Expiring** | Absolute `expires_at`, TTL clamped to 1 hour – 14 days, daily reclaim cron | `PreviewScopeService.cleanupExpiredScopes` |

## Scope ids

```
pr-<prNumber>-<first 12 chars of the commit sha>
```

Determinism is the point. Re-running provisioning for the same commit lands on the
same scope rather than creating a second one and orphaning the first's data, so a
workflow re-run, a retry, or a manual dispatch is safe. A *new* commit produces a
new scope, so a new push gets fresh data instead of inheriting the previous push's
rows.

```ts
import { buildPreviewManifest } from './preview-scope.types';

const manifest = buildPreviewManifest({
  prNumber: 299,
  commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  branchName: 'feat/previews',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
});
// scopeId: 'pr-299-abcdef123456'
// expiresAt: absolute ISO-8601
```

## Expiry

TTLs are **clamped**, not trusted:

| Bound | Value | Why |
|---|---|---|
| `MIN_PREVIEW_TTL_MS` | 1 hour | Below this the preview cannot be useful |
| `DEFAULT_PREVIEW_TTL_MS` | 7 days | Default when none is requested |
| `MAX_PREVIEW_TTL_MS` | 14 days | A preview must not become permanent infrastructure |

`resolveTtlMs` clamps out-of-range values rather than throwing, so a misconfigured
preview degrades to a bounded one instead of erroring or, worse, surviving forever.

Expiry is enforced **on read** (`isValidScope` runs on every guarded request) *and*
by the daily cron that reclaims the data. Read-time enforcement means a stalled
cron leaks storage for a while but never leaks access.

### Recovery behavior

- A failed cleanup RPC **does not delete the scope row**. Deleting the registry
  entry while its data is still present would orphan that data and make a retry
  impossible to reason about. The row survives so the next run retries.
- One failed scope **does not abort the sweep**. The remaining scopes are still
  reclaimed and the summary reports how many failed.
- If the datastore is unreachable, the sweep **aborts** rather than reporting a
  clean result over an unknown scope set.

## Errors

Stable codes, in `PREVIEW_SCOPE_ERROR_CODES`. Do not reword them.

| Code | Meaning | HTTP |
|---|---|---|
| `PREVIEW_SCOPE_INVALID` | Malformed scope id, past expiry, or mainnet requested | 400 |
| `PREVIEW_SCOPE_UNAUTHORIZED` | Scope header missing on a guarded route | 403 |
| `PREVIEW_SCOPE_EXPIRED` | Scope exists but `expires_at` has passed | 403 |
| `PREVIEW_SCOPE_NOT_FOUND` | No such scope | 404 |
| `PREVIEW_SCOPE_DEPENDENCY_FAILURE` | Datastore unreachable — retry, do not treat as 404 | 503 |

A dependency failure is deliberately **not** degraded to "not found". Collapsing
the two would make an outage look like a missing scope, and a client would give up
instead of retrying.

## Network gating

Previews are **testnet-only**. `buildPreviewManifest` throws
`PREVIEW_SCOPE_INVALID` for `mainnet`, because the Soroban contract has no mainnet
deployment and a mainnet preview would be a shell pointing at an address that
cannot exist ([ADR 0002](./adr/0002-testnet-first-mainnet-feature-gated.md)). This
is the feature gate for the capability: implemented end to end for testnet,
explicitly unavailable for mainnet.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PREVIEW_INACTIVITY_THRESHOLD_MS` | Inactivity window before a branch preview is stale | 3 days |
| `PREVIEW_MAX_AGE_MS` | Hard lifetime cap for a branch preview | 14 days |
| `PREVIEW_SUPABASE_URL` | CI secret: preview datastore | — |
| `PREVIEW_SUPABASE_SERVICE_ROLE_KEY` | CI secret: preview datastore | — |

Without the CI secrets, `.github/workflows/staging-preview.yml` degrades to
validate-only and says so, rather than provisioning a half-working preview.

## Observability

Structured JSON log events, via `logPreviewScopeEvent`. Fields: `event`,
`scopeId`, `network`, `durationMs`, `rowsDeleted`, `tablesTouched`, `reason`.

```json
{"event":"preview_scope.created","scopeId":"pr-299-abcdef123456","network":"testnet","durationMs":143}
{"event":"preview_scope.expired","scopeId":"pr-299-abcdef123456","network":"testnet","rowsDeleted":8,"tablesTouched":2,"reason":"expired"}
{"event":"preview_scope.cleanup_failed","scopeId":"pr-299-abcdef123456","network":"testnet","reason":"rpc_failed"}
```

Success, latency, and failure are all visible, and no event carries a key, a
credential, or user data. `reason` is a fixed vocabulary
(`expired`, `insert_failed`, `rpc_failed`, `enumeration_failed`).

## Workflow

`.github/workflows/staging-preview.yml` runs on `opened`, `synchronize`, and
`reopened` for PRs targeting `main`, on manual dispatch, and on a nightly schedule.

Fork PRs are skipped: they cannot read repository secrets, and half-provisioning a
preview is worse than not provisioning one.

## Known gap

There is **no `preview-scope` controller**. Scopes are created by CI, not by an
API call, so an external system cannot provision one today. Both this module and
`branch-preview` are marked **Partial** in
[CAPABILITY-MAP.md](./CAPABILITY-MAP.md) for this reason — not because the
isolation or expiry logic is missing.
