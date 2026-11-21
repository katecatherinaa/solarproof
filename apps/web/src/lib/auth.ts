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
export async function requireAuth(
  req: NextRequest
): Promise<{ user: { id: string; email?: string }; accessToken: string; cooperativeId: string } | NextResponse> {
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

  const cooperativeId = data.user.app_metadata.cooperative_id
  if (!cooperativeId) {
    return NextResponse.json({ error: 'User has no associated cooperative' }, { status: 403 })
  }

  return {
    user: { id: data.user.id, email: data.user.email },
    accessToken,
    cooperativeId,
  }
}

/**
 * Type guard: returns `true` when `requireAuth` returned a `NextResponse`.
 */
export function isAuthError(result: unknown): result is NextResponse {
  return result instanceof NextResponse
}

// ---------------------------------------------------------------------------
// Refresh-token session management (issue #770)
//
// Refresh tokens are stored hashed in the `refresh_tokens` table. Each token
// belongs to a "family" (one per login session). Every refresh call rotates the
// token: the presented token is marked used and a child token is inserted into
// the same family. Presenting an already-used token is treated as theft and
// invalidates the entire family.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto'

/** Hash a raw refresh token for at-rest storage/lookup (SHA-256, hex). */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

/** Generate a cryptographically random raw refresh token. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface RefreshTokenRecord {
  id: string
  family_id: string
  user_id: string
  token_hash: string
  parent_id: string | null
  used_at: string | null
  revoked_at: string | null
  expires_at: string
  created_at: string
}

/**
 * Create a brand-new refresh-token family (one per login session).
 * Returns the raw token (to hand to the client) and the stored record.
 */
export async function createRefreshTokenRecord(params: {
  userId: string
  ttlSeconds?: number
}): Promise<{ rawToken: string; record: RefreshTokenRecord }> {
  const db = createServiceClient()
  const rawToken = generateRefreshToken()
  const tokenHash = hashRefreshToken(rawToken)
  const familyId = randomBytes(16).toString('hex')
  const ttl = params.ttlSeconds ?? 30 * 24 * 60 * 60
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()

  const { data, error } = await db
    .from('refresh_tokens')
    .insert({
      family_id: familyId,
      user_id: params.userId,
      token_hash: tokenHash,
      parent_id: null,
      expires_at: expiresAt,
    })
    .select()
    .single()

  if (error || !data) {
    throw new Error(`Failed to create refresh token: ${error?.message ?? 'unknown error'}`)
  }

  return { rawToken, record: data as RefreshTokenRecord }
}

export type RotateRefreshTokenResult =
  | { status: 'rotated'; rawToken: string; record: RefreshTokenRecord; userId: string }
  | { status: 'reuse'; userId: string; familyId: string }
  | { status: 'invalid' }
  | { status: 'expired'; userId: string; familyId: string }

/**
 * Rotate a refresh token.
 *
 * - Looks up the presented token by hash.
 * - If it has already been used or revoked, this is a reuse/theft signal:
 *   the whole family is revoked and `status: 'reuse'` is returned.
 * - Otherwise the token is marked used and a child token is inserted into the
 *   same family, atomically-ish (mark-then-insert; a failed insert revokes the
 *   family to fail closed).
 */
export async function rotateRefreshToken(params: {
  rawToken: string
  ttlSeconds?: number
}): Promise<RotateRefreshTokenResult> {
  const db = createServiceClient()
  const tokenHash = hashRefreshToken(params.rawToken)

  const { data: existing, error: lookupError } = await db
    .from('refresh_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (lookupError || !existing) return { status: 'invalid' }

  const current = existing as RefreshTokenRecord

  // Reuse detection: a token that was already used or revoked means the
  // credential has been replayed. Nuke the entire family.
  if (current.used_at || current.revoked_at) {
    await revokeSessionFamily(current.family_id)
    return { status: 'reuse', userId: current.user_id, familyId: current.family_id }
  }

  if (new Date(current.expires_at).getTime() <= Date.now()) {
    await revokeSessionFamily(current.family_id)
    return { status: 'expired', userId: current.user_id, familyId: current.family_id }
  }

  // Mark the presented token as used. Guard on `used_at IS NULL` so a
  // concurrent replay cannot both succeed.
  const { data: marked, error: markError } = await db
    .from('refresh_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', current.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle()

  if (markError || !marked) {
    // Lost the race (or DB error) — treat as reuse and fail closed.
    await revokeSessionFamily(current.family_id)
    return { status: 'reuse', userId: current.user_id, familyId: current.family_id }
  }

  const rawToken = generateRefreshToken()
  const ttl = params.ttlSeconds ?? 30 * 24 * 60 * 60
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()

  const { data: child, error: insertError } = await db
    .from('refresh_tokens')
    .insert({
      family_id: current.family_id,
      user_id: current.user_id,
      token_hash: hashRefreshToken(rawToken),
      parent_id: current.id,
      expires_at: expiresAt,
    })
    .select()
    .single()

  if (insertError || !child) {
    await revokeSessionFamily(current.family_id)
    return { status: 'reuse', userId: current.user_id, familyId: current.family_id }
  }

  return {
    status: 'rotated',
    rawToken,
    record: child as RefreshTokenRecord,
    userId: current.user_id,
  }
}

/**
 * Revoke every token in a session family. Used on reuse detection and logout.
 */
export async function revokeSessionFamily(familyId: string): Promise<void> {
  const db = createServiceClient()
  await db
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('family_id', familyId)
    .is('revoked_at', null)
}
