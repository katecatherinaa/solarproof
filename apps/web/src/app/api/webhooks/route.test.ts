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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks — signature verification (issue #29)', () => {
  let POST: (req: NextRequest) => Promise<Response>

  beforeEach(async () => {
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
