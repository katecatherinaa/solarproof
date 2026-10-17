import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { env } from '@/env'

const VALID_EVENTS = [
  'anchor',
  'mint',
  'retire',
  'mint_failed',
  'certificate.minted',
  'certificate.transferred',
  'certificate.retired',
] as const

const WebhookSchema = z.object({
  cooperative_id: z.string().uuid(),
  url: z.string().trim().url(),
  secret: z.string().trim().min(16),
  events: z.array(z.enum(VALID_EVENTS)).min(1),
})

const QuerySchema = z.object({
  cooperative_id: z.string().uuid(),
})

/**
 * Verify the HMAC-SHA256 signature on an incoming webhook payload.
 *
 * The sender must include a `X-SolarProof-Signature` header containing
 * `HMAC-SHA256(<raw body>, WEBHOOK_SECRET)` encoded as hex.
 *
 * Constant-time comparison (`timingSafeEqual`) is used to prevent
 * timing-oracle attacks.
 *
 * @param secret  The `WEBHOOK_SECRET` env var value.
 * @param rawBody The raw (unparsed) request body bytes.
 * @param sigHeader The value of the `X-SolarProof-Signature` header.
 * @returns `true` if the signature is valid.
 */
function verifySignature(secret: string, rawBody: Buffer, sigHeader: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sigHeader, 'hex'))
  } catch {
    // Buffer lengths differ → invalid signature
    return false
  }
}

/**
 * POST /api/webhooks
 *
 * Register a webhook endpoint for a cooperative.
 * Body: { cooperative_id, url, secret, events }
 *
 * When `WEBHOOK_SECRET` is configured the request must carry a valid
 * `X-SolarProof-Signature` header (HMAC-SHA256 of the raw body using the
 * shared secret). Requests with a missing or invalid signature are rejected
 * with HTTP 401.
 */
export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer())

  // ── HMAC signature verification ──────────────────────────────────────────
  const webhookSecret = env.WEBHOOK_SECRET
  if (webhookSecret) {
    const sigHeader = req.headers.get('x-solarproof-signature') ?? ''
    if (!sigHeader || !verifySignature(webhookSecret, rawBody, sigHeader)) {
      return NextResponse.json(
        { error: 'Invalid or missing webhook signature' },
        { status: 401 }
      )
    }
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = WebhookSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const db = createServiceClient()
  const { data, error } = await db
    .from('webhook_endpoints')
    .insert(parsed.data)
    .select('id, cooperative_id, url, events, active, created_at')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Failed to register webhook' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}

/**
 * GET /api/webhooks?cooperative_id=UUID
 *
 * List registered webhook endpoints for a cooperative.
 */
export async function GET(req: NextRequest) {
  const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries())
  const parsedQuery = QuerySchema.safeParse(queryParams)

  if (!parsedQuery.success) {
    return NextResponse.json({ error: parsedQuery.error.flatten() }, { status: 400 })
  }

  const { cooperative_id: cooperativeId } = parsedQuery.data

  const db = createServiceClient()
  const { data, error } = await db
    .from('webhook_endpoints')
    .select('id, cooperative_id, url, events, active, created_at')
    .eq('cooperative_id', cooperativeId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: data ?? [] })
}
