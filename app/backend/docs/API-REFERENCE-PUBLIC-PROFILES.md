# Public Profile Discovery - API Quick Reference

## Base URL
```
http://localhost:3000/username
```

---

## Endpoints

### 1. Search Public Profiles

**GET** `/username/search`

Fuzzy search for public profiles with similarity scoring.

#### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | ✅ Yes | - | Search term (min 2 chars) |
| `limit` | number | ❌ No | 10 | Max results (1-100) |

#### Example Request

```bash
curl "http://localhost:3000/username/search?query=alice&limit=10"
```

#### Example Response

```json
{
  "profiles": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "username": "alice",
      "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
      "similarityScore": 95,
      "lastActiveAt": "2025-03-27T10:30:00Z",
      "createdAt": "2025-02-19T08:00:00Z"
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "username": "alicen",
      "publicKey": "GCXHJ66KNR5M3C7F8T9A0B1C2D3E4F5G6H7I8J9K0LAS",
      "similarityScore": 85,
      "lastActiveAt": "2025-03-26T15:20:00Z",
      "createdAt": "2025-02-20T09:15:00Z"
    }
  ],
  "total": 2
}
```

#### Status Codes

- `200 OK` - Success
- `400 Bad Request` - Invalid query (too short or invalid format)

---

### 2. Get Trending Creators

**GET** `/username/trending`

Get trending creator profiles ranked by transaction volume.

#### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `timeWindowHours` | number | ❌ No | 24 | Time window (1-720 hours) |
| `limit` | number | ❌ No | 10 | Max creators (1-100) |

#### Example Request

```bash
curl "http://localhost:3000/username/trending?timeWindowHours=24&limit=10"
```

#### Example Response

```json
{
  "creators": [
    {
      "id": "770e8400-e29b-41d4-a716-446655440002",
      "username": "toptrader",
      "publicKey": "GDXYZ123ABC456DEF789GHI012JKL345MNO678PQR901STU",
      "transactionVolume": 75000.50,
      "transactionCount": 200,
      "lastActiveAt": "2025-03-27T11:45:00Z",
      "createdAt": "2025-02-19T08:00:00Z"
    },
    {
      "id": "880e8400-e29b-41d4-a716-446655440003",
      "username": "activeuser",
      "publicKey": "GEABC456DEF789GHI012JKL345MNO678PQR901STU234VWX",
      "transactionVolume": 35250.75,
      "transactionCount": 95,
      "lastActiveAt": "2025-03-27T09:30:00Z",
      "createdAt": "2025-02-20T10:00:00Z"
    }
  ],
  "timeWindowHours": 24,
  "calculatedAt": "2025-03-27T12:00:00Z"
}
```

#### Status Codes

- `200 OK` - Success
- `400 Bad Request` - Invalid time window parameter

---

### 3. Toggle Public Profile Visibility

**POST** `/username/toggle-public`

Enable or disable public profile visibility.

#### Request Body

```json
{
  "username": "alice",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "isPublic": true
}
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `username` | string | ✅ Yes | Username to toggle |
| `publicKey` | string | ✅ Yes | Owner's Stellar public key |
| `isPublic` | boolean | ✅ Yes | Visibility state |

#### Example Request

```bash
curl -X POST "http://localhost:3000/username/toggle-public" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
    "isPublic": true
  }'
```

#### Example Response (Success)

```json
{
  "ok": true
}
```

#### Status Codes

- `200 OK` - Successfully toggled
- `400 Bad Request` - Invalid username format
- `404 Not Found` - Username not found or wrong ownership
- `500 Internal Server Error` - Server error

---

### 4. Rename Username (with redirect preservation)

**POST** `/username/rename`

Rename a username while preserving existing payment links. The previous
username is retained as a permanent redirect alias so that any payment link
or QR code that already references the old username continues to resolve to
the same Stellar public key. Self-custody is preserved: the rename only
affects the username-to-publicKey mapping, never the key itself.

#### Request Body

```json
{
  "currentUsername": "alice",
  "newUsername": "alice-co",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "idempotencyKey": "3f9c1e2a-7b4d-4c8e-9f01-2a3b4c5d6e7f"
}
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `currentUsername` | string | ✅ Yes | Username being renamed (normalized, lowercase) |
| `newUsername` | string | ✅ Yes | Desired new username (normalized, lowercase) |
| `publicKey` | string | ✅ Yes | Owner's Stellar public key (must match current owner) |
| `idempotencyKey` | string (UUID) | ✅ Yes | Client-generated key; replays return the original result |

#### Example Request

```bash
curl -X POST "http://localhost:3000/username/rename" \
  -H "Content-Type: application/json" \
  -d '{
    "currentUsername": "alice",
    "newUsername": "alice-co",
    "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
    "idempotencyKey": "3f9c1e2a-7b4d-4c8e-9f01-2a3b4c5d6e7f"
  }'
```

#### Example Response (Success)

```json
{
  "ok": true,
  "username": "alice-co",
  "redirectFrom": "alice",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "renamedAt": "2025-03-27T12:05:00Z"
}
```

#### Status Codes

- `200 OK` - Rename applied (or idempotent replay of a prior success)
- `400 Bad Request` - Malformed username or missing idempotency key
- `401 Unauthorized` - Missing or invalid signature over the rename payload
- `403 Forbidden` - `publicKey` does not own `currentUsername`
- `404 Not Found` - `currentUsername` does not exist
- `409 Conflict` - `newUsername` already taken, or `currentUsername` is a reserved redirect alias
- `410 Gone` - Redirect alias expired (only when a non-permanent alias policy is configured)
- `503 Service Unavailable` - Dependency (DB/registry) unavailable; safe to retry with the same idempotency key

#### Redirect Semantics

- The old username becomes a **permanent redirect alias** to the new username.
- Payment links, QR codes, and share URLs that embed the old username keep
  resolving to the same `publicKey`; no funds are ever routed to a new key.
- Redirects are resolved server-side before any payment intent is created, so
  the financial invariant "username → publicKey is stable for the lifetime of
  a payment link" is preserved.
- A username that is currently a redirect alias cannot be re-registered by a
  different wallet (`409 Conflict`).

#### Idempotency & Rollback

- Every rename requires an `idempotencyKey`. Replaying the same key returns
  the original `200 OK` response without re-applying the change.
- Renames are applied atomically: the new mapping and the redirect alias are
  written in a single transaction. On dependency failure the transaction is
  rolled back and the old username remains fully active.
- If the new username write succeeds but the alias write fails, the whole
  transaction is rolled back — there is never a window where the old link
  stops resolving.

#### Observability

- Structured log fields: `event=username.rename`, `currentUsername`,
  `newUsername`, `publicKey` (hashed), `idempotencyKey`, `outcome`,
  `latencyMs`. No secrets or raw keys are logged.
- Metrics: `username_rename_total{outcome}`, `username_rename_latency_ms`,
  `username_redirect_resolve_total{hit|miss}`.

---

### 5. Report a Public Profile (Abuse Reporting)

**POST** `/username/report`

Submit an abuse report against a public profile. Reports are accepted only
from authenticated reporters and are recorded for moderator review. Reporting
never mutates the target profile or its `username → publicKey` mapping, so
self-custody and the financial invariants are preserved.

#### Request Body

```json
{
  "username": "alice",
  "category": "impersonation",
  "details": "Profile is impersonating a known creator.",
  "idempotencyKey": "9b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e"
}
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `username` | string | ✅ Yes | Reported profile username (normalized, lowercase) |
| `category` | string | ✅ Yes | One of `impersonation`, `spam`, `fraud`, `harassment`, `other` |
| `details` | string | ❌ No | Free-text context (max 2000 chars) |
| `idempotencyKey` | string (UUID) | ✅ Yes | Client-generated key; replays return the original result |

#### Example Request

```bash
curl -X POST "http://localhost:3000/username/report" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <reporter-token>" \
  -d '{
    "username": "alice",
    "category": "impersonation",
    "details": "Profile is impersonating a known creator.",
    "idempotencyKey": "9b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e"
  }'
```

#### Example Response (Success)

```json
{
  "ok": true,
  "reportId": "c1a2b3d4-e5f6-7890-abcd-ef1234567890",
  "status": "received",
  "reportedAt": "2025-03-27T12:10:00Z"
}
```

#### Status Codes

- `200 OK` - Report recorded (or idempotent replay of a prior submission)
- `400 Bad Request` - Malformed username, unknown category, or missing idempotency key
- `401 Unauthorized` - Missing or invalid reporter authentication
- `404 Not Found` - Reported username does not exist
- `409 Conflict` - Duplicate report for the same `(reporter, username, category)` within the dedupe window
- `429 Too Many Requests` - Reporter exceeded the abuse-report rate limit
- `503 Service Unavailable` - Dependency (DB/moderation queue) unavailable; safe to retry with the same idempotency key

#### Idempotency & Rollback

- Every report requires an `idempotencyKey`. Replaying the same key returns
  the original `200 OK` response without creating a second report.
- Reports are append-only and never mutate the target profile, so there is no
  rollback path that could affect the `username → publicKey` mapping.
- On dependency failure the report is not persisted and the caller may safely
  retry with the same idempotency key.

#### Observability

- Structured log fields: `event=username.report`, `username`, `category`,
  `reporterId` (hashed), `idempotencyKey`, `outcome`, `latencyMs`. No secrets
  or raw reporter identifiers are logged.
- Metrics: `username_report_total{outcome}`, `username_report_latency_ms`,
  `username_report_dedupe_total{hit|miss}`.

---

### 6. Get Verified Profile Metadata

**GET** `/username/:username/metadata`

Return the verified profile metadata for a public profile. Metadata is
attached to the `username → publicKey` mapping and is served from a cache
that is invalidated on every write. Self-custody is preserved: metadata is
advisory display data and never influences payment routing.

#### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `username` | string | ✅ Yes | - | Profile username (normalized, lowercase) |

#### Example Request

```bash
curl "http://localhost:3000/username/alice/metadata"
```

#### Example Response

```json
{
  "username": "alice",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "verified": true,
  "verifiedAt": "2025-03-20T09:00:00Z",
  "displayName": "Alice",
  "avatarUrl": "https://cdn.quickex.example/avatars/alice.png",
  "bio": "Stellar payments educator.",
  "links": [
    { "label": "website", "url": "https://alice.example" }
  ],
  "version": 4,
  "updatedAt": "2025-03-27T12:00:00Z"
}
```

#### Status Codes

- `200 OK` - Metadata returned (cache hit or miss)
- `400 Bad Request` - Malformed username
- `404 Not Found` - Username does not exist
- `503 Service Unavailable` - Metadata store unavailable and no cached copy is servable

#### Cache Semantics

- Metadata reads are served from a per-username cache keyed by
  `profile:metadata:<username>`.
- Every successful metadata write bumps `version` and invalidates the cache
  entry for that username before returning, so a subsequent read observes the
  new value (read-after-write consistency).
- Cache entries carry a short TTL as a safety net; a stale entry is never
  served after a successful write because invalidation is synchronous.
- On cache-store failure the read falls back to the source of truth; the
  response is still correct, only slower.

---

### 7. Update Verified Profile Metadata

**PUT** `/username/:username/metadata`

Create or replace the verified profile metadata for a username. Only the
wallet that owns the `username → publicKey` mapping may write metadata.
Writes are idempotent, validated, and invalidate the metadata cache.

#### Request Body

```json
{
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "displayName": "Alice",
  "avatarUrl": "https://cdn.quickex.example/avatars/alice.png",
  "bio": "Stellar payments educator.",
  "links": [
    { "label": "website", "url": "https://alice.example" }
  ],
  "expectedVersion": 3,
  "idempotencyKey": "7d2e3f4a-5b6c-7d8e-9f0a-1b2c3d4e5f60"
}
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `publicKey` | string | ✅ Yes | Owner's Stellar public key (must match current owner) |
| `displayName` | string | ❌ No | Display name (max 64 chars) |
| `avatarUrl` | string | ❌ No | HTTPS URL to avatar image |
| `bio` | string | ❌ No | Short bio (max 280 chars) |
| `links` | array | ❌ No | Up to 5 `{ label, url }` entries; URLs must be HTTPS |
| `expectedVersion` | number | ❌ No | Optimistic-concurrency guard; `409` if it does not match current `version` |
| `idempotencyKey` | string (UUID) | ✅ Yes | Client-generated key; replays return the original result |

#### Example Request

```bash
curl -X PUT "http://localhost:3000/username/alice/metadata" \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
    "displayName": "Alice",
    "avatarUrl": "https://cdn.quickex.example/avatars/alice.png",
    "bio": "Stellar payments educator.",
    "links": [{ "label": "website", "url": "https://alice.example" }],
    "expectedVersion": 3,
    "idempotencyKey": "7d2e3f4a-5b6c-7d8e-9f0a-1b2c3d4e5f60"
  }'
```

#### Example Response (Success)

```json
{
  "ok": true,
  "username": "alice",
  "version": 4,
  "updatedAt": "2025-03-27T12:00:00Z",
  "cacheInvalidated": true
}
```

#### Status Codes

- `200 OK` - Metadata written (or idempotent replay of a prior success)
- `400 Bad Request` - Malformed username, invalid field, or missing idempotency key
- `401 Unauthorized` - Missing or invalid signature over the metadata payload
- `403 Forbidden` - `publicKey` does not own `username`
- `404 Not Found` - `username` does not exist
- `409 Conflict` - `expectedVersion` mismatch (concurrent write)
- `413 Payload Too Large` - Metadata exceeds size limits
- `503 Service Unavailable` - Dependency (DB/cache) unavailable; safe to retry with the same idempotency key

#### Authorization

- The caller must prove ownership of `publicKey` by signing the canonical
  metadata payload. The signature is verified server-side before any write.
- Metadata writes never change the `username → publicKey` mapping, so
  self-custody and the financial invariants are preserved.

#### Idempotency & Rollback

- Every write requires an `idempotencyKey`. Replaying the same key returns
  the original `200 OK` response without re-applying the change.
- The metadata row and its `version` bump are written in a single
  transaction. On dependency failure the transaction is rolled back and the
  previous metadata remains active.
- Cache invalidation runs after the transaction commits. If invalidation
  fails, the write still succeeds and the cache entry is left to expire via
  its TTL; the response reports `cacheInvalidated: false` so callers can
  observe the degraded mode.

#### Observability

- Structured log fields: `event=username.metadata.write`, `username`,
  `publicKey` (hashed), `version`, `idempotencyKey`, `outcome`,
  `cacheInvalidated`, `latencyMs`. No secrets or raw keys are logged.
- Metrics: `username_metadata_write_total{outcome}`,
  `username_metadata_write_latency_ms`,
  `username_metadata_cache_invalidation_total{hit|miss|error}`.

---

### 8. Feature Gate

Verified profile metadata is gated behind the `PROFILE_METADATA_ENABLED`
configuration flag. When the flag is off (the default on mainnet until the
rollout issue is closed), the metadata endpoints return `404 Not Found` and
no metadata is read or written. Testnet enables the flag by default.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROFILE_METADATA_ENABLED` | `false` (mainnet), `true` (testnet) | Feature gate for verified profile metadata |
| `PROFILE_METADATA_CACHE_TTL_SECONDS` | `300` | Safety-net TTL for metadata cache entries |
| `PROFILE_METADATA_MAX_LINKS` | `5` | Maximum number of links per profile |

---

## Operational Procedure

1. Enable `PROFILE_METADATA_ENABLED` on testnet and verify the happy path
   with the `PUT`/`GET` examples above.
2. Confirm cache invalidation by writing metadata and immediately reading it
   back; the read must reflect the new `version`.
3. Roll out to mainnet by flipping the flag; no migration is required because
   metadata is stored alongside the existing username mapping.
4. To roll back, disable the flag; metadata endpoints return `404` and the
   existing `username → publicKey` mapping is unaffected.
