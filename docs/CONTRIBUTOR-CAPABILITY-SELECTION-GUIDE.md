# Contributor Guide: Choosing and Advancing Live vs. Partial Capabilities

This guide instructs contributors on how to evaluate the status of QuickEx features, choose appropriate issues, and implement production-ready upgrades.

Before picking up an issue or building on top of existing flows, review this guide alongside [CAPABILITY-MAP.md](./CAPABILITY-MAP.md), [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md), and [INVARIANTS.md](./INVARIANTS.md).

---

## 1. The Four Capability Statuses

QuickEx categorizes all features across `app/frontend`, `app/backend`, `app/mobile`, and `app/contract` into four strict statuses:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CAPABILITY SPECTRUM                           │
├───────────────────┬───────────────────┬───────────────────┬─────────────┤
│      MOCKED       │      PARTIAL      │   EXPERIMENTAL    │    LIVE     │
│                   │                   │                   │             │
│ • Hardcoded data  │ • Missing wiring  │ • Testnet-only    │ • Full E2E  │
│ • Fake delays     │ • Stubbed segment │ • Behind flags    │ • Real DB   │
│ • Local-only      │ • Route mismatch  │ • Spec phase      │ • Audited   │
│ • No real actions │ • Known breakage  │ • Subject to API  │ • Invariant │
│                   │                   │   changes         │   compliant │
└───────────────────┴───────────────────┴───────────────────┴─────────────┘
```

1. **Live**: Fully implemented, tested, and connected end-to-end against real services (NestJS backend, Supabase, Horizon, or Soroban RPC). Safe to depend upon directly in production code.
2. **Partial**: Contains real logic, but has broken or incomplete integration segments (e.g. client is wired but backend route is missing, or database call is a `TODO`). Requires reading notes in `CAPABILITY-MAP.md`.
3. **Mocked**: Surface UI exists, but executes purely on simulated data (`MOCK_*` constants, fake `setTimeout` promises, local storage stubs).
4. **Experimental**: Functional but gated behind feature flags (`testnet.contract_writes`, `mainnet.contract_writes`), testnet-only, or in the RFC stage.

---

## 2. Contributor Decision Matrix

When selecting work or building a feature, follow this decision tree:

```
                      Do you need this capability for your task?
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
           It is marked LIVE                     It is NOT marked LIVE
                    │                                     │
           Safe to build upon!               Inspect CAPABILITY-MAP.md
           Consume documented API                         │
           contracts directly.             ┌──────────────┼──────────────┐
                                           ▼              ▼              ▼
                                        PARTIAL        MOCKED       EXPERIMENTAL
                                           │              │              │
                                     Wire missing   Replace mock   Check feature
                                     endpoint / fix with minimal   flags & testnet
                                     contract drift production     constraints
                                                    design
```

### High-Leverage Contribution Opportunities
The highest-value issues in QuickEx involve **connecting existing Live backend modules to Mocked frontend or mobile surfaces**:
- **Discovery Page**: `app/frontend/src/app/discovery` currently displays static data, while the backend already serves real `GET /username/search`, `/trending`, and `/featured`.
- **Receipt Screen**: Connect mobile `ReceiptScreen` to real `GET /v1/receipts/tx/:txHash`.
- **Mobile Contract Registry Sync**: Fix the `/api/contracts/registry` path mismatch (#1) by routing to `/contracts/registry`.

---

## 3. Checklist: Promoting a Capability to LIVE

To promote any feature from **Mocked** or **Partial** to **Live**, your pull request must satisfy all of the following engineering criteria:

### 1. Minimal Maintainable Production Design
- [ ] Remove all hardcoded mocks (`MOCK_BIDS`, `MOCK_LISTINGS`, fake delays).
- [ ] Implement end-to-end communication connecting the client UI/store to the appropriate backend controller and Supabase/Stellar services.
- [ ] Avoid adding speculative complexity or unused dependencies; choose the smallest maintainable production architecture.

### 2. Authorization and Security
- [ ] Enforce appropriate guards on backend controllers:
  - Public endpoints: apply rate limiting (`ThrottlerGuard`).
  - Partner / App endpoints: apply `ApiKeyGuard`.
  - Administrative endpoints: enforce `@RequireScopes('admin')`.
- [ ] Ensure non-custodial boundaries: private keys must never be accepted, transmitted, or logged.

### 3. Idempotency & Input Validation
- [ ] Define explicit TypeScript DTOs using `class-validator` and `class-transformer`.
- [ ] Ensure validation errors return the canonical error structure:
  ```json
  {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "fields": { "fieldName": ["constraint failed"] }
  }
  ```
- [ ] Support `Idempotency-Key` or atomic database constraints on write operations to prevent duplicate mutations.

### 4. Preservation of Protocol Invariants (INV-01 to INV-10)
- [ ] Verify that financial balances remain conserved (`INV-01`).
- [ ] Ensure no unauthorized withdrawals can occur (`INV-02`, `INV-08`).
- [ ] Verify single-settlement semantics (`INV-04`) and unique nonces (`INV-07`).

### 5. Feature Gating & Mainnet Safety
- [ ] If the capability touches on-chain Soroban contract interactions or writes that have not completed mainnet audit:
  - Gate backend execution behind `feature-flags.service.ts` flags (`testnet.contract_writes`, `mainnet.contract_writes`).
  - Ensure mainnet environments default to disabled until audit completion.

### 6. Observability & Redaction
- [ ] Implement structured logging with `Winston` or `Logger`.
- [ ] Verify zero credential leakage: never log secrets (`S...`), seed phrases, or database connection strings (`redaction.util.ts`).
- [ ] Increment Prometheus metrics on success/failure where applicable.

### 7. Degraded-Mode & Stable Error Handling
- [ ] Handle network timeouts and upstream RPC failures cleanly.
- [ ] Never return unhandled 500 errors to clients.
- [ ] Implement client-side fallbacks (e.g. mobile offline action queue or local cache).

### 8. Testing Standards
- [ ] **Unit Tests**: Cover happy paths, validation boundary conditions, and invalid inputs (`*.unit.spec.ts`).
- [ ] **Integration Tests**: Verify database/controller behavior and security guards (`*.integration.spec.ts`).
- [ ] **Negative Scenarios**: Test unauthorized, malformed, expired, and duplicate requests.

### 9. Documentation Synchronization
- [ ] Update [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) updating the status column from `Partial` or `Mocked` to `Live`.
- [ ] Update [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) if any routes, query parameters, or payloads were added or modified.
- [ ] Note assumptions regarding network, custody, and migrations in the PR description.
