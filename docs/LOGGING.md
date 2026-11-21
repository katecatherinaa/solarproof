# Log Aggregation

SolarProof ships structured JSON logs to **Better Stack (Logtail)** from all Next.js API routes.

## Setup

1. Create a **Source** in [Better Stack Logs](https://logs.betterstack.com) → choose *HTTP source*.
2. Copy the **Source token** and add it to your environment:
   - Vercel: `Settings → Environment Variables → LOGTAIL_SOURCE_TOKEN`
   - Local: add to `.env.local`
3. Retention is configured per-team in Better Stack → **30 days** is the default for the free tier; upgrade if needed.

## Correlation IDs

Every API request is assigned a **`X-Correlation-ID`** header in middleware. This ID flows through all log entries for a request so you can trace a single request across logs, Sentry, and external services.

- If the inbound request includes `X-Correlation-ID`, that value is reused.
- Otherwise the middleware generates a new UUID v4.
- The value is forwarded in the `X-Correlation-ID` response header.

### Using the request-scoped logger

Use `createRequestLogger(req)` in route handlers to automatically include `correlationId`, `route`, `method`, and `duration_ms` in every log entry:

```ts
import { createRequestLogger } from '@/lib/logger'

export async function POST(req: NextRequest) {
  const log = createRequestLogger(req)
  log.info('readings.post.start', { meter_id })
  // ... process ...
  log.end(202)  // emits request.complete with status + duration
}
```

## Log format

Every log line is a JSON object with at minimum:

```json
{
  "level": "info",
  "event": "reading.anchored",
  "timestamp": "2026-04-24T13:00:00.000Z",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "route": "/api/v1/readings",
  "method": "POST",
  "txHash": "abc123",
  "kwh": 12.5
}
```

A completed request emits a `request.complete` entry with timing:

```json
{
  "level": "info",
  "event": "request.complete",
  "timestamp": "2026-04-24T13:00:01.000Z",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "route": "/api/v1/readings",
  "method": "POST",
  "status": 202,
  "duration_ms": 312
}
```

## PII Redaction

PII fields are automatically redacted. See [docs/SECURE_LOGGING.md](./SECURE_LOGGING.md) for the full policy.

Key fields that are **always redacted**:
- `meter_id`, `email`, `operator_email` (PII per SECURE_LOGGING.md)
- Any key matching `/key|secret|token|password|sig|hex|private/i`

Use `redactPii(meta)` before passing untrusted objects to the logger:

```ts
import { redactPii } from '@/lib/logger'
log.info('reading.received', redactPii({ meter_id, kwh, timestamp }))
```

## Sentry integration

`createRequestLogger()` sets the `correlationId` tag on the active Sentry scope. This means:
- Sentry errors include the correlation ID as a tag and extra field
- Sentry breadcrumbs include the correlation ID, route, and method
- You can search Sentry by correlation ID to find the log context for any error

## Usage in code

```ts
import { logger, createRequestLogger, redact, redactPii } from '@/lib/logger'

// Simple logger (no request context)
logger.info('reading.anchored', { txHash, kwh })
logger.error('mint.failed', { error: err.message, readingId })

// With explicit correlation ID
const log = logger.withCorrelationId(correlationId)
log.info('reading.anchored', { txHash })

// Request-scoped (recommended for route handlers)
const log = createRequestLogger(req)
log.info('readings.post.start')
log.end(202)

// Structural redaction
const safe = redact({ signature_hex, pubkey_hex, kwh })
log.info('reading.received', safe)
```

## Alerts

Configure in Better Stack → **Alerts**:

| Alert | Condition | Channel |
|---|---|---|
| Error spike | `level = error` count > 10 in 5 min | Email / PagerDuty |
| High error rate | `level = error` / total > 5 % over 15 min | Slack |

Logs are also captured by Vercel function logs (stdout) and Sentry (errors via `@sentry/nextjs`).

## Audit log hash chain

The `audit_log` table is **tamper-evident**: every row is linked to its predecessor with a SHA-256 hash, so any deletion or modification of an existing row breaks the chain and becomes detectable.

### Chain structure

Each `audit_log` row stores two hashes:

| Column | Meaning |
|---|---|
| `prev_hash` | `SHA-256` of the **previous row's canonical content** (see below). |
| `content_hash` | `SHA-256` of this row's canonical content, including its `prev_hash`. |

The canonical content of a row is the deterministic JSON serialization of its audited fields — `id`, `created_at`, `actor`, `action`, `entity_type`, `entity_id`, and `metadata` — with keys sorted lexicographically and no insignificant whitespace. `prev_hash` is included in the input to `content_hash`, which is what binds each row to its predecessor.

```
row N-1: { ..., prev_hash: H(N-2), content_hash: H(N-1) }
row N:   { ..., prev_hash: H(N-1), content_hash: H(N)   }
```

### Genesis value

The first row in the chain has no predecessor. Its `prev_hash` is the **genesis value**:

```
0000000000000000000000000000000000000000000000000000000000000000
```

(64 zero hex characters, i.e. a 32-byte zero hash.)

### Verification procedure

Verification walks the table in ascending `id` order and, for each row:

1. Recomputes `content_hash` from the row's canonical content and compares it to the stored `content_hash`. A mismatch means the row was **modified**.
2. Compares the row's `prev_hash` to the previous row's stored `content_hash` (or the genesis value for the first row). A mismatch means a row was **deleted or inserted** between them.

If both checks pass for every row, the chain is intact.

### Calling the verify endpoint

```
GET /api/admin/audit-logs?action=verify_chain
```

The endpoint requires an admin session. Optional query parameters:

| Param | Description |
|---|---|
| `from` | Start verifying at this `id` (inclusive). Defaults to the first row. |
| `to` | Stop verifying at this `id` (inclusive). Defaults to the last row. |

Example response for an intact chain:

```json
{
  "ok": true,
  "checked": 1284,
  "first_mismatch": null
}
```

Example response when tampering is detected:

```json
{
  "ok": false,
  "checked": 1284,
  "first_mismatch": {
    "id": 512,
    "reason": "content_hash_mismatch",
    "expected": "9f2c...a1",
    "actual": "3b7e...04"
  }
}
```

### Interpreting `first_mismatch`

`first_mismatch` is `null` when the chain is intact. Otherwise it identifies the **earliest** row where verification failed:

- `reason: "content_hash_mismatch"` — the row's stored `content_hash` does not match its recomputed content. The row itself was edited (or its `metadata`/`action`/etc. was altered).
- `reason: "prev_hash_mismatch"` — the row's `prev_hash` does not match the previous row's `content_hash`. A row was deleted or inserted before this one; the missing/inserted row is the one immediately preceding `id`.
- `reason: "genesis_mismatch"` — the first row's `prev_hash` is not the genesis value.

Because every row commits to its predecessor, a single tampered row invalidates all subsequent rows. Report the `first_mismatch.id` — that is the earliest point of divergence and the place to start an investigation.

## Centralised log shipping

stdout JSON is the single source of truth; shipping is handled by the platform, not the app.

### Vercel (production)

1. Vercel → **Project → Settings → Log Drains** → *Add Log Drain*.
2. Choose the **Datadog** or **Loki** (HTTP) drain type.
3. Set the drain to forward `info`, `warn`, and `error` level logs from all deployments.
4. Store the drain secret in Vercel env vars and rotate it quarterly.

### Docker / self-hosted

Run a **Fluent Bit** sidecar that tails the container's stdout and forwards JSON to the aggregator:

```ini
# fluent-bit.conf
[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    Parser            docker
    Tag               solarproof.*

[FILTER]
    Name              parser
    Match             solarproof.*
    Key_Name          log
    Parser            json

[OUTPUT]
    Name              loki
    Match             solarproof.*
    Host              loki.internal
    Port              3100
    Labels            job=solarproof,level=$level,route=$route
```

For Datadog, replace the output block with the `datadog` output plugin and set `DD_API_KEY` via the sidecar's environment.

### Retention policy

| Tier | Retention | Storage |
|---|---|---|
| Hot (searchable, alerting) | 30 days | Datadog / Loki index |
| Cold (compliance, forensics) | 365 days | Object storage (S3/GCS) via aggregator archive |

Configure the archive in the aggregator: Datadog → *Logs → Archives*, or Loki → `ruler`/`compactor` retention with an S3 backend.

### ERROR-level rate-spike alerts

Configure in Datadog → **Monitors** or Loki → **Ruler**:

| Alert | Condition | Channel |
|---|---|---|
| Error rate spike | `level = error` count > 50 in 5 min (2× baseline) | PagerDuty |
| Error ratio | `level = error` / total > 5 % over 15 min | Slack `#alerts` |
| Log silence | 0 logs from any route for 10 min during business hours | Slack `#alerts` |

## OpenTelemetry tracing

Distributed tracing is configured in `instrumentation.ts` via `@opentelemetry/sdk-node`. Traces are exported over OTLP/HTTP to a managed backend.

### Backend choice

Pick one and set the endpoint accordingly:

- **Grafana Tempo** (self-hosted or Grafana Cloud): `OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo-<region>.grafana.net/otlp`
- **Honeycomb**: `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io`

### Required environment variables

| Variable | Description |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL (Tempo or Honeycomb) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers, e.g. `authorization=Bearer <token>` or `x-honeycomb-team=<key>` |
| `OTEL_SERVICE_NAME` | Service name, e.g. `solarproof-web` |
| `OTEL_SERVICE_VERSION` | Deployed git SHA or semver, e.g. `1.4.2` |

Set these in Vercel → **Settings → Environment Variables** per environment, and in `.env.local` for local development (leave the endpoint unset locally to disable export).

### Sampling

| Environment | Sample rate |
|---|---|
| Production | 10 % (`OTEL_TRACES_SAMPLER_ARG=0.1`) |
| Staging | 100 % (`OTEL_TRACES_SAMPLER_ARG=1.0`) |

The sampler is configured as `parentbased_traceidratio` so child spans inherit the parent's sampling decision.

### Latency dashboard

A Grafana dashboard definition lives at `docs/dashboards/otel-latency.json`. Import it via Grafana → **Dashboards → New → Import → Upload JSON**, then select the Tempo data source. It shows p50/p95/p99 latency for key routes (`/api/v1/readings`, `/api/v1/mint`, `/api/v1/verify`) broken down by span name.

### Correlating traces with logs and Sentry

- The `X-Correlation-ID` from middleware is attached to the active span as the `correlation.id` attribute.
- The active trace ID is added to every log entry as `trace_id` and `span_id`, so a log line links directly to its trace in Tempo/Honeycomb.
- `createRequestLogger()` sets the Sentry tag `trace_id` alongside `correlationId`, so Sentry errors can be pivoted to the corresponding trace.

Search flow: Sentry error → `trace_id` tag → Tempo/Honeycomb trace → `correlation.id` → log aggregator query.
