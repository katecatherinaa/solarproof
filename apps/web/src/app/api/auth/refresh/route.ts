import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createHash, randomUUID } from 'crypto'
import { env } from '@/env'

const RefreshSchema = z.object({ refresh_token: z.string().trim().min(1) })

const ACCESS_COOKIE = 'sp_access_token'
const REFRESH_COOKIE = 'sp_refresh_token'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function clearAuthCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 })
  res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 })
}

interface RefreshTokenRow {
  id: string
  token_hash: string
  session_family_id: string
  parent_token_id: string | null
  used_at: string | null
  revoked_at: string | null
  expires_at: string | null
  user_id: string | null
}

async function emitAuditLog(
  supabase: ReturnType<typeof createClient>,
  event: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from('audit_logs').insert({
      event,
      details,
      created_at: new Date().toISOString(),
    })
  } catch {
    // Audit logging must never break the auth flow.
  }
}

async function notifyUser(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
  message: string
): Promise<void> {
  if (!userId) return
  try {
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'security',
      message,
      created_at: new Date().toISOString(),
    })
  } catch {
    // Notification failures must never break the auth flow.
  }
}

/** POST /api/auth/refresh — rotate refresh token and return new token pair */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = RefreshSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const supabase = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  )

  const presentedToken = parsed.data.refresh_token
  const presentedHash = hashToken(presentedToken)

  // Look up the presented refresh token.
  const { data: existing, error: lookupError } = await supabase
    .from('refresh_tokens')
    .select('*')
    .eq('token_hash', presentedHash)
    .maybeSingle<RefreshTokenRow>()

  if (lookupError) {
    return NextResponse.json({ error: 'Unable to validate refresh token' }, { status: 500 })
  }

  // Reuse detection: token already used or revoked => revoke entire family.
  if (existing && (existing.used_at || existing.revoked_at)) {
    const now = new Date().toISOString()

    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: now })
      .eq('session_family_id', existing.session_family_id)
      .is('revoked_at', null)

    await emitAuditLog(supabase, 'refresh_token_reuse_detected', {
      session_family_id: existing.session_family_id,
      token_id: existing.id,
      user_id: existing.user_id,
      detected_at: now,
    })

    await notifyUser(
      supabase,
      existing.user_id,
      'A reused refresh token was detected. For your security, you have been logged out of all sessions in this session family. Please sign in again.'
    )

    const res = NextResponse.json(
      { error: 'Refresh token reuse detected. Session revoked.', code: 'refresh_token_reuse_detected' },
      { status: 401 }
    )
    clearAuthCookies(res)
    return res
  }

  // Mark the presented token as used (rotation).
  if (existing) {
    const { error: markUsedError } = await supabase
      .from('refresh_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', existing.id)
      .is('used_at', null)

    if (markUsedError) {
      return NextResponse.json({ error: 'Unable to rotate refresh token' }, { status: 500 })
    }
  }

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: presentedToken,
  })

  if (error || !data.session) {
    return NextResponse.json({ error: 'Invalid or expired refresh token' }, { status: 401 })
  }

  const newRefreshToken = data.session.refresh_token
  const newHash = hashToken(newRefreshToken)
  const familyId = existing?.session_family_id ?? randomUUID()
  const userId = data.session.user?.id ?? existing?.user_id ?? null

  // Persist the new refresh token in the same family, linked to the presented token.
  const { error: persistError } = await supabase.from('refresh_tokens').insert({
    token_hash: newHash,
    session_family_id: familyId,
    parent_token_id: existing?.id ?? null,
    user_id: userId,
    used_at: null,
    revoked_at: null,
    expires_at: null,
  })

  if (persistError) {
    return NextResponse.json({ error: 'Unable to persist rotated refresh token' }, { status: 500 })
  }

  const res = NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: newRefreshToken,
    expires_in: data.session.expires_in,
    token_type: 'Bearer',
  })

  res.cookies.set(ACCESS_COOKIE, data.session.access_token, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })
  res.cookies.set(REFRESH_COOKIE, newRefreshToken, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })

  return res
}