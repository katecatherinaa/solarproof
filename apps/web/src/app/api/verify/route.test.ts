import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock Supabase and cache before importing the route
vi.mock('@/lib/supabase', () => ({
  createAnonClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/cache', () => ({
  getCachedCert: vi.fn().mockResolvedValue(null),
  setCachedCert: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bot-protection', () => ({
  verifyBotToken: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}))

import { GET } from '@/app/api/verify/route'
import { createAnonClient } from '@/lib/supabase'
import { getCachedCert } from '@/lib/cache'
import { verifyBotToken } from '@/lib/bot-protection'
import { checkRateLimit } from '@/lib/rate-limit'

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const VALID_HASH = 'a'.repeat(64)
const ADMIN_TOKEN = 'test-admin-token'
const BOT_TOKEN = 'test-bot-token'

function makeRequest(
  id: string | null,
  opts: { botToken?: string; adminToken?: string; ip?: string } = {}
) {
  const url = new URL(`http://localhost/api/verify${id ? `?id=${id}` : ''}`)
  const headers: Record<string, string> = {}
  if (opts.botToken) headers['cf-turnstile-response'] = opts.botToken
  if (opts.adminToken) headers['x-admin-token'] = opts.adminToken
  if (opts.ip) headers['x-forwarded-for'] = opts.ip
  return new NextRequest(url, { headers })
}

function makeDb(cert: unknown, reading: unknown) {
  const single = vi.fn()
  const maybeSingle = vi.fn()
  const eq = vi.fn().mockReturnValue({ maybeSingle, single })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  maybeSingle.mockResolvedValue({ data: cert })
  single.mockResolvedValue({ data: reading })
  return from
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCachedCert).mockResolvedValue(null)
  vi.mocked(verifyBotToken).mockResolvedValue(true)
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 4 })
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN
})

describe('GET /api/verify', () => {
  it('returns 400 when id is missing', async () => {
    const res = await GET(makeRequest(null, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when id is invalid format', async () => {
    const res = await GET(makeRequest('not-valid', { botToken: BOT_TOKEN }))
    expect(res.status).toBe(400)
  })

  it('returns 403 when bot token is missing for unverified caller', async () => {
    const res = await GET(makeRequest(VALID_UUID))
    expect(res.status).toBe(403)
    expect(verifyBotToken).not.toHaveBeenCalled()
  })

  it('returns 403 when bot token validation fails', async () => {
    vi.mocked(verifyBotToken).mockResolvedValue(false)
    const res = await GET(makeRequest(VALID_UUID, { botToken: 'bad-token' }))
    expect(res.status).toBe(403)
    expect(verifyBotToken).toHaveBeenCalledWith('bad-token', expect.any(String))
  })

  it('returns 429 when unverified caller exceeds 5 req/min', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, remaining: 0 })
    const res = await GET(makeRequest(VALID_UUID, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('verify'),
      expect.objectContaining({ limit: 5, windowMs: 60_000 })
    )
  })

  it('bypasses bot check and rate limit for valid admin token', async () => {
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
    const res = await GET(makeRequest(VALID_UUID, { adminToken: ADMIN_TOKEN }))
    expect(res.status).toBe(200)
    expect(verifyBotToken).not.toHaveBeenCalled()
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('rejects an invalid admin token and falls back to bot check', async () => {
    const res = await GET(makeRequest(VALID_UUID, { adminToken: 'wrong-token' }))
    expect(res.status).toBe(403)
    expect(verifyBotToken).not.toHaveBeenCalled()
  })

  it('returns 404 when certificate not found', async () => {
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(makeRequest(VALID_UUID, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(404)
  })

  it('returns 200 with chain of custody for a valid UUID', async () => {
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
    const res = await GET(makeRequest(VALID_UUID, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.certificate.id).toBe(VALID_UUID)
    expect(body.meter_proof.verified).toBe(true)
  })

  it('returns cached result on cache hit', async () => {
    const cached = { certificate: { id: VALID_UUID }, on_chain: {}, meter_proof: null }
    vi.mocked(getCachedCert).mockResolvedValue(cached)
    const res = await GET(makeRequest(VALID_UUID, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.certificate.id).toBe(VALID_UUID)
    expect(res.headers.get('X-Cache')).toBe('HIT')
  })

  it('accepts a 64-char hex hash as id', async () => {
    const from = makeDb(null, null)
    vi.mocked(createAnonClient).mockReturnValue({ from } as never)
    const res = await GET(makeRequest(VALID_HASH, { botToken: BOT_TOKEN }))
    expect(res.status).toBe(404)
  })
})
