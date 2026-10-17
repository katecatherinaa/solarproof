import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase', () => ({
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })),
  getClientIp: vi.fn(() => '1.2.3.4'),
}))

import { createServiceClient } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/rate-limit'
import { GET } from '@/app/api/audit-log/export/route'

const CERT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/audit-log/export')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url)
}

const SAMPLE_ROWS = [
  {
    id: 'log-1',
    operator_id: 'op-1',
    action: 'certificate.retire',
    resource_id: CERT_ID,
    ip_address: '1.2.3.4',
    metadata: { kwh: 10 },
    created_at: '2026-01-01T00:00:00.000Z',
  },
]

function mockDb(data: unknown, error: unknown = null) {
  const chain = {
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then: (resolve: (v: { data: unknown; error: unknown }) => void) =>
      Promise.resolve({ data, error }).then(resolve),
  }
  const select = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue({ select })
  vi.mocked(createServiceClient).mockReturnValue({ from } as never)
  return { chain }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/audit-log/export', () => {
  it('returns 400 when certificate_id is missing', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/certificate_id is required/i)
  })

  it('returns 200 with CSV content type when certificate_id is provided', async () => {
    mockDb(SAMPLE_ROWS)
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
  })

  it('returns CSV with header row', async () => {
    mockDb(SAMPLE_ROWS)
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    const text = await res.text()
    expect(text).toContain('id,operator_id,action,resource_id')
  })

  it('includes data rows for the certificate', async () => {
    mockDb(SAMPLE_ROWS)
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    const text = await res.text()
    expect(text).toContain('log-1')
    expect(text).toContain('certificate.retire')
  })

  it('returns empty CSV (header only) when no records found', async () => {
    mockDb([])
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    const text = await res.text()
    expect(text.trim()).toBe('id,operator_id,action,resource_id,ip_address,metadata,created_at')
  })

  it('sets Content-Disposition with filename including certificate_id', async () => {
    mockDb(SAMPLE_ROWS)
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    expect(res.headers.get('Content-Disposition')).toContain(CERT_ID)
  })

  it('returns 500 when DB query fails', async () => {
    mockDb(null, { message: 'DB error' })
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('DB error')
  })

  it('filters by custom from and to dates', async () => {
    const { chain } = mockDb(SAMPLE_ROWS)
    await GET(makeRequest({
      certificate_id: CERT_ID,
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T00:00:00Z',
    }))
    expect(chain.gte).toHaveBeenCalledWith('created_at', '2026-01-01T00:00:00Z')
    expect(chain.lte).toHaveBeenCalledWith('created_at', '2026-01-31T00:00:00Z')
  })

  it('returns 429 when rate limit is exceeded', async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toMatch(/too many requests/i)
  })

  it('includes rate-limit headers on 429', async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    const res = await GET(makeRequest({ certificate_id: CERT_ID }))
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })
})
