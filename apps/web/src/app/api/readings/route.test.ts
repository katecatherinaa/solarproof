/**
 * Tests for POST /api/readings
 *
 * Acceptance criteria:
 *  - All required fields are validated with typed schema
 *  - Invalid payloads return consistent 400 responses
 *  - Signature and numeric fields are validated before processing
 *  - Verified readings proceed to async anchor_and_mint job
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPublicKey, sign } from '@noble/ed25519'
import { computeReadingHash } from '@/lib/crypto'
import { kwhToStroops } from '@solarproof/stellar'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/stellar', () => ({
  anchorReading: vi.fn().mockResolvedValue('anchor_tx_abc'),
  mintCertificates: vi.fn().mockResolvedValue('mint_tx_abc'),
}))
vi.mock('@/lib/cache', () => ({
  invalidateCert: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
}))
vi.mock('@/lib/queue', () => ({
  enqueue: vi.fn().mockResolvedValue('job-id-test'),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, resetAt: Date.now() + 60_000, remaining: 9 }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))
vi.mock('@/lib/idempotency', () => ({
  getIdempotentResponse: vi.fn().mockResolvedValue(null),
  storeIdempotentResponse: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn().mockReturnValue(false),
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withCorrelationId: vi.fn().mockReturnThis(),
  },
}))
import { createServiceClient } from '@/lib/supabase'
import { POST } from '@/app/api/readings/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKeypair() {
  const privKey = crypto.getRandomValues(new Uint8Array(32))
  const pubKey = await getPublicKey(privKey)
  return {
    pubKeyHex: Buffer.from(pubKey).toString('hex'),
    privKey,
  }
}

const METER_ID = '123e4567-e89b-12d3-a456-426614174000'
const KWH = 12.5

async function makeBody(privKey: Uint8Array, overrides: Record<string, unknown> = {}) {
  const kwhStroops = kwhToStroops(KWH)
  const currentTimestamp = (overrides.timestamp as number) ?? Math.floor(Date.now() / 1000)
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

function makeRequest(body: unknown, apiKey = 'mk_test_api_key') {
  return {
    json: () => Promise.resolve(body),
    headers: { get: (key: string) => key === 'x-api-key' ? apiKey : null },
  } as unknown as Parameters<typeof POST>[0]
}

function mockDb(meter: unknown) {
  const meterSingle = vi.fn().mockResolvedValue({ data: meter, error: null })
  const coopSingle = vi.fn().mockResolvedValue({ data: { admin_address: 'GADMIN' }, error: null })
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: meterSingle }) }) })
  const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'reading-id-1' }, error: null })
  const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: insertSingle }) })

  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'meters') return { select }
      if (table === 'readings') return { insert }
      if (table === 'cooperatives') {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: coopSingle }) }) }
      }
      if (table === 'idempotency_keys') {
        return {
          select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }),
          delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        }
      }
      return {}
    }),
  } as unknown as ReturnType<typeof createServiceClient>)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/readings', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── 400 for malformed payloads ─────────────────────────────────────────────

  it('returns 400 when body is not JSON', async () => {
    const req = { json: () => Promise.reject(new Error('bad json')), headers: { get: () => null } } as unknown as Parameters<typeof POST>[0]
    expect((await POST(req)).status).toBe(400)
  })

  it('returns 400 when meter_id is missing', async () => {
    expect((await POST(makeRequest({ kwh: 1, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when meter_id is not a UUID', async () => {
    expect((await POST(makeRequest({ meter_id: 'not-a-uuid', kwh: KWH, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when kwh is negative', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: -1, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when kwh is zero', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: 0, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when kwh exceeds 1 000 000', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: 2_000_000, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when kwh is a string', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: '12.5', timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when signature_hex is wrong length', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'deadbeef', nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when signature_hex contains non-hex characters', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'z'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when timestamp is missing', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when timestamp looks like milliseconds (too large)', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: Date.now(), signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when timestamp is a float', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: 1_700_000_000.5, signature_hex: 'a'.repeat(128), nonce: 'n' }))).status).toBe(400)
  })

  it('returns 400 when nonce is missing', async () => {
    expect((await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: Math.floor(Date.now() / 1000), signature_hex: 'a'.repeat(128) }))).status).toBe(400)
  })

  // ── 404 for unknown meter ──────────────────────────────────────────────────

  it('returns 404 when meter is not found', async () => {
    mockDb(null)
    const { privKey } = await makeKeypair()
    expect((await POST(makeRequest(await makeBody(privKey)))).status).toBe(404)
  })

  // ── 401 for invalid signature ──────────────────────────────────────────────

  it('returns 401 when signature is signed by a different key', async () => {
    const { pubKeyHex } = await makeKeypair()
    const { privKey: wrongKey } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const res = await POST(makeRequest(await makeBody(wrongKey)))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/invalid meter signature/i)
  })

  it('returns 401 when signature_hex is all zeros', async () => {
    const { pubKeyHex } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const res = await POST(makeRequest({ meter_id: METER_ID, kwh: KWH, timestamp: Math.floor(Date.now() / 1000), signature_hex: '0'.repeat(128), nonce: 'n' }))
    expect(res.status).toBe(401)
  })

  // ── Valid signature enqueues job ───────────────────────────────────────────

  it('returns 202 and enqueues job when signature is valid', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const res = await POST(makeRequest(await makeBody(privKey)))
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.reading_id).toBeDefined()
    expect(json.job_id).toBeDefined()
  })

  it('enqueues anchor_and_mint job with correct reading hash', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const body = await makeBody(privKey)
    const { enqueue } = await import('@/lib/queue')
    await POST(makeRequest(body))
    expect(enqueue).toHaveBeenCalledOnce()
    const [jobName, payload] = vi.mocked(enqueue).mock.calls[0]
    expect(jobName).toBe('anchor_and_mint')
    expect(payload.readingHashHex).toBe(
      computeReadingHash(METER_ID, kwhToStroops(KWH), BigInt(body.timestamp)).toString('hex')
    )
    expect(payload.kwh).toBe(KWH)
    expect(kwhToStroops(KWH)).toBe(125_000_000n)
  })

  // ── API key validation ─────────────────────────────────────────────────────

  it('returns 401 when x-api-key header is missing', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const res = await POST(makeRequest(await makeBody(privKey), null as unknown as string))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/api key/i)
  })

  it('returns 401 when x-api-key is wrong', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb({ id: METER_ID, pubkey_hex: pubKeyHex, cooperative_id: 'coop-1', api_key: 'mk_test_api_key' })
    const res = await POST(makeRequest(await makeBody(privKey), 'mk_wrong_key'))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/api key/i)
  })
})
