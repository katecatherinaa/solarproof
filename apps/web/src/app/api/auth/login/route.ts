import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { env } from '@/env'
import {
  isAccountLocked,
  recordFailedAttempt,
  resetFailedAttempts,
  lockoutRemainingSeconds,
} from '@/lib/account-lockout'
import { sendLockoutEmail } from '@/lib/email'
import { hashRefreshToken, storeRefreshToken } from '@/lib/refresh-token-store'

const LoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(8),
})

// Cookie names used for auth token storage.
// These must match the names read by requireAuth() in src/lib/auth.ts.
const ACCESS_TOKEN_COOKIE = 'sp_access_token'
const REFRESH_TOKEN_COOKIE = 'sp_refresh_token'

/**
 * POST /api/auth/login
 *
 * Exchanges email + password for Supabase session tokens and stores them in
 * HttpOnly, Secure, SameSite=Strict cookies (issue #113).
 *
 * Brute-force protection (issue #115):
 *   - Checks whether the account is currently locked before attempting auth.
 *   - Records failed attempts in Redis; locks the account after MAX_ATTEMPTS
 *     failures within the 15-minute window and notifies the user via email.
 *   - Resets the counter on successful login.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { email, password } = parsed.data

  // ── Account lockout check (issue #115) ────────────────────────────────────
  const locked = await isAccountLocked(email)
  if (locked) {
    const remaining = await lockoutRemainingSeconds(email)
    return NextResponse.json(
      {
        error: 'Account temporarily locked due to too many failed login attempts.',
        retry_after_seconds: remaining,
      },
      { status: 429 }
    )
  }

  // ── Supabase authentication ───────────────────────────────────────────────
  const supabase = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  )

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    // Record failure; lock if threshold reached
    const justLocked = await recordFailedAttempt(email)
    if (justLocked) {
      // Fire-and-forget — do not let email failure block the response
      sendLockoutEmail(email).catch((err: unknown) =>
        console.error('[lockout] email send failed', err)
      )
    }
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  // Successful login — reset failure counter
  await resetFailedAttempts(email)

  // ── Start a new refresh-token session family (issue #770) ─────────────────
  // Every login begins a fresh family; the issued refresh token is the root
  // (parent_token_id = null) of that family.
  const sessionFamilyId = randomUUID()
  try {
    await storeRefreshToken({
      tokenHash: hashRefreshToken(data.session.refresh_token),
      sessionFamilyId,
      parentTokenId: null,
      userId: data.user?.id ?? null,
    })
  } catch (err) {
    console.error('[refresh-token] failed to persist session family', err)
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 })
  }

  // ── Set HttpOnly cookies (issue #113) ─────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production'
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/',
  }

  const res = NextResponse.json({
    ok: true,
    expires_in: data.session.expires_in,
    token_type: 'Bearer',
  })

  res.cookies.set(ACCESS_TOKEN_COOKIE, data.session.access_token, {
    ...cookieOptions,
    maxAge: data.session.expires_in ?? 3600,
  })

  res.cookies.set(REFRESH_TOKEN_COOKIE, data.session.refresh_token, {
    ...cookieOptions,
    maxAge: 60 * 24 * 60 * 60, // 60 days
  })

  return res
}
