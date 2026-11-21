/**
 * Unit tests for webhook signature verification (issue #29).
 *
 * Covers:
 *  - Valid HMAC-SHA256 signature → 201 Created
 *  - Missing signature header  → 401 Unauthorized
 *  - Invalid signature header  → 401 Unauthorized
 *  - No WEBHOOK_SECRET set     → verification skipped, 201 Created
 */
import { createHmac } from 'crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── DNS mock ────────────────────────────────────────────────────────────────
// Controls what dns.promises.lookup resolves to, so we can simulate SSRF
// targets (private IPs, loopback, link-local) without real network access.
const mockDnsLookup = vi.fn()

vi.mock('dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockDnsLookup(...args),
  },
}))

// ── Env mock ────────────────────────────────────────────────────────────────
// We control the WEBHOOK_SECRET via the module mock below.
let mockWebhookSecret: string | undefined = 'super-secret-value-xyz'

vi.mock('@/env', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'WEBHOOK_SECRET') return mockWebhookSecret
      // Provide minimal values for the rest of the env
      return 'mock-value'
    },
  }),
}))

// ── Supabase mock ────────────────────────────────────────────────────────────
const mockInsertResult = {
  id: 'wh-id-1',
  cooperative_id: '00000000-0000-0000-0000-000000000001',
  url: 'https://example.com/hook',
  events: ['anchor'],
  active: true,
  created_at: new Date().toISOString(),
}

vi.mock('@/lib/supabase', () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: mockInsertResult, error: null }),
        }),
      }),
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [], error: null }),
        }),
      }),
    }),
  }),
}))

// ── Helper ───────────────────────────────────────────────────────────────────

function makeBody() {
  return JSON.stringify({
    cooperative_id: '00000000-0000-0000-0000-000000000001',
    url: 'https://example.com/hook',
    secret: 'a-secret-longer-than-sixteen-chars',
    events: ['anchor'],
  })
}

function buildRequest(bodyStr: string, sigHeader?: string): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (sigHeader !== undefined) {
    headers['x-solarproof-signature'] = sigHeader
  }
  return new NextRequest('http://localhost/api/webhooks', {
    method: 'POST',
    headers,
    body: bodyStr,
  })
}

function computeSig(secret: string, body: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')
}

function makeBodyWithUrl(url: string) {
  return JSON.stringify({
    cooperative_id: '00000000-0000-0000-0000-000000000001',
    url,
    secret: 'a-secret-longer-than-sixteen-chars',
    events: ['anchor'],
  })
}

function mockLookupTo(address: string) {
  mockDnsLookup.mockResolvedValue({ address, family: address.includes(':') ? 6 : 4 })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks — signature verification (issue #29)', () => {
  let POST: (req: NextRequest) => Promise<Response>

  beforeEach(async () => {
    mockDnsLookup.mockReset()
    mockLookupTo('93.184.216.34') // public IP by default
    // Re-import so the mock env is used each test
    const mod = await import('./route')
    POST = mod.POST
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('accepts a request with a valid HMAC-SHA256 signature', async () => {
    mockWebhookSecret = 'super-secret-value-xyz'
    const body = makeBody()
    const sig = computeSig('super-secret-value-xyz', body)
    const req = buildRequest(body, sig)
    const res = await POST(req)
    expect(res.status).toBe(201)
  })

  it('returns 401 when the signature header is missing', async () => {
    mockWebhookSecret = 'super-secret-value-xyz'
    const req = buildRequest(makeBody()) // no sig header
    const res = await POST(req)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatch(/signature/i)
  })

  it('returns 401 when the signature is wrong', async () => {
    mockWebhookSecret = 'super-secret-value-xyz'
    const req = buildRequest(makeBody(), 'deadbeef'.repeat(8)) // wrong sig
    const res = await POST(req)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatch(/signature/i)
  })

  it('skips verification when WEBHOOK_SECRET is not set', async () => {
    mockWebhookSecret = undefined
    const req = buildRequest(makeBody()) // no sig header — should be fine
    const res = await POST(req)
    expect(res.status).toBe(201)
  })
})

// ── SSRF protection tests (issue #767) ───────────────────────────────────────

describe('validateWebhookUrl — SSRF protection (issue #767)', () => {
  let validateWebhookUrl: (url: string) => Promise<void>

  beforeEach(async () => {
    mockDnsLookup.mockReset()
    const mod = await import('@/lib/webhook-url')
    validateWebhookUrl = mod.validateWebhookUrl
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('rejects a private (RFC 1918) IP URL', async () => {
    mockLookupTo('10.0.0.1')
    await expect(validateWebhookUrl('https://10.0.0.1/hook')).rejects.toThrow(
      /private|blocked|not allowed/i
    )
  })

  it('rejects a loopback IP URL', async () => {
    mockLookupTo('127.0.0.1')
    await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(
      /loopback|private|blocked|not allowed/i
    )
  })

  it('rejects a link-local IP URL (cloud metadata endpoint)', async () => {
    mockLookupTo('169.254.169.254')
    await expect(
      validateWebhookUrl('https://169.254.169.254/latest/meta-data')
    ).rejects.toThrow(/link-local|private|blocked|not allowed/i)
  })

  it('rejects a hostname that resolves to a private IP (DNS rebinding)', async () => {
    mockLookupTo('192.168.1.10')
    await expect(validateWebhookUrl('https://evil.example.com/hook')).rejects.toThrow(
      /private|blocked|not allowed/i
    )
  })

  it('accepts a valid public URL', async () => {
    mockLookupTo('93.184.216.34')
    await expect(validateWebhookUrl('https://example.com/hook')).resolves.toBeUndefined()
  })
})

describe('POST /api/webhooks — SSRF protection (issue #767)', () => {
  let POST: (req: NextRequest) => Promise<Response>

  beforeEach(async () => {
    mockDnsLookup.mockReset()
    mockWebhookSecret = 'super-secret-value-xyz'
    const mod = await import('./route')
    POST = mod.POST
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns 400 with a descriptive error for a blocked URL', async () => {
    mockLookupTo('169.254.169.254')
    const body = makeBodyWithUrl('https://169.254.169.254/latest/meta-data')
    const sig = computeSig('super-secret-value-xyz', body)
    const req = buildRequest(body, sig)
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/url|blocked|private|not allowed/i)
  })
})

// ── Delivery & retry integration tests (issue #744) ──────────────────────────
//
// These tests exercise the outbound delivery path in @/lib/webhooks by mocking
// global fetch as a fake HTTP receiver. They assert:
//  1. A 2xx on the first attempt → exactly one fetch call, 'delivered' logged.
//  2. A non-2xx response triggers retries with exponential backoff (1s, 2s, 4s, 8s).
//  3. The outbound request carries a valid X-SolarProof-Signature header.
//  4. After 5 consecutive failures the webhook is recorded in dead-letter state.

describe('webhook delivery & retry (issue #744)', () => {
  // Captured Supabase writes so we can assert dead-letter state.
  const supabaseUpdates: Array<{ table: string; payload: Record<string, unknown> }> = []
  const supabaseInserts: Array<{ table: string; payload: Record<string, unknown> }> = []

  let fetchMock: ReturnType<typeof vi.fn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  const SECRET = 'delivery-secret-longer-than-sixteen'
  const PAYLOAD = { event: 'anchor', cooperative_id: '00000000-0000-0000-0000-000000000001' }
  const TARGET_URL = 'https://example.com/hook'

  beforeEach(() => {
    supabaseUpdates.length = 0
    supabaseInserts.length = 0
    mockDnsLookup.mockReset()
    mockLookupTo('93.184.216.34')
    mockWebhookSecret = 'super-secret-value-xyz'

    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.resetModules()
  })

  // Build a chainable Supabase mock that records update/insert calls.
  function buildSupabaseMock() {
    const recordUpdate = (table: string) => (payload: Record<string, unknown>) => {
      supabaseUpdates.push({ table, payload })
      return {
        eq: () => ({
          eq: async () => ({ data: null, error: null }),
        }),
      }
    }
    const recordInsert = (table: string) => (payload: Record<string, unknown>) => {
      supabaseInserts.push({ table, payload })
      return {
        select: () => ({
          single: async () => ({ data: { id: 'dl-id-1', ...payload }, error: null }),
        }),
      }
    }
    return {
      from: (table: string) => ({
        update: recordUpdate(table),
        insert: recordInsert(table),
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
            single: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }
  }

  async function loadDelivery() {
    vi.doMock('@/lib/supabase', () => ({
      createServiceClient: () => buildSupabaseMock(),
    }))
    const mod = await import('@/lib/webhooks')
    return mod
  }

  function computeOutboundSig(secret: string, payload: unknown): string {
    return createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex')
  }

  it('delivers successfully on the first attempt with a single fetch call', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const { deliverWebhook } = await loadDelivery()

    await deliverWebhook({
      url: TARGET_URL,
      secret: SECRET,
      payload: PAYLOAD,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toMatch(/delivered/i)
    // No dead-letter writes on success.
    expect(supabaseUpdates).toHaveLength(0)
    expect(supabaseInserts).toHaveLength(0)
  })

  it('retries with exponential backoff (1s, 2s, 4s, 8s) on non-2xx responses', async () => {
    vi.useFakeTimers()
    // Four failures then a success on the fifth attempt.
    fetchMock
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const { deliverWebhook } = await loadDelivery()

    const delivery = deliverWebhook({
      url: TARGET_URL,
      secret: SECRET,
      payload: PAYLOAD,
    })

    // First attempt happens immediately.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Backoff #1: 1s
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Backoff #2: 2s
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Backoff #3: 4s
    await vi.advanceTimersByTimeAsync(3999)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // Backoff #4: 8s
    await vi.advanceTimersByTimeAsync(7999)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    await delivery
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('signs the outbound request with a valid HMAC-SHA256 signature', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const { deliverWebhook } = await loadDelivery()

    await deliverWebhook({
      url: TARGET_URL,
      secret: SECRET,
      payload: PAYLOAD,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    const sig = headers.get('x-solarproof-signature')
    expect(sig).toBeTruthy()

    const expected = computeOutboundSig(SECRET, PAYLOAD)
    expect(sig).toBe(expected)
  })

  it('moves the webhook to dead-letter state after 5 consecutive failures', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }))

    const { deliverWebhook } = await loadDelivery()

    const delivery = deliverWebhook({
      url: TARGET_URL,
      secret: SECRET,
      payload: PAYLOAD,
    })

    // Advance through all backoff windows: 1s + 2s + 4s + 8s = 15s.
    await vi.advanceTimersByTimeAsync(15_000)
    await delivery

    expect(fetchMock).toHaveBeenCalledTimes(5)

    // Dead-letter state must be recorded via the mocked Supabase client.
    const deadLetterWrite = [...supabaseUpdates, ...supabaseInserts].find((w) => {
      const serialized = JSON.stringify(w.payload)
      return /dead[_-]?letter/i.test(serialized)
    })
    expect(deadLetterWrite).toBeDefined()

    const errored = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errored).toMatch(/dead[_-]?letter|failed|exhausted/i)
  })
})
