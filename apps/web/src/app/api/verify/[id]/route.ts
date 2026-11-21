import { NextRequest, NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase'
import { getCachedCert, setCachedCert } from '@/lib/cache'

/**
 * GET /api/verify/[id]
 *
 * Public endpoint — no auth required.
 * Returns the full chain of custody for a certificate identified by:
 *   - certificate UUID
 *   - reading_hash (64-char hex)
 *   - mint_tx_hash (64-char hex)
 *
 * Response is cached for 60 s.
 *
 * Abuse protection:
 *   - per-IP rate limiting (5 req/min for unverified callers) enforced by
 *     middleware.ts — see docs/ABUSE_PROTECTION.md.
 *   - bot protection (Cloudflare Turnstile / hCaptcha) validated server-side
 *     here. The token is supplied via the `cf-turnstile-response` or
 *     `h-captcha-response` header (or query param) by the /verify page.
 *   - internal service calls presenting a valid admin token bypass the
 *     challenge entirely.
 */

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify'

function getAdminToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return req.headers.get('x-admin-token')
}

function isInternalCall(req: NextRequest): boolean {
  const expected = process.env.ADMIN_API_TOKEN
  if (!expected) return false
  const provided = getAdminToken(req)
  if (!provided) return false
  // Constant-time-ish comparison to avoid trivial timing leaks.
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function getCaptchaToken(req: NextRequest): string | null {
  return (
    req.headers.get('cf-turnstile-response') ??
    req.headers.get('h-captcha-response') ??
    req.nextUrl.searchParams.get('cf-turnstile-response') ??
    req.nextUrl.searchParams.get('h-captcha-response')
  )
}

async function verifyCaptchaToken(token: string, remoteIp: string | null): Promise<boolean> {
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY
  const hcaptchaSecret = process.env.HCAPTCHA_SECRET_KEY

  const secret = turnstileSecret ?? hcaptchaSecret
  if (!secret) {
    // No bot protection configured — fail closed in production, allow in dev.
    return process.env.NODE_ENV !== 'production'
  }

  const url = turnstileSecret ? TURNSTILE_VERIFY_URL : HCAPTCHA_VERIFY_URL
  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp) body.set('remoteip', remoteIp)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || !/^([0-9a-f]{64}|[0-9a-f-]{36})$/i.test(id)) {
    return NextResponse.json({ error: 'id must be a UUID or 64-char hex hash' }, { status: 400 })
  }

  // Internal service calls with a valid admin token bypass bot protection.
  if (!isInternalCall(req)) {
    const token = getCaptchaToken(req)
    if (!token) {
      return NextResponse.json(
        { error: 'Bot verification required' },
        { status: 403 }
      )
    }
    const remoteIp =
      req.headers.get('cf-connecting-ip') ??
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      null
    const valid = await verifyCaptchaToken(token, remoteIp)
    if (!valid) {
      return NextResponse.json(
        { error: 'Bot verification failed' },
        { status: 403 }
      )
    }
  }

  const cached = await getCachedCert<unknown>(id)
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=30',
        'X-Cache': 'HIT',
      },
    })
  }

  const db = createAnonClient()
  let cert = null
  for (const column of ['id', 'reading_hash', 'mint_tx_hash'] as const) {
    const { data } = await db.from('certificates').select('*').eq(column, id).maybeSingle()
    if (data) { cert = data; break }
  }

  if (!cert) {
    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  }

  const { data: reading } = await db
    .from('readings')
    .select('*')
    .eq('id', cert.reading_id)
    .single()

  const chain = {
    certificate: {
      id: cert.id,
      kwh: cert.kwh,
      issued_at: cert.issued_at,
      retired: cert.retired,
      retired_at: cert.retired_at,
      retired_by: cert.retired_by,
    },
    on_chain: {
      anchor_tx: cert.anchor_tx_hash,
      anchor_explorer: `https://stellar.expert/explorer/testnet/tx/${cert.anchor_tx_hash}`,
      mint_tx: cert.mint_tx_hash,
      mint_explorer: `https://stellar.expert/explorer/testnet/tx/${cert.mint_tx_hash}`,
      retirement_tx: cert.retired_at ? cert.mint_tx_hash : null,
    },
    meter_proof: reading
      ? {
          meter_id: reading.meter_id,
          reading_hash: reading.reading_hash,
          signature_hex: reading.signature_hex,
          kwh: reading.kwh,
          timestamp: reading.timestamp,
          verified: true,
        }
      : null,
  }

  await setCachedCert(id, chain)

  return NextResponse.json(chain, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=30',
      'X-Cache': 'MISS',
    },
  })
}
