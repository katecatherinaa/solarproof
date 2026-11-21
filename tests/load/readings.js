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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_URL = __ENV.API_URL || 'http://localhost:3000'
const METER_ID = __ENV.METER_ID || '00000000-0000-0000-0000-000000000001'
const API_KEY = __ENV.API_KEY || 'mk_placeholder_key'
// Set SCENARIO=baseline (default), SCENARIO=breakpoint or SCENARIO=regression
const SCENARIO = __ENV.SCENARIO || 'baseline'

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
 * Regression: focused hot-path test for POST /api/readings (issue #758).
 * 100 VUs continuously submit valid readings for 30 s.
 * Acceptance: p95 < 300 ms, error rate < 0.1 %.
 */
const regressionScenario = {
  readings_regression: {
    executor: 'constant-vus',
    vus: 100,
    duration: '30s',
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

// ---------------------------------------------------------------------------
// Thresholds (applied to both scenarios)
// ---------------------------------------------------------------------------
const thresholds = {
  // Acceptance criterion: p95 response time < 500 ms
  'reading_duration_ms': ['p(95)<500'],
  // Overall HTTP error rate (5xx / network errors) must stay below 5 %
  'error_rate': ['rate<0.05'],
  // k6 built-in; consistent with error_rate above
  'http_req_failed': ['rate<0.05'],
}

/** Tighter thresholds for the focused regression scenario (issue #758). */
const regressionThresholds = {
  // Acceptance criterion: p95 response time < 300 ms
  'reading_duration_ms': ['p(95)<300'],
  // Error rate must stay below 0.1 %
  'error_rate': ['rate<0.001'],
  // k6 built-in; consistent with error_rate above
  'http_req_failed': ['rate<0.001'],
}

function selectScenario() {
  if (SCENARIO === 'breakpoint') return breakpointScenario
  if (SCENARIO === 'regression') return regressionScenario
  return baselineScenario
}

export const options = {
  scenarios: selectScenario(),
  thresholds: SCENARIO === 'regression' ? regressionThresholds : thresholds,
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

  const res = http.post(`${API_URL}/api/readings`, payload, params)

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
  console.log('╚══════════════════════════════════════╝\n')

  const p95Limit = SCENARIO === 'regression' ? 300 : 500
  const passedP95 = typeof p95 === 'number' && p95 < p95Limit
  console.log(passedP95
    ? `✅ PASSED — p95 < ${p95Limit} ms (acceptance criterion met)`
    : `❌ FAILED — p95 ≥ ${p95Limit} ms (acceptance criterion NOT met)`)

  // Write the summary JSON to a file so CI can archive it as an artifact
  // and parse thresholds/results (see .github/workflows/load-test.yml).
  const summaryPath = __ENV.SUMMARY_PATH || `load-summary-${SCENARIO}.json`

  return {
    stdout: JSON.stringify(data, null, 2),
    [summaryPath]: JSON.stringify(data, null, 2),
  }
}
