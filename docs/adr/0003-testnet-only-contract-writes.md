# ADR-0003: Contract writes are testnet-only behind feature flags

## Status

Accepted

## Context

The Soroban contract is deployed to **testnet only**; a mainnet deployment is post-audit and has not happened
([../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §5, [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md)). Despite
that, the code paths that build contract writes are reachable from the public backend API:

- `POST /transactions/compose|build|simulate` and `POST /stellar/soroban-preflight` (see
  `app/backend/src/stellar/stellar.controller.ts`).
- Mainnet-capable behaviour would otherwise be one misconfigured `NETWORK=mainnet` away from moving real funds.

Existing controls, all of which must be preserved by any change to these routes:

| Control | Location |
|---|---|
| `testnet.contract_writes` flag (default **enabled**), `mainnet.contract_writes` (default **disabled**) | `app/backend/src/feature-flags/feature-flags.service.ts` |
| `NetworkSafetyGuard` (refuses writes off-testnet) | `app/backend/src/feature-flags/network-safety.guard.ts` |
| `@RequiresFlag(...)` decorator + `ContractMethodAllowlistGuard` | `app/backend/src/feature-flags/requires-flag.decorator.ts`, `app/backend/src/transactions` |
| `CONTRACT_NOT_CONFIGURED` (503) when `QUICKEX_CONTRACT_ID` is unset | `stellar.controller.ts`, `app/backend/src/config` |
| Env rollback guard `FEATURE_<NAME>=true` | `app/backend/flags.js` |

## Decision

1. **No Soroban write may be reachable on mainnet until this ADR is superseded.** New write endpoints must carry
   `@UseGuards(NetworkSafetyGuard)` **and** `@RequiresFlag(<flag>)`; a route without both is a defect.
2. Mainnet enablement is a **flag flip that must be preceded by** (a) a successful mainnet deployment recorded in
   the contract registry, (b) the audit report, (c) an exercised rollback drill, and (d) a release-readiness entry
   in [../../RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md).
3. The default-off posture is the rollback mechanism: disabling `testnet.contract_writes` /
   `mainnet.contract_writes` (or `killSwitch: true`) stops new writes without a redeploy. Clients must treat
   `403 FORBIDDEN` / `503` as expected, not as a crash (documented in
   [../BACKEND-CLIENT-CONTRACT-MAP.md](../BACKEND-CLIENT-CONTRACT-MAP.md)).
4. Feature-flag changes are audited (`app/backend/src/audit/audit.service.ts`) with actor attribution, and the
   flags controller is admin-scoped; the known unguarded-flag-controller gap (mismatch #7) must be closed before
   flags are used as a mainnet safety control.
5. Sequencing/idempotency: a write is only considered applied when the composed XDR has been submitted and
   confirmed; retries reuse the same `correlationId`, and the contract's own replay protection (transaction
   sequence numbers, `Address::require_auth`) is the authority on double-spend — never a client-supplied nonce.

## Consequences

- Feature work on contract writes is testnet-only in practice; mainnet work must begin with the enablement
  checklist rather than with code.
- Every new write route triples its review checklist (guard + flag + degraded-mode documentation), which is the
  intended friction.
- Operators can halt writes quickly, at the cost of a client-visible 403/503 that must be surfaced as a friendly
  "not available on this network" state.

## Reversal Cost

MEDIUM. Flags flip back in one audited API call. The *irreversible* part is the mainnet deployment itself: once a
contract is deployed and escrows exist, its address and storage layout cannot be recalled. That is why this ADR
gates deployment, not just flags.

## Invariants Affected

- [INV-01](../INVARIANTS.md) Conservation of Value — the kill switch bounds the blast radius of a faulty release.
- [INV-04](../INVARIANTS.md) No Double-Settlement — replay protection is delegated to the contract and transaction sequence, not client state.
- [INV-08](../INVARIANTS.md) Authorization Consistency — `Address::require_auth` is the authority; the backend never stands in for a user.

## References

- `app/backend/src/feature-flags/*`, `app/backend/flags.js`, `app/backend/src/stellar/stellar.controller.ts`
- [../RUNTIME-CONFIG-MATRIX.md](../RUNTIME-CONFIG-MATRIX.md), [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md) (flag table, mismatch #7)
- [ADR-0001](./0001-self-custody-and-no-server-side-key-custody.md), [ADR-0006](./0006-contract-registry-rollback-and-etag.md)
