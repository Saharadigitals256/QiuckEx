# Data Retention, Deletion & User Privacy Policy

Issue: [#307](https://github.com/Viky207/QiuckEx/issues/307) · Workstream: documentation & governance · Owning surfaces: `app/backend` (`privacy`, `audit`, `analytics`, `notifications`, `support-bundle`, `crash-reporting`, `abuse-signals`, `contracts`), `app/mobile` (device-local stores), `app/contract` (public chain state)

This document publishes **how long QuickEx keeps each class of data, how it is deleted, what a user can demand,
and what QuickEx cannot delete**. Everything here is enforced by the machine-readable schedule at
[data/retention-schedule.json](./data/retention-schedule.json), which the governance gate validates against this
document and against the backend mirror
(`app/backend/src/privacy/retention/retention-schedule.ts`, asserted equal by unit test).

Non-negotiables inherited from the rest of the system:

- **Self-custody ([ADR-0001](../adr/0001-self-custody-and-no-server-side-key-custody.md))** — QuickEx never holds
  user signing keys, so a deletion request cannot be authenticated by an account login. The subject proves control
  of their Stellar key by signing a server-issued challenge.
- **Financial invariants ([../INVARIANTS.md](../INVARIANTS.md))** — financial records that prove conservation of
  value (receipts, refunds, reconciliation) are retained under a documented legal hold and are **pseudonymized, not
  deleted**, so totals still reconcile without identifying the subject.
- **Chain immutability** — data written to Stellar cannot be deleted by anyone. The policy states this plainly
  instead of promising deletion it cannot deliver.

---

## 1. Principles

1. **Minimize first.** The cheapest data to protect is data never collected. New fields that store free text
   (memos, notes, labels) must justify themselves in review; analytics uses aggregates, not raw identifiers.
2. **Delete on schedule, not on request.** Retention windows are enforced by a scheduled sweep
   (`RetentionService.planSweep`) so data does not linger until someone asks; a subject request only *shortens* the
   window, it is never the mechanism that makes deletion happen.
3. **Every deletion is auditable and idempotent.** Each request and sweep run produces a record; re-running a sweep
   or replaying a request never double-deletes and never resurrects data.
4. **No secrets, no unnecessary personal data in logs or metrics.** Deletion machinery logs subject *hashes* and
   request ids, never subject references in clear text.
5. **Document what cannot be honoured** (on-chain state, active legal holds) with the reason and the maximum
   duration, so support can answer honestly.

---

## 2. Data inventory and retention windows

Canonical machine-readable form: [data/retention-schedule.json](./data/retention-schedule.json) · a negative
`windowDays` means indefinite retention (documented hold).

| Category id | Where | Window (days) | Window starts | Method | Personal data |
|---|---|---|---|---|---|
| `payment_link_metadata` | Supabase `payment_links` | 30 | link expiry or deletion | `hard_delete` | possible (memo) |
| `link_analytics_events` | Supabase analytics views | 400 | event time | `aggregate_only` | possible |
| `transaction_index` | Supabase Soroban event tables | 400 | ledger time | `redact` | possible (memo enrichment) |
| `financial_records` | Supabase receipts/refunds/reconciliation | 2555 | record creation | `pseudonymize` | possible |
| `audit_logs` | Supabase admin audit log | 1095 | record creation | `redact` | possible |
| `api_keys` | Supabase `api_keys` | 90 | key revocation | `hard_delete` | no (stored hashed) |
| `webhook_deliveries` | Supabase webhook log/DLQ | 30 | delivery time | `redact` | possible |
| `notifications` | Supabase `notifications` | 90 | record creation | `hard_delete` | possible |
| `support_bundles` | Supabase support-bundle references | 30 | bundle creation | `hard_delete` | possible |
| `crash_reports` | Sentry | 90 | event time | `redact` | possible (scrubbed) |
| `abuse_signals` | Supabase `abuse_signals` | 180 | signal time | `hard_delete` | no |
| `scam_alerts` | Supabase `scam_alerts` | 365 | alert time | `redact` | possible |
| `asset_listing_evidence` | Supabase listing evidence | 730 | delisting | `redact` | no |
| `verified_assets` | Supabase `verified_assets` | 730 | delisting | `redact` | no |
| `contract_registry_history` | Supabase deployment artifacts | indefinite | publish time | `not_deletable` | no |
| `privacy_deletion_requests` | Supabase `privacy_deletion_requests` | 730 | request completion | `pseudonymize` | no (salted hash) |
| `telegram_link_mappings` | Supabase Telegram tables | 30 | chat unlink | `hard_delete` | yes |
| `dashboard_feed_cache` | Redis | 7 | cache write | `hard_delete` | no |
| `job_replay_log` | Supabase `job_replay_log` | 90 | record creation | `hard_delete` | no |
| `device_local_mobile_data` | Mobile AsyncStorage / SecureStore | on user action (0) | user action | `device_local` | yes |
| `onchain_escrow_state` | Stellar / Soroban | indefinite | ledger time | `not_deletable` | no |

Deletion methods:

| Method | Meaning |
|---|---|
| `hard_delete` | Row/object removed. |
| `pseudonymize` | Identifying fields replaced with keyed HMAC pseudonyms; financial amounts and timestamps retained so accounting still balances. |
| `redact` | Free-text/identifier fields dropped; structured, non-identifying fields retained. |
| `aggregate_only` | Only aggregates survive; raw rows are dropped. |
| `not_deletable` | Retained by design (audit/forensic/chain); documented under a hold. |
| `device_local` | Never sent to the backend; removed by the subject through app settings or by uninstalling the app. |

---

## 3. Deletion requests (subject rights)

### 3.1 What a subject can ask for

| Right | Endpoint | Notes |
|---|---|---|
| Know what is held about them | `GET /privacy/retention-policy` (public, machine-readable) plus the machine-readable schedule | No personal data is returned by this endpoint — it describes categories, not subjects |
| Delete their data | `POST /privacy/deletion-requests` | Process described below; financial records are pseudonymized per §4 |
| Cancel a pending deletion (rollback) | `POST /privacy/deletion-requests/:id/cancel` | Allowed during the 7-day cooling-off window and until execution begins |
| Track status | `GET /privacy/deletion-requests/:id` (admin/API-key scoped) | Returns status, due date, per-category outcome, and any hold with its reason |
| Export | see `GET /analytics/export` and `GET /v1/receipts/*` | Existing capabilities; not duplicated here |

### 3.2 Proof of control (no accounts, no email)

Because QuickEx is non-custodial and stores no login, the subject proves control of their Stellar key:

1. `POST /privacy/deletion-requests/challenge` with `{"subject":"G…"}` (a 56-character StrKey public key) or a
   registered `username` that the backend resolves to its public key. Unknown subject ⇒ `404 DELETION_SUBJECT_NOT_FOUND`
   (the response does not reveal whether a username exists beyond the standard 404 shape).
2. The server returns `{ challengeId, challenge, expiresAt }` where `challenge` is a canonical string containing
   `purpose=quickex.data-deletion`, the subject reference, the challenge id, `issuedAt`, and `expiresAt`.
   TTL is `challengeTtlSeconds` (900 s) and a challenge is single-use.
3. The subject signs the exact `challenge` string with their Stellar ed25519 key and submits
   `POST /privacy/deletion-requests` with `{ subject, challengeId, signature (base64) }` and an `Idempotency-Key`.
4. The server verifies the signature **before** looking at any data. Failures are `401 DELETION_SIGNATURE_INVALID`;
   expired/unknown challenges are `410 DELETION_CHALLENGE_EXPIRED` / `404 DELETION_CHALLENGE_UNKNOWN`.
   Proof failures are counted (`deletion_proof_failures_total`) but the attempted signature is never logged.

### 3.3 Lifecycle, service levels, and rollback

```
request ──▶ pending ──(7-day cooling-off)──▶ executing ──▶ completed
              │                                  │
              └── cancel (signed) ──▶ cancelled  └── dependency failure ──▶ pending (resumable, no partial delete)
```

| Stage | SLA / rule |
|---|---|
| Acknowledgement | within `acknowledgeBusinessDays` (5 business days) — the `202` response *is* the acknowledgement and carries the request id |
| Cooling-off | `coolingOffDays` (7) during which the request is cancellable (`cancelled`) |
| Execution | within `executeDays` (30) of the request, or `executeDaysWithHold` (45) when a hold applies |
| Idempotency | replaying the same `Idempotency-Key` with the same payload returns the original request (`409 DELETION_REQUEST_DUPLICATE` when a live request already exists for the subject, with the existing id in `details.requestId`) — never a second, parallel request |
| Partial failure | The sweep is per category and per record id: a dependency failure leaves already-deleted records deleted, marks the request `pending`, and resumes on the next run; it never reports `completed` |
| Rollback | `cancel` (during cooling-off) restores nothing because nothing was deleted yet; after execution, restoration is impossible by design (`409 DELETION_ALREADY_EXECUTED`). Forward-fix: re-register with a new request |
| Completion record | `privacy_deletion_requests` row is kept 730 days as proof of compliance — salted hash only |

### 3.4 Duplicate, malformed, and expired cases

| Case | Behaviour |
|---|---|
| Duplicate live request for the same subject | `409 DELETION_REQUEST_DUPLICATE`; the existing request id is returned in `details` so the client can track it |
| Same idempotency key, different payload | `409 DELETION_IDEMPOTENCY_CONFLICT` |
| Malformed subject (not a StrKey / blank / wrong length) | `400 VALIDATION_ERROR` before any challenge is issued |
| Malformed signature (not base64, wrong length) | `401 DELETION_SIGNATURE_INVALID` |
| Replayed challenge (already used) | `409 DELETION_REQUEST_DUPLICATE` |
| Expired challenge | `410 DELETION_CHALLENGE_EXPIRED` |
| Cancel after execution | `409 DELETION_ALREADY_EXECUTED` |

---

## 4. Legal holds and what cannot be deleted

A hold **blocks or narrows** deletion. Holds are explicit, justified, and time-bounded where a bound exists.

| Hold id | Applies to | Max duration | Why it exists | Effect on a deletion request |
|---|---|---|---|---|
| `legal_obligation` | `financial_records`, `audit_logs` | 2555 days (7 years) | tax/accounting retention | Category is **pseudonymized**, not deleted; the request still completes for everything else |
| `regulatory_defense` | `asset_listing_evidence`, `verified_assets`, `scam_alerts` | 1825 days (5 years) | defend listing/sanctions decisions | Records are redacted but retained for the hold period |
| `forensic_audit` | `contract_registry_history` | indefinite | prove where funds were directed ([ADR-0006](../adr/0006-contract-registry-rollback-and-etag.md)) | Retained; the request reports the hold and its reason |
| `security_incident_active` | any category in scope of an open investigation | until the incident closes | stop a deletion being used to destroy evidence | Request stays `pending` with `DELETION_HOLD_ACTIVE` in the category outcome; resumes automatically when the hold is released |

Rules:

1. A hold **never blocks the request itself** — the response lists per-category outcomes so the subject knows what
   happened to each class of data. Nothing is hidden behind a generic failure.
2. Holds are recorded (who set it, why, when it expires) and visible in `GET /privacy/deletion-requests/:id`.
3. **On-chain data cannot be deleted.** `onchain_escrow_state` is public, permanent, and outside QuickEx's control.
   QuickEx can redact the *off-chain index* of that data but cannot remove the ledger entries. This is stated in
   user-facing copy and must not be contradicted by support.
4. Because financial records are pseudonymized rather than deleted, totals continue to reconcile —
   [INV-01](../INVARIANTS.md) and [INV-04](../INVARIANTS.md) survive a deletion request.

---

## 5. Error codes

| Code | HTTP | Cause |
|---|---|---|
| `DELETION_SUBJECT_NOT_FOUND` | 404 | Subject reference cannot be resolved to a known public key |
| `DELETION_CHALLENGE_UNKNOWN` | 404 | Challenge id not issued (or already consumed and expired out of the store) |
| `DELETION_CHALLENGE_EXPIRED` | 410 | Challenge past `expiresAt` |
| `DELETION_SIGNATURE_INVALID` | 401 | Signature does not verify against the subject key |
| `DELETION_REQUEST_DUPLICATE` | 409 | A live request already exists for the subject / challenge replayed (existing id in `details`) |
| `DELETION_IDEMPOTENCY_CONFLICT` | 409 | Same idempotency key, different payload |
| `DELETION_INTAKE_DISABLED` | 403 | `privacy.deletion_requests` flag off (expected on mainnet until legal review sign-off) |
| `DELETION_HOLD_ACTIVE` | 409 | At least one category is under a hold (per-category detail included) |
| `DELETION_NOT_CANCELLABLE` | 409 | Cancellation attempted after execution began |
| `DELETION_ALREADY_EXECUTED` | 409 | The request already completed |
| `RETENTION_SWEEP_DISABLED` | 403 | `privacy.retention_sweep` flag off (expected on mainnet until sign-off) |
| `RETENTION_STORE_UNAVAILABLE` | 503 | Registry/store unreachable and the operation cannot be performed safely |
| `RETENTION_POLICY_UNAVAILABLE` | 503 | The schedule itself could not be loaded (fail closed, never delete more than the schedule allows) |

Codes are mirrored in [../../app/backend/docs/ERROR-CODES.md](../../app/backend/docs/ERROR-CODES.md).

---

## 6. Observability

Structured logs (no clear-text subject references, no signatures, no payload bodies):

```json
{"event":"privacy.deletion_request","requestId":"…","subjectHash":"sha256:9f2c…","status":"pending","categories":[{"id":"payment_link_metadata","action":"hard_delete"},{"id":"financial_records","action":"pseudonymize","hold":"legal_obligation"}],"correlationId":"…","outcome":"accepted"}
{"event":"privacy.retention_sweep","runId":"…","mode":"dry_run","due":[{"category":"webhook_deliveries","count":128}],"deleted":{"webhook_deliveries":128},"durationMs":412,"outcome":"ok"}
```

| Metric | Type | Labels | Why |
|---|---|---|---|
| `deletion_requests_total` | counter | `status`, `method` | request volume and where requests stall |
| `deletion_request_duration_seconds` | histogram | `phase` (`proof`, `schedule`, `execute`) | SLA tracking (30-day execution bound) |
| `deletion_proof_failures_total` | counter | `reason` (`expired`, `unknown`, `invalid_signature`) | detects abuse and client bugs without logging signatures |
| `retention_sweep_records_total` | counter | `category`, `method`, `outcome` | proves the schedule is actually running |
| `retention_sweep_duration_seconds` | histogram | `mode` | sweep latency |
| `retention_records_due` | gauge | `category` | backlog alarm: a category that keeps growing is not being swept |

Alerting intent: `retention_records_due` non-zero and non-decreasing for 2 consecutive days pages the privacy owner;
any `deletion_proof_failures_total` spike over baseline is a security signal, not an availability signal.

---

## 7. Configuration and degraded mode

| Key | Type | Default (local/dev) | Default (production/mainnet) | Effect |
|---|---|---|---|---|
| `privacy.deletion_requests` (flag) | bool | `true` | `false` | Enables deletion-request intake (proof + scheduling) |
| `privacy.retention_sweep` (flag) | bool | `true` | `false` | Enables the scheduled sweep / admin sweep endpoint |
| `PRIVACY_DELETION_REQUESTS_ENABLED` (env) | bool | unset | unset | Last-resort intake kill switch (env guard style, `app/backend/flags.js`) |
| `PRIVACY_SUBJECT_HASH_SALT` | secret | dev default | **required** | Salt for subject hashing; must be a secret, never logged. Missing salt ⇒ requests refused (`503 RETENTION_POLICY_UNAVAILABLE`) rather than stored unsalted |
| `PRIVACY_SWEEP_BATCH_SIZE` | int | `500` | `500` | Records handled per category per run (bounds latency and blast radius) |
| `PRIVACY_HOLD_OVERRIDES_JSON` | JSON | unset | unset | Operator-set holds (`{"security_incident_active":["abuse_signals"]}`); only ever *adds* restrictions |

**Degraded mode.** The sweep and request intake fail closed:

- Store unreachable ⇒ `503 RETENTION_STORE_UNAVAILABLE`, request stays `pending` and resumable; **no partial
  deletion is reported as success**.
- Schedule unloadable ⇒ `503 RETENTION_POLICY_UNAVAILABLE`; nothing is deleted based on a guessed window.
- Holds are evaluated **before** any destructive step, so a hold that lands mid-flight stops the remaining work
  (already-deleted records are not restored; the run is marked incomplete and re-planned next run).
- Both flags off ⇒ reads still work (`GET /privacy/retention-policy` is always available) so the published policy
  remains observable even when the machinery is disabled.

---

## 8. Operational procedures

**Run the retention sweep (routine)**

1. Dry run first: `POST /admin/privacy/retention/sweep` with `{"apply": false}` (admin API key). Inspect `due` per
   category — a surprise count means a schedule change or a window that is too long, not a reason to force it.
2. Apply: same call with `{"apply": true}` and an `Idempotency-Key`. Watch `retention_sweep_records_total` and
   `retention_sweep_duration_seconds`.
3. If a run fails halfway, re-run with the same idempotency key: already-deleted records are skipped by id.
4. Record the run id in the privacy log; the sweep is also scheduled automatically when `privacy.retention_sweep`
   is enabled.

**Handle a deletion request manually**

1. Verify the request exists and its proof passed: `GET /privacy/deletion-requests/:id` (the `subjectHash` is
   safe to quote; the raw subject is not).
2. If a category is held, do **not** override the hold — escalate to the privacy owner; holds are released only by
   the owner (recorded in the request trail).
3. If a category is missing from the schedule (new data store), the gate fails; add the category to
   [data/retention-schedule.json](./data/retention-schedule.json) and the mirror, then ship the change. Do not delete
   ad hoc.

**Adding a new data store** (required for any new persistence)

1. Add the category to the JSON schedule with window, window start, method, and PII classification (a new table
   with personal data and no retention window is a gate failure).
2. Add the mirror entry in `retention-schedule.ts`; the unit test asserts equality with the JSON.
3. Add a sweep adapter that deletes by record id and is idempotent.
4. Update §2 of this document and the capability map row if a client-visible surface changed.

---

## 9. References

- [./ASSET-LISTING-POLICY.md](./ASSET-LISTING-POLICY.md) (listing evidence retention, holds)
- [../adr/0001-self-custody-and-no-server-side-key-custody.md](../adr/0001-self-custody-and-no-server-side-key-custody.md), [../adr/0006-contract-registry-rollback-and-etag.md](../adr/0006-contract-registry-rollback-and-etag.md)
- [../GOVERNANCE.md](../GOVERNANCE.md) (owners, review cadence, waivers)
- `app/backend/src/privacy/` (proof, scheduling), `app/backend/src/audit/audit.service.ts` (decision trail), `app/backend/src/analytics` (aggregate-only views), `app/backend/src/support-bundle`, `app/backend/src/crash-reporting`, `app/backend/src/abuse-signals`
- Machine-readable: [data/retention-schedule.json](./data/retention-schedule.json) · Gate: `node scripts/governance/check.mjs --only retention`
