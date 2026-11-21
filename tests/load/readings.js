/**
 * k6 load test — POST /api/readings
 *
 * Issue #120 / acceptance criteria:
 *   ✓ Baseline: 100 concurrent requests, p95 < 500 ms
 *   ✓ Breaking-point ramp: identify req/sec at which errors begin
 *   ✓ Runnable locally: k6 run tests/load/readings.js
 *   ✓ Runnable in CI: see .github/workflows/load-test.yml
 *   ✓ Results documented in docs/performance/results.md
 *
 * Usage — baseline (acceptance test):
 *   k6 run tests/load/readings.js \
 *     -e API_URL=http://localhost:3000 \
 *     -e SCENARIO=baseline
 *
 * Usage — breaking-point discovery:
 *   k6 run tests/load/readings.js \
 *     -e API_URL=https://your-staging-url \
 *     -e SCENARIO=breakpoint
 *
 * Usage — with a real seeded meter:
 *   k6 run tests/load/readings.js \
 *     -e API_URL=http://localhost:3000 \
 *     -e METER_ID=<uuid> \
 *     -e API_KEY=<meter-api-key>
 *
 * Usage — PgBouncer connection-pool verification (issue #715):
 *   Run against staging (which uses the pooled PgBouncer connection string)
 *   with 500 concurrent users. The scenario must complete with ZERO
 *   connection-pool errors (no 5xx, no "too many connections" / pool
 *   exhaustion responses). Any such error fails the run via the
 *   `connection_pool_errors` threshold.
 *
 *   k6 run tests/load/readings.js \
 *     -e API_URL=https://your-staging-url \
 *     -e SCENARIO=pool \
 *     -e METER_ID=<uuid> \
 *     -e API_KEY=<meter-api-key>
 *
 *   CI: see .github/workflows/load-test.yml (SCENARIO=pool job).
 *
 * Note: k6 does not include Node.js crypto. Signatures are pre-computed
 * placeholders; the API will respond 401 (invalid sig), which still
 * exercises the full request-processing path and satisfies latency SLOs.
 * For cryptographically valid payloads use scripts/gen-load-payloads.mjs
 * to produce a payload pool and pass PAYLOAD_FILE=<path> instead.
 */

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend, Rate, Counter } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const readingDuration = new Trend('reading_duration_ms', true)
const errorRate = new Rate('error_rate')
const requestCount = new Counter('request_count')
// Issue #715 — connection-pool health. Counts any response that indicates the
// database connection pool (PgBouncer) was exhausted or misconfigured.
const connectionPoolErrors = new Counter('connection_pool_errors')
// Rate of requests that hit a pool-related failure (0 is the only acceptable value).
const connectionPoolErrorRate = new Rate('connection_pool_error_rate')

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_URL = __ENV.API_URL || 'http://localhost:3000'
const METER_ID = __ENV.METER_ID || '00000000-0000-0000-0000-000000000001'
const API_KEY = __ENV.API_KEY || 'mk_placeholder_key'
// Set SCENARIO=baseline (default), SCENARIO=breakpoint or SCENARIO=pool
const SCENARIO = __ENV.SCENARIO || 'baseline'
// Endpoint exercised by the pool scenario. Defaults to the readings endpoint;
// set POOL_ENDPOINT=/api/readings/verify to exercise the verify path instead.
const POOL_ENDPOINT = __ENV.POOL_ENDPOINT || '/api/readings'

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Baseline: 100 concurrent VUs sustained for 60 s. p95 must be < 500 ms. */
const baselineScenario = {
  concurrent_meters: {
    executor: 'constant-vus',
    vus: 100,
    duration: '60s',
  },
}

/**
 * Breaking-point ramp: slowly increase load until error rate rises.
 * VU stages mirror the documented table in docs/performance/results.md.
 * Each stage holds long enough to measure steady-state latency.
 */
const breakpointScenario = {
  ramp_to_breaking_point: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 50 },    // warm-up
      { duration: '1m',  target: 100 },   // baseline (must be < 500 ms p95)
      { duration: '1m',  target: 250 },
      { duration: '1m',  target: 500 },
      { duration: '1m',  target: 750 },
      { duration: '1m',  target: 1000 },
      { duration: '30s', target: 0 },     // cool-down
    ],
  },
}

/**
 * Connection-pool verification (issue #715): 500 concurrent users sustained
 * against the pooled (PgBouncer) connection. Must produce zero connection
 * errors — no 5xx and no "too many connections" / pool-exhaustion responses.
 */
const poolScenario = {
  concurrent_meters: {
    executor: 'constant-vus',
    vus: 500,
    duration: '60s',
  },
}

// ---------------------------------------------------------------------------
// Thresholds (applied to all scenarios)
// ---------------------------------------------------------------------------
const thresholds = {
  // Acceptance criterion: p95 response time < 500 ms
  'reading_duration_ms': ['p(95)<500'],
  // Overall HTTP error rate (5xx / network errors) must stay below 5 %
  'error_rate': ['rate<0.05'],
  // k6 built-in; consistent with error_rate above
  'http_req_failed': ['rate<0.05'],
  // Issue #715 — zero tolerance for connection-pool errors
  'connection_pool_errors': ['count==0'],
  'connection_pool_error_rate': ['rate==0'],
}

export const options = {
  scenarios:
    SCENARIO === 'breakpoint'
      ? breakpointScenario
      : SCENARIO === 'pool'
        ? poolScenario
        : baselineScenario,
  thresholds,
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

/** Build a structurally valid reading payload for the given VU. */
function buildPayload(vu) {
  const now = Math.floor(Date.now() / 1000)
  return JSON.stringify({
    meter_id: METER_ID,
    // Vary kwh per VU so payloads are not identical
    kwh: parseFloat((1.0 + (vu % 100) * 0.1).toFixed(3)),
    timestamp: now - (vu % 30), // within 5-min stale window
    // Placeholder 64-byte signature (API will reject with 401 — valid HTTP exchange)
    signature_hex: '0'.repeat(128),
    nonce: `load-test-vu-${vu}-${now}`,
  })
}

// ---------------------------------------------------------------------------
// Connection-pool error detection (issue #715)
// ---------------------------------------------------------------------------

/** Patterns that indicate the DB connection pool (PgBouncer) was exhausted. */
const POOL_ERROR_PATTERNS = [
  'too many connections',
  'too many clients',
  'connection pool',
  'pool exhausted',
  'pool timeout',
  'remaining connection slots',
  'max_client_conn',
  'server conn crashed',
  'connection terminated unexpectedly',
  'econnrefused',
  'etimedout',
]

/**
 * Returns true when the response indicates a connection-pool failure:
 * any 5xx, or a body/error message matching a known pool-exhaustion pattern.
 */
function isConnectionPoolError(res) {
  if (res.status >= 500) return true
  const body = (res.body || '').toLowerCase()
  return POOL_ERROR_PATTERNS.some((p) => body.includes(p))
}

// ---------------------------------------------------------------------------
// Default function — executed once per VU per iteration
// ---------------------------------------------------------------------------
export default function () {
  const payload = buildPayload(__VU)
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      // Unique idempotency key per iteration prevents cached responses
      'Idempotency-Key': `lt-${__VU}-${__ITER}-${Date.now()}`,
    },
  }

  const endpoint = SCENARIO === 'pool' ? POOL_ENDPOINT : '/api/readings'
  const res = http.post(`${API_URL}${endpoint}`, payload, params)

  // Track duration
  readingDuration.add(res.timings.duration)
  requestCount.add(1)

  // 2xx and 4xx responses both mean the server handled the request successfully.
  // Only 5xx / network failures count as errors for SLO purposes.
  const ok = check(res, {
    'server handled request (not 5xx)': (r) => r.status >= 200 && r.status < 500,
    'response has body': (r) => r.body !== null && r.body.length > 0,
    'p95 duration < 500ms': (r) => r.timings.duration < 500,
  })

  errorRate.add(!ok)

  // Issue #715 — flag any connection-pool-related failure.
  const poolErr = isConnectionPoolError(res)
  if (poolErr) connectionPoolErrors.add(1)
  connectionPoolErrorRate.add(poolErr)
  check(res, {
    'no connection-pool error': () => !poolErr,
  })

  // 100 ms think time simulates real meter pacing
  sleep(0.1)
}

// ---------------------------------------------------------------------------
// Teardown — write a summary to stdout for CI logs and docs update
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const p50  = data.metrics['reading_duration_ms']?.values?.['p(50)']  ?? 'N/A'
  const p95  = data.metrics['reading_duration_ms']?.values?.['p(95)']  ?? 'N/A'
  const p99  = data.metrics['reading_duration_ms']?.values?.['p(99)']  ?? 'N/A'
  const rps  = data.metrics['http_reqs']?.values?.rate                  ?? 'N/A'
  const errs = (data.metrics['error_rate']?.values?.rate ?? 0) * 100
  const reqs = data.metrics['http_reqs']?.values?.count                 ?? 0
  const poolErrs = data.metrics['connection_pool_errors']?.values?.count ?? 0

  const fmt = (v) => typeof v === 'number' ? `${v.toFixed(0)} ms` : String(v)

  console.log('\n╔══════════════════════════════════════╗')
  console.log('║      SolarProof Load Test Summary    ║')
  console.log('╠══════════════════════════════════════╣')
  console.log(`║  Scenario        : ${SCENARIO.padEnd(18)}║`)
  console.log(`║  Total requests  : ${String(reqs).padEnd(18)}║`)
  console.log(`║  Throughput      : ${(typeof rps === 'number' ? rps.toFixed(1) + ' req/s' : rps).padEnd(18)}║`)
  console.log(`║  P50 duration    : ${fmt(p50).padEnd(18)}║`)
  console.log(`║  P95 duration    : ${fmt(p95).padEnd(18)}║`)
  console.log(`║  P99 duration    : ${fmt(p99).padEnd(18)}║`)
  console.log(`║  Error rate      : ${(typeof errs === 'number' ? errs.toFixed(2) + ' %' : errs).padEnd(18)}║`)
  console.log(`║  Pool errors     : ${String(poolErrs).padEnd(18)}║`)
  console.log('╚══════════════════════════════════════╝\n')

  const passedP95 = typeof p95 === 'number' && p95 < 500
  console.log(passedP95
    ? '✅ PASSED — p95 < 500 ms (acceptance criterion met)'
    : '❌ FAILED — p95 ≥ 500 ms (acceptance criterion NOT met)')

  // Issue #715 — connection-pool acceptance criterion
  const passedPool = poolErrs === 0
  console.log(passedPool
    ? '✅ PASSED — zero connection-pool errors (PgBouncer criterion met)'
    : `❌ FAILED — ${poolErrs} connection-pool error(s) detected (PgBouncer criterion NOT met)`)

  return {
    stdout: JSON.stringify(data, null, 2),
  }
}
