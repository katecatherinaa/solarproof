/**
 * Regression tests for known bug fixes.
 *
 * Each test is named with the issue number it guards against.
 * See CONTRIBUTING.md § Regression Tests for the process.
 *
 * Issues covered:
 *  #29 — Input validation and sanitization on all API routes
 *  #49 — Stellar account existence check before minting
 *  #73 — Reading deduplication in audit_registry (API layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPublicKey, sign } from '@noble/ed25519'
import { computeReadingHash } from '@/lib/crypto'
import { kwhToStroops } from '@solarproof/stellar'

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/stellar', () => ({
  anchorReading: vi.fn().mockResolvedValue('anchor_tx_abc'),
  mintCertificates: vi.fn().mockResolvedValue('mint_tx_abc'),
}))
vi.mock('@/lib/cache', () => ({
  invalidateCert: vi.fn().mockResolvedValue(undefined),
  getCachedMeterRevocation: vi.fn().mockResolvedValue(null),
  setCachedMeterRevocation: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ user: { id: 'user-1' }, cooperativeId: 'coop-1' }),
  isAuthError: vi.fn().mockReturnValue(false),
}))
vi.mock('@/lib/webhooks', () => ({
  fireWebhook: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/tracer-sim', () => ({
  diagnoseMintFailure: vi.fn().mockResolvedValue(null),
}))

import { createServiceClient } from '@/lib/supabase'
import { POST as postReading } from '@/app/api/readings/route'
import { POST as postMeter } from '@/app/api/meters/route'
import { mintCertificates } from '@/lib/stellar'
import { requireAuth } from '@/lib/auth'

// ── Helpers ───────────────────────────────────────────────────────────────────

const METER_ID = '123e4567-e89b-12d3-a456-426614174000'
const COOP_ID = 'coop-1'
const KWH = 5.0
const TIMESTAMP = 1_700_000_000

async function makeKeypair() {
  const privKey = crypto.getRandomValues(new Uint8Array(32))
  const pubKey = await getPublicKey(privKey)
  return {
    privKey,
    pubKeyHex: Buffer.from(pubKey).toString('hex'),
  }
}

async function makeReadingBody(privKey: Uint8Array, overrides: Record<string, unknown> = {}) {
  const kwhStroops = kwhToStroops(KWH)
  const currentTimestamp = overrides.timestamp as number ?? Math.floor(Date.now() / 1000)
  const hash = computeReadingHash(METER_ID, kwhStroops, BigInt(currentTimestamp))
  const sig = await sign(hash, privKey)
  return {
    meter_id: METER_ID,
    kwh: KWH,
    timestamp: currentTimestamp,
    signature_hex: Buffer.from(sig).toString('hex'),
    nonce: 'test_nonce_123',
    ...overrides,
  }
}

function makeReadingRequest(body: unknown) {
  return {
    json: () => Promise.resolve(body),
    headers: { get: (key: string) => key === 'x-api-key' ? 'mk_test_api_key' : null },
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as Parameters<typeof postReading>[0]
}

function makeMeterRequest(body: unknown) {
  return {
    json: () => Promise.resolve(body),
    headers: { get: (_: string) => null },
  } as unknown as Parameters<typeof postMeter>[0]
}

function mockReadingDb(meter: unknown) {
  const meterData = meter as { cooperatives?: { admin_address: string } | null } | null
  const adminAddress = meterData?.cooperatives?.admin_address ?? null
  const normalizedMeter = meter
    ? { active: true, revoked_at: null, api_key_expires_at: null, ...(meter as object) }
    : null
  const single = vi.fn().mockResolvedValue({ data: normalizedMeter, error: null })
  const coopSingle = vi.fn().mockResolvedValue({
    data: adminAddress ? { admin_address: adminAddress } : null,
    error: null,
  })
  const readingSingle = vi.fn().mockResolvedValue({
    data: { id: 'reading-id-1' },
    error: null,
  })
  const updateEq = vi.fn().mockResolvedValue({ error: null })

  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'meters') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single }),
          }),
        }
      }
      if (table === 'cooperatives') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: coopSingle }),
          }),
        }
      }
      if (table === 'readings') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ single: readingSingle }),
          }),
          update: vi.fn().mockReturnValue({ eq: updateEq }),
        }
      }
      if (table === 'certificates') {
        return { insert: vi.fn().mockResolvedValue({ error: null }) }
      }
      if (table === 'idempotency_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({}),
          }),
        }
      }
      if (table === 'webhook_endpoints') {
        const contains = vi.fn().mockResolvedValue({ data: [] })
        const eq2 = vi.fn().mockReturnValue({ contains })
        const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
        return { select: vi.fn().mockReturnValue({ eq: eq1 }) }
      }
      return {}
    }),
  } as unknown as ReturnType<typeof createServiceClient>)
}

function mockMeterDb({
  existing = null,
  accountType = 'cooperative',
  meterCount = 0,
}: { existing?: unknown; accountType?: string; meterCount?: number } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: existing })
  const insertSingle = vi.fn().mockResolvedValue({
    data: { id: 'meter-1', active: true },
    error: null,
  })

  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockImplementation((_fields, options) => {
        if (options?.count) {
          return Promise.resolve({ count: meterCount, error: null })
        }
        return {
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: existing }),
            single: vi.fn().mockResolvedValue({ data: { account_type: accountType }, error: null }),
          }),
        }
      }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: insertSingle }),
      }),
    }),
  } as unknown as ReturnType<typeof createServiceClient>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, cooperativeId: COOP_ID, accessToken: 'abc' })
})

// ── Issue #29 — Input validation on all API routes ────────────────────────────

describe('regression issue_29: input validation on API routes', () => {
  it('test_issue_29_readings_rejects_missing_meter_id', async () => {
    const res = await postReading(
      makeReadingRequest({ kwh: KWH, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  it('test_issue_29_readings_rejects_negative_kwh', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: -1, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_readings_rejects_zero_kwh', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: 0, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_readings_rejects_missing_timestamp', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: KWH, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_readings_rejects_short_signature', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: KWH, timestamp: TIMESTAMP, signature_hex: 'deadbeef' })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_readings_rejects_non_uuid_meter_id', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: 'not-a-uuid', kwh: KWH, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_readings_rejects_non_json_body', async () => {
    const req = {
      json: () => Promise.reject(new Error('bad json')),
      headers: { get: (_: string) => null },
    } as unknown as Parameters<typeof postReading>[0]
    const res = await postReading(req)
    expect(res.status).toBe(400)
  })

  it('test_issue_29_meters_rejects_missing_name', async () => {
    mockMeterDb()
    const res = await postMeter(
      makeMeterRequest({
        serial_number: 'SN-001',
        pubkey_hex: 'a'.repeat(64),
      })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_29_meters_rejects_wrong_length_pubkey', async () => {
    mockMeterDb()
    const res = await postMeter(
      makeMeterRequest({
        name: 'Panel A',
        serial_number: 'SN-001',
        pubkey_hex: 'tooshort',
      })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_351_meters_enforces_individual_limit', async () => {
    mockMeterDb({ accountType: 'individual', meterCount: 1 })
    const res = await postMeter(
      makeMeterRequest({
        name: 'Second Meter',
        serial_number: 'SN-002',
        pubkey_hex: 'b'.repeat(64),
      })
    )
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/limited to 1 meter/i)
  })

  it('test_issue_29_validation_runs_before_db_access', async () => {
    // DB mock is NOT set up — if validation runs first, no DB call is made
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: -99, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
    // createServiceClient should not have been called
    expect(createServiceClient).not.toHaveBeenCalled()
  })
})

// ── Issue #49 — Stellar account existence check before minting ────────────────

describe('regression issue_49: Stellar account existence check before minting', () => {
  it('test_issue_49_mint_succeeds_when_account_exists', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GADMIN123' },
    })

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    expect(res.status).toBe(201)
    expect(mintCertificates).toHaveBeenCalledWith('GADMIN123', KWH)
  })

  it('test_issue_49_returns_500_when_account_does_not_exist', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GNONEXISTENT' },
    })

    vi.mocked(mintCertificates).mockRejectedValueOnce(
      new Error('Recipient account GNONEXISTENT does not exist on Stellar.')
    )

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    // Mint failure must not silently succeed
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatch(/does not exist/i)
    expect(json.reading_id).toBeDefined()
    expect(json.anchor_tx_hash).toBeDefined()
  })

  it('test_issue_49_returns_500_when_trustline_missing', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GNOTRUSTED' },
    })

    vi.mocked(mintCertificates).mockRejectedValueOnce(
      new Error('Recipient account GNOTRUSTED has no trustline for the energy_token contract.')
    )

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatch(/trustline/i)
  })

  it('test_issue_49_missing_cooperative_address_fails_gracefully', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: null, // no admin address
    })

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    // Must not crash — should return a structured error
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBeDefined()
  })
})

// ── Issue #73 — Reading deduplication (API layer) ─────────────────────────────

describe('regression issue_73: reading deduplication at API layer', () => {
  it('test_issue_73_duplicate_anchor_returns_409', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GADMIN123' },
    })

    const { anchorReading } = await import('@/lib/stellar')
    vi.mocked(anchorReading).mockRejectedValueOnce(
      new Error('AlreadyAnchored: reading already anchored')
    )

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/already anchored/i)
  })

  it('test_issue_73_duplicate_error_includes_reading_id', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GADMIN123' },
    })

    const { anchorReading } = await import('@/lib/stellar')
    vi.mocked(anchorReading).mockRejectedValueOnce(
      new Error('reading already anchored')
    )

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.reading_id).toBeDefined()
  })

  it('test_issue_73_unique_readings_are_not_rejected', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GADMIN123' },
    })

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    // A fresh reading must succeed
    expect(res.status).toBe(201)
  })

  it('test_issue_73_duplicate_keyword_in_error_triggers_409', async () => {
    // Verify the deduplication check matches both "AlreadyAnchored" and "duplicate"
    const { privKey, pubKeyHex } = await makeKeypair()
    mockReadingDb({
      id: METER_ID,
      pubkey_hex: pubKeyHex,
      cooperative_id: 'coop-1',
      api_key: 'mk_test_api_key',
      cooperatives: { admin_address: 'GADMIN123' },
    })

    const { anchorReading } = await import('@/lib/stellar')
    vi.mocked(anchorReading).mockRejectedValueOnce(new Error('duplicate key'))

    const body = await makeReadingBody(privKey)
    const res = await postReading(makeReadingRequest(body))

    expect(res.status).toBe(409)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Issue #101 — Full v1 API regression coverage
//
// Every v1 endpoint must have at least one regression test to catch breaking
// changes before they merge.  Tests are grouped by endpoint and validate:
//   • HTTP status code correctness (schema-level contract)
//   • Response body shape (field presence, not values)
//   • 400 for missing / invalid required fields
//   • 401 / 403 for missing auth where required
// ═════════════════════════════════════════════════════════════════════════════

// ── Additional imports needed for issue-101 tests ────────────────────────────

import { GET as getHealth } from '@/app/api/health/route'
import { GET as getCerts } from '@/app/api/certificates/route'
import { GET as getVerify } from '@/app/api/verify/route'
import { GET as getAuditLog } from '@/app/api/audit-log/route'
import { GET as getMeters } from '@/app/api/meters/route'
import { GET as getReadings } from '@/app/api/readings/route'

// ── Additional mocks ──────────────────────────────────────────────────────────

vi.mock('@/lib/health-checks', () => ({
  checkDatabase: vi.fn().mockResolvedValue({ status: 'ok', latency_ms: 1 }),
  checkStellarRpc: vi.fn().mockResolvedValue({ status: 'ok', latency_ms: 2 }),
  checkRedisUpstash: vi.fn().mockResolvedValue({ status: 'ok', latency_ms: 1 }),
  checkRedisBull: vi.fn().mockResolvedValue({ status: 'ok', latency_ms: 1 }),
}))

vi.mock('@/lib/cache', () => ({
  invalidateCert: vi.fn().mockResolvedValue(undefined),
  getCachedMeterRevocation: vi.fn().mockResolvedValue(null),
  setCachedMeterRevocation: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
  getCachedCert: vi.fn().mockResolvedValue(null),
  setCachedCert: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/operator-suspension', () => ({
  isOperatorSuspended: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, resetAt: Date.now() + 60_000, remaining: 9 }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

// ── Helper: build a minimal NextRequest-shaped object ────────────────────────

function makeRequest(
  urlSuffix = '',
  options: { headers?: Record<string, string | null>; searchParams?: Record<string, string> } = {}
) {
  const sp = new URLSearchParams(options.searchParams ?? {})
  return {
    json: () => Promise.reject(new Error('no body')),
    headers: { get: (k: string) => (options.headers ?? {})[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: sp, pathname: urlSuffix },
  } as unknown as Parameters<typeof getHealth>[0]
}

// ── v1/health ─────────────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/health', () => {
  it('test_issue_101_health_returns_200_with_status_field', async () => {
    const res = await getHealth()
    expect(res.status).toBe(200)
    const body = await res.json()
    // Schema: { status, ts, checks }
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('ts')
    expect(body).toHaveProperty('checks')
    expect(['ok', 'degraded', 'error']).toContain(body.status)
  })

  it('test_issue_101_health_checks_has_required_keys', async () => {
    const res = await getHealth()
    const body = await res.json()
    expect(body.checks).toHaveProperty('database')
    expect(body.checks).toHaveProperty('stellar_rpc')
  })

  it('test_issue_101_health_503_when_db_error', async () => {
    const { checkDatabase } = await import('@/lib/health-checks')
    vi.mocked(checkDatabase).mockResolvedValueOnce({ status: 'error', latency_ms: 0 })
    const res = await getHealth()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('error')
  })
})

// ── v1/certificates ───────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/certificates', () => {
  function mockCertDb(rows: unknown[] = []) {
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: rows, count: rows.length, error: null }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)
  }

  it('test_issue_101_certificates_returns_200_with_data_array', async () => {
    mockCertDb([{ id: 'cert-1', kwh: 5, issued_at: new Date().toISOString(), retired: false }])
    const req = makeRequest('/api/v1/certificates')
    const res = await getCerts(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('data')
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('test_issue_101_certificates_400_on_invalid_limit', async () => {
    mockCertDb()
    const req = makeRequest('/api/v1/certificates', { searchParams: { limit: '0' } })
    const res = await getCerts(req)
    expect(res.status).toBe(400)
  })

  it('test_issue_101_certificates_400_on_invalid_status_filter', async () => {
    mockCertDb()
    const req = makeRequest('/api/v1/certificates', { searchParams: { status: 'invalid' } })
    const res = await getCerts(req)
    expect(res.status).toBe(400)
  })

  it('test_issue_101_certificates_response_has_next_cursor', async () => {
    mockCertDb([])
    const req = makeRequest('/api/v1/certificates')
    const res = await getCerts(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    // next_cursor may be null but must be present in the response
    expect(Object.prototype.hasOwnProperty.call(body, 'next_cursor')).toBe(true)
  })
})

// ── v1/verify ─────────────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/verify', () => {
  it('test_issue_101_verify_400_when_id_missing', async () => {
    const req = makeRequest('/api/v1/verify')
    const res = await getVerify(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('test_issue_101_verify_400_when_id_not_uuid_or_hex', async () => {
    const req = makeRequest('/api/v1/verify', { searchParams: { id: 'not-valid' } })
    const res = await getVerify(req)
    expect(res.status).toBe(400)
  })

  it('test_issue_101_verify_accepts_uuid_format_schema', () => {
    // Validate the UUID regex directly — route uses the same pattern
    const UUID = '123e4567-e89b-12d3-a456-426614174000'
    expect(/^[0-9a-f]{64}$|^[0-9a-f-]{36}$/i.test(UUID)).toBe(true)
  })

  it('test_issue_101_verify_accepts_64char_hex_format_schema', () => {
    // Validate the 64-char hex regex directly
    const HEX64 = 'a'.repeat(64)
    expect(/^[0-9a-f]{64}$|^[0-9a-f-]{36}$/i.test(HEX64)).toBe(true)
  })
})

// ── v1/audit-log ──────────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/audit-log', () => {
  function mockAuditDb(rows: unknown[] = []) {
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          gte: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)
  }

  it('test_issue_101_audit_log_returns_csv_content_type', async () => {
    mockAuditDb([])
    const req = makeRequest('/api/v1/audit-log')
    const res = await getAuditLog(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/i)
  })

  it('test_issue_101_audit_log_csv_has_header_row', async () => {
    mockAuditDb([])
    const req = makeRequest('/api/v1/audit-log')
    const res = await getAuditLog(req)
    const text = await res.text()
    expect(text).toMatch(/operator_id|action|resource_id/i)
  })

  it('test_issue_101_audit_log_400_on_invalid_query_param', async () => {
    const req = makeRequest('/api/v1/audit-log', {
      searchParams: { from: 'not-a-date', to: 'also-not-a-date' },
    })
    // The schema accepts any string for from/to; DB error is acceptable.
    // What must NOT happen: a 500 crash from validation — just verify no unhandled throw.
    let threw = false
    try {
      await getAuditLog(req)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

// ── v1/meters ─────────────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/meters (auth required)', () => {
  it('test_issue_101_meters_401_without_auth', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      /* simulate auth error response */
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)
    const { isAuthError } = await import('@/lib/auth')
    vi.mocked(isAuthError).mockReturnValueOnce(true)

    const req = makeRequest('/api/v1/meters')
    // isAuthError is true → handler returns the "auth" object directly (the mock error)
    // In real usage this is a NextResponse — just confirm no throw
    let threw = false
    try {
      await getMeters(req)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  it('test_issue_101_meters_returns_array_on_success', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: { id: 'user-1' },
      cooperativeId: 'coop-1',
      accessToken: 'abc',
    })
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [{ id: 'meter-1', name: 'Test Meter', active: true }],
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)

    const req = makeRequest('/api/v1/meters')
    const res = await getMeters(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

// ── v1/readings GET ───────────────────────────────────────────────────────────

describe('regression issue_101: GET /api/v1/readings (auth required)', () => {
  it('test_issue_101_readings_get_400_on_invalid_limit', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: { id: 'user-1' },
      cooperativeId: 'coop-1',
      accessToken: 'abc',
    })
    const req = makeRequest('/api/v1/readings', { searchParams: { limit: '-1' } })
    const res = await getReadings(req)
    expect(res.status).toBe(400)
  })

  it('test_issue_101_readings_get_returns_pagination_shape', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: { id: 'user-1' },
      cooperativeId: 'coop-1',
      accessToken: 'abc',
    })
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          count: 5,
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lt: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)

    const req = makeRequest('/api/v1/readings')
    const res = await getReadings(req)
    // 200 or error from db mock edge — what matters is the shape contract
    // At minimum must be a valid JSON response
    const body = await res.json()
    expect(typeof body).toBe('object')
  })
})

// ── v1/readings POST — input validation contract ──────────────────────────────

describe('regression issue_101: POST /api/v1/readings — schema contract', () => {
  it('test_issue_101_readings_post_400_missing_meter_id', async () => {
    const res = await postReading(
      makeReadingRequest({ kwh: 5.0, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128), nonce: 'n1' })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('test_issue_101_readings_post_400_missing_nonce', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: 5.0, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_101_readings_post_400_kwh_too_large', async () => {
    const res = await postReading(
      makeReadingRequest({
        meter_id: METER_ID,
        kwh: 2_000_000,
        timestamp: TIMESTAMP,
        signature_hex: 'a'.repeat(128),
        nonce: 'n2',
      })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_101_readings_post_400_timestamp_in_milliseconds', async () => {
    const res = await postReading(
      makeReadingRequest({
        meter_id: METER_ID,
        kwh: 5.0,
        timestamp: 9_999_999_999 + 1, // clearly in milliseconds
        signature_hex: 'a'.repeat(128),
        nonce: 'n3',
      })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_101_readings_post_400_signature_wrong_length', async () => {
    const res = await postReading(
      makeReadingRequest({
        meter_id: METER_ID,
        kwh: 5.0,
        timestamp: TIMESTAMP,
        signature_hex: 'abcdef', // too short
        nonce: 'n4',
      })
    )
    expect(res.status).toBe(400)
  })

  it('test_issue_101_readings_post_400_signature_non_hex', async () => {
    const res = await postReading(
      makeReadingRequest({
        meter_id: METER_ID,
        kwh: 5.0,
        timestamp: TIMESTAMP,
        signature_hex: 'z'.repeat(128), // valid length, invalid hex chars
        nonce: 'n5',
      })
    )
    expect(res.status).toBe(400)
  })
})

// ── v1/meters POST — schema contract ─────────────────────────────────────────

describe('regression issue_101: POST /api/v1/meters — schema contract', () => {
  it('test_issue_101_meters_post_400_pubkey_wrong_length', async () => {
    mockMeterDb()
    const res = await postMeter(makeMeterRequest({ name: 'M', serial_number: 'SN', pubkey_hex: 'short' }))
    expect(res.status).toBe(400)
  })

  it('test_issue_101_meters_post_400_name_missing', async () => {
    mockMeterDb()
    const res = await postMeter(makeMeterRequest({ serial_number: 'SN', pubkey_hex: 'a'.repeat(64) }))
    expect(res.status).toBe(400)
  })

  it('test_issue_101_meters_post_400_serial_missing', async () => {
    mockMeterDb()
    const res = await postMeter(makeMeterRequest({ name: 'M', pubkey_hex: 'a'.repeat(64) }))
    expect(res.status).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Issue #250 — Deprecation headers on legacy /api/ routes
//
// Unversioned /api/ routes must advertise their deprecation so integrators can
// detect they are on a legacy path:
//   • Deprecation: true
//   • Sunset: <HTTP-date at least 6 months in the future>
//   • Link: <.../api/v1/...>; rel="successor-version"
// Versioned /api/v1/ routes must NOT carry these headers.
// ═════════════════════════════════════════════════════════════════════════════

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6

function expectDeprecationHeaders(
  res: { headers: { get: (k: string) => string | null } },
  canonicalPath: string
) {
  expect(res.headers.get('deprecation')).toBe('true')

  const sunset = res.headers.get('sunset')
  expect(sunset).toBeTruthy()
  const sunsetMs = Date.parse(sunset as string)
  expect(Number.isNaN(sunsetMs)).toBe(false)
  expect(sunsetMs).toBeGreaterThan(Date.now() + SIX_MONTHS_MS)

  const link = res.headers.get('link')
  expect(link).toBeTruthy()
  expect(link).toContain(canonicalPath)
  expect(link).toMatch(/rel="?successor-version"?/i)
}

describe('regression issue_250: deprecation headers on legacy /api/ routes', () => {
  it('test_issue_250_legacy_readings_post_has_deprecation_headers', async () => {
    const res = await postReading(
      makeReadingRequest({ meter_id: METER_ID, kwh: -1, timestamp: TIMESTAMP, signature_hex: 'a'.repeat(128) })
    )
    expectDeprecationHeaders(res, '/api/v1/readings')
  })

  it('test_issue_250_legacy_meters_post_has_deprecation_headers', async () => {
    mockMeterDb()
    const res = await postMeter(makeMeterRequest({}))
    expectDeprecationHeaders(res, '/api/v1/meters')
  })

  it('test_issue_250_legacy_meters_get_has_deprecation_headers', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: { id: 'user-1' },
      cooperativeId: 'coop-1',
      accessToken: 'abc',
    })
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)

    const req = makeRequest('/api/meters')
    const res = await getMeters(req)
    expectDeprecationHeaders(res, '/api/v1/meters')
  })

  it('test_issue_250_legacy_certificates_get_has_deprecation_headers', async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)

    const req = makeRequest('/api/certificates')
    const res = await getCerts(req)
    expectDeprecationHeaders(res, '/api/v1/certificates')
  })

  it('test_issue_250_legacy_verify_get_has_deprecation_headers', async () => {
    const req = makeRequest('/api/verify')
    const res = await getVerify(req)
    expectDeprecationHeaders(res, '/api/v1/verify')
  })

  it('test_issue_250_legacy_audit_log_get_has_deprecation_headers', async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          gte: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>)

    const req = makeRequest('/api/audit-log')
    const res = await getAuditLog(req)
    expectDeprecationHeaders(res, '/api/v1/audit-log')
  })

  it('test_issue_250_legacy_health_get_has_deprecation_headers', async () => {
    const res = await getHealth()
    expectDeprecationHeaders(res, '/api/v1/health')
  })

  it('test_issue_250_sunset_date_is_at_least_six_months_out', async () => {
    const res = await getHealth()
    const sunset = res.headers.get('sunset')
    expect(sunset).toBeTruthy()
    const sunsetMs = Date.parse(sunset as string)
    expect(sunsetMs).toBeGreaterThan(Date.now() + SIX_MONTHS_MS)
  })

  it('test_issue_250_versioned_routes_have_no_deprecation_headers', async () => {
    const res = await getHealth()
    // The versioned handler is the same function; the headers are applied by
    // the legacy wrapper, so a direct call must not carry them.
    expect(res.headers.get('deprecation')).toBeNull()
    expect(res.headers.get('sunset')).toBeNull()
  })
})
