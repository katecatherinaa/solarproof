import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock @supabase/supabase-js before importing auth
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  },
}))

vi.mock('@/lib/cache', () => ({
  getCachedRevocation: vi.fn(),
  setCachedRevocation: vi.fn(),
}))

vi.mock('@/lib/audit', () => ({
  auditLog: vi.fn(),
}))

import { createClient } from '@supabase/supabase-js'
import { requireAuth, isAuthError, revokeToken, isSecureCookie } from '@/lib/auth'
import { getCachedRevocation, setCachedRevocation } from '@/lib/cache'
import { auditLog } from '@/lib/audit'

const mockGetUser = vi.fn()
const mockCreateClient = vi.mocked(createClient)
const mockGetCachedRevocation = vi.mocked(getCachedRevocation)
const mockSetCachedRevocation = vi.mocked(setCachedRevocation)
const mockAuditLog = vi.mocked(auditLog)

const mockRevokedMaybeSingle = vi.fn()
const mockRevokedInsert = vi.fn()
const mockFrom = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCachedRevocation.mockResolvedValue(null)
  mockSetCachedRevocation.mockResolvedValue(undefined)
  mockAuditLog.mockResolvedValue(undefined)
  mockRevokedMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockRevokedInsert.mockResolvedValue({ error: null })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'revoked_tokens') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mockRevokedMaybeSingle }),
        }),
        insert: mockRevokedInsert,
      }
    }
    return {}
  })
  mockCreateClient.mockReturnValue({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  } as never)
})

function makeRequest(authHeader?: string) {
  return new NextRequest('http://localhost/api/meters', {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('requireAuth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const result = await requireAuth(makeRequest())
    expect(isAuthError(result)).toBe(true)
    const res = result as Response
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/missing/i)
  })

  it('returns 401 when token is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid') })
    const result = await requireAuth(makeRequest('Bearer bad-token'))
    expect(isAuthError(result)).toBe(true)
    const res = result as Response
    expect(res.status).toBe(401)
  })

  it('returns user when token is valid', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'op@example.com', app_metadata: { cooperative_id: 'coop-1' } } },
      error: null,
    })
    const result = await requireAuth(makeRequest('Bearer valid-token'))
    expect(isAuthError(result)).toBe(false)
    const auth = result as { user: { id: string; email?: string }; accessToken: string }
    expect(auth.user.id).toBe('user-1')
    expect(auth.accessToken).toBe('valid-token')
  })
})

describe('requireAuth revocation', () => {
  it('returns 401 when token JTI is in revoked_tokens and logs audit', async () => {
    mockGetCachedRevocation.mockResolvedValue(null)
    mockRevokedMaybeSingle.mockResolvedValue({ data: { jti: 'jti-1' }, error: null })
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'op@example.com' } },
      error: null,
    })

    const result = await requireAuth(makeRequest('Bearer revoked-token'))
    expect(isAuthError(result)).toBe(true)
    const res = result as Response
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Token has been revoked/)
    expect(mockAuditLog).toHaveBeenCalledTimes(1)
    expect(mockGetUser).not.toHaveBeenCalled()
  })

  it('short-circuits DB query when revocation is cached', async () => {
    mockGetCachedRevocation.mockResolvedValue(true)

    const result = await requireAuth(makeRequest('Bearer revoked-token'))
    expect(isAuthError(result)).toBe(true)
    const res = result as Response
    expect(res.status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAuditLog).toHaveBeenCalledTimes(1)
  })

  it('proceeds to getUser when token is not revoked', async () => {
    mockGetCachedRevocation.mockResolvedValue(null)
    mockRevokedMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'op@example.com' } },
      error: null,
    })

    const result = await requireAuth(makeRequest('Bearer valid-token'))
    expect(isAuthError(result)).toBe(false)
    const auth = result as { user: { id: string } }
    expect(auth.user.id).toBe('user-1')
    expect(mockGetUser).toHaveBeenCalledTimes(1)
    expect(mockSetCachedRevocation).toHaveBeenCalled()
  })
})

describe('revokeToken', () => {
  it('inserts into revoked_tokens and primes the cache', async () => {
    await revokeToken('jti-1', 'user-1')

    expect(mockFrom).toHaveBeenCalledWith('revoked_tokens')
    expect(mockRevokedInsert).toHaveBeenCalledWith(
      expect.objectContaining({ jti: 'jti-1' })
    )
    expect(mockSetCachedRevocation).toHaveBeenCalledWith('jti-1', true)
  })
})

describe('isSecureCookie', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
    }
  })

  it('returns true when NEXT_PUBLIC_APP_URL is HTTPS (production)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.spore.example'
    expect(isSecureCookie()).toBe(true)
  })

  it('returns true when NEXT_PUBLIC_APP_URL is HTTPS (staging)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.spore.example'
    expect(isSecureCookie()).toBe(true)
  })

  it('returns false when NEXT_PUBLIC_APP_URL is HTTP (local development)', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
    expect(isSecureCookie()).toBe(false)
  })

  it('returns false when NEXT_PUBLIC_APP_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(isSecureCookie()).toBe(false)
  })
})
