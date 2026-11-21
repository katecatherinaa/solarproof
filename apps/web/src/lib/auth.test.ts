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
import {
  requireAuth,
  isAuthError,
  revokeToken,
  hashRefreshToken,
  rotateRefreshToken,
  revokeSessionFamily,
} from '@/lib/auth'
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

const mockRefreshMaybeSingle = vi.fn()
const mockRefreshInsert = vi.fn()
const mockRefreshUpdateEq = vi.fn()
const mockRefreshUpdate = vi.fn()
const mockRefreshSelectEq = vi.fn()
const mockRefreshSelect = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCachedRevocation.mockResolvedValue(null)
  mockSetCachedRevocation.mockResolvedValue(undefined)
  mockAuditLog.mockResolvedValue(undefined)
  mockRevokedMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockRevokedInsert.mockResolvedValue({ error: null })
  mockRefreshMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockRefreshInsert.mockResolvedValue({ error: null })
  mockRefreshUpdateEq.mockResolvedValue({ error: null })
  mockRefreshUpdate.mockReturnValue({ eq: mockRefreshUpdateEq })
  mockRefreshSelectEq.mockReturnValue({ maybeSingle: mockRefreshMaybeSingle })
  mockRefreshSelect.mockReturnValue({ eq: mockRefreshSelectEq })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'revoked_tokens') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mockRevokedMaybeSingle }),
        }),
        insert: mockRevokedInsert,
      }
    }
    if (table === 'refresh_tokens') {
      return {
        select: mockRefreshSelect,
        insert: mockRefreshInsert,
        update: mockRefreshUpdate,
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

describe('hashRefreshToken', () => {
  it('is deterministic for the same input', () => {
    const a = hashRefreshToken('refresh-token-value')
    const b = hashRefreshToken('refresh-token-value')
    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'))
  })

  it('does not return the raw token', () => {
    const raw = 'refresh-token-value'
    expect(hashRefreshToken(raw)).not.toBe(raw)
  })
})

describe('rotateRefreshToken', () => {
  it('inserts a child token in the same session family and marks the parent used', async () => {
    mockRefreshMaybeSingle.mockResolvedValue({
      data: {
        id: 'rt-parent',
        user_id: 'user-1',
        session_family_id: 'family-1',
        used_at: null,
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    })

    const result = await rotateRefreshToken('parent-token', 'new-token')

    expect(result).not.toBeNull()
    expect(result?.sessionFamilyId).toBe('family-1')
    expect(result?.userId).toBe('user-1')

    // Parent marked used
    expect(mockFrom).toHaveBeenCalledWith('refresh_tokens')
    expect(mockRefreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ used_at: expect.any(String) })
    )
    expect(mockRefreshUpdateEq).toHaveBeenCalledWith('id', 'rt-parent')

    // Child inserted with same family
    expect(mockRefreshInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        session_family_id: 'family-1',
        token_hash: hashRefreshToken('new-token'),
      })
    )
  })

  it('detects reuse of an already-used token and revokes the whole family', async () => {
    mockRefreshMaybeSingle.mockResolvedValue({
      data: {
        id: 'rt-parent',
        user_id: 'user-1',
        session_family_id: 'family-1',
        used_at: new Date().toISOString(),
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    })

    const result = await rotateRefreshToken('parent-token', 'new-token')

    expect(result).toBeNull()
    // Whole family revoked
    expect(mockRefreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(String) })
    )
    expect(mockRefreshUpdateEq).toHaveBeenCalledWith('session_family_id', 'family-1')
    // No new child issued
    expect(mockRefreshInsert).not.toHaveBeenCalled()
    // Reuse logged
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.stringMatching(/reuse/i) })
    )
  })

  it('returns null when the refresh token is unknown', async () => {
    mockRefreshMaybeSingle.mockResolvedValue({ data: null, error: null })

    const result = await rotateRefreshToken('unknown-token', 'new-token')

    expect(result).toBeNull()
    expect(mockRefreshInsert).not.toHaveBeenCalled()
  })
})

describe('revokeSessionFamily', () => {
  it('marks every row in the family revoked', async () => {
    await revokeSessionFamily('family-1')

    expect(mockFrom).toHaveBeenCalledWith('refresh_tokens')
    expect(mockRefreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(String) })
    )
    expect(mockRefreshUpdateEq).toHaveBeenCalledWith('session_family_id', 'family-1')
  })
})
