# ADR-0004: Emergency pause is irreversible

## Status

Accepted

## Context

QuickEx needs two different kinds of stop control, and conflating them is the classic bridge/escrow failure mode:
a *reversible* pause for routine operations, and a *terminal* freeze for an active exploit.

The contract implements both (`app/contract/contracts/quickex/src/pause_policy.rs`, `admin.rs`, documented in
[../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §4A):

- **Granular pause flags** (`set_pause_flags`) — reversible, per operation, e.g. pause deposits while leaving
  refunds/withdrawals open. Operators may toggle these.
- **Emergency mode** (`activate_emergency_mode`) — a one-way halt that freezes deposits, withdrawals and refunds
  indefinitely. Recovery requires a contract upgrade, i.e. it is not an operational action.

`docs/CAPABILITY-MAP.md` already records this row as **Live** with the note "Emergency mode is irreversible by
design", so the semantics are intentional and are relied on by operators.

## Decision

1. `activate_emergency_mode` is **terminal**. There is no `deactivate_emergency_mode`, no flag, and no backend
   endpoint that can undo it. Reversal is only possible by upgrading the contract through the safety gate
   (`app/contract/docs/UPGRADE_SAFETY_GATE.md`).
2. Routine operational stops must use `set_pause_flags`. Anyone reaching for emergency mode for a
   non-exploit reason is making a mistake; the runbook requires a second human approval and a written
   incident justification before invocation.
3. The backend must never call `activate_emergency_mode` automatically (no "circuit breaker calls emergency
   mode" path). The API-surface circuit breaker
   (`app/backend/src/circuit-breaker`) may shed load, and refund/withdraw flags may be toggled, but terminal
   freezing is a human decision on a multi-sig admin (2-of-3 per MVP-CONTRACT-SCOPE.md §4B).
4. Emergency activation is observable end-to-end: the contract event stream carries the activation, the backend
   emits an alert-able structured log and metric, and the transaction timeline shows the halt to affected users.
   Users must be able to see *why* funds cannot move.
5. Existing escrows remain recoverable *in principle* after an upgrade; the invariant checks in `storage.rs`
   (`assert_post_upgrade_invariants()`) must pass before the upgrade completes, so a botched recovery cannot
   silently drop balances.

## Consequences

- A false-positive emergency activation is a severe incident: it requires an upgrade to recover. This is accepted
  because the alternative (a reversible emergency halt) can be exploited by the attacker it was meant to stop or
  by a compromised admin key.
- Disaster-recovery documentation must include the upgrade-based recovery path, and drills must rehearse it; the
  repository provides `app/contract/docs/TESTNET_UPGRADE_REHEARSAL.md` for that purpose.
- Support tooling must distinguish "paused" (transient, operator-toggled) from "emergency" (terminal) in user
  facing copy; conflating them misleads users about whether funds are coming back.

## Reversal Cost

IRREVERSIBLE at the protocol level by design. The only path back is a contract upgrade, which is itself a governed,
windowed, invariant-checked operation. Do not treat this as a configuration knob.

## Invariants Affected

- [INV-01](../INVARIANTS.md) Conservation of Value — freezing is safer than leaking; value is preserved, not moved.
- [INV-05](../INVARIANTS.md) Valid State Transitions Only — paused operations cannot create new escrows or transitions.
- [INV-06](../INVARIANTS.md) Expiry Monotonicity — expiry continues to elapse while paused; refunds resume post-recovery without re-negotiation.

## References

- `app/contract/contracts/quickex/src/pause_policy.rs`, `admin.rs`, `storage.rs`
- [../../app/contract/docs/UPGRADE_SAFETY_GATE.md](../../app/contract/docs/UPGRADE_SAFETY_GATE.md), [../../app/contract/docs/TESTNET_UPGRADE_REHEARSAL.md](../../app/contract/docs/TESTNET_UPGRADE_REHEARSAL.md)
- [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) §4, [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md)
