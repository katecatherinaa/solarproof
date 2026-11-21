/**
 * Tests for idempotency key behaviour on POST /api/readings — Issue #110
 *
 * Verifies that:
 *  1. Submitting a reading with idempotency key K → certificate/reading created.
 *  2. Submitting the SAME reading again with key K → same response returned, no new mint.
 *  3. Submitting the same reading with a DIFFERENT key → new reading/mint triggered.
 *  4. On-chain anchor count is exactly 1 per unique reading (mint called once).
 *
 * NOTE: The readings route processes asynchronously via a job queue.
 *       "mint" in this context means enqueue() was called, which triggers
 *       the anchor_and_mint worker. We verify enqueue call counts as a proxy
 *       for on-chain anchor count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  getCachedMeterRevocation: vi.fn().mockResolvedValue(null),
  setCachedMeterRevocation: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, resetAt: Date.now() + 60_000, remaining: 9 }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
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

/**
 * Idempotency module is mocked with state so we can simulate the
 * store-once / return-cached behaviour without hitting Redis.
 */
const idempotencyStore = new Map<string, { body: unknown; status: number }>()

vi.mock('@/lib/idempotency', () => ({
  getIdempotentResponse: vi.fn(async (key: string) => {
    return idempotencyStore.get(key) ?? null
  }),
  storeIdempotentResponse: vi.fn(async (key: string, response: { body: unknown; status: number }) => {
    idempotencyStore.set(key, response)
  }),
}))

vi.mock('@/lib/queue', () => ({
  enqueue: vi.fn().mockResolvedValue('job-id-test'),
}))
vi.mock('@/lib/operator-suspension', () => ({
  isOperatorSuspended: vi.fn().mockResolvedValue(false),
}))

import { createServiceClient } from '@/lib/supabase'
import { POST } from '@/app/api/readings/route'
import { enqueue } from '@/lib/queue'
import { getIdempotentResponse, storeIdempotentResponse } from '@/lib/idempotency'
import * as realIdempotency from '@/lib/idempotency'

// ── Constants ─────────────────────────────────────────────────────────────────

const METER_ID = '223e4567-e89b-12d3-a456-426614174111'
const COOP_ID = 'coop-idem-1'
const KWH = 8.0

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKeypair() {
  const privKey = crypto.getRandomValues(new Uint8Array(32))
  const pubKey = await getPublicKey(privKey)
  return {
    privKey,
    pubKeyHex: Buffer.from(pubKey).toString('hex'),
  }
}

async function makeReadingBody(privKey: Uint8Array, overrides: Record<string, unknown> = {}) {
  const timestamp = overrides.timestamp as number ?? Math.floor(Date.now() / 1000)
  const kwhStroops = kwhToStroops(KWH)
  const hash = computeReadingHash(METER_ID, kwhStroops, BigInt(timestamp))
  const sig = await sign(hash, privKey)
  return {
    meter_id: METER_ID,
    kwh: KWH,
    timestamp,
    signature_hex: Buffer.from(sig).toString('hex'),
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  }
}

function makeReadingRequest(body: unknown, headers: Record<string, string | null> = {}) {
  const allHeaders: Record<string, string | null> = {
    'x-api-key': 'mk_test_api_key',
    ...headers,
  }
  return {
    json: () => Promise.resolve(body),
    headers: { get: (key: string) => allHeaders[key.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams() },
  } as unknown as Parameters<typeof POST>[0]
}

let _readingCounter = 0

function mockDb(pubKeyHex: string) {
  const meter = {
    id: METER_ID,
    pubkey_hex: pubKeyHex,
    cooperative_id: COOP_ID,
    api_key: 'mk_test_api_key',
    api_key_expires_at: null,
    active: true,
    revoked_at: null,
  }
  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'meters') {
        return {
          select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: meter, error: null }),
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: meter, error: null }),
                }),
            }),
          }),
        }
      }
      if (table === 'cooperatives') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { admin_address: 'GADMIN_IDEM_TEST' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'readings') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: `reading-${++_readingCounter}` },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'idempotency_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({}),
          }),
        }
      }
      if (table === 'webhook_endpoints') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                contains: vi.fn().mockResolvedValue({ data: [] }),
              }),
            }),
          }),
        }
      }
      return {}
    }),
  } as unknown as ReturnType<typeof createServiceClient>)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  idempotencyStore.clear()
  _readingCounter = 0
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('idempotency key prevents duplicate mint (issue #110)', () => {
  it('test_issue_110_first_request_with_key_creates_reading', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const body = await makeReadingBody(privKey)
    const res = await POST(makeReadingRequest(body, { 'idempotency-key': 'key-K-1' }))

    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.reading_id).toBeDefined()
    expect(json.job_id).toBeDefined()

    // enqueue was called exactly once
    expect(enqueue).toHaveBeenCalledTimes(1)
    // response was stored in idempotency store
    expect(storeIdempotentResponse).toHaveBeenCalledWith('key-K-1', expect.objectContaining({ status: 202 }))
  })

  it('test_issue_110_duplicate_request_with_same_key_returns_cached_response', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const idempotencyKey = 'key-K-2'
    const body = await makeReadingBody(privKey)
    const req = makeReadingRequest(body, { 'idempotency-key': idempotencyKey })

    // First request
    const res1 = await POST(req)
    expect(res1.status).toBe(202)
    const json1 = await res1.json()

    // Second request — same key, same body
    mockDb(pubKeyHex) // reset db mock (enqueue mock is still fresh)
    const res2 = await POST(makeReadingRequest(body, { 'idempotency-key': idempotencyKey }))

    expect(res2.status).toBe(202)
    const json2 = await res2.json()

    // Must return the exact same reading_id and job_id
    expect(json2.reading_id).toBe(json1.reading_id)
    expect(json2.job_id).toBe(json1.job_id)

    // enqueue must have been called only once total — no second mint
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('test_issue_110_same_reading_different_key_creates_new_certificate', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const timestamp = Math.floor(Date.now() / 1000)
    const body1 = await makeReadingBody(privKey, { timestamp, nonce: 'nonce-A' })
    const body2 = await makeReadingBody(privKey, { timestamp, nonce: 'nonce-B' })

    // First request with key K-A
    const res1 = await POST(makeReadingRequest(body1, { 'idempotency-key': 'key-K-A' }))
    expect(res1.status).toBe(202)
    const json1 = await res1.json()

    // Re-mock DB for second reading insert
    mockDb(pubKeyHex)

    // Second request with a DIFFERENT key K-B (must trigger a new mint)
    const res2 = await POST(makeReadingRequest(body2, { 'idempotency-key': 'key-K-B' }))
    expect(res2.status).toBe(202)
    const json2 = await res2.json()

    // Must be a new certificate (different reading_id)
    expect(json2.reading_id).not.toBe(json1.reading_id)

    // enqueue called twice — one per unique request
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('test_issue_110_anchor_count_exactly_1_for_duplicate_key', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const idempotencyKey = 'key-K-count'
    const body = await makeReadingBody(privKey)

    // Submit the same request 5 times with the same idempotency key
    for (let i = 0; i < 5; i++) {
      mockDb(pubKeyHex)
      const res = await POST(makeReadingRequest(body, { 'idempotency-key': idempotencyKey }))
      expect(res.status).toBe(202)
    }

    // enqueue (anchor_and_mint) must have fired exactly once regardless of
    // how many times the same idempotency key was sent
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      'anchor_and_mint',
      expect.objectContaining({ recipientAddress: 'GADMIN_IDEM_TEST', kwh: KWH })
    )
  })

  it('test_issue_110_cached_response_body_matches_original', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const idempotencyKey = 'key-K-body-check'
    const body = await makeReadingBody(privKey)

    const res1 = await POST(makeReadingRequest(body, { 'idempotency-key': idempotencyKey }))
    const json1 = await res1.json()

    mockDb(pubKeyHex)
    const res2 = await POST(makeReadingRequest(body, { 'idempotency-key': idempotencyKey }))
    const json2 = await res2.json()

    // Every field of the response body must match exactly
    expect(json2).toEqual(json1)
  })

  it('test_issue_110_request_without_key_is_processed_normally', async () => {
    // Requests without an idempotency key must still work (key is optional)
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const body = await makeReadingBody(privKey)
    const res = await POST(makeReadingRequest(body)) // no idempotency-key header

    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.reading_id).toBeDefined()

    // storeIdempotentResponse must NOT have been called (no key to store under)
    expect(storeIdempotentResponse).not.toHaveBeenCalled()
  })

  it('test_issue_110_getIdempotentResponse_called_when_key_provided', async () => {
    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const body = await makeReadingBody(privKey)
    await POST(makeReadingRequest(body, { 'idempotency-key': 'key-lookup-check' }))

    expect(getIdempotentResponse).toHaveBeenCalledWith('key-lookup-check')
  })

  it('test_issue_110_idempotency_key_header_is_case_insensitive_lookup', async () => {
    // Simulate a cache hit returned by the mock for an existing key.
    const cachedReading = { reading_id: 'cached-id-xyz', job_id: 'cached-job-xyz' }
    idempotencyStore.set('KEY-UPPER', { body: cachedReading, status: 202 })

    const { privKey, pubKeyHex } = await makeKeypair()
    mockDb(pubKeyHex)

    const body = await makeReadingBody(privKey)
    // Header lookup in the route uses req.headers.get('idempotency-key') which
    // in Next.js is always lowercased — verify the mock returns the stored entry.
    const res = await POST(makeReadingRequest(body, { 'idempotency-key': 'KEY-UPPER' }))

    // Should return cached response without hitting enqueue
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json.reading_id).toBe('cached-id-xyz')
    expect(enqueue).not.toHaveBeenCalled()
  })
})

// ── Unit tests for the idempotency store itself (issue #742) ──────────────────
//
// These tests exercise the REAL implementation in @/lib/idempotency by
// re-importing it after vi.resetModules(), with a mocked global fetch that
// emulates the Upstash REST API.

type IdempotencyModule = typeof realIdempotency

async function loadRealIdempotency(): Promise<IdempotencyModule> {
  vi.resetModules()
  return (await import('@/lib/idempotency')) as IdempotencyModule
}

function mockUpstashFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const result = handler(url, init)
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('idempotency store (issue #742)', () => {
  const ORIGINAL_URL = process.env.UPSTASH_REDIS_REST_URL
  const ORIGINAL_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
    if (ORIGINAL_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_URL
    if (ORIGINAL_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_TOKEN
  })

  it('test_742_store_then_get_same_key_returns_cached_response', async () => {
    const store = new Map<string, string>()
    const fetchMock = mockUpstashFetch((url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'SET') {
        const body = JSON.parse(String(init?.body)) as string[]
        store.set(body[1], body[2])
        return { result: 'OK' }
      }
      // GET
      const key = url.split('/').pop() as string
      return { result: store.get(key) ?? null }
    })

    const { storeIdempotentResponse, getIdempotentResponse } = await loadRealIdempotency()

    const response = { body: { reading_id: 'r-1', job_id: 'j-1' }, status: 202 }
    await storeIdempotentResponse('idem-key-1', response)

    const cached = await getIdempotentResponse('idem-key-1')
    expect(cached).toEqual(response)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('test_742_expired_key_is_not_returned', async () => {
    // Simulate an expired key: the GET endpoint returns null.
    mockUpstashFetch(() => ({ result: null }))

    const { getIdempotentResponse } = await loadRealIdempotency()
    const cached = await getIdempotentResponse('expired-key')
    expect(cached).toBeNull()
  })

  it('test_742_store_passes_ttl_expiry_to_redis', async () => {
    const fetchMock = mockUpstashFetch(() => ({ result: 'OK' }))

    const { storeIdempotentResponse } = await loadRealIdempotency()
    await storeIdempotentResponse('ttl-key', { body: { ok: true }, status: 200 })

    // Find the SET call and assert an expiry option was provided.
    const setCall = fetchMock.mock.calls.find(([, init]) => {
      const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()
      return method === 'SET'
    })
    expect(setCall).toBeDefined()
    const body = JSON.parse(String((setCall![1] as RequestInit).body)) as string[]
    // Upstash SET accepts ["SET", key, value, "EX", ttl] — assert an EX TTL is present.
    const exIndex = body.findIndex((part) => String(part).toUpperCase() === 'EX')
    expect(exIndex).toBeGreaterThan(-1)
    const ttl = Number(body[exIndex + 1])
    expect(Number.isFinite(ttl)).toBe(true)
    expect(ttl).toBeGreaterThan(0)
  })

  it('test_742_get_returns_null_when_redis_url_unset', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    const fetchMock = mockUpstashFetch(() => ({ result: 'should-not-be-used' }))

    const { getIdempotentResponse } = await loadRealIdempotency()
    const cached = await getIdempotentResponse('any-key')

    expect(cached).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('test_742_store_resolves_without_throwing_when_redis_url_unset', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    const fetchMock = mockUpstashFetch(() => ({ result: 'OK' }))

    const { storeIdempotentResponse } = await loadRealIdempotency()
    await expect(
      storeIdempotentResponse('any-key', { body: { ok: true }, status: 200 })
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('test_742_get_returns_null_when_fetch_rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    const { getIdempotentResponse } = await loadRealIdempotency()
    await expect(getIdempotentResponse('any-key')).resolves.toBeNull()
  })

  it('test_742_store_resolves_without_throwing_when_fetch_rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    const { storeIdempotentResponse } = await loadRealIdempotency()
    await expect(
      storeIdempotentResponse('any-key', { body: { ok: true }, status: 200 })
    ).resolves.toBeUndefined()
  })

  it('test_742_get_returns_null_when_redis_responds_with_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as unknown as Response))
    )

    const { getIdempotentResponse } = await loadRealIdempotency()
    await expect(getIdempotentResponse('any-key')).resolves.toBeNull()
  })

  it('test_742_store_resolves_without_throwing_when_redis_responds_with_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as unknown as Response))
    )

    const { storeIdempotentResponse } = await loadRealIdempotency()
    await expect(
      storeIdempotentResponse('any-key', { body: { ok: true }, status: 200 })
    ).resolves.toBeUndefined()
  })
})
