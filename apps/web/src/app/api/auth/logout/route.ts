import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError, createUserClient, revokeToken } from '@/lib/auth'
import { revokeSessionFamily } from '@/lib/auth/refresh-tokens'

const ACCESS_TOKEN_COOKIE = 'sp_access_token'
const REFRESH_TOKEN_COOKIE = 'sp_refresh_token'

/**
 * POST /api/auth/logout
 *
 * Invalidates the current session, revokes the access token JTI, revokes the
 * entire refresh-token session family, and clears the HttpOnly auth cookies
 * set by /api/auth/login.
 *
 * Closes #113, #770.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  // Add token JTI to revocation list before signing out
  await revokeToken(auth.accessToken)

  // Revoke the entire refresh-token session family so the logged-out session
  // cannot be refreshed (and any rotated descendants are also invalidated).
  if (auth.sessionId) {
    await revokeSessionFamily(auth.sessionId)
  }

  const client = createUserClient(auth.accessToken)
  const { error } = await client.auth.signOut()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const res = NextResponse.json({ ok: true })

  // Clear the auth cookies by setting them to expire immediately.
  // Path and SameSite must match the values used when the cookie was set.
  const clearOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 0,
  }

  res.cookies.set(ACCESS_TOKEN_COOKIE, '', clearOptions)
  res.cookies.set(REFRESH_TOKEN_COOKIE, '', clearOptions)

  return res
}