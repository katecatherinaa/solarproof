# API Reference

Base URL: `https://solarproof.vercel.app` (production) · `http://localhost:3000` (local)

All responses are JSON. Timestamps are ISO 8601 strings unless noted.

---

## Authentication

Endpoints that accept meter readings require an **Ed25519 signature** produced by the registered meter device. The signature is passed in the request body as `signature_hex` — there are no HTTP-level API keys or bearer tokens for this endpoint.

The `GET /api/verify` and `GET /api/health` endpoints are **public** and require no authentication.

---

## CSRF Protection

All browser-facing state-mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) require a valid CSRF token using the **double-submit cookie pattern**.

### How to obtain a token

```http
GET /api/csrf
```

**Response**

```json
{ "csrf_token": "<nonce>.<hmac>.<timestamp>" }
```

The server also sets an `HttpOnly: false` cookie named `csrf_token` so the browser can read it.

### How to use the token

Include the token value in the `x-csrf-token` request header on every state-mutating request:

```http
POST /api/v1/certificates/retire
Content-Type: application/json
x-csrf-token: <token>
Cookie: csrf_token=<token>

{ "id": "cert-uuid" }
```

### Error response

A missing, mismatched, or expired token returns **HTTP 403**:

```json
{ "error": "CSRF token missing" }
```

Possible `error` values:
- `"CSRF token missing"` — header or cookie absent
- `"CSRF token mismatch"` — header value differs from cookie
- `"CSRF token invalid or expired"` — HMAC validation failed or token older than 1 hour

### Exempt routes

The following routes are **exempt** from CSRF validation (they use independent authentication mechanisms):

| Route | Reason |
|---|---|
| `POST /api/readings` | Ed25519 meter signature + API key |
| `POST /api/v1/readings` | Ed25519 meter signature + API key |
| `POST /api/webhooks/**` | HMAC webhook secret |
| `GET /api/csrf` | Token issuance endpoint itself |

---

## Endpoints

### POST /api/readings

Submit a signed meter reading. The server verifies the Ed25519 signature, anchors the reading hash on Stellar, and mints energy certificates.

**Request body**

| Field | Type | Description |
|---|---|---|
| `meter_id` | `string` (UUID) | Registered meter identifier |
| `kwh` | `number` | Energy generated (positive, kWh) |
| `timestamp` | `number` | Unix timestamp in seconds (integer) |
| `signature_hex` | `string` (128 hex chars) | Ed25519 signature of the canonical reading hash, hex-encoded (64 bytes) |

**Canonical reading hash**

The signature must cover the hash produced by `computeReadingHash(meter_id, kwhStroops, BigInt(timestamp))` where `kwhStroops = kwh × 10_000_000`. See [`apps/web/src/lib/crypto.ts`](../apps/web/src/lib/crypto.ts) and [`scripts/send-reading.mjs`](../scripts/send-reading.mjs) for the reference implementation.

**Example request**

```http
POST /api/readings
Content-Type: application/json

{
  "meter_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "kwh": 12.5,
  "timestamp": 1745366400,
  "signature_hex": "4b3e...f09a"
}
```

**Responses**

| Status | Meaning | Body |
|---|---|---|
| `201 Created` | Reading accepted, anchored, and certificates minted | `{ reading_id, anchor_tx_hash, mint_tx_hash }` |
| `400 Bad Request` | Validation failed | `{ error: { fieldErrors, formErrors } }` |
| `401 Unauthorized` | Ed25519 signature invalid | `{ error: "Invalid meter signature" }` |
| `404 Not Found` | `meter_id` not registered or inactive | `{ error: "Meter not found or inactive" }` |
| `429 Too Many Requests` | Rate limit exceeded (10 req/60s per IP, 60 req/60s per meter key) | `{ error: "Rate limit exceeded" }` |
| `500 Internal Server Error` | Anchor or mint failed | `{ error: string, reading_id: string, anchor_tx_hash?: string }` |

**201 response body**

```json
{
  "reading_id": "uuid",
  "anchor_tx_hash": "stellar-tx-hash",
  "mint_tx_hash": "stellar-tx-hash"
}
```

---

### GET /api/explore/certificates

Public, unauthenticated listing of all verified certificates. Powers the public `/explore` page (issue #782). Results are paginated at **20 per page** by default and each certificate links to `/verify/[id]`.

**Auth:** Not required.

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | `integer` | `1` | 1-based page number |
| `limit` | `integer` | `20` | Page size (max 100) |
| `cooperative` | `string` | — | Case-insensitive substring match on cooperative name |
| `date_from` | ISO date | — | Inclusive lower bound on `issued_at` |
| `date_to` | ISO date | — | Inclusive upper bound on `issued_at` |
| `kwh_min` | `number` | — | Inclusive lower bound on `kwh` |
| `kwh_max` | `number` | — | Inclusive upper bound on `kwh` |

**Example request**

```http
GET /api/explore/certificates?cooperative=Sunshine&date_from=2026-01-01&kwh_min=1&kwh_max=100&page=2
```

**200 response body**

```json
{
  "data": [
    {
      "id": "cert-uuid",
      "kwh": 12.5,
      "issued_at": "2026-04-23T10:00:00.000Z",
      "expires_at": "2027-04-23T10:00:00.000Z",
      "retired": false,
      "cooperative_id": "coop-uuid",
      "cooperative_name": "Sunshine Coop",
      "meter_id": "meter-uuid",
      "verify_url": "/verify/cert-uuid"
    }
  ],
  "page": 2,
  "limit": 20,
  "total": 142,
  "total_pages": 8
}
```

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Certificate page |
| `400 Bad Request` | Invalid query params (`{ "error": string }`) |
| `500 Internal Server Error` | Database error |

---

### GET /api/verify

Retrieve the full chain of custody for a certificate. Accepts a certificate ID, reading hash, or mint transaction hash.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Certificate UUID, reading hash (hex), or mint transaction hash |

**Example request**

```http
GET /api/verify?id=a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Certificate found — returns chain of custody |
| `400 Bad Request` | `id` parameter missing |
| `404 Not Found` | No certificate matches the given `id` |
| `429 Too Many Requests` | Rate limit exceeded (30 req/60s per IP) |

**200 response body**

```json
{
  "certificate": {
    "id": "uuid",
    "kwh": 12.5,
    "issued_at": "2026-04-23T00:00:00.000Z",
    "expires_at": "2027-04-23T00:00:00.000Z",
    "expired": false,
    "retired": false,
    "retired_at": null,
    "retired_by": null
  },
  "on_chain": {
    "anchor_tx": "stellar-tx-hash",
    "anchor_explorer": "https://stellar.expert/explorer/testnet/tx/<hash>",
    "mint_tx": "stellar-tx-hash",
    "mint_explorer": "https://stellar.expert/explorer/testnet/tx/<hash>"
  },
  "meter_proof": {
    "meter_id": "uuid",
    "reading_hash": "hex-string",
    "signature_hex": "128-char-hex",
    "kwh": 12.5,
    "timestamp": "2026-04-23T00:00:00.000Z",
    "verified": true
  }
}
```

`meter_proof` is `null` if the associated reading record cannot be found.

`expires_at` is `null` when the certificate has no validity period. `expired` is `true` when `expires_at` is in the past and the certificate has not been retired.

---

### POST /api/webhooks

Register a webhook endpoint that receives event notifications (anchor, mint, retire, etc.).

> **Signature verification (issue #29)**
> When the `WEBHOOK_SECRET` environment variable is set, every incoming `POST /api/webhooks`
> request **must** include an `X-SolarProof-Signature` header containing the
> HMAC-SHA256 hex digest of the raw request body, computed with `WEBHOOK_SECRET` as the key.
> Requests with a missing or invalid signature are rejected with **HTTP 401**.
> The comparison uses constant-time equality (`timingSafeEqual`) to prevent timing attacks.

**Computing the signature (sender side)**

```js
import { createHmac } from 'crypto'
const sig = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
// Include as: X-SolarProof-Signature: <sig>
```

**Request headers**

| Header | Required | Description |
|---|---|---|
| `X-SolarProof-Signature` | ✅ (when `WEBHOOK_SECRET` is set) | HMAC-SHA256 hex digest of raw body |
| `Content-Type` | ✅ | `application/json` |

**Request body**

| Field | Type | Description |
|---|---|---|
| `cooperative_id` | `string` (UUID) | Cooperative to subscribe |
| `url` | `string` (URL) | Endpoint that will receive webhook events |
| `secret` | `string` (≥16 chars) | Shared secret for outgoing webhook signatures |
| `events` | `string[]` | One or more of: `anchor`, `mint`, `retire`, `mint_failed`, `certificate.minted`, `certificate.transferred`, `certificate.retired` |

**Responses**

| Status | Meaning |
|---|---|
| `201 Created` | Webhook registered successfully |
| `400 Bad Request` | Validation failed |
| `401 Unauthorized` | Missing or invalid `X-SolarProof-Signature` |
| `500 Internal Server Error` | Database write failed |

---

### GET /api/webhooks?cooperative_id=UUID

List registered webhook endpoints for a cooperative.

---

### GET /api/cooperative/retirement-report

Monthly cooperative summary report (issue #785). Returns the total kWh retired in the requested period, a per-buyer breakdown, the retired certificate IDs, and a **production summary** covering total kWh produced, certificates issued and retired, broken down by meter. The report can be returned as JSON, CSV, or PDF.

**Authentication**

Requires a cooperative admin session (Supabase auth cookie). The authenticated user must be an admin of the cooperative whose report is requested; otherwise the request is rejected with `403 Forbidden`.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `month` | `string` (`YYYY-MM`) | ❌* | Calendar month (UTC) to report on, e.g. `2026-04` |
| `date_from` | ISO date | ❌* | Inclusive start of an arbitrary date range |
| `date_to` | ISO date | ❌* | Inclusive end of an arbitrary date range |
| `format` | `string` | ❌ | `json` (default), `csv`, or `pdf` |

\* Either `month` or both `date_from` and `date_to` must be supplied. When `month` is given it takes precedence.

**Example requests**

```http
GET /api/cooperative/retirement-report?month=2026-04
```

```http
GET /api/cooperative/retirement-report?date_from=2026-01-01&date_to=2026-03-31&format=csv
```

```http
GET /api/cooperative/retirement-report?month=2026-04&format=pdf
```

**Responses**

| Status | Meaning | Body |
|---|---|---|
| `200 OK` | Report generated | JSON report, or CSV (`text/csv`) / PDF (`application/pdf`) attachment |
| `400 Bad Request` | No period supplied, invalid date format, or invalid `format` | `{ error: string }` |
| `401 Unauthorized` | No authenticated session | `{ error: string }` |
| `403 Forbidden` | Authenticated user is not a cooperative admin | `{ error: string }` |
| `500 Internal Server Error` | Database query failed | `{ error: string }` |

**200 response body (JSON)**

```json
{
  "month": "2026-04",
  "date_from": "2026-04-01",
  "date_to": "2026-04-30",
  "cooperative_id": "uuid",
  "total_kwh_retired": 1250.5,
  "total_certificates": 42,
  "buyers": [
    {
      "buyer_id": "uuid",
      "buyer_name": "Acme Corp",
      "total_kwh": 750.25,
      "certificate_count": 25,
      "certificate_ids": ["uuid", "uuid"]
    }
  ],
  "production": {
    "total_kwh_produced": 2100.0,
    "certificates_issued": 2100,
    "certificates_retired": 42,
    "by_meter": [
      {
        "meter_id": "uuid",
        "meter_name": "Roof Panel A",
        "kwh_produced": 840.0,
        "certificates_issued": 840,
        "certificates_retired": 18
      }
    ]
  }
}
```

**CSV response**

When `format=csv` is requested, the response has `Content-Type: text/csv` and `Content-Disposition: attachment; filename="cooperative-report-<period>.csv"`. The file contains two sections: retirement rows (`buyer_id`, `buyer_name`, `certificate_id`, `kwh`, `retired_at`) followed by production rows (`meter_id`, `meter_name`, `kwh_produced`, `certificates_issued`, `certificates_retired`).

**PDF response**

When `format=pdf` is requested, the response has `Content-Type: application/pdf` and `Content-Disposition: attachment; filename="cooperative-report-<period>.pdf"`. The PDF contains the same retirement and production summary tables.

**Automated monthly delivery**

Monthly email delivery of the report is configurable per cooperative. When enabled, a scheduled cron job (`/api/cron/monthly-report`, protected by the `CRON_SECRET` bearer token) generates the previous month's report and emails it to the configured recipients. Configure recipients and enable/disable delivery via the cooperative settings; the cron endpoint is not intended for direct public use.

---

### GET /api/ws/readings

**Not implemented.** This route currently responds with `501 Not Implemented` JSON; it does not accept WebSocket upgrades or publish events. Real-time certificate alerts require a WebSocket-capable event service or an authorized Supabase Realtime subscription before the frontend can receive issuance, failure, and retirement notifications. The event source and payload contract must be defined before a client integration can be implemented. See [issue #11](https://github.com/katecatherinaa/solarproof/issues/11).

---

### GET /api/health

Liveness check used by uptime monitoring.

**No parameters.**

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "status": "ok", "ts": <unix-ms> }` |

---

## Rate Limits

Rate limits are enforced per client and per scope. Every limited response includes the standard `X-RateLimit-*` headers, and rejected requests additionally include `Retry-After`.

### Policies

| Scope | Applies to | Limit | Window |
|---|---|---|---|
| Per IP address | `POST /api/readings` | 10 requests | 60 seconds |
| Per IP address | `GET /api/verify` | 30 requests | 60 seconds |
| Per meter public key | Reading submissions (`POST /api/readings`, `POST /api/v1/readings`, `POST /api/v1/readings/batch`) | 60 requests | 60 seconds |

The per-IP and per-meter limits are independent: a request must satisfy both to succeed. Batch submissions count each contained reading against the submitting meter's public key.

### Sliding window

Limits use a **sliding window** rather than a fixed window. Each request is timestamped, and the counter reflects only requests made within the trailing window (e.g. the last 60 seconds). A client that stops sending requests regains capacity gradually as older requests age out of the window — there is no hard reset at a fixed clock boundary.

### Response headers

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum number of requests permitted in the current window for the applicable scope |
| `X-RateLimit-Remaining` | Number of requests still available in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) at which the oldest counted request leaves the window and capacity is restored |
| `Retry-After` | Seconds the client must wait before retrying. Only present on `429` responses |

### Exceeding a limit

When a limit is exceeded the server responds with **HTTP 429 Too Many Requests** and does not process the request.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1745366460
Retry-After: 42

{ "error": "Rate limit exceeded" }
```

Clients should **back off until `Retry-After` seconds have elapsed** before retrying, and should honour `X-RateLimit-Remaining` to avoid hitting the limit again. Retrying earlier will continue to receive `429` responses.

---

## Error format

All error responses follow this shape:
=======

```json
{ "error": "human-readable message" }
```

Validation errors from `POST /api/readings` return a Zod flatten structure:

```json
{
  "error": {
    "fieldErrors": { "kwh": ["Expected number, received string"] },
    "formErrors": []
  }
}
```

---

## Error codes

| HTTP Status | Cause |
|---|---|
| `400` | Missing or invalid request parameters |
| `401` | Ed25519 signature verification failed |
| `404` | Resource (meter or certificate) not found |
| `429` | Rate limit exceeded — see [Rate Limits](#rate-limits) |
| `500` | Upstream failure: Supabase write, Stellar anchor, or certificate mint |

---

## v1 API endpoints (`/api/v1/`)

All routes under `/api/v1/` are aliases of the corresponding unversioned routes and behave identically. The `/api/v1/` prefix is provided for forward-compatibility.

Base URL prefix: `/api/v1`

---

### Authentication (JWT)

Most `/api/v1/` routes (meters, certificates, cooperative, governance) require a **Bearer JWT** issued at login.

```
Authorization: Bearer <jwt>
```

Obtain a JWT via `POST /api/v1/auth/login`.

---

### POST /api/v1/auth/login

Exchange email + password for a JWT.

**Request body**

| Field | Type | Description |
|---|---|---|
| `email` | `string` | Operator email address |
| `password` | `string` | Account password |

**Example request**

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "admin@coop.example",
  "password": "s3cr3t!"
}
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 3600 }` |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...}, "formErrors": [] } }` |
| `401 Unauthorized` | `{ "error": "Invalid credentials" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### POST /api/v1/auth/logout

Invalidate the current session token. Requires a valid Bearer JWT.

**Example request**

```http
POST /api/v1/auth/logout
Authorization: Bearer <jwt>
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "message": "Logged out" }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |

---

### POST /api/v1/auth/switch-cooperative

Switch the active cooperative for an account that holds roles in more than one cooperative (issue #783). Issues a new JWT whose `cooperative_id` claim is set to the requested cooperative, so all subsequent data views are scoped to it.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Description |
|---|---|---|
| `cooperative_id` | `string` (UUID) | Cooperative to switch to; the user must hold a role in it |

**Example request**

```http
POST /api/v1/auth/switch-cooperative
Authorization: Bearer <jwt>
Content-Type: application/json

{ "cooperative_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "access_token": "<new-jwt>", "token_type": "Bearer", "expires_in": 3600, "cooperative": { "id": "uuid", "name": "Sunshine Coop" } }` |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...}, "formErrors": [] } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `403 Forbidden` | `{ "error": "You do not have access to this cooperative" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### POST /api/v1/auth/refresh

Refresh an expiring JWT.

**Example request**

```http
POST /api/v1/auth/refresh
Authorization: Bearer <expired-or-near-expiry-jwt>
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "access_token": "<new-jwt>", "expires_in": 3600 }` |
| `401 Unauthorized` | `{ "error": "Invalid or expired token" }` |

---

### GET /api/v1/meters

List all meters belonging to the authenticated cooperative.

**Auth:** Bearer JWT required.

**Example request**

```http
GET /api/v1/meters
Authorization: Bearer <jwt>
```

**200 response body**

```json
[
  {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "name": "Roof Panel A",
    "serial_number": "METER-001",
    "pubkey_hex": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    "active": true,
    "created_at": "2026-01-15T10:00:00.000Z",
    "cooperative_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "meter_group": "rooftop",
    "tags": ["phase-1", "south-facing"]
  }
]
```

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Array of meter objects |
| `401 Unauthorized` | Missing or invalid JWT |
| `500 Internal Server Error` | Database error |

---

### POST /api/v1/meters

Register a new meter for the authenticated cooperative.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Human-readable label (max 128 chars) |
| `serial_number` | `string` | ✅ | Unique device serial number (max 64 chars) |
| `pubkey_hex` | `string` | ✅ | Ed25519 public key — exactly 64 hex chars (32 bytes) |
| `meter_group` | `string` | ✗ | Logical group label (max 64 chars) |
| `tags` | `string[]` | ✗ | Array of tag strings (each max 32 chars) |

> **Note:** Individual accounts are limited to 1 meter. Cooperative accounts may register unlimited meters.

**Example request**

```http
POST /api/v1/meters
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "name": "Roof Panel A",
  "serial_number": "METER-001",
  "pubkey_hex": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  "meter_group": "rooftop",
  "tags": ["phase-1", "south-facing"]
}
```

**Responses**

| Status | Meaning | Body |
|---|---|---|
| `201 Created` | Meter registered | Full meter object including one-time `api_key` |
| `400 Bad Request` | Validation failed | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | Invalid JWT | `{ "error": "Unauthorized" }` |
| `403 Forbidden` | Individual account meter limit reached | `{ "error": "Individual accounts are limited to 1 meter…" }` |
| `404 Not Found` | Cooperative record missing | `{ "error": "Cooperative not found" }` |
| `409 Conflict` | Public key already registered | `{ "error": "A meter with this public key already exists" }` |
| `500 Internal Server Error` | Database error | `{ "error": "<message>" }` |

> **Important:** The `api_key` field (`mk_…`) in the 201 response is shown exactly once. Store it securely; it cannot be retrieved again.

---

### GET /api/v1/meters/:id

Get a single meter by ID.

**Auth:** Bearer JWT required.

**Path parameter:** `id` — meter UUID.

**Example request**

```http
GET /api/v1/meters/f47ac10b-58cc-4372-a567-0e02b2c3d479
Authorization: Bearer <jwt>
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Meter object |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Meter not found" }` |

---

### DELETE /api/v1/meters/:id

Delete (deregister) a meter. Does not delete associated reading history.

**Auth:** Bearer JWT required.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "success": true }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Meter not found" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### POST /api/v1/meters/:id/revoke

Revoke a meter's API key, generating and returning a new one.

**Auth:** Bearer JWT required.

**Example request**

```http
POST /api/v1/meters/f47ac10b-58cc-4372-a567-0e02b2c3d479/revoke
Authorization: Bearer <jwt>
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "api_key": "mk_<new-hex>" }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Meter not found" }` |

---

### POST /api/v1/readings

Submit a signed meter reading. Identical to `POST /api/readings` — see [that endpoint](#post-apireadings) for the full specification.

---

### POST /api/v1/readings/batch

Submit multiple signed meter readings in a single request.

**Auth:** No bearer token; each reading includes its own `signature_hex`.

**Request body**

```json
{
  "readings": [
    {
      "meter_id": "uuid",
      "kwh": 12.5,
      "timestamp": 1745366400,
      "signature_hex": "4b3e...f09a"
    },
    {
      "meter_id": "uuid",
      "kwh": 8.2,
      "timestamp": 1745370000,
      "signature_hex": "9c1a...b72e"
    }
  ]
}
```

**Responses**

| Status | Meaning | Body |
|---|---|---|
| `207 Multi-Status` | Batch processed (some may have failed) | `{ "results": [ { "index": 0, "status": 201, "data": {...} }, { "index": 1, "status": 401, "error": "..." } ] }` |
| `400 Bad Request` | Top-level schema invalid | `{ "error": { "fieldErrors": {...} } }` |

---

### GET /api/v1/certificates

List energy certificates with cursor-based pagination.

**Auth:** Not required (public endpoint).

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | `integer` | `20` | Page size (max 100) |
| `cursor` | `string` | — | ISO timestamp of `issued_at` from previous page's `next_cursor` |
| `q` | `string` | — | Prefix search on certificate ID or meter ID |
| `status` | `"active"` \| `"retired"` | — | Filter by retirement status |
| `date_from` | ISO date | — | Inclusive lower bound on `issued_at` |
| `date_to` | ISO date | — | Inclusive upper bound on `issued_at` |

**Example request**

```http
GET /api/v1/certificates?limit=10&status=active&date_from=2026-01-01
```

**200 response body**

```json
{
  "data": [
    {
      "id": "cert-uuid",
      "kwh": 12.5,
      "issued_at": "2026-04-23T10:00:00.000Z",
      "expires_at": "2027-04-23T10:00:00.000Z",
      "expired": false,
      "retired": false,
      "retired_at": null,
      "retired_by": null,
      "mint_tx_hash": "stellar-tx-hash",
      "meter_id": "meter-uuid"
    }
  ],
  "next_cursor": "2026-04-22T08:00:00.000Z",
  "total": 142
}
```

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Certificate page |
| `400 Bad Request` | Invalid query params |
| `500 Internal Server Error` | Database error |

---

### POST /api/v1/certificates/:id/retire

Permanently retire (burn) a certificate.

**Auth:** Bearer JWT required.

**Path parameter:** `id` — certificate UUID.

**Example request**

```http
POST /api/v1/certificates/cert-uuid/retire
Authorization: Bearer <jwt>
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "success": true, "retired_at": "<iso-timestamp>" }` |
| `400 Bad Request` | `{ "error": "Certificate already retired" }` or `{ "error": "Certificate expired on <iso-timestamp> and cannot be retired" }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Certificate not found" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

> **Warning:** Retirement is irreversible. The certificate token is burned on-chain.

> **Expiry (issue #784):** Certificates may carry an `expires_at` timestamp. Retirement of a certificate whose `expires_at` is in the past is rejected with `400 Bad Request` and the descriptive error shown above. Certificates with `expires_at: null` never expire.

---

### GET /api/v1/certificates/:id/irec-export

Export a certificate in I-REC(E) issuance request format (JSON).

**Auth:** Bearer JWT required.

**Example request**

```http
GET /api/v1/certificates/cert-uuid/irec-export
Authorization: Bearer <jwt>
```

**200 response body**

```json
{
  "deviceId": "meter-uuid",
  "productionStart": "2026-04-23T00:00:00.000Z",
  "productionEnd": "2026-04-23T23:59:59.000Z",
  "volume": 0.0000125,
  "validityPeriod": {
    "start": "2026-04-23T00:00:00.000Z",
    "end": "2027-04-23T00:00:00.000Z"
  },
  "mrvDocumentUrl": "https://solarproof.vercel.app/verify?id=cert-uuid"
}
```

`validityPeriod.end` is derived from the certificate's `expires_at`; it is `null` when the certificate has no expiry.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | I-REC payload object |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Certificate not found" }` |

---

### POST /api/v1/certificates/:id/transfer

Transfer a certificate to another cooperative.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Description |
|---|---|---|
| `recipient_cooperative_id` | `string` (UUID) | Destination cooperative |

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "success": true }` |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Certificate not found" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/verify

Identical to `GET /api/verify` — see [that endpoint](#get-apiverify). Also available at `GET /api/v1/verify/:id` (path-param form).

---

## Marketplace (OTC transfers)

The `/marketplace` page lets cooperatives list certificates for peer-to-peer (OTC) transfer. Listings are stored **off-chain**; the actual ownership change is performed by the existing `POST /api/v1/certificates/:id/transfer` endpoint, and each transfer is recorded in `transfer_history`.

> **Scope (v1):** Escrow and payment settlement are **out of scope**. Buyers and sellers settle payment manually off-platform. The marketplace only advertises listings and initiates the on-chain transfer.

### GET /api/v1/marketplace/listings

List certificates currently available for transfer.

**Auth:** Not required (public endpoint).

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | `integer` | `20` | Page size (max 100) |
| `cursor` | `string` | — | Pagination cursor from previous response |
| `cooperative_id` | `string` (UUID) | — | Filter by seller cooperative |

**Example request**

```http
GET /api/v1/marketplace/listings?limit=10
```

**200 response body**

```json
{
  "data": [
    {
      "id": "listing-uuid",
      "certificate_id": "cert-uuid",
      "seller_cooperative_id": "coop-uuid",
      "seller_name": "Sunshine Coop",
      "kwh": 12.5,
      "asking_price": 25.0,
      "currency": "EUR",
      "status": "open",
      "created_at": "2026-04-23T10:00:00.000Z"
    }
  ],
  "next_cursor": "2026-04-22T08:00:00.000Z"
}
```

**Responses**

| Status | Meaning |
|---|---|
| `200 OK` | Listing page |
| `400 Bad Request` | Invalid query params |
| `500 Internal Server Error` | Database error |

---

### POST /api/v1/marketplace/listings

Create a listing for one of the authenticated cooperative's certificates.

**Auth:** Bearer JWT required. The certificate must belong to the caller's cooperative.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `certificate_id` | `string` (UUID) | ✅ | Certificate to list |
| `asking_price` | `number` | ✅ | Asking price (positive, off-chain) |
| `currency` | `string` | ✗ | Currency code (default `EUR`) |

**Example request**

```http
POST /api/v1/marketplace/listings
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "certificate_id": "cert-uuid",
  "asking_price": 25.0,
  "currency": "EUR"
}
```

**Responses**

| Status | Body |
|---|---|
| `201 Created` | Listing object |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Certificate not found" }` |
| `409 Conflict` | `{ "error": "Certificate already listed" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### DELETE /api/v1/marketplace/listings/:id

Cancel an open listing. Only the seller cooperative may cancel.

**Auth:** Bearer JWT required.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "success": true }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `403 Forbidden` | `{ "error": "Not the listing owner" }` |
| `404 Not Found` | `{ "error": "Listing not found" }` |

---

### POST /api/v1/marketplace/listings/:id/buy

Initiate a transfer for a listed certificate. This is a thin wrapper around `POST /api/v1/certificates/:id/transfer`; the resulting transfer is recorded in `transfer_history` and the listing is marked `sold`.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient_cooperative_id` | `string` (UUID) | ✅ | Buyer cooperative (must match the caller) |

**Example request**

```http
POST /api/v1/marketplace/listings/listing-uuid/buy
Authorization: Bearer <jwt>
Content-Type: application/json

{ "recipient_cooperative_id": "buyer-coop-uuid" }
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "success": true, "transfer_id": "uuid" }` |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Listing not found" }` |
| `409 Conflict` | `{ "error": "Listing is no longer open" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

> **Note:** Payment is settled manually between the parties. No escrow or funds movement occurs through the API in v1.

---

### GET /api/v1/cooperative/me

Return the authenticated user's cooperative profile.

**Auth:** Bearer JWT required.

**Example request**

```http
GET /api/v1/cooperative/me
Authorization: Bearer <jwt>
```

**200 response body**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Sunshine Coop",
  "account_type": "cooperative",
  "admin_address": "GABC...XYZ",
  "suspended": false,
  "created_at": "2026-01-01T00:00:00.000Z",
  "memberships": [
    { "cooperative_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "name": "Sunshine Coop", "role": "admin" },
    { "cooperative_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901", "name": "Windy Coop", "role": "operator" }
  ]
}
```

`memberships` lists every cooperative the authenticated user can access and is used to populate the cooperative switcher in the navbar (issue #783). Switch the active cooperative with `POST /api/v1/auth/switch-cooperative`.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Cooperative object |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/cooperatives/:id

Return the **public** cooperative profile used by the `/cooperatives/[id]` page. This endpoint is public and exposes no PII — `admin_address`, operator emails, and other private fields are never included.

**Auth:** Not required (public endpoint).

**Path parameter:** `id` — cooperative UUID.

**Example request**

```http
GET /api/v1/cooperatives/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**200 response body**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Sunshine Coop",
  "location": "Lisbon, Portugal",
  "total_kwh_produced": 4210.5,
  "active_meters": 5,
  "certificates_issued": 4210,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

> **Privacy:** The public profile intentionally omits `admin_address`, operator email addresses, and any other personally identifiable information.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Public cooperative profile object |
| `404 Not Found` | `{ "error": "Cooperative not found" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/cooperative/stats

Return aggregated energy and certificate statistics for the authenticated cooperative.

**Auth:** Bearer JWT required.

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `date_from` | ISO datetime | 30 days ago | Range start |
| `date_to` | ISO datetime | now | Range end |
| `granularity` | `"day"` \| `"month"` \| `"year"` | `"day"` | Trend bucket size |

**Example request**

```http
GET /api/v1/cooperative/stats?granularity=month&date_from=2026-01-01T00:00:00.000Z
Authorization: Bearer <jwt>
```

**200 response body**

```json
{
  "summary": {
    "total_kwh": 4210.5,
    "certificates_issued": 4210,
    "certificates_retired": 300,
    "active_meters": 5
  },
  "trends": [
    { "period": "2026-01", "kwh": 1200.0, "certs_issued": 1200, "certs_retired": 80 }
  ],
  "meter_stats": [
    { "meter_id": "uuid", "name": "Roof Panel A", "kwh": 840.0, "readings_count": 168 }
  ],
  "range": {
    "start": "2026-01-01T00:00:00.000Z",
    "end": "2026-10-19T00:00:00.000Z",
    "granularity": "month"
  }
}
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Stats object |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/governance

List governance proposals for the authenticated cooperative.

**Auth:** Bearer JWT required.

**Example request**

```http
GET /api/v1/governance
Authorization: Bearer <jwt>
```

**200 response body**

```json
[
  {
    "id": "prop-uuid",
    "title": "Reduce platform fee to 1%",
    "description": "Proposal to lower the cooperative fee...",
    "status": "active",
    "ends_at": "2026-10-26T00:00:00.000Z",
    "created_at": "2026-10-19T00:00:00.000Z",
    "tally": { "for": 12, "against": 3, "abstain": 1 }
  }
]
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Array of proposal objects |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### POST /api/v1/governance

Create a new governance proposal.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | ✅ | Proposal title (max 120 chars) |
| `description` | `string` | ✅ | Full description (max 2000 chars) |
| `action` | `string` | ✗ | Machine-readable action identifier (max 200 chars) |
| `days` | `integer` | ✗ | Voting period in days (1–30, default 7) |

**Example request**

```http
POST /api/v1/governance
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "title": "Reduce platform fee to 1%",
  "description": "We propose lowering the cooperative fee from 2% to 1% of minted certificates.",
  "days": 14
}
```

**Responses**

| Status | Body |
|---|---|
| `201 Created` | Proposal object |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### POST /api/v1/governance/:id/vote

Cast a vote on an active proposal.

**Auth:** Bearer JWT required.

**Path parameter:** `id` — proposal UUID.

**Request body**

| Field | Type | Description |
|---|---|---|
| `choice` | `"for"` \| `"against"` \| `"abstain"` | Your vote |

**Example request**

```http
POST /api/v1/governance/prop-uuid/vote
Authorization: Bearer <jwt>
Content-Type: application/json

{ "choice": "for" }
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | `{ "message": "Vote recorded successfully" }` |
| `400 Bad Request` | `{ "error": "Voting is closed for this proposal" }` or validation error |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Proposal not found" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/audit-log

Return the structured audit log for the authenticated cooperative.

**Auth:** Bearer JWT required.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | `integer` | Page size (max 100, default 20) |
| `cursor` | `string` | Pagination cursor from previous response |
| `event_type` | `string` | Filter by event type (e.g. `reading.anchored`, `certificate.retired`) |

**Example request**

```http
GET /api/v1/audit-log?limit=10&event_type=certificate.retired
Authorization: Bearer <jwt>
```

**200 response body**

```json
{
  "data": [
    {
      "id": "log-uuid",
      "event_type": "certificate.retired",
      "actor_id": "user-uuid",
      "resource_id": "cert-uuid",
      "meta": {},
      "created_at": "2026-04-23T10:00:00.000Z"
    }
  ],
  "next_cursor": "2026-04-22T08:00:00.000Z"
}
```

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Audit log page |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/jobs/:id

Poll the status of a long-running background job (e.g. a batch reading import).

**Auth:** Bearer JWT required.

**Path parameter:** `id` — job UUID.

**200 response body**

```json
{
  "id": "job-uuid",
  "status": "completed",
  "progress": 100,
  "result": { "processed": 50, "failed": 0 },
  "created_at": "2026-04-23T10:00:00.000Z",
  "completed_at": "2026-04-23T10:00:05.000Z"
}
```

**Job statuses:** `pending` · `running` · `completed` · `failed`

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Job status object |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `404 Not Found` | `{ "error": "Job not found" }` |

---

### GET /api/v1/webhooks

List registered webhook endpoints for the authenticated cooperative.

**Auth:** Bearer JWT required.

**Responses**

| Status | Body |
|---|---|
| `200 OK` | Array of webhook objects |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |

---

### POST /api/v1/webhooks

Register a new webhook endpoint to receive reading and certificate events.

**Auth:** Bearer JWT required.

**Request body**

| Field | Type | Description |
|---|---|---|
| `url` | `string` | HTTPS endpoint to receive POST events |
| `events` | `string[]` | Event types to subscribe to (e.g. `["reading.anchored", "certificate.minted", "certificate.retired"]`) |
| `secret` | `string` | HMAC-SHA256 signing secret for payload verification |

**Example request**

```http
POST /api/v1/webhooks
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "url": "https://your-system.example/webhooks/solar",
  "events": ["reading.anchored", "certificate.retired"],
  "secret": "whsec_your-secret-here"
}
```

**Responses**

| Status | Body |
|---|---|
| `201 Created` | Webhook object with `id` |
| `400 Bad Request` | `{ "error": { "fieldErrors": {...} } }` |
| `401 Unauthorized` | `{ "error": "Unauthorized" }` |
| `500 Internal Server Error` | `{ "error": "<message>" }` |

---

### GET /api/v1/health

Liveness check. Identical to `GET /api/health`.

**No parameters. No auth required.**

```json
{ "status": "ok", "ts": 1745366400000 }
```

---

## Postman / Insomnia collection

A collection is available at [`docs/solarproof-api-v1.postman_collection.json`](./solarproof-api-v1.postman_collection.json) and can be imported directly into Postman or Insomnia. Set the `baseUrl` collection variable to your target environment (`https://solarproof.vercel.app` for production, `http://localhost:3000` for local).
