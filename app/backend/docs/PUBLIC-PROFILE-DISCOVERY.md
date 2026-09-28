# Public Profile Discovery Feature - Implementation Summary

## Overview
This document summarizes the implementation of the public profile discovery feature for QuickEx, enabling users to find public profiles via fuzzy search and discover trending creators based on transaction volume.

## Features Implemented

### 1. Fuzzy Search for Public Usernames
**Endpoint:** `GET /username/search`

Allows users to search for public profiles using fuzzy matching with similarity scoring.

**Query Parameters:**
- `query` (required): Search term (minimum 2 characters)
- `limit` (optional): Maximum results (default: 10, range: 1-100)

**Response:**
```json
{
  "profiles": [
    {
      "id": "uuid",
      "username": "alice",
      "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
      "similarityScore": 95,
      "lastActiveAt": "2025-03-27T10:00:00Z",
      "createdAt": "2025-02-19T08:00:00Z"
    }
  ],
  "total": 1
}
```

**Search Algorithm:**
- **Primary:** PostgreSQL `pg_trgm` extension with `word_similarity()` for advanced trigram-based fuzzy matching
- **Fallback:** Pattern matching with intelligent similarity scoring when pg_trgm is unavailable
- Results sorted by similarity score (0-100) and activity timestamp

### 2. Trending Creators
**Endpoint:** `GET /username/trending`

Returns creator profiles ranked by recent transaction volume.

**Query Parameters:**
- `timeWindowHours` (optional): Time window in hours (default: 24, range: 1-720)
- `limit` (optional): Maximum creators (default: 10, range: 1-100)

**Response:**
```json
{
  "creators": [
    {
      "id": "uuid",
      "username": "toptrader",
      "publicKey": "GDXYZ...",
      "transactionVolume": 75000,
      "transactionCount": 200,
      "lastActiveAt": "2025-03-27T10:00:00Z",
      "createdAt": "2025-02-19T08:00:00Z"
    }
  ],
  "timeWindowHours": 24,
  "calculatedAt": "2025-03-27T12:00:00Z"
}
```

**Ranking Algorithm:**
- Aggregates payment records from `payment_records` table
- Counts both sender and receiver activity
- Sorted by total USD volume in the time window
- Only includes profiles with "Public Profile" enabled

### 3. Toggle Public Profile Visibility
**Endpoint:** `POST /username/toggle-public`

Allows users to enable/disable their profile's visibility in public search and trending.

**Request Body:**
```json
{
  "username": "alice",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "isPublic": true
}
```

**Response:**
```json
{
  "ok": true
}
```

**Security:**
- Only the wallet owner can toggle their profile visibility
- Ownership verification required before toggling

### 4. Username Rename Redirects

Renaming a username must never break existing payment links. Payment links are
resolved by username, so a rename has to leave a durable redirect from the old
username to the current one instead of silently 404-ing.

**Endpoint:** `POST /username/rename`

**Request Body:**
```json
{
  "currentUsername": "alice",
  "newUsername": "alice-pro",
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR"
}
```

**Response:**
```json
{
  "ok": true,
  "username": "alice-pro",
  "redirectFrom": "alice"
}
```

**Redirect resolution:** `GET /username/resolve/:username` returns the canonical
profile for a username, following at most one rename hop. Old links keep working
because the resolver maps the historical username to the current owner.

**Authorization:** Only the wallet that owns `currentUsername` may rename it;
ownership is verified against `publicKey` before any write.

**Validation:**
- `newUsername` must satisfy the same normalization/uniqueness rules as
  registration (lowercase, allowed charset, length bounds).
- `newUsername` must not already be taken by another wallet.
- `newUsername` must not collide with a reserved or previously-used username
  that is still an active redirect target.

**Idempotency:** Renames are keyed by `(publicKey, currentUsername, newUsername)`.
Replaying the same request returns the original result without creating a second
redirect or mutating state again.

**Rollback:** The rename and the redirect insert happen in a single transaction.
If the redirect cannot be written, the rename is rolled back so the old username
remains valid and no payment link is orphaned.

**Stable errors:**
- `400` malformed or invalid `newUsername`
- `401` missing/invalid ownership proof
- `403` `publicKey` does not own `currentUsername`
- `404` `currentUsername` not found
- `409` `newUsername` already taken or reserved
- `503` dependency failure (database unavailable) — safe to retry

**Observability:** Structured logs record `publicKey` (hashed), old and new
username, outcome, and latency. Metrics track rename success/failure counts,
redirect resolution hits/misses, and rename latency. No secrets or raw personal
data are logged.

**Feature gating:** Rename redirects are gated behind the
`USERNAME_RENAME_REDIRECTS` flag and are disabled on mainnet until the redirect
backfill migration has been verified on testnet.

### 5. Verified Profile Metadata with Cache Invalidation

Public profiles can carry **verified metadata** (display name, avatar URL, bio,
and social links) that is attested by the wallet owner. Verified metadata is
served from a read-through cache so discovery endpoints stay fast, and every
write invalidates the affected cache entries so stale metadata is never served.

**Endpoint:** `PUT /username/:username/metadata`

**Request Body:**
```json
{
  "publicKey": "GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR",
  "displayName": "Alice",
  "avatarUrl": "https://cdn.quickex.example/avatars/alice.png",
  "bio": "Payments for indie makers",
  "links": ["https://alice.example", "https://x.com/alice"],
  "signature": "base64-ed25519-signature",
  "issuedAt": "2025-03-27T12:00:00Z",
  "expiresAt": "2025-03-27T12:05:00Z"
}
```

**Response:**
```json
{
  "ok": true,
  "username": "alice",
  "metadataVersion": 7,
  "verifiedAt": "2025-03-27T12:00:01Z"
}
```

**Verification (self-custody):** The wallet owner signs a canonical payload
(`username`, `metadataVersion`, `issuedAt`, `expiresAt`, and a hash of the
metadata fields) with their Stellar keypair. The backend verifies the signature
against the profile's `publicKey`; it never holds or derives private keys. A
metadata write is only accepted when the signature is valid and the payload has
not expired.

**Authorization:**
- `401` missing or malformed `signature`/`issuedAt`/`expiresAt`
- `403` signature does not verify against the profile's `publicKey`
- `404` `username` not found

**Validation:**
- `displayName` length 1-64, `bio` length 0-280, `avatarUrl` must be `https`
- `links` at most 5 entries, each an `https` URL
- `expiresAt` must be after `issuedAt` and within a 10-minute window
- `metadataVersion` must be strictly greater than the stored version

**Idempotency:** Writes are keyed by `(publicKey, username, metadataVersion)`.
Replaying the same version returns the original result without re-writing or
re-invalidating the cache. A lower or equal version is rejected with `409`.

**Cache invalidation:** Metadata is cached under `profile:meta:{username}` and
`profile:meta:{publicKey}`. On a successful write the service invalidates both
keys (and the discovery list keys `profile:search:*` / `profile:trending:*`)
inside the same transaction boundary, then repopulates lazily on the next read.
If invalidation fails the write is rolled back so the cache can never diverge
from the database.

**Degraded mode:** If the cache backend is unavailable, reads fall through to
the database and writes proceed with a logged `cache_degraded` warning; the
response includes `"cacheDegraded": true` so clients can retry later. Metadata
writes are never blocked by cache availability.

**Stable errors:**
- `400` malformed body or invalid metadata fields
- `401` missing/invalid signature envelope
- `403` signature does not match `publicKey`
- `404` `username` not found
- `409` stale `metadataVersion` (duplicate or out-of-order write)
- `410` expired signature envelope
- `503` dependency failure (database unavailable) — safe to retry

**Observability:** Structured logs record `publicKey` (hashed), `username`,
`metadataVersion`, outcome, and latency. Metrics track metadata write
success/failure counts, cache invalidation hits/misses, verification latency,
and degraded-mode activations. No secrets or raw personal data are logged.

**Feature gating:** Verified metadata is gated behind the
`VERIFIED_PROFILE_METADATA` flag and is disabled on mainnet until the metadata
migration and cache invalidation path have been verified on testnet.

## Database Changes

### Migration 1: `20250327000000_add_username_visibility.sql`
Added columns to `usernames` table:
- `is_public` (BOOLEAN): Controls profile visibility (defaults to false)
- `last_active_at` (TIMESTAMPTZ): Tracks user activity for trending

**Indexes Created:**
- `usernames_is_public_idx`: Partial index for fast public profile filtering
- `usernames_last_active_at_idx`: Activity-based sorting
- `usernames_public_active_idx`: Composite index for public profiles by activity

### Migration 2: `20250327000001_add_fuzzy_search_function.sql`
PostgreSQL function for optimized fuzzy search:
- Enables `pg_trgm` extension
- Creates `search_usernames(query, limit)` function
- GIN index on trigram ops for performance
- Returns results with similarity scores (0-100)

### Migration 3: `20250327000002_add_username_rename_redirects.sql`
Adds durable redirects for renamed usernames:
- `username_redirects` table: `old_username` (PK), `current_username`,
  `public_key`, `created_at`
- Unique index on `old_username` to guarantee a single canonical target
- Foreign key from `current_username` to `usernames.username`
- Backfill is a no-op for existing rows; redirects are created only on rename

### Migration 4: `20250327000003_add_verified_profile_metadata.sql`
Adds verified metadata storage for public profiles:
- `profile_metadata` table: `username` (PK, FK to `usernames.username`),
  `public_key`, `display_name`, `avatar_url`, `bio`, `links` (JSONB),
  `metadata_version` (BIGINT), `verified_at`, `updated_at`
- Unique index on `(public_key, metadata_version)` to enforce idempotent writes
- `metadata_version` starts at 1 and increments on each accepted write
- Backfill is a no-op; rows are created only on the first verified write

## Architecture

### DTOs Created
Located in `src/dto/username/`:
- `SearchUsernamesQueryDto`: Search query validation
- `SearchUsernamesResponseDto`: Search response structure
- `PublicProfileDto`: Common profile representation
- `TrendingCreatorsQueryDto`: Trending query parameters
- `TrendingCreatorsResponseDto`: Trending response structure
- `RenameUsernameDto`: Rename request validation
- `RenameUsernameResponseDto`: Rename response structure
- `UpdateProfileMetadataDto`: Verified metadata write validation
- `UpdateProfileMetadataResponseDto`: Verified metadata write response

### Service Layer Updates

#### `UsernamesService`
New methods:
- `searchPublicUsernames(query, limit)`: Fuzzy search with validation
- `getTrendingCreators(timeWindowHours, limit)`: Trending calculation
- `togglePublicProfile(username, publicKey, isPublic)`: Visibility control
- `renameUsername(currentUsername, newUsername, publicKey)`: Transactional rename
  with redirect creation and idempotency
- `resolveUsername(username)`: Follows at most one rename hop to the canonical profile
- `updateVerifiedMetadata(username, dto)`: Verifies the owner signature, enforces
  monotonic `metadataVersion`, writes metadata, and invalidates cache entries
- `getVerifiedMetadata(username)`: Read-through cache lookup with database fallback

#### `SupabaseService`
New methods:
- `searchPublicUsernames(query, limit)`: Database search with fallback
- `getTrendingCreators(timeWindowHours, limit)`: Volume aggregation
- `updateUsernameActivity(username)`: Activity timestamp update
- `togglePublicProfile(username, isPublic)`: Visibility toggle
- `renameUsernameWithRedirect(...)`: Atomic rename + redirect insert
- `resolveUsernameRedirect(username)`: Redirect lookup
- `upsertProfileMetadata(...)`: Atomic metadata write with version guard
- `getProfileMetadata(username)`: Metadata read for cache population

### Controller Updates
`UsernamesController` now exposes:
- `GET /username/search`: Public profile search
- `GET /username/trending`: Trending creators
- `POST /username/toggle-public`: Visibility toggle
- `POST /username/rename`: Rename with redirect
- `GET /username/resolve/:username`: Canonical resolution for payment links
- `PUT /username/:username/metadata`: Verified metadata write with cache invalidation
- `GET /username/:username/metadata`: Verified metadata read (cache-backed)

All endpoints include:
- Swagger/OpenAPI documentation
- Input validation
- Stable error codes for unauthorized, duplicate, expired, malformed, and
  dependency-failure cases
- Structured logging and metrics without secrets or raw personal data
