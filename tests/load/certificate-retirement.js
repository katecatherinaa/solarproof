import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics for the certificate retirement scenario
const successCount = new Counter('success_count');
const conflictCount = new Counter('conflict_count');
const serverErrorCount = new Counter('server_error_count');
const otherCount = new Counter('other_count');

// Configuration via environment variables
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CERTIFICATE_ID = __ENV.CERTIFICATE_ID || '';
const API_TOKEN = __ENV.API_TOKEN || '';
const VUS = parseInt(__ENV.VUS || '50', 10);

// Shared state to track how many successful retirements occurred across all VUs.
// k6 does not share JS memory between VUs, so we rely on the server's response
// codes to determine the winner: exactly one request should get a 200 and the
// rest should get 409 (or an idempotent 200 if the API treats retirement as
// idempotent). The thresholds below enforce that invariant.
export const options = {
  scenarios: {
    concurrent_retirement: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    // Exactly one successful retirement across the whole scenario.
    success_count: ['count==1'],
    // No server errors allowed.
    server_error_count: ['count==0'],
    // Every request must complete successfully at the HTTP level.
    http_req_failed: ['rate==0'],
  },
};

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (API_TOKEN) {
    headers['Authorization'] = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

// Create a fresh certificate to retire if no CERTIFICATE_ID was provided.
// This runs once in the init context of the first VU that needs it; to keep
// things simple and deterministic we create it in setup().
export function setup() {
  if (CERTIFICATE_ID) {
    return { certificateId: CERTIFICATE_ID };
  }

  const headers = buildHeaders();
  const payload = JSON.stringify({
    subject: `load-test-${randomString(8)}`,
    // Minimal payload; adjust fields to match the certificate creation API.
  });

  const res = http.post(`${BASE_URL}/api/certificates`, payload, { headers });

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `Failed to create certificate for load test: status=${res.status} body=${res.body}`
    );
  }

  let certificateId;
  try {
    const body = res.json();
    certificateId = body.id || body.certificateId || body.certificate_id;
  } catch (e) {
    throw new Error(`Failed to parse certificate creation response: ${res.body}`);
  }

  if (!certificateId) {
    throw new Error(`Certificate creation response missing id: ${res.body}`);
  }

  return { certificateId };
}

export default function (data) {
  const certificateId = data.certificateId;
  const url = `${BASE_URL}/api/certificates/${certificateId}/retire`;
  const headers = buildHeaders();

  const res = http.post(url, null, { headers, tags: { name: 'retire_certificate' } });

  // Classify the response.
  if (res.status === 200) {
    successCount.add(1);
  } else if (res.status === 409) {
    conflictCount.add(1);
  } else if (res.status >= 500) {
    serverErrorCount.add(1);
  } else {
    otherCount.add(1);
  }

  check(res, {
    'retire response is 200, 409, or idempotent 200': (r) =>
      r.status === 200 || r.status === 409,
    'retire response is not a 5xx server error': (r) => r.status < 500,
    'retire response is not a 4xx client error other than 409': (r) =>
      r.status === 200 || r.status === 409,
  });
}

export function teardown(data) {
  // Best-effort cleanup: nothing to do for retirement itself, but if we
  // created a certificate we could delete it here. Left as a no-op to avoid
  // interfering with the retirement state under test.
  if (!CERTIFICATE_ID && data && data.certificateId) {
    // Optionally delete the certificate to keep the environment clean.
    // http.del(`${BASE_URL}/api/certificates/${data.certificateId}`, null, {
    //   headers: buildHeaders(),
    // });
  }
}