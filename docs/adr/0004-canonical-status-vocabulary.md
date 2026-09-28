# 0004. Live / Partial / Mocked / Experimental is the only status vocabulary

- Status: Accepted
- Date: 2026-02-10
- Surfaces: docs

## Context

QuickEx has a large gap between what the UI shows and what the backend does. The
marketplace renders bids that no server produces. The discovery page renders
`MOCK_USERS` while real `/username/search` endpoints sit unused. The X-Ray quote
preflight always reports feasible. `payment-confirmation.tsx` calls
`/api/contracts/registry` while the backend serves `/contracts/registry`, so every
sync 404s.

A contributor who reads a feature description and starts building against it will
burn days discovering the flow is fabricated. This is not hypothetical — the stale
README instructions documented in #301 are the same failure in documentation form.

## Decision

`docs/CAPABILITY-MAP.md` is the single source of truth for what is actually built.
It uses exactly four status terms, and no others:

| Status | Meaning |
|---|---|
| **Live** | Wired end-to-end against real services. Safe to build on. |
| **Partial** | Some segments real, others stubbed, missing, or broken. The notes column says which. |
| **Mocked** | Returns hardcoded or simulated data. The shape exists; nothing real happens behind it. |
| **Experimental** | Feature-flagged, testnet-only, or at requirements stage. May change or be disabled. |

Rules:

1. These four terms are the only permitted values. "Planned", "WIP", "almost
   done", and "beta" are not statuses.
2. A flow with a client but no backend route is **Partial**, not "Planned".
   Known-broken wiring is also **Partial**, with the breakage named.
3. Anything in `.kiro/specs/` is a requirements document, not shipped behavior.
4. **Changing what is shipped requires changing the map in the same PR.** This
   includes the `needs:design` case: an architectural change that alters a status
   updates the row, not just the ADR.
5. Where the backend/client wiring is also affected, update
   `docs/BACKEND-CLIENT-CONTRACT-MAP.md` in the same PR.
6. "Enabled on testnet" is not a claim of readiness. Per
   [0002](./0002-testnet-first-mainnet-feature-gated.md), mainnet is a separate,
   flag-gated question.

## Alternatives considered

**Per-module README status badges.** Rejected. Status scattered across ~38 modules
drifts, and there is no single place to look. One map, updated in the same PR, is
auditable.

**Trust the docs and fix them when noticed.** Rejected. That is the current state
of the README, and it is the problem.

**A green/red "production ready" badge per service.** Rejected. It invites
optimistic labelling; a four-term vocabulary with a mandatory notes column forces
the useful detail.

## Consequences

- Any PR that turns a **Mocked** or **Partial** row **Live** is high value and is
  labeled `type:mocked-to-live`. It must add the real tests that justify the
  status, not just the wiring.
- Reviewers should reject a PR that changes behavior without touching the map.
- New product surfaces start as **Experimental** or **Partial**, not **Live**, and
  have to earn the promotion.
- This ADR constrains documentation, not code. No runtime behavior depends on it,
  so nothing here can affect funds or the invariants in `docs/INVARIANTS.md`.
