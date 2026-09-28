# Horizon Usage Guidelines

This document outlines how to fetch Stellar transaction data via Horizon in the QuickEx backend.

## Overview

The `HorizonService` provides a centralized way to interact with the Stellar Horizon API. It uses the `stellar-sdk` and implements in-memory caching to reduce latency and avoid rate limits.

## Fetching Payments

To get reliable amount and asset data, we fetch **operations** of type `payment`, `path_payment_strict_receive`, and `path_payment_strict_send` rather than raw transactions.

### Endpoint

`GET /transactions`

### Query Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `accountId` | string | Yes | Stellar public key (G...) |
| `asset` | string | No | Filter by asset (`XLM` or `CODE:ISSUER`) |
| `limit` | number | No | Max items to return (1-200, default 20) |
| `cursor` | string | No | Pagination token (`paging_token`) |

## Caching

Results are cached for **60 seconds** in memory using an LRU cache. The cache key includes the network, account ID, asset filter, limit, and cursor.

## Rate Limiting

If Horizon returns a `429 Too Many Requests` error, the backend will return a `503 Service Unavailable` response. Clients should implement their own backoff strategy and avoid aggressive polling.

## Transaction Simulation Hardening (Issue #214)

Transaction simulation must be validated against the **active network** and the **expected asset registry** before any result is trusted. Mismatches are rejected with stable error codes so callers can branch deterministically.

### Network matching

- The requested network (e.g. `PUBLIC`, `TESTNET`, `FUTURENET`) MUST equal the configured/active network for the running deployment.
- A mismatch returns `SIM_NETWORK_MISMATCH` and the simulation is not executed.
- Mainnet-only behavior is feature-gated: when the active network is not `PUBLIC`, mainnet-gated simulation paths return `SIM_FEATURE_GATED` instead of silently degrading.

### Asset matching

- Asset identifiers are compared against the expected asset registry using the canonical form:
  - Native: `XLM`
  - Issued: `CODE:ISSUER` (issuer validated with `StrKey.isValidEd25519PublicKey`)
  - Contract/SAC: `C...` contract address
- A mismatch (wrong issuer, wrong code, wrong SAC address, or unknown asset) returns `SIM_ASSET_MISMATCH`.
- Malformed asset identifiers return `SIM_ASSET_MALFORMED`.

### Stable error codes

| Code | Meaning |
| :--- | :--- |
| `SIM_NETWORK_MISMATCH` | Requested network does not match the active network. |
| `SIM_ASSET_MISMATCH` | Asset does not match the expected registry entry. |
| `SIM_ASSET_MALFORMED` | Asset identifier is malformed or unparseable. |
| `SIM_UNAUTHORIZED` | Caller is not authorized to simulate for the requested account. |
| `SIM_DUPLICATE` | Duplicate simulation request (idempotency key already seen). |
| `SIM_EXPIRED` | Simulation request or referenced ledger window has expired. |
| `SIM_DEPENDENCY_FAILURE` | Horizon or another upstream dependency failed. |
| `SIM_FEATURE_GATED` | Requested behavior is not enabled on the active network. |

### Idempotency, expiry, and degraded mode

- Simulation requests carry an idempotency key; replays return the original result or `SIM_DUPLICATE`.
- Requests older than the configured simulation TTL return `SIM_EXPIRED`.
- When Horizon is unavailable, simulation returns `SIM_DEPENDENCY_FAILURE` (mapped from upstream `503`) rather than a partial result.

### Observability

- Structured logs record `network`, `asset`, `errorCode`, and `latencyMs` for each simulation.
- Metrics track success rate, latency, and failure counts by `errorCode`.
- Logs MUST NOT include secrets, private keys, or unnecessary personal data.

## Horizon Circuit Breaker and Bounded Stale Cache (Issue #216)

Horizon is a hard dependency for reads and simulation. To keep QuickEx available during Horizon degradation without serving unbounded or stale financial data, the backend wraps every Horizon call in a **circuit breaker** and a **bounded stale-cache** layer.

### Circuit breaker states

| State | Behavior |
| :--- | :--- |
| `CLOSED` | Normal operation. Requests pass through to Horizon. |
| `OPEN` | Horizon is failing. Requests short-circuit immediately with `SIM_DEPENDENCY_FAILURE` (or the read equivalent) and do not hit the network. |
| `HALF_OPEN` | A single probe request is allowed through to test recovery. Success closes the breaker; failure re-opens it. |

- The breaker opens after `HORIZON_CB_FAILURE_THRESHOLD` consecutive dependency failures (default `5`).
- It stays `OPEN` for `HORIZON_CB_COOLDOWN_MS` (default `30000`) before transitioning to `HALF_OPEN`.
- In `HALF_OPEN`, only `HORIZON_CB_HALF_OPEN_PROBES` (default `1`) concurrent probe is permitted; other callers receive the degraded response.
- A successful probe resets the failure counter and returns the breaker to `CLOSED`.
- Only dependency failures (timeouts, `5xx`, connection errors, `429`) count toward opening the breaker. Client errors (`4xx` other than `429`) do not.

### Bounded retries

- Retries are bounded: at most `HORIZON_MAX_RETRIES` (default `2`) attempts per call, with exponential backoff and jitter.
- Retries are only attempted while the breaker is `CLOSED` or during a `HALF_OPEN` probe.
- Once the breaker is `OPEN`, no retries are attempted; the call fails fast with a stable error.

### Bounded stale cache

- Successful Horizon responses are cached with a **fresh TTL** (`HORIZON_CACHE_TTL_MS`, default `60000`).
- During a Horizon outage, a cached entry may be served as **stale** only within a bounded staleness window (`HORIZON_STALE_MAX_AGE_MS`, default `300000`).
- Stale responses are marked (`stale: true`) and logged with `staleAgeMs` so callers and operators can distinguish them from fresh data.
- Once an entry exceeds the staleness window, it is evicted and the call fails with `SIM_DEPENDENCY_FAILURE` (reads return the equivalent dependency error). No unbounded stale data is ever served.
- Stale-cache serving is **feature-gated**: it is enabled only when `HORIZON_STALE_CACHE_ENABLED` is set and the active network is not `PUBLIC`. On mainnet, stale serving is disabled and outages fail fast with `SIM_DEPENDENCY_FAILURE`.

### Recovery

- When Horizon recovers, the `HALF_OPEN` probe succeeds, the breaker closes, and normal fresh caching resumes.
- Recovery is observable via the `horizon_circuit_breaker_state` gauge and `horizon_circuit_breaker_transitions_total` counter.

### Stable errors

| Code | Meaning |
| :--- | :--- |
| `SIM_DEPENDENCY_FAILURE` | Horizon failed and no bounded stale entry was available. |
| `SIM_FEATURE_GATED` | Stale-cache serving requested on a network where it is disabled (e.g. mainnet). |

### Observability

- Structured logs record `network`, `errorCode`, `breakerState`, `stale`, `staleAgeMs`, `attempt`, and `latencyMs` for each Horizon call.
- Metrics: `horizon_requests_total{outcome}`, `horizon_request_latency_ms`, `horizon_circuit_breaker_state`, `horizon_circuit_breaker_transitions_total`, and `horizon_stale_served_total`.
- Logs MUST NOT include secrets, private keys, or unnecessary personal data.

### Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HORIZON_CB_FAILURE_THRESHOLD` | `5` | Consecutive dependency failures before opening the breaker. |
| `HORIZON_CB_COOLDOWN_MS` | `30000` | Time the breaker stays `OPEN` before probing. |
| `HORIZON_CB_HALF_OPEN_PROBES` | `1` | Concurrent probes allowed in `HALF_OPEN`. |
| `HORIZON_MAX_RETRIES` | `2` | Bounded retry attempts per call. |
| `HORIZON_CACHE_TTL_MS` | `60000` | Fresh cache TTL. |
| `HORIZON_STALE_MAX_AGE_MS` | `300000` | Maximum bounded staleness window. |
| `HORIZON_STALE_CACHE_ENABLED` | `false` | Feature gate for stale serving (non-mainnet only). |

### Operational procedure

1. On `horizon_circuit_breaker_state` transitioning to `OPEN`, check Horizon status and the `horizon_requests_total{outcome="failure"}` rate.
2. If the outage is expected to exceed `HORIZON_STALE_MAX_AGE_MS`, expect `SIM_DEPENDENCY_FAILURE` responses and surface a degraded-mode banner to clients.
3. After Horizon recovers, confirm the breaker returns to `CLOSED` and `horizon_stale_served_total` stops increasing.
4. Do not raise `HORIZON_STALE_MAX_AGE_MS` on mainnet; stale serving remains disabled there by design.

## Example Usage

```typescript
// In a controller or service
const transactions = await this.horizonService.getPayments(
  'GD...',
  'USDC:GA...',
  20,
  '123456789'
);
```

## Best Practices

1.  **Always use the operations endpoint** for payment data.
2.  **Use pagination** instead of high limits to avoid long response times.
3.  **Validate account IDs** using `StrKey.isValidEd25519PublicKey`.
4.  **Validate network and asset identifiers** before trusting any simulation result (see above).
5.  **Treat stale responses as degraded**: honor the `stale` flag and never persist stale data as authoritative.
