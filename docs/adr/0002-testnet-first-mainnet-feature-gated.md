# 0002. Testnet-first, with mainnet behaviour behind disabled-by-default feature flags

- Status: Accepted
- Date: 2026-01-15
- Surfaces: app/backend, app/frontend, app/contract

## Context

QuickEx writes to Stellar: it composes transactions, simulates Soroban contract
calls, and (once audited) submits them. A bug in that path can move real funds, and
Stellar settlement is irreversible. The contract in `app/contract` has admin
capabilities including an irreversible emergency pause (`src/admin.rs`,
`src/pause_policy.rs`).

At the same time, the testnet and mainnet code paths are the *same* code. A separate
"staging build" of the backend would double the surface area for a codebase that
does not yet have a stable release cadence.

## Decision

One codebase serves both networks. The network is selected by configuration
(`STELLAR_NETWORK`, defaulting to `testnet`), and every mainnet-only capability is
gated behind a feature flag that **defaults to disabled**.

The switchboard lives in `app/backend/src/feature-flags/feature-flags.service.ts`:

| Flag | Default | Gates |
|---|---|---|
| `testnet.contract_writes` | enabled | `POST /transactions/compose|build|simulate`, `POST /stellar/soroban-preflight` |
| `mainnet.contract_writes` | **disabled** | All Soroban writes on mainnet |
| `mainnet.refunds` | **disabled** | Refund initiation on mainnet |
| `mainnet.dispute_actions` | **disabled** | Escrow dispute actions on mainnet |

Rules that follow from this:

1. A flag is disabled on mainnet by default. Enabling mainnet behaviour is an
   explicit, reviewed act with a rollback recorded in the PR.
2. A flag guards the *action*, not the UI. Hiding a button is not gating; the
   backend must return a stable error (503, not 500) when a flag is off.
3. The environment-variable kill switch in `app/backend/flags.js`
   (`FEATURE_<NAME>=true`) is a separate, unrelated rollback mechanism. It does not
   read or write the Supabase-backed flags above, and neither is a substitute for
   the other.
4. A flag that gates a *write* must be paired with a test asserting the disabled
   path returns the documented error.
5. `mainnet.contract_writes` stays disabled until the contract is deployed to
   mainnet, which per [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md) has not
   happened and is post-audit.

## Alternatives considered

**Separate staging environment with its own data.** Rejected for now: it doubles
configuration drift (the class of bug `docs/RUNTIME-CONFIG-MATRIX.md` already
documents) before the project has a release cadence to justify it. Revisit if the
release process stabilises.

**Build-time network separation.** Rejected. Two artifacts means two things to test
and two ways to be wrong; the flag approach keeps one artifact whose behavior
narrows with configuration.

**Optimistic mainnet with a manual kill switch.** Rejected. Relying on a human to
flip a switch before funds move is not a control.

## Consequences

- Contributors can run everything locally against testnet and know that no config
  mistake reaches mainnet. This is why `.env.example` values and a local
  `STELLAR_NETWORK=mainnet` are safe-ish: the flags still block the writes.
- Every mainnet-gated endpoint needs a documented disabled-path error code. Adding
  a flag means updating the switchboard table in `docs/CAPABILITY-MAP.md` in the
  same PR.
- "Enabled on testnet" is not a claim of production readiness. `docs/CAPABILITY-MAP.md`
  tracks that distinction, and this ADR only governs the network switch.
- Enabling any `mainnet.*` flag for a real release is a rollout decision that must
  name its rollback. See `RELEASE_PROMOTION_FLOW.md`.
