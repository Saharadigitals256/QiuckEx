# QuickEx Custody Boundaries, Trust Assumptions, and Threat Mitigations

This document outlines the security architecture, custody boundaries, trust assumptions, and threat mitigations across all four QuickEx application surfaces (`app/frontend`, `app/backend`, `app/mobile`, and `app/contract`).

It serves as the formal security baseline for maintaining self-custody and enforcing the core protocol invariants defined in [INVARIANTS.md](./INVARIANTS.md).

---

## 1. Custody Boundaries

QuickEx is engineered strictly as a **non-custodial** protocol. The platform never holds, transfers, or exercises custody over user assets outside of trustless on-chain Soroban smart contracts.

```
       ┌────────────────────────────────────────────────────────┐
       │                 CLIENT CUSTODY BOUNDARY                │
       │                                                        │
       │   Frontend (Freighter / Albedo / Web3 Wallet)          │
       │   Mobile (SecureStore / Device Hardware Keystore)      │
       │                                                        │
       │   [Private Keys] ────────► [Client-Side Signer]        │
       └──────────────────────────────┬─────────────────────────┘
                                      │ Signed XDR / Auth
                                      ▼
┌───────────────────────────┐      ┌───────────────────────────┐
│     BACKEND SERVICES      │      │      STELLAR NETWORK      │
│  (Untrusted Coordinator)  │      │     (On-Chain Ledger)     │
│                           │      │                           │
│ • Unsigned XDR compose    │      │ • Horizon / Soroban RPC   │
│ • Route discovery         │      │ • Soroban Escrow Contract │
│ • Event indexing          │      │   - Funds held in escrow  │
│ • Scam heuristics         │      │   - Enforces INV-01..10   │
│ • No User Private Keys    │      │                           │
└───────────────────────────┘      └───────────────────────────┘
```

### 1.1 Client-Side Custody (`app/frontend`, `app/mobile`)
- **Key Isolation**: Private keys (Stellar seed words, Secret Keys starting with `S...`) are generated, stored, and managed solely on the client device.
  - On web (`app/frontend`), keys reside exclusively inside user-controlled browser extension wallets (Freighter, Albedo, Lobstr).
  - On mobile (`app/mobile`), keys and session seeds are persisted using hardware-backed encrypted storage (`expo-secure-store` / `services/security*.ts`). They are never synchronized to backend servers.
- **Signing Exclusivity**: All state-mutating transactions (escrow funding, fulfillment, refund claims, dispute initiation) are signed locally by the user.

### 1.2 Backend Operational Boundary (`app/backend`)
- **Zero Custody Invariant**: The backend server never possesses user private keys.
- **Unsigned Transaction Construction**: Backend endpoints (`POST /transactions/compose`, `POST /transactions/build`, `POST /stellar/path-preview`) only build unsigned transaction envelopes (XDR). The client inspects the decoded operations before providing local cryptographic authorization.
- **Server-Side Key Isolation**: The optional `STELLAR_SECRET_KEY` configured in the backend environment is strictly dedicated to protocol fee relayer actions or operational probes. When omitted, the backend boots safely in read-only mode (`validateCriticalConfig` in `main.ts`). Server keys cannot withdraw or redirect escrow balances.

### 1.3 Smart Contract Escrow Custody (`app/contract`)
- **Autonomous Escrow**: Escrow deposits (`src/escrow.rs`, `src/commitment.rs`) lock funds directly inside the Soroban contract instance on the Stellar ledger.
- **Deterministic Settlement**: Funds can only leave contract storage through authenticated contract transitions:
  - Fulfill: Releases escrow principal to the pre-designated merchant (`INV-02`).
  - Refund: Returns escrow principal to the customer after expiration (`INV-02`, `INV-06`).
  - Dispute Resolution: Executable only by the designated arbiter (`INV-08`).
- **Emergency Halt Isolation**: If `activate_emergency_mode` is triggered, all funds remain permanently locked in the contract until an audited governance upgrade is enacted. No administrator can drain or seize trapped assets.

---

## 2. Trust Assumptions

| Component | Trust Level | Justification & Mitigations |
|---|---|---|
| **User Wallet** | Fully Trusted | The user's device is responsible for safeguarding their private keys. Hardware wallet integration and PIN-protected SecureStore mitigate key theft. |
| **Backend API** | Untrusted Coordinator | The backend can fail, drop events, or delay responses, but **cannot steal funds** because it lacks signing capabilities. |
| **Stellar Horizon / RPC** | Semi-Trusted | QuickEx relies on Stellar validators for consensus and finality. RPC timeouts or split-brain forks are mitigated via multiple fallback endpoints and idempotency. |
| **Contract Admin** | Restricted Operator | The contract administrator can pause entrypoints or rotate the fee collector address, but **cannot alter past escrows** or redirect balances. |
| **Third-Party Oracles** | Deferred / Untrusted | In MVP, external price oracles are stubbed (`src/oracle.rs`); fee logic uses static on-chain basis points to eliminate oracle manipulation vectors. |

---

## 3. Threat Model & Mitigations

### 3.1 Replay Attacks & Duplicate Settlements (INV-04, INV-07)
- **Threat**: An adversary intercepts a valid payment or contract call and attempts to broadcast it multiple times.
- **Mitigation**:
  1. Stellar native transaction sequence numbers prevent replaying identical transaction envelopes.
  2. Soroban escrows require unique `(creator, nonce)` pairs (`INV-07`). Nonce consumption is verified atomically in on-chain storage.
  3. Terminal states (`Fulfilled`, `Refunded`, `DisputeResolved`) are recorded permanently; any subsequent settlement attempt fails immediately with `INV-04: No Double-Settlement`.

### 3.2 Unauthorized Fund Release & Confiscation (INV-02, INV-08)
- **Threat**: A rogue operator, compromised backend, or malicious peer attempts to claim another party's escrowed tokens.
- **Mitigation**:
  1. Every mutating contract function calls `Address::require_auth()` against the transaction invoker.
  2. Withdrawals strictly check recipient equality against the escrow record created at deposit time.
  3. The contract contains no backdoor withdrawal or administrative clawback method.

### 3.3 Overpayment and Conservation of Value (INV-01, INV-03, INV-10)
- **Threat**: Integer overflow or miscalculated fee deductions cause tokens to be minted, leaked, or drained from neighboring escrows.
- **Mitigation**:
  1. Safe arithmetic is enforced throughout Rust contracts; arithmetic overflow panics automatically rollback the transaction.
  2. Total funds disbursed (`merchant_amount + protocol_fee`) cannot exceed deposited principal (`INV-03`).
  3. Platform fees are capped by an immutable on-chain fee ceiling (`INV-10`).

### 3.4 Phishing, Scam Links, and Malicious Routing
- **Threat**: Attackers distribute fake payment links or fraudulent assets mimicking reputable tokens (e.g. counterfeit USDC).
- **Mitigation**:
  1. The backend runs a dedicated scam alert analysis service (`scam-alerts.service.ts`) evaluating domain reputation, creator history, and destination anomalies.
  2. The asset directory (`GET /stellar/verified-assets`) verifies issuer public keys against official SEP-0001 domain TOML declarations.
  3. Clients display asset contract IDs and issuer addresses prominently prior to signing.

### 3.5 Dependency Failure & Network Partition (Degraded-Mode Operation)
- **Threat**: Backend crashes, Horizon node latency spikes, or Supabase database becomes unavailable.
- **Mitigation**:
  1. **Direct Submission Fallback**: Clients can submit signed XDR envelopes directly to Stellar public Horizon nodes (`https://horizon.stellar.org`) bypassing the QuickEx backend.
  2. **Mobile Offline Action Queue**: The mobile client (`services/offline-queue.ts`) queues non-immediate requests locally and safely replays them with idempotency tokens when connectivity resumes.
  3. **Read Caching & ETags**: Public profile and asset directories return strong `ETag` headers, enabling clients and CDNs to serve cached data when origin servers degrade.

---

## 4. Invariant Traceability Matrix

| Invariant | Description | Enforcing Layer | Owning Code |
|---|---|---|---|
| **INV-01** | Conservation of Value | Contract | `contracts/quickex/src/escrow.rs` |
| **INV-02** | No Unauthorized Withdrawals | Contract & Client | `contracts/quickex/src/lib.rs` (`fulfill_escrow`, `refund_escrow`) |
| **INV-03** | No Overpayment | Contract | `contracts/quickex/src/fee.rs` |
| **INV-04** | No Double-Settlement | Contract & Backend | `src/escrow.rs`, `app/backend/src/transactions` |
| **INV-05** | Valid State Transitions Only | Contract | `contracts/quickex/src/state.rs` |
| **INV-06** | Expiry Monotonicity | Contract | `contracts/quickex/src/escrow.rs` (ledger timestamp validation) |
| **INV-07** | Nonce Uniqueness | Contract | `contracts/quickex/src/escrow_id.rs` |
| **INV-08** | Authorization Consistency | Contract & Wallet | `Address::require_auth`, `app/frontend/src/lib/stellar` |
| **INV-09** | Zero-Amount Payment | Contract | `contracts/quickex/src/escrow.rs` validation guard |
| **INV-10** | Fee Ceiling | Contract | `contracts/quickex/src/fee/fee_policy.rs` |
