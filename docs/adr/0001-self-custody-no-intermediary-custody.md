# 0001. Keep QuickEx self-custodial; no intermediary holds funds

- Status: Accepted
- Date: 2026-01-15
- Surfaces: app/backend, app/frontend, app/mobile, app/contract

## Context

QuickEx issues payment links (`quickex.to/yourname/50`) for USDC, XLM, and other
Stellar assets. A payer scans a QR code and pays from their own wallet. The product
question is who is in the payment path.

The custodial alternative is common: the platform holds funds between payer and
recipient and releases them on fulfilment. That buys some product features —
escrow with a counterparty, chargeback handling, fiat on/off-ramps with a
regulated intermediary — at the cost of QuickEx becoming the party that can lose
user money, that must be trusted, and that draws the regulatory weight of holding
customer funds.

`docs/INVARIANTS.md` states the constraints in the negative: INV-01 (conservation of
value) and INV-02 (no unauthorized withdrawals) are both phrased as "the platform
cannot move value except through an explicitly authorized protocol action."

## Decision

QuickEx is non-custodial end to end. Funds route directly from the payer's Stellar
account to the recipient's Stellar account. The backend composes, simulates, and
records transactions; it never holds, escrows, or sweeps assets on a user's behalf.

Concretely:

- The backend never has a signing key with authority over user funds. Transaction
  signing happens in the client (Freighter/Lobstr) or in a contract the parties
  control.
- The backend may hold *service* secrets — API keys, JWT signing keys — but never a
  key with custody of user assets.
- Where a flow needs conditional release of value, it belongs in a Soroban contract
  (`app/contract`) with an explicit arbiter/role separation, not in backend state.
- Any future fiat on/off-ramp must go through a regulated anchor as the custodial
  party, with QuickEx as the integrator — never as the holder.

## Alternatives considered

**Platform escrow.** Rejected. It would make QuickEx the loss-bearing party, which
inverts the trust model the product is sold on and would require us to hold and
reconcile user funds.

**Hosted wallet / custodial accounts.** Rejected. Same objection, plus it breaks
"no apps required" — payers would need an account before they can pay.

**Delegate-by-default signing.** Rejected. Silent delegation is strictly worse than
custody for user trust and adds no capability we need.

## Consequences

- Some product ideas are structurally out of scope: chargebacks, credit, and
  merchant-of-record flows. This is intentional, and the feature request template
  says so up front to save contributors the detour.
- Conditional payment logic is more expensive: it goes in Soroban, which is slower
  to iterate on than backend code. Accepted as the cost of custody.
- Fiat on/off-ramps (`app/backend/src/fiat-ramps`) are currently **Mocked** and must
  not be described as moving real funds. The integration boundary is fixed here
  even though the implementation is not.
- Reviewers should treat any change that introduces a user-asset signing key into
  the backend as a `custody:sensitive` change requiring maintainer review, and any
  proposed relaxation of INV-01/INV-02 as requiring a new ADR that supersedes this
  one.
