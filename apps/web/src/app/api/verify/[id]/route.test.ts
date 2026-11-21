import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase', () => ({ createAnonClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/cache', () => ({
  getCachedCert: vi.fn().mockResolvedValue(null),
  setCachedCert: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bot-protection', () => ({
  verifyTurnstileToken: vi.fn(),
  isAdminToken: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}))

import { GET } from '@/app/api/verify/[id]/route'
import { createAnonClient } from '@/lib/supabase'
import { getCachedCert } from '@/lib/cache'
import { verifyTurnstileToken, isAdminToken } from '@/lib/bot-protection'
import { checkRateLimit } from '@/lib/rate-limit'

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const VALID_HASH = 'a'.repeat(64)
const VALID_TOKEN = 'turnstile-valid-token'
const ADMIN_TOKEN = 'admin-secret-token'

function makeRequest(id: string, opts: { token?: string; admin?: string; ip?: string } = {}) {
  const url = new URL(`http://localhost/api/verify/${id}`)
  if (opts.token) url.searchParams.set('cf-turnstile-response', opts.token)
  const headers: Record<string, string> = {}
  if (opts.admin) headers['x-admin-token'] = opts.admin
  if (opts.ip) headers['x-forwarded-for'] = opts.ip
  return new NextRequest(url, { headers })
}
=======

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeDb(cert: unknown, reading: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: cert })
  const single = vi.fn().mockResolvedValue({ data: reading })
  const eq = vi.fn().mockReturnValue({ maybeSingle, single })
  const select = vi.fn().mockReturnValue({ eq })
  return vi.fn().mockReturnValue({ select })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCachedCert).mockResolvedValue(null)
  vi.mocked(verifyTurnstileToken).mockResolvedValue(false)
  vi.mocked(isAdminToken).mockReturnValue(false)
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 4 })
})

describe('GET /api/verify/[id]', () => {
  it('returns 400 for invalid id format', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const res = await GET(makeRequest('not-valid', { token: VALID_TOKEN }), makeParams('not-valid'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when certificate not found', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_UUID, { token: VALID_TOKEN }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(404)
  })

  it('returns 200 with full chain for valid UUID', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const cert = {
      id: VALID_UUID,
      kwh: 10,
      issued_at: '2026-01-01T00:00:00Z',
      retired: false,
      retired_at: null,
      retired_by: null,
      reading_id: 'r1',
      anchor_tx_hash: 'a'.repeat(64),
      mint_tx_hash: 'b'.repeat(64),
    }
    const reading = {
      meter_id: 'meter-1',
      reading_hash: VALID_HASH,
      signature_hex: 'c'.repeat(128),
      kwh: 10,
      timestamp: '2026-01-01T00:00:00Z',
    }
    const from = makeDb(cert, reading)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_UUID, { token: VALID_TOKEN }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.certificate.id).toBe(VALID_UUID)
    expect(body.on_chain.anchor_tx).toBe('a'.repeat(64))
    expect(body.meter_proof.verified).toBe(true)
    expect(res.headers.get('Cache-Control')).toContain('max-age=60')
    expect(res.headers.get('X-Cache')).toBe('MISS')
  })

  it('returns cached result on cache hit', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const cached = { certificate: { id: VALID_UUID }, on_chain: {}, meter_proof: null }
    vi.mocked(getCachedCert).mockResolvedValue(cached)
    const res = await GET(
      makeRequest(VALID_UUID, { token: VALID_TOKEN }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('HIT')
  })

  it('accepts a 64-char hex hash as id', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_HASH, { token: VALID_TOKEN }),
      makeParams(VALID_HASH)
    )
    expect(res.status).toBe(404)
  })

  it('rejects request with missing token', async () => {
    const res = await GET(makeRequest(VALID_UUID), makeParams(VALID_UUID))
    expect(res.status).toBe(403)
    expect(verifyTurnstileToken).not.toHaveBeenCalled()
    expect(createAnonClient).not.toHaveBeenCalled()
  })

  it('rejects request with invalid token', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(false)
    const res = await GET(
      makeRequest(VALID_UUID, { token: 'bad-token' }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(403)
    expect(verifyTurnstileToken).toHaveBeenCalledWith('bad-token', expect.anything())
    expect(createAnonClient).not.toHaveBeenCalled()
  })

  it('accepts request with valid token', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_UUID, { token: VALID_TOKEN }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(404)
    expect(verifyTurnstileToken).toHaveBeenCalledWith(VALID_TOKEN, expect.anything())
  })

  it('bypasses verification for admin token', async () => {
    vi.mocked(isAdminToken).mockReturnValue(true)
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_UUID, { admin: ADMIN_TOKEN }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(404)
    expect(verifyTurnstileToken).not.toHaveBeenCalled()
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('enforces 5 req/min rate limit for unverified callers', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true)
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, remaining: 0 })
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(
      makeRequest(VALID_UUID, { token: VALID_TOKEN, ip: '203.0.113.7' }),
      makeParams(VALID_UUID)
    )
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('203.0.113.7'),
      5,
      60_000
    )
    expect(createAnonClient).not.toHaveBeenCalled()
  })
})
