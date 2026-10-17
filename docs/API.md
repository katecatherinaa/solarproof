# API Reference

Base URL: `https://solarproof.vercel.app` (production) · `http://localhost:3000` (local)

All responses are JSON. Timestamps are ISO 8601 strings unless noted.

---

## Authentication

Endpoints that accept meter readings require an **Ed25519 signature** produced by the registered meter device. The signature is passed in the request body as `signature_hex` — there are no HTTP-level API keys or bearer tokens for this endpoint.

The `GET /api/verify` and `GET /api/health` endpoints are **public** and require no authentication.

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

**200 response body**

```json
{
  "certificate": {
    "id": "uuid",
    "kwh": 12.5,
    "issued_at": "2026-04-23T00:00:00.000Z",
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

## Error format

All error responses follow this shape:

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
| `500` | Upstream failure: Supabase write, Stellar anchor, or certificate mint |
