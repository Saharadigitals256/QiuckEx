# ADR-0002: One monolithic Soroban escrow contract

## Status

Accepted

## Context

QuickEx ships a single Soroban contract, `QuickexContract`, in
`app/contract/contracts/quickex/src/lib.rs`, composed of module files (`escrow.rs`, `commitment.rs`, `fee/`,
`admin.rs`, `pause_policy.rs`, `oracle.rs`, `storage.rs`, `escrow_id.rs`). Clients resolve its ID through the
contract registry or `QUICKEX_CONTRACT_ID` ([../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §2, §5).

Splitting escrow, fees, or access control into several deployed contracts was considered. The deciding factors:

- Cross-contract calls add ledger footprint and re-entrancy surface; the MVP explicitly rejects hook/callback
  registries for that reason (MVP-CONTRACT-SCOPE.md §1).
- Fee routing and escrow settlement read the same storage keys; a split would need either shared state or a
  cross-contract read per settlement.
- A separate contracts-per-module deployment multiplies contract IDs that frontend, mobile and backend must
  resolve and keep in sync (`docs/RUNTIME-CONFIG-MATRIX.md` documents this drift as a real operational risk).

The price of the choice is that **storage layout and the WASM hash are shared by every feature**, so upgrades are
all-or-nothing and must run through the upgrade safety gate
(`app/contract/docs/UPGRADE_SAFETY_GATE.md`).

## Decision

1. All in-scope escrow, fee, admin, role and pause logic lives in the single `QuickexContract`.
2. Out-of-scope primitives are **stubs inside the same contract**, not separate deployments: `oracle.rs` returns a
   static fallback, and deferred features (nonces, arbitration, hook registry, on-chain privacy levels) stay
   documented as deferred rather than partially deployed.
3. Storage keys are a single `DataKey` enum owned by `storage.rs`; adding a variant is a *migration*, not a
   refactor, and requires the upgrade procedure in UPGRADE_SAFETY_GATE.md.
4. The contract exposes `get_version()` / `CURRENT_CONTRACT_VERSION`; clients must halt or warn when
   `get_version() != client_supported_version` instead of sending unrecognised parameters.
5. Deploying a second production contract requires a superseding ADR that names the call graph, the migration of
   existing escrows, and the client rollout plan.

## Consequences

- Any contract change can affect unrelated flows; the blast radius is the whole product, so the upgrade window,
  `UpgradeInProgress` flag and post-upgrade invariant checks are mandatory, not optional.
- Fees and escrow cannot be upgraded independently, which is acceptable while the fee model is static
  ([ADR-0005](./0005-static-fee-model-oracle-deferred.md)).
- Frontends and mobile keep exactly one contract ID to resolve, which keeps the registry `ETag` protocol
  ([ADR-0006](./0006-contract-registry-rollback-and-etag.md)) simple.
- Tests must cover the monolithic surface; the repository convention is unit + fuzz + bench + upgrade suites under
  `app/contract/contracts/quickex/src` (see CAPABILITY-MAP.md contract rows).

## Reversal Cost

HIGH. Splitting the contract means a new deployment, a state migration for live escrows, a second registry entry
and a client rollout; existing escrow state cannot be "moved" without protocol actions from the parties. Not
reversible by a flag.

## Invariants Affected

- [INV-01](../INVARIANTS.md) Conservation of Value — settlement and fee routing read/write the same storage in one contract, in one transaction.
- [INV-05](../INVARIANTS.md) Valid State Transitions Only — the state machine is enforced in the single escrow module.
- [INV-10](../INVARIANTS.md) Fee Ceiling — fee config is co-located with settlement, so the ceiling can be asserted at release time.

## References

- `app/contract/contracts/quickex/src/lib.rs`, `storage.rs`, `admin.rs`, `pause_policy.rs`
- [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md), [../../app/contract/docs/UPGRADE_SAFETY_GATE.md](../../app/contract/docs/UPGRADE_SAFETY_GATE.md)
- [ADR-0005](./0005-static-fee-model-oracle-deferred.md), [ADR-0006](./0006-contract-registry-rollback-and-etag.md)
