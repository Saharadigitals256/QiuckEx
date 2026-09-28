# Asset Listing Policy — Issuers, Verification, Delisting

Issue: [#306](https://github.com/Viky207/QiuckEx/issues/306) · Workstream: documentation & governance · Owning surfaces: `app/backend` (`asset-listing`, `asset-metadata`, `stellar`), `app/contract` (`SUPPORTED_ASSETS` validation)

This is the **published policy** for which Stellar assets QuickEx will list, what "verified" means, how a listing
is withdrawn, and who may do it. It is enforced in three places and the three must agree:

1. **Served state (runtime).** `GET /stellar/verified-assets` (and the asset pickers in web/mobile) only ever
   returns assets whose policy status is `listed`. The decision is computed by
   `app/backend/src/asset-listing/asset-listing.policy.ts` from the registry rows and the evidence records.
2. **Governance gate (CI).** `node scripts/governance/check.mjs --only assets` validates this document, the
   machine-readable policy at [data/asset-listing-policy.json](./data/asset-listing-policy.json), the backend
   constant mirror, and the seeded registry from the `verified_assets` migration.
3. **On-chain guard.** The contract validates asset codes against `SUPPORTED_ASSETS`
   (`app/contract/contracts/quickex/src/lib.rs`). A delisted asset **must not** be silently accepted on-chain just
   because it stopped being served off-chain — delisting therefore also requires a contract-side change once an
   asset is in the on-chain allowlist (see [Rollout](#rollout-and-rollback)).

Machine-readable companion: [data/asset-listing-policy.json](./data/asset-listing-policy.json) (validated; the
backend mirrors it in TypeScript and a unit test asserts the two agree — see
[Keeping code and policy in sync](#keeping-code-and-policy-in-sync)).

---

## 1. Scope and current state

| Surface | Behaviour before this policy | After this policy |
|---|---|---|
| `GET /stellar/verified-assets` | Serves rows from `verified_assets` where `verified = true`, falling back to the hardcoded `VERIFIED_STELLAR_ASSETS` constant when the DB is empty/unavailable | Same rows, **filtered** to `status = listed` and non-expired verification |
| `POST /asset-metadata/verify` (admin) | Sets `verified = true/false` with no evidence, expiry, reason, or idempotency | Retained for compatibility; governed decisions go through `POST /admin/asset-listing/decisions` and record evidence |
| Delisting | Only "set verified = false" — no reason, no audit trail, no user-visible state, no re-listing path | Governed transition with trigger, evidence, audit record, metrics, and a documented re-listing path |
| Client display | Assets are either "verified" or not fetched at all | Clients receive `status` and `tier`; `suspended` assets are hidden, `community` assets are labelled |

Baseline data (from the seeded migration `20260526000000_create_verified_assets.sql`): `XLM` (native), `USDC`
(Circle issuer), `AQUA`, `yXLM`. The governance gate fails if a seeded asset has no tier assignment in
[data/asset-listing-policy.json](./data/asset-listing-policy.json).

---

## 2. Listing states

```
   (new asset) pending ──accept──▶ listed ──trigger──▶ suspended ──trigger──▶ delisted
                  │                 ▲     │                                     │
                  └─reject─▶ rejected      └──clear trigger──┘        re-list (cooling-off + new
                            (terminal)                                evidence + full review)
```

| State | Served to clients? | Meaning | Exit |
|---|---|---|---|
| `pending` | No | Submitted, under review | `listed`, `rejected` |
| `listed` | Yes | Meets the tier's evidence requirements | `suspended`, `delisted` |
| `suspended` | No | A trigger fired, or verification evidence expired; reversible | `listed` (trigger cleared + evidence renewed), `delisted` |
| `delisted` | No | Withdrawn; terminal *until* a full re-listing review succeeds | `listed` (after cooling-off) |
| `rejected` | No | Never met requirements | Terminal (re-open requires a new request with new evidence) |

Rules:

1. `suspended` **must** resolve within `suspensionMaxDays` (30): either back to `listed` with fresh evidence, or to
   `delisted`. A suspension that ages out auto-transitions to `delisted` (no silent limbo).
2. Verification evidence expires. Expiry is a **soft** failure: the asset moves to `suspended` (excluded from the
   served list) rather than being deleted or silently kept listed. Boundary semantics: evidence with
   `expiresAt <= now` is **expired** (inclusive) — see the unit tests.
3. `delisted` → `listed` requires: cooling-off elapsed (`coolingOffDaysBeforeRelist`, 30), a new evidence set that
   satisfies the tier, and an explicit reviewer decision id. The original evidence is never reused.
4. `listed` → `delisted` is always allowed and takes effect immediately in the served list, even if the underlying
   trigger is later found to be wrong — errors are corrected by re-listing, never by ignoring a trigger.
5. Illegal transitions (e.g. `rejected` → `listed`, `pending` → `suspended`) are rejected with
   `ASSET_LISTING_INVALID_TRANSITION` (422). The transition table is data, not code.

---

## 3. Verification tiers

| Tier | Applies to | Requirements | Client treatment |
|---|---|---|---|
| `native` | `XLM` (`issuer = null`, `type = native`) | None (protocol asset) | Listed, unlabelled |
| `verified` | Issued assets with a public, auditable issuer | All required evidence below + issuer account age ≥ `minIssuerAccountAgeDays` (180) on the target network | Listed, "Verified" badge |
| `community` | Issued assets with an identifiable issuer but incomplete evidence (e.g. no reserve attestation) | `toml_document` evidence + issuer age | **Not** returned by `/stellar/verified-assets`; may be offered behind an explicit opt-in |
| `unlisted` | Anything else | — | Never served; not selectable |

### 3.1 Required evidence per tier

| Evidence | `verified` | `community` | Max age (days) | Source of truth |
|---|---|---|---|---|
| `toml_document` — issuer `stellar.toml` has a `[[CURRENCIES]]` entry whose `code`+`issuer` match the listing, fetched over HTTPS from the account's `home_domain` | Required | Required | 92 | `app/backend/src/asset-metadata/toml-fetcher.service.ts` |
| `attestation_of_reserve` — public attestation (TOML `attestation_of_reserve` or equivalent public statement) | Required | — | 92 | TOML / issuer disclosure |
| `issuer_identity` — the legal entity behind the issuer key is identified and its home domain matches the entity | Required | — | 365 | review record |
| `sanctions_screen` — issuer (entity and key) screened against applicable sanctions/PEP lists | Required | — | 365 | review record |
| `security_review` — issuer key management and freeze/revocation powers reviewed for abuse risk | Required | — | 730 | review record |

Evidence records are review artefacts (retention: `asset_listing_evidence`, 24 months after delisting) and
**never** contain personal data beyond a reviewer reference and the public issuer key.

### 3.2 Issuer eligibility rules (all tiers except `native`)

- The issuer is an **account**, not a pooled/shared address used to issue several unrelated assets.
- The issuer publishes a `stellar.toml` reachable over HTTPS with a valid certificate; an unreachable TOML is a
  failing `toml_document` check after 3 retries with backoff (degraded mode below).
- Issuers that keep freeze/confiscation authority must publish a discoverable policy for it in TOML; where they
  do, the API response marks the asset `issuerFreeze: true` so users can see it.
- Wrapped/derived representations of other listed assets are not listed unless the wrapper's redemption path and
  reserve are disclosed.

---

## 4. Delisting triggers

A trigger forces `listed → suspended` (immediately when `immediate: true`) and then `→ delisted` unless cleared
within the suspension window.

| Trigger id | Severity | Immediate | Evidence required | Default resolution |
|---|---|---|---|---|
| `issuer_key_compromised` | critical | Yes | incident reference | `delisted` |
| `reserve_or_peg_failure` | critical | Yes | attestation or public statement | `delisted` |
| `sanctions_or_legal_order` | critical | Yes | case reference (no case PII in API payloads) | `delisted` |
| `fraud_or_scam_reports` | high | No (≥ `scamReportThreshold` unique reports in 30 days) | report count + samples | `delisted` unless rebutted |
| `metadata_divergence` — TOML/metadata no longer matches the listed `code`/`issuer` | medium | No | diff record | `suspended` → `listed` when corrected |
| `evidence_expired` | medium | Yes (auto) | expiry record | `listed` on renewal |
| `issuer_requested` | high | No | issuer-signed request | `delisted` |
| `network_mismatch` — asset not issuable on the enabled network | high | Yes | network snapshot | `delisted` |
| `policy_violation` — breach of these rules found in review | high | No | review record | `suspended` or `delisted` |

Suspension is the **default** response to uncertainty; delisting is reserved for confirmed failures. Both are
recorded, never silent.

---

## 5. Authorization, idempotency, validation

| Concern | Rule |
|---|---|
| Who may decide | An admin-scoped API key (`@RequireScopes('admin')`), exactly as for contract registry writes. Public callers may only read the policy and the served list. |
| Idempotency | Decisions accept an `Idempotency-Key` header. Replaying the same key with the same payload returns the **original** decision record with `idempotent: true`. The same key with a different payload fails `409 ASSET_LISTING_IDEMPOTENCY_CONFLICT`. |
| Validation | `code`, `issuer`, `type`, `decimals` are validated before any state change; unknown assets fail `404 ASSET_NOT_FOUND`; a transition the table forbids fails `422 ASSET_LISTING_INVALID_TRANSITION`; missing/expired required evidence fails `422 ASSET_LISTING_EVIDENCE_INCOMPLETE` / `ASSET_LISTING_EVIDENCE_EXPIRED`. |
| Expiry | Evidence carries `expiresAt`; expiry is evaluated **at read time**, so a late sweeper cannot leave a stale asset listed. |
| Feature gates | `assets.listing_policy` gates policy-driven filtering; `assets.listing_decisions` gates admin mutations. Both default **disabled on mainnet** and enabled on local/testnet — see [Configuration](#7-configuration). |
| Degraded mode | If the registry/evidence store is unavailable, the endpoint serves the **last known good** listed set with `degraded: true` plus a warning log/metric. It must not fail open to "everything is listed", and must not fail the request while a cached set exists. With no cache: `503 ASSET_LISTING_REGISTRY_UNAVAILABLE`. |
| Rollback | Every decision is reversible: reverse `delist` by re-listing, reverse `list` by suspending/delisting. Reversal is itself a decision with its own audit record — no history is mutated or deleted. |

### 5.1 Error codes

| Code | HTTP | Cause |
|---|---|---|
| `ASSET_LISTING_UNAUTHORIZED` | 401/403 | Missing/insufficient scope (admin required) |
| `ASSET_NOT_FOUND` | 404 | Unknown `code`/`issuer` pair |
| `ASSET_LISTING_EVIDENCE_INCOMPLETE` | 422 | Tier requirements unmet |
| `ASSET_LISTING_EVIDENCE_EXPIRED` | 422 | Evidence beyond `maxAgeDays` |
| `ASSET_LISTING_INVALID_TRANSITION` | 422 | Transition not in the table (e.g. `rejected → listed`) |
| `ASSET_LISTING_COOLING_OFF_ACTIVE` | 409 | Re-listing attempted before `coolingOffDaysBeforeRelist` |
| `ASSET_LISTING_IDEMPOTENCY_CONFLICT` | 409 | Idempotency key reused with a different payload |
| `ASSET_LISTING_DECISIONS_DISABLED` | 403 | `assets.listing_decisions` off (expected on mainnet) |
| `ASSET_LISTING_REGISTRY_UNAVAILABLE` | 503 | Registry/evidence store unreachable and no cached set |

Codes are also listed in [../../app/backend/docs/ERROR-CODES.md](../../app/backend/docs/ERROR-CODES.md).

---

## 6. Observability

Structured log (one JSON line per decision; no secrets, no personal data — issuer keys are public):

```json
{"event":"asset_listing.decision","assetKey":"USDC:GA5Z...KZVN","action":"delist","from":"suspended","to":"delisted","trigger":"reserve_or_peg_failure","actor":"api-key:6f1c…(prefix only)","idempotencyKey":"…","correlationId":"…","durationMs":7,"outcome":"applied"}
```

| Metric | Type | Labels | Why |
|---|---|---|---|
| `asset_listing_decisions_total` | counter | `action`, `outcome`, `tier` | success/failure rate per action |
| `asset_listing_decision_duration_seconds` | histogram | `action` | latency; alert on p99 |
| `asset_listing_assets_served` | gauge | `tier` | how many assets clients can select |
| `asset_listing_assets_suspended` | gauge | `trigger` | early warning that an issuer broke |
| `asset_listing_policy_denials_total` | counter | `reason` | validation/authorization failures |

Alerting intent: any `critical` trigger is page-worthy; `asset_listing_assets_served == 0` is page-worthy (the
generator becomes unusable).

---

## 7. Configuration

| Key | Type | Default (local/dev) | Default (production/mainnet) | Effect |
|---|---|---|---|---|
| `assets.listing_policy` (flag) | bool | `true` | `false` | Filters the served asset list by policy status |
| `assets.listing_decisions` (flag) | bool | `true` | `false` | Enables admin list/suspend/delist/re-list mutations |
| `ASSET_LISTING_POLICY_ENFORCE` (env) | bool | unset | unset | Last-resort read-only switch, evaluated like the `app/backend/flags.js` env guards |

Both flags are kill switches: turning them off restores pre-policy behaviour without a deploy. They are recorded
in [../RUNTIME-CONFIG-MATRIX.md](../RUNTIME-CONFIG-MATRIX.md) and the flag table in
[../CAPABILITY-MAP.md](../CAPABILITY-MAP.md).

---

## 8. Rollout and rollback

**Mainnet gate.** This capability is **feature-gated and not enabled for mainnet**: enforcement defaults off in
production until (a) the first policy review of the seeded registry is signed off, (b) the retention policy holds
for listing evidence are in force, and (c) the suspension/adjudication runbook below has a named owner. Until
then, mainnet behaviour is the previous `verified` boolean.

**Rollback.** `assets.listing_policy=false` restores serving every `verified = true` row; `assets.listing_decisions=false`
freezes mutations (reads stay available). Because decisions are recorded rather than destructive and never rewrite
history, both rollbacks are instant and lossless. Re-listing is the forward-recovery path for a wrong delisting:
cooling-off → fresh evidence → decision.

**Operational procedure — suspend or delist an asset**

1. Confirm the trigger against §4 and capture the evidence reference; never act on unverified reports alone.
2. Read the current state (safe on mainnet): `GET /admin/asset-listing/registry?code=USDC`.
3. For a `critical`/immediate trigger: `POST /admin/asset-listing/decisions` with
   `{"action":"suspend","code":"USDC","issuer":"G…","trigger":"reserve_or_peg_failure","evidenceRef":"INC-1234"}`
   and an `Idempotency-Key`. Confirm `asset_listing_assets_served` dropped and that the asset disappeared from
   `/stellar/verified-assets`.
4. Within 30 days, resolve to `listed` with renewed evidence, or `delist` with the confirmed trigger.
5. If the asset is in the on-chain `SUPPORTED_ASSETS` allowlist, open the contract-side removal issue and link it
   in the incident record — off-chain delisting alone does not stop a direct on-chain transfer.
6. Publish a user-facing note; include no personal data and no unverified allegations.

**Operational procedure — re-list**

1. Confirm cooling-off elapsed and collect the full evidence set for the target tier.
2. `POST /admin/asset-listing/decisions` with `{"action":"list", …}` and fresh `evidenceRef` values.
3. Confirm the asset reappears in `/stellar/verified-assets` and re-add to `SUPPORTED_ASSETS` if it was removed.

---

## 9. Keeping code and policy in sync

- Canonical policy: [data/asset-listing-policy.json](./data/asset-listing-policy.json).
- The backend mirrors the decision-relevant subset in
  `app/backend/src/asset-listing/asset-listing.policy.ts`; `asset-listing.policy.unit.spec.ts` reads the JSON from
  disk and asserts equality, so documentation and code cannot drift.
- The governance gate additionally checks that every asset seeded by
  `app/backend/supabase/migrations/20260526000000_create_verified_assets.sql` appears in the policy tier map.

```bash
node scripts/governance/check.mjs --only assets                 # doc + JSON + seed consistency
cd app/backend && npx jest --config jest.unit.config.ts asset-listing   # policy engine + doc/code parity
```

## 10. References

- [../../app/backend/src/asset-metadata/asset-metadata.service.ts](../../app/backend/src/asset-metadata/asset-metadata.service.ts), [../../app/backend/src/stellar/stellar.controller.ts](../../app/backend/src/stellar/stellar.controller.ts)
- [../../app/backend/supabase/migrations/20260526000000_create_verified_assets.sql](../../app/backend/supabase/migrations/20260526000000_create_verified_assets.sql)
- [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md), [../BACKEND-CLIENT-CONTRACT-MAP.md](../BACKEND-CLIENT-CONTRACT-MAP.md), [../MVP-CONTRACT-SCOPE.md](../MVP-CONTRACT-SCOPE.md)
- [./DATA-RETENTION-PRIVACY-POLICY.md](./DATA-RETENTION-PRIVACY-POLICY.md) (evidence retention, holds)
- [../GOVERNANCE.md](../GOVERNANCE.md) (owners, review cadence, waivers) · gate: `node scripts/governance/check.mjs --only assets`
- [../adr/0003-testnet-only-contract-writes.md](../adr/0003-testnet-only-contract-writes.md) (flag-gating posture)
