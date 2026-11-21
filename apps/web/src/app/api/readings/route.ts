import { NextRequest, NextResponse } from 'next/server'
import { verifyAsync } from '@noble/ed25519'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { computeReadingHash } from '@/lib/crypto'
import { kwhToStroops } from '@solarproof/stellar'
import { checkRateLimit, getCachedMeterRevocation, setCachedMeterRevocation } from '@/lib/cache'
import { checkRateLimit as checkIpRateLimit, getClientIp } from '@/lib/rate-limit'
import { getIdempotentResponse, storeIdempotentResponse } from '@/lib/idempotency'
import { logger } from '@/lib/logger'
import { requireAuth, isAuthError } from '@/lib/auth'
import { enqueue } from '@/lib/queue'
import { AppError, ErrorCategory, errorBody } from '@/lib/errors'
import { auditLog } from '@/lib/audit'
import { isOperatorSuspended } from '@/lib/operator-suspension'

const NONCE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function isAlreadyAnchoredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string }
  return e.code === '23505' || (e.message?.includes('duplicate') ?? false) || (e.message?.includes('unique') ?? false)
}

// IP rate limit: 10 POSTs per 60 s per IP
const IP_RATE_LIMIT = 10
const IP_RATE_WINDOW_MS = 60_000
const PAGE_SIZES = [25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 50

const QuerySchema = z.object({
  // Offset-based pagination (preferred)
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .refine((v) => (PAGE_SIZES as readonly number[]).includes(v), {
      message: `page_size must be one of ${PAGE_SIZES.join(', ')}`,
    })
    .default(DEFAULT_PAGE_SIZE),
  // Legacy cursor-based pagination (kept for backward compatibility)
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
})

/**
 * GET /api/v1/readings
 *
 * Offset-based pagination via `page` (>=1) and `page_size` (25/50/100, default 50).
 * Returns `{ data, total, page, page_size }`.
 *
 * Legacy cursor-based pagination via `cursor` (ISO timestamp) and `limit` (max 100)
 * is still supported for backward compatibility; when a `cursor` is supplied the
 * response additionally includes `next_cursor`.
 *
 * Requires operator JWT.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  const { searchParams } = req.nextUrl
  const queryParams = Object.fromEntries(searchParams.entries())
  const parsedQuery = QuerySchema.safeParse(queryParams)

  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', code: ErrorCategory.VALIDATION, details: parsedQuery.error.flatten() },
      { status: 400 }
    )
  }

  const { page, page_size, cursor } = parsedQuery.data
  const db = createServiceClient()

  // Total count (for UI pagination). `head: true` avoids transferring rows and
  // relies on the planner's count strategy, keeping this cheap for large tables.
  const { count } = await db
    .from('readings')
    .select('id', { count: 'exact', head: true })

  const total = count ?? 0

  // Legacy cursor mode: fetch limit+1 rows after the cursor.
  if (cursor) {
    const limit = parsedQuery.data.limit ?? page_size
    const { data, error } = await db
      .from('readings')
      .select('id, meter_id, kwh, timestamp, reading_hash, anchored, minted, anchor_tx_hash, mint_tx_hash')
      .order('timestamp', { ascending: false })
      .lt('timestamp', cursor)
      .limit(limit + 1)

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch readings', code: ErrorCategory.DB_QUERY },
        { status: 500 }
      )
    }

    const rows = data ?? []
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const next_cursor = hasMore ? (pageRows.length > 0 ? pageRows[pageRows.length - 1].timestamp : null) : null

    return NextResponse.json({
      data: pageRows,
      next_cursor,
      total,
      page,
      page_size,
    })
  }

  // Offset-based pagination.
  const from = (page - 1) * page_size
  const to = from + page_size - 1

  const { data, error } = await db
    .from('readings')
    .select('id, meter_id, kwh, timestamp, reading_hash, anchored, minted, anchor_tx_hash, mint_tx_hash')
    .order('timestamp', { ascending: false })
    .range(from, to)

  if (error) {
    return NextResponse.json(
      { error: 'Failed to fetch readings', code: ErrorCategory.DB_QUERY },
      { status: 500 }
    )
  }

  return NextResponse.json({
    data: data ?? [],
    total,
    page,
    page_size,
  })
}

const MetadataSchema = z.object({
  firmware_version: z.string().optional(),
  hardware_model: z.string().optional(),
  location_lat: z.number().optional(),
  location_lon: z.number().optional(),
  manufacturer: z.string().optional(),
})

const ReadingSchema = z.object({
  meter_id: z.string().uuid({ message: 'meter_id must be a valid UUID' }),
  kwh: z
    .number({ invalid_type_error: 'kwh must be a number' })
    .positive({ message: 'kwh must be positive' })
    .max(1_000_000, { message: 'kwh value is unrealistically large' }),
  timestamp: z
    .number({ invalid_type_error: 'timestamp must be a number' })
    .int({ message: 'timestamp must be an integer' })
    .positive({ message: 'timestamp must be a positive Unix epoch (seconds)' })
    .max(9_999_999_999, { message: 'timestamp must be Unix epoch in seconds, not milliseconds' }),
  signature_hex: z
    .string()
    .trim()
    .length(128, { message: 'signature_hex must be exactly 128 hex characters (64-byte Ed25519 signature)' })
    .regex(/^[0-9a-fA-F]{128}$/, { message: 'signature_hex must contain only hexadecimal characters' }),
  nonce: z.string().trim().min(1).max(128),
})

/**
 * POST /api/readings
 *
 * Verifies the Ed25519 signature, persists the reading, anchors on Stellar,
 * and mints a certificate.
 *
 * Supports idempotency via the `Idempotency-Key` header (UUID recommended).
 * Duplicate requests with the same key return the cached response without
 * re-processing. Keys expire after IDEMPOTENCY_TTL_SECONDS (default 24 h).
 *
 * Returns 202 Accepted with { reading_id, job_id }.
 */
export async function POST(req: NextRequest) {
  const correlationId = req.headers.get('x-correlation-id') ?? undefined
  const log = correlationId ? logger.withCorrelationId(correlationId) : logger

  // IP-based rate limit: 10 requests / 60 s per IP (abuse protection)
  const ip = getClientIp(req)
  const ipRl = checkIpRateLimit(`ip:readings:${ip}`, IP_RATE_LIMIT, IP_RATE_WINDOW_MS)
  if (!ipRl.allowed) {
    const retryAfter = Math.ceil((ipRl.resetAt - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.', retryAfter },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(IP_RATE_LIMIT),
          'X-RateLimit-Remaining': String(ipRl.remaining),
          'X-RateLimit-Reset': String(Math.ceil(ipRl.resetAt / 1000)),
        },
      }
    )
  }

  const body = await req.json().catch(() => null)
  if (body === null) {
    return NextResponse.json(
      { error: 'Request body must be valid JSON', code: ErrorCategory.VALIDATION },
      { status: 400 }
    )
  }
  const parsed = ReadingSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('readings.post.invalid_body', { errors: parsed.error.flatten() })
    return NextResponse.json(
      { error: 'Invalid request body', code: ErrorCategory.VALIDATION, details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { meter_id, kwh, timestamp, signature_hex, nonce } = parsed.data

  const db = createServiceClient()

  if (await getCachedMeterRevocation(meter_id)) {
    return NextResponse.json(
      { error: 'Meter has been revoked', code: ErrorCategory.UNAUTHORIZED },
      { status: 403 }
    )
  }

  // Timestamp check: reject if >5 minutes old
  const ageMs = Date.now() - (timestamp * 1000)
  if (ageMs > 5 * 60 * 1000 || ageMs < -60 * 1000) {
    log.warn('readings.post.stale_timestamp', { meter_id, timestamp })
    return NextResponse.json(
      { error: 'Reading timestamp is too old or in the future', code: ErrorCategory.VALIDATION },
      { status: 400 }
    )
  }

  // Fetch meter + cooperative
  const { data: meter } = await db
    .from('meters')
    .select('id, pubkey_hex, cooperative_id, api_key, api_key_expires_at, active, revoked_at')
    .eq('id', meter_id)
    .single()

  if (meter?.revoked_at) {
    await setCachedMeterRevocation(meter_id, true)
    log.warn('readings.post.meter_revoked', { meter_id })
    return NextResponse.json(
      { error: 'Meter has been revoked', code: ErrorCategory.UNAUTHORIZED },
      { status: 403 }
    )
  }

  if (!meter || !meter.active) {
    log.warn('readings.post.meter_not_found_or_revoked', { meter_id })
    return NextResponse.json(
      { error: 'Meter not found or inactive', code: ErrorCategory.VALIDATION },
      { status: 404 }
    )
  }

  await setCachedMeterRevocation(meter_id, false)

  // Return cached responses only after confirming the meter is not revoked.
  const idempotencyKey = req.headers.get('idempotency-key')
  if (idempotencyKey) {
    const cached = await getIdempotentResponse(idempotencyKey)
    if (cached) {
      log.info('readings.post.idempotent_hit', { idempotencyKey })
      return NextResponse.json(cached.body, { status: cached.status })
    }
  }

  const { data: existingNonce } = await db
    .from('idempotency_keys')
    .select('response, created_at')
    .eq('nonce', nonce)
    .maybeSingle()

  if (existingNonce) {
    const age = Date.now() - new Date(existingNonce.created_at).getTime()
    if (age < NONCE_TTL_MS) {
      return NextResponse.json(existingNonce.response, { status: 200 })
    }
    await db.from('idempotency_keys').delete().eq('nonce', nonce)
  }

  // Validate API key (presence, match, and expiry) before Ed25519 signature check
  const apiKey = req.headers.get('x-api-key')
  if (
    !apiKey ||
    apiKey !== meter.api_key ||
    (meter.api_key_expires_at && new Date(meter.api_key_expires_at).getTime() <= Date.now())
  ) {
    log.warn('readings.post.invalid_api_key', { meter_id })
    return NextResponse.json(
      { error: 'Invalid or missing API key', code: ErrorCategory.UNAUTHORIZED },
      { status: 401 }
    )
  }

  // Operator suspension check (cached in Redis for 5 minutes)
  const suspended = await isOperatorSuspended(meter.cooperative_id)
  if (suspended) {
    log.warn('readings.post.operator_suspended', { meter_id, cooperative_id: meter.cooperative_id })
    // Audit log the blocked submission (non-fatal — must not block the 403 response)
    void auditLog(req, {
      operator_id: meter.cooperative_id,
      action: 'reading.suspension_blocked',
      resource_id: meter_id,
      metadata: { meter_id, reason: 'operator_suspended', cooperative_id: meter.cooperative_id },
    })
    return NextResponse.json(
      {
        error: 'Operator is suspended and cannot submit readings',
        reason: 'operator_suspended',
        code: ErrorCategory.UNAUTHORIZED,
      },
      { status: 403 }
    )
  }

  // Rate limit: 60 requests/minute per meter public key
  const rl = await checkRateLimit(meter.pubkey_hex)
  if (!rl.allowed) {
    log.warn('readings.post.rate_limited', { meter_id })
    return NextResponse.json(
      { error: 'Rate limit exceeded', code: ErrorCategory.VALIDATION },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }

  // Compute canonical reading hash
  const kwhStroops = kwhToStroops(kwh)
  const readingHash = computeReadingHash(meter_id, kwhStroops, BigInt(timestamp))

  // Verify Ed25519 signature
  const sigValid = await verifyAsync(
    Buffer.from(signature_hex, 'hex'),
    readingHash,
    Buffer.from(meter.pubkey_hex, 'hex')
  ).catch(() => false)

  if (!sigValid) {
    log.warn('readings.post.invalid_signature', { meter_id })
    return NextResponse.json(
      { error: 'Invalid meter signature', code: ErrorCategory.UNAUTHORIZED },
      { status: 401 }
    )
  }

  // Persist reading; Stellar anchor + mint will be processed asynchronously.
  const { data: reading, error: readingErr } = await db
    .from('readings')
    .insert({
      meter_id,
      kwh,
      timestamp: new Date(timestamp * 1000).toISOString(),
      reading_hash: readingHash.toString('hex'),
      signature_hex,
      anchored: false,
      minted: false,

    })
    .select()
    .single()

  if (readingErr || !reading) {
    if (isAlreadyAnchoredError(readingErr)) {
      const { data: existing } = await db
        .from('readings')
        .select('id')
        .eq('reading_hash', readingHash.toString('hex'))
        .single()

      return NextResponse.json(
        { error: 'Reading already anchored', reading_id: existing?.id, code: ErrorCategory.DB_CONSTRAINT, retriable: false },
        { status: 409 }
      )
    }
    const appErr = new AppError(ErrorCategory.DB_QUERY, 'Failed to save reading', { meter_id, dbError: readingErr?.message })
    log.error('readings.post.db_insert_failed', { ...appErr.meta })
    return NextResponse.json(errorBody(appErr), { status: appErr.httpStatus })
  }

  const { data: coop } = await db
    .from('cooperatives')
    .select('admin_address')
    .eq('id', meter.cooperative_id)
    .single()

  const recipient = coop?.admin_address
  if (!recipient) {
    log.error('readings.post.missing_recipient', { reading_id: reading.id, cooperative_id: meter.cooperative_id })
    return NextResponse.json(
      { error: 'No cooperative admin address', code: ErrorCategory.INTERNAL },
      { status: 500 }
    )
  }

  const jobId = await enqueue('anchor_and_mint', {
    readingId: reading.id,
    readingHashHex: readingHash.toString('hex'),
    recipientAddress: recipient,
    kwh,
    correlationId,
  })

  log.info('readings.post.enqueued', { reading_id: reading.id, job_id: jobId })

  const responseBody = { reading_id: reading.id, job_id: jobId }
  if (idempotencyKey) {
    await storeIdempotentResponse(idempotencyKey, { body: responseBody, status: 202 })
  }

  return NextResponse.json(responseBody, { status: 202 })
}
