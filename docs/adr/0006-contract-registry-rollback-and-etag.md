# ADR-0006: Contract registry rollback and ETag change detection

## Status

Accepted

## Context

Clients (web, mobile, backend) must not hardcode a contract ID: they resolve it from the contract registry or fall
back to `QUICKEX_CONTRACT_ID` ([../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §5,
`docs/RUNTIME-CONFIG-MATRIX.md`). The registry is backed by `app/backend/src/contracts` with deployment rows per
network, admin-scoped writes, and a documented protocol in
[../BACKEND-CLIENT-CONTRACT-MAP.md](../BACKEND-CLIENT-CONTRACT-MAP.md):

- `GET /contracts/registry` returns an `ETag`; clients send `If-None-Match` and treat `304` as "unchanged".
- `POST /contracts/registry/rollback` shifts the **active** entry without forcing clients to change paths.
- Registry writes (`publish`, `PUT deployments/:name`, `rollback`) require an admin-scoped API key.

Contract address reuse is the underlying hazard: once a client caches `(network, contractId, wasmHash)`, changing
any of those silently changes where money goes — the most dangerous class of cache-invalidation bug in the product.

## Decision

1. **Change detection is ETag-based and conditional.** Clients must cache the registry response body together with
   its `ETag`, revalidate with `If-None-Match`, and treat `304` as "keep current ID". Polling the full body is a
   fallback, not the default.
2. **Rollback shifts the pointer, never the client code.** A rollback is recorded as a new registry state (an
   audited admin action) that makes a previously published deployment active again. Clients converge on the next
   revalidation. Rollback must never require a client release.
3. **Registry state is append-only history.** Publishing or rolling back adds an audited entry; previous entries
   remain queryable for forensics and for support bundles. Deletion of registry history is prohibited.
4. **Fail-safe on ambiguity.** If a client cannot resolve a registry entry (error, malformed body, unknown
   network) it must fall back to `QUICKEX_CONTRACT_ID` and surface a degraded-state indicator — it must never
   guess a contract ID or use a cached mainnet ID for a testnet request. The network field is part of the cache
   key.
5. **Cache invalidation is bounded**: clients revalidate at most every 60 seconds, and always immediately before
   composing a write (the value of a stale ID is bounded by how quickly it is re-read).
6. A rollback is a **stop-the-bleed** action for a bad deployment; it does not move funds, does not migrate state,
   and does not undo on-chain effects. Recovery of user-facing correctness is a separate, documented step.

## Consequences

- Contract rollovers become operationally cheap (pointer change + TTL), which is what lets contract upgrades be
  rehearsed on testnet and rolled out safely.
- The registry becomes a critical dependency for writes; the documented degraded mode is the env fallback plus an
  operator-visible warning, with `CONTRACT_NOT_CONFIGURED` (503) when neither source is available.
- Clients must carry two code paths (registry and env fallback) and test both; the mobile `services/contract-registry.ts`
  path-prefix bug (mismatch #1 in the contract map) is a live example of why this must be tested.
- Append-only history has a storage cost and must be considered by retention policy: registry/deployment records
  are **retained** (see the retention schedule) because they are required to audit where funds were directed.

## Reversal Cost

HIGH for the *semantics* (clients depend on the pointer + ETag contract); an individual rollback action is cheap
and reversible (roll forward again). Abandoning the registry would require embedding IDs into client builds, which
MVP-CONTRACT-SCOPE.md §5 explicitly forbids.

## Invariants Affected

- [INV-01](../INVARIANTS.md) Conservation of Value — an incorrect contract ID is a direct path to sending value to the wrong code.
- [INV-08](../INVARIANTS.md) Authorization Consistency — registry writes are admin-scoped and audited, so the pointer cannot be moved by an unprivileged caller.
- [INV-09](../INVARIANTS.md) Zero-Amount Payment — unchanged: registry resolution never substitutes an amount.

## References

- `app/backend/src/contracts/*`, `app/backend/supabase/migrations/20260710000000_create_deployment_artifacts.sql`
- [../BACKEND-CLIENT-CONTRACT-MAP.md](../BACKEND-CLIENT-CONTRACT-MAP.md), [../RUNTIME-CONFIG-MATRIX.md](../RUNTIME-CONFIG-MATRIX.md)
- [../policies/DATA-RETENTION-PRIVACY-POLICY.md](../policies/DATA-RETENTION-PRIVACY-POLICY.md), [ADR-0003](./0003-testnet-only-contract-writes.md)
