# ADR-0001: Self-custody, no server-side key custody

## Status

Accepted

## Context

QuickEx is a non-custodial payment-link product on Stellar. The backend must be able to observe and index
payments, build unsigned transactions, and gate risky flows, but it must never be able to move a user's funds
without that user's own signature. Contributors repeatedly reach for the cheap alternative — storing a wallet
secret to "make the flow work" — and the repository already contains one shape of that mistake: the frontend
fabricates a signed XDR in `app/frontend/src/components/payment-states/ActivePaymentState.tsx` (documented as
**Mocked** in [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md)).

Evidence that this is a load-bearing constraint:

- `docs/CAPABILITY-MAP.md` lists "Frontend payment signing" as Mocked precisely *because* no real signature is produced — the gap is signing, not custody.
- `app/backend/src/transactions` composes **unsigned** XDR (`composeTransaction`) and returns it with a `correlationId`; it has no signing endpoint.
- `app/backend/src/privacy` provides X25519/X-ray *envelope* primitives so recipient metadata can be encrypted for a recipient view key that only the client holds.
- The Soroban contract relies on `Address::require_auth` (Soroban-native auth) rather than off-chain signatures, per [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md).

A one-off "operator wallet" is still permitted for server-initiated operations that are *explicitly* protocol
actions (fee collector rotation, refunds on the platform account). That is different from custody of user funds
and is tracked separately below.

## Decision

1. User signing keys (`S…` secrets / Soroban keypairs) live **only** on the client: browser memory/keychain or the
   mobile `SecureStore` (`app/mobile/services/wallet-session.ts`).
2. The backend accepts only **public** keys and **signatures**: it may compose, simulate, verify and broadcast a
   transaction that a user has already signed, and it must reject any request whose payload embeds a secret.
3. No backend endpoint, job, log line, metric label, support bundle or webhook payload may contain a secret key,
   seed, mnemonic or private key material. `scripts/secret-scan.sh` and `gitleaks.toml` are the enforcing layer
   for the repository; `.github/workflows/secret-scanning.yml` blocks merges.
4. Wallet-facing server-side key material is limited to explicitly-named infrastructure accounts (for example a
   platform account for recurring payments) configured **only** through environment variables, never persisted in
   Supabase, and never derived from user input.
5. Any new endpoint that needs privileged chain authority must declare it: `X-API-Key` scope, `NetworkSafetyGuard`,
   and a `RequiresFlag` gate, so that mainnet behaviour is off unless an operator enables it (see
   [ADR-0003](./0003-testnet-only-contract-writes.md)).

## Consequences

- Client flows need an explicit signing step; features cannot "just work" server-side. The Mocked row for
  `ActivePaymentState.tsx` must be closed by real client-side signing, not by moving signing to the backend.
- Support and debugging are harder because the backend cannot replay a user's transaction into a signing state;
  the compensating control is `correlationId` propagation (`docs/BACKEND-CLIENT-CONTRACT-MAP.md`) plus the
  transaction timeline module.
- Lost client keys are unrecoverable by design; recovery is a product decision, not a backend capability.
- Data-subject operations cannot rely on "we could re-sign for the user" (see
  [../policies/DATA-RETENTION-PRIVACY-POLICY.md](../policies/DATA-RETENTION-PRIVACY-POLICY.md)); deletion proof
  must come from the client's own signature.

## Reversal Cost

HIGH. Introducing custody would require key-management infrastructure, insurance/regulatory review, a new
authorization model, and client migration, and it would break the product's non-custodial positioning. Reversal
requires a superseding ADR plus a security review; it is not something a feature PR may do.

## Invariants Affected

- [INV-02](../INVARIANTS.md) No Unauthorized Withdrawals — no third party (including QuickEx) can withdraw from an escrow it is not a party to.
- [INV-08](../INVARIANTS.md) Authorization Consistency — only the designated actor can drive a transition.

## References

- `app/backend/src/transactions/transaction.service.ts` (unsigned compose/build/simulate)
- `app/backend/src/privacy/privacy.service.ts` (recipient-view-key envelopes)
- `app/mobile/services/wallet-session.ts` (device-local key storage)
- `docs/security.md` (secret storage and scanning), [ADR-0003](./0003-testnet-only-contract-writes.md)
