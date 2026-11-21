import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}))

vi.mock('@/lib/auth/notify', () => ({
  notifySessionRevoked: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/auth/audit', () => ({
  logAuthEvent: vi.fn().mockResolvedValue(undefined),
}))

import { createClient } from '@supabase/supabase-js'
import { notifySessionRevoked } from '@/lib/auth/notify'
import { logAuthEvent } from '@/lib/auth/audit'
import { POST } from '@/app/api/auth/refresh/route'

function makeRequest(body: unknown) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0]
}

function mockSupabase(session: unknown, error: unknown = null) {
  vi.mocked(createClient).mockReturnValue({
    auth: {
      refreshSession: vi.fn().mockResolvedValue({ data: { session }, error }),
    },
  } as never)
}

type TokenRow = {
  id: string
  family_id: string
  user_id: string
  used_at: string | null
  revoked_at: string | null
}

/**
 * Builds a Supabase service-client mock backed by an in-memory
 * `refresh_tokens` table so rotation/reuse behaviour can be asserted.
 */
function mockServiceClient(rows: TokenRow[]) {
  const table = rows.map((r) => ({ ...r }))
  const updates: Array<{ id: string; patch: Partial<TokenRow> }> = []

  const from = vi.fn((name: string) => {
    if (name !== 'refresh_tokens') {
      throw new Error(`unexpected table: ${name}`)
    }
    const filters: Array<(r: TokenRow) => boolean> = []
    let patch: Partial<TokenRow> | null = null

    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Partial<TokenRow>) => {
        patch = p
        return builder
      },
      eq: (col: keyof TokenRow, value: unknown) => {
        filters.push((r) => r[col] === value)
        return builder
      },
      is: (col: keyof TokenRow, value: unknown) => {
        filters.push((r) => r[col] === value)
        return builder
      },
      maybeSingle: () => {
        const match = table.find((r) => filters.every((f) => f(r)))
        return Promise.resolve({ data: match ?? null, error: null })
      },
      then: (resolve: (v: unknown) => unknown) => {
        const matched = table.filter((r) => filters.every((f) => f(r)))
        if (patch) {
          for (const r of matched) {
            Object.assign(r, patch)
            updates.push({ id: r.id, patch })
          }
        }
        return Promise.resolve({ data: matched, error: null }).then(resolve)
      },
    }
    return builder
  })

  const client = { from }
  vi.mocked(createClient).mockReturnValue(client as never)
  return { client, table, updates }
}

describe('POST /api/auth/refresh', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when body is missing', async () => {
    const req = { json: () => Promise.resolve(null) } as unknown as Parameters<typeof POST>[0]
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when refresh_token is missing', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 when refresh_token is empty string', async () => {
    const res = await POST(makeRequest({ refresh_token: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when body is not JSON', async () => {
    const req = { json: () => Promise.reject(new Error('bad json')) } as unknown as Parameters<typeof POST>[0]
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 when refresh token is invalid', async () => {
    mockSupabase(null, { message: 'Invalid refresh token' })
    const res = await POST(makeRequest({ refresh_token: 'bad-token' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid or expired refresh token')
  })

  it('returns 401 when session is null without error', async () => {
    mockSupabase(null, null)
    const res = await POST(makeRequest({ refresh_token: 'stale-token' }))
    expect(res.status).toBe(401)
  })

  it('returns 200 with new token pair on success', async () => {
    mockSupabase({
      access_token: 'new-access-789',
      refresh_token: 'new-refresh-012',
      expires_in: 3600,
    })
    const res = await POST(makeRequest({ refresh_token: 'valid-refresh-token' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.access_token).toBe('new-access-789')
    expect(body.refresh_token).toBe('new-refresh-012')
    expect(body.token_type).toBe('Bearer')
  })

  describe('token rotation', () => {
    it('marks the presented token as used and issues a new token in the same family', async () => {
      const { table, updates } = mockServiceClient([
        {
          id: 'tok-1',
          family_id: 'fam-1',
          user_id: 'user-1',
          used_at: null,
          revoked_at: null,
        },
      ])
      mockSupabase({
        access_token: 'new-access-789',
        refresh_token: 'new-refresh-012',
        expires_in: 3600,
      })

      const res = await POST(makeRequest({ refresh_token: 'tok-1' }))
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.refresh_token).toBe('new-refresh-012')

      // Old token is marked used exactly once.
      expect(updates).toHaveLength(1)
      expect(updates[0].id).toBe('tok-1')
      expect(updates[0].patch.used_at).toBeTruthy()

      // A new row is recorded in the same session family.
      const newRow = table.find((r) => r.id === 'new-refresh-012')
      expect(newRow).toBeDefined()
      expect(newRow?.family_id).toBe('fam-1')
      expect(newRow?.user_id).toBe('user-1')
      expect(newRow?.used_at).toBeNull()
      expect(newRow?.revoked_at).toBeNull()

      // No reuse detection on a normal rotation.
      expect(notifySessionRevoked).not.toHaveBeenCalled()
    })
  })

  describe('reuse detection', () => {
    it('revokes the whole session family, clears cookies, returns 401 and notifies the user', async () => {
      const { table } = mockServiceClient([
        {
          id: 'tok-1',
          family_id: 'fam-1',
          user_id: 'user-1',
          used_at: '2024-01-01T00:00:00.000Z',
          revoked_at: null,
        },
        {
          id: 'tok-2',
          family_id: 'fam-1',
          user_id: 'user-1',
          used_at: null,
          revoked_at: null,
        },
        {
          id: 'tok-3',
          family_id: 'fam-2',
          user_id: 'user-1',
          used_at: null,
          revoked_at: null,
        },
      ])
      mockSupabase({
        access_token: 'new-access-789',
        refresh_token: 'new-refresh-012',
        expires_in: 3600,
      })

      const res = await POST(makeRequest({ refresh_token: 'tok-1' }))
      expect(res.status).toBe(401)

      const body = await res.json()
      expect(body.error).toBe('Invalid or expired refresh token')

      // Every token in the reused family is revoked.
      const family = table.filter((r) => r.family_id === 'fam-1')
      expect(family).toHaveLength(2)
      for (const row of family) {
        expect(row.revoked_at).toBeTruthy()
      }

      // Tokens from other families are untouched.
      const other = table.find((r) => r.id === 'tok-3')
      expect(other?.revoked_at).toBeNull()

      // Auth cookies are cleared on the response.
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toMatch(/sb-access-token=;/)
      expect(setCookie).toMatch(/sb-refresh-token=;/)

      // User is notified and the event is audited.
      expect(notifySessionRevoked).toHaveBeenCalledTimes(1)
      expect(notifySessionRevoked).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', familyId: 'fam-1' }),
      )
      expect(logAuthEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'refresh_token_reuse_detected',
          userId: 'user-1',
          familyId: 'fam-1',
        }),
      )
    })

    it('does not issue a new token pair when reuse is detected', async () => {
      const { table } = mockServiceClient([
        {
          id: 'tok-1',
          family_id: 'fam-1',
          user_id: 'user-1',
          used_at: '2024-01-01T00:00:00.000Z',
          revoked_at: null,
        },
      ])
      mockSupabase({
        access_token: 'new-access-789',
        refresh_token: 'new-refresh-012',
        expires_in: 3600,
      })

      const res = await POST(makeRequest({ refresh_token: 'tok-1' }))
      expect(res.status).toBe(401)
      expect(table.find((r) => r.id === 'new-refresh-012')).toBeUndefined()
    })
  })
})
