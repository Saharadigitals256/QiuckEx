# ADR-0005: Static fee model; oracle pricing deferred

## Status

Accepted

## Context

QuickEx collects a protocol fee on settlement. Two implementations were possible: fees fixed by configuration, or
fees derived from a live fiat price feed.

The repository contains an explicit stub for the second: `app/contract/contracts/quickex/src/oracle.rs` returns a
fallback price, and `app/backend/src/stellar/quote.service.ts` reports quote preflight as feasible without a real
oracle check (flagged as **Mocked** in [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md)). The scope decision is
recorded in [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §1: "Dynamic Oracle Fees — OUT OF SCOPE
(Deferred) … apply flat or static per-token basis-point configs on-chain. Stub oracle price fetching for MVP."

Fee behaviour that *is* in scope and must not regress: basis-point fees, per-asset override tiers, collector
address rotation, and the ceiling enforced by [INV-10](../INVARIANTS.md).

## Decision

1. Fees are **static basis points** with per-asset overrides, configured on-chain by the operator role
   (`fee` modules); the fee collector address is rotatable by the admin.
2. The oracle module remains a stub that returns a deterministic fallback. It must never silently change a fee:
   if oracle data is unavailable, the fee falls back to the configured static basis points rather than to zero,
   and the fallback is logged/metric'd so operators can see that pricing is degraded.
3. `INV-10` is enforced **before** a fee config change is accepted: `fee_ceiling` validation rejects a
   configuration whose effective fee exceeds the configured maximum percentage of the payment amount. A fee
   config change is a governed operation (audited, admin/operator scoped) — never a client-supplied parameter.
4. Clients must not compute or display fees from their own oracle; they display what the backend/contract
   reports. `quote.service.ts` preflight results are advisory and must not be treated as an oracle-bound price
   guarantee (documented in CAPABILITY-MAP contributor note #5).
5. Switching to dynamic pricing requires a superseding ADR covering oracle source selection, staleness bounds,
   manipulation resistance, and a migration for in-flight escrows.

## Consequences

- Fee revenue is stable and easy to reconcile, but QuickEx cannot price in fiat terms; fiat-denominated pricing
  remains a product/UX concern outside the contract.
- Because a fee change is stored state (not code), changing fees is cheaper than a contract upgrade — but the
  ceiling check means a mis-typed basis-point value is rejected rather than silently applied.
- Reconciliation and analytics stay simple: fees observed by the indexer can be compared with static config,
  which is a precondition for the reconciliation module to become trustworthy
  ([../CAPABILITY-MAP.md](../CAPABILITY-MAP.md) contributor note #4).

## Reversal Cost

MEDIUM. Fee *rates* change via governed config with no redeploy. The oracle itself is code, so adopting dynamic
fees means implementing `oracle.rs`, sourcing data in a way Soroban can verify, and re-auditing the fee path —
reversible only through an upgrade that has post-upgrade invariant checks applied.

## Invariants Affected

- [INV-10](../INVARIANTS.md) Fee Ceiling — the whole point of the static model is that the ceiling is checkable before it is stored.
- [INV-03](../INVARIANTS.md) No Overpayment — settlement releases principal plus *permitted* fee adjustments only.
- [INV-01](../INVARIANTS.md) Conservation of Value — the fallback path must never mint or burn value.

## References

- `app/contract/contracts/quickex/src/oracle.rs`, fee modules under `app/contract/contracts/quickex/src/fee*`
- `app/backend/src/stellar/quote.service.ts`, [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §1
- [ADR-0002](./0002-monolithic-soroban-escrow-contract.md), [../INVARIANTS.md](../INVARIANTS.md)
