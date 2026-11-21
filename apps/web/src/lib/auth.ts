import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { Database } from './database.types'
import { env } from '@/env'
import { redis } from './redis'
import { auditLog } from './audit'

/**
 * Create a Supabase client that validates the caller's JWT (anon key, RLS enforced).
 */
export function createUserClient(accessToken: string) {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    }
  )
}

/** Service-role client — bypasses RLS, used for revocation list writes. */
function createServiceClient() {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )
}

/**
 * Decode the JTI claim from a JWT without verifying the signature.
 * Verification is handled by Supabase's getUser() call.
 */
function extractJti(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.jti === 'string' ? payload.jti : null
  } catch {
    return null
  }
}

// Revocation cache TTL (seconds) — minimizes DB queries on hot auth paths.
const REVOCATION_CACHE_TTL = 30

function revocationCacheKey(jti: string): string {
  return `revoked_token:${jti}`
}

/**
 * Read a JTI's revocation status from the Redis cache.
 * Returns `null` on a cache miss (or if Redis is unavailable).
 */
async function getCachedRevocation(jti: string): Promise<boolean | null> {
  try {
    const cached = await redis.get(revocationCacheKey(jti))
    if (cached === null || cached === undefined) return null
    return cached === '1' || cached === 'true' || cached === 1 || cached === true
  } catch {
    return null
  }
}

/**
 * Cache a JTI's revocation status (positive or negative) for 30s.
 * Failures are swallowed — the DB remains the source of truth.
 */
async function setCachedRevocation(jti: string, revoked: boolean): Promise<void> {
  try {
    await redis.set(revocationCacheKey(jti), revoked ? '1' : '0', {
      ex: REVOCATION_CACHE_TTL,
    })
  } catch {
    // Ignore cache write failures.
  }
}

/**
 * Check whether a token's JTI appears in the revocation list.
 * Consults the Redis cache first; on a miss queries the DB and caches
 * both positive and negative results for 30s.
 * Returns true if the token has been revoked.
 */
async function isRevoked(jti: string): Promise<boolean> {
  const cached = await getCachedRevocation(jti)
  if (cached !== null) return cached

  const db = createServiceClient()
  const { data } = await db
    .from('revoked_tokens')
    .select('jti')
    .eq('jti', jti)
    .maybeSingle()
  const revoked = data !== null
  await setCachedRevocation(jti, revoked)
  return revoked
}

/**
 * Add a token's JTI to the revocation list.
 * expires_at is set to now + 15 minutes (access token max lifetime).
 */
export async function revokeToken(accessToken: string): Promise<void> {
  const jti = extractJti(accessToken)
  if (!jti) return
  const db = createServiceClient()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  await db.from('revoked_tokens').upsert({ jti, expires_at: expiresAt })
  // Invalidate/refresh the cache so logout takes effect immediately.
  await setCachedRevocation(jti, true)
}

// Cookie name that /api/auth/login sets with the access token.
// Must stay in sync with the name used in the login/logout route handlers.
const ACCESS_TOKEN_COOKIE = 'sp_access_token'

/**
 * Extract and validate the Bearer JWT from either:
 *   1. The `sp_access_token` HttpOnly cookie (set by /api/auth/login), or
 *   2. The `Authorization: Bearer <token>` header (for API / non-browser clients).
 *
 * Cookie auth is preferred — it prevents JavaScript from accessing the token
 * and mitigates XSS token theft (issue #113).
 *
 * Also checks the revocation list before accepting the token.
 */
export interface AuthContext {
  user: { id: string; email?: string }
  accessToken: string
  /** The cooperative currently active for this session (JWT cooperative_id claim). */
  cooperativeId: string
  /** All cooperatives the user may switch to (includes the current one). */
  cooperativeIds: string[]
}

/**
 * Resolve the full set of cooperatives a user may access.
 *
 * Prefers the `cooperative_ids` app_metadata claim (multi-cooperative accounts).
 * Falls back to the single `cooperative_id` claim for backward compatibility.
 * The current cooperative is always included, even if the claims disagree.
 */
export function resolveCooperativeIds(
  appMetadata: Record<string, unknown>,
  currentCooperativeId: string
): string[] {
  const ids = new Set<string>()

  const rawList = appMetadata.cooperative_ids
  if (Array.isArray(rawList)) {
    for (const value of rawList) {
      if (typeof value === 'string' && value.length > 0) ids.add(value)
    }
  }

  const single = appMetadata.cooperative_id
  if (typeof single === 'string' && single.length > 0) ids.add(single)

  ids.add(currentCooperativeId)

  return Array.from(ids)
}

export async function requireAuth(
  req: NextRequest
): Promise<AuthContext | NextResponse> {
  // Prefer HttpOnly cookie over Authorization header.
  const cookieToken = req.cookies.get(ACCESS_TOKEN_COOKIE)?.value ?? null
  const authHeader = req.headers.get('authorization') ?? ''
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const accessToken = cookieToken ?? headerToken

  if (!accessToken) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 })
  }

  // Check revocation list (Redis-cached) before hitting Supabase
  const jti = extractJti(accessToken)
  if (jti && (await isRevoked(jti))) {
    await auditLog({
      action: 'auth.revoked_token',
      metadata: { jti, path: req.nextUrl.pathname },
    })
    return NextResponse.json({ error: 'Token has been revoked' }, { status: 401 })
  }

  const client = createUserClient(accessToken)
  const { data, error } = await client.auth.getUser()

  if (error || !data.user) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const appMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>
  const cooperativeId = appMetadata.cooperative_id
  if (typeof cooperativeId !== 'string' || !cooperativeId) {
    return NextResponse.json({ error: 'User has no associated cooperative' }, { status: 403 })
  }

  return {
    user: { id: data.user.id, email: data.user.email },
    accessToken,
    cooperativeId,
    cooperativeIds: resolveCooperativeIds(appMetadata, cooperativeId),
  }
}

/**
 * Type guard: returns `true` when `requireAuth` returned a `NextResponse`.
 */
export function isAuthError(result: unknown): result is NextResponse {
  return result instanceof NextResponse
}
