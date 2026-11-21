import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { mintCertificates } from '@/lib/stellar'
import { mintEvmNft } from '@/lib/bridge'

const MAX_PAGE_SIZE = 100

// Allowlist for free-text search input. Supabase's `.or()` builds a raw
// PostgREST filter string, so any interpolated value must be strictly
// constrained to characters that cannot alter the filter grammar
// (no commas, dots, parentheses, quotes, wildcards, etc.).
const SAFE_SEARCH_PATTERN = /^[A-Za-z0-9_-]+$/

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  cursor: z.string().optional(),
  // Backward-compatible offset pagination (deprecated — prefer cursor)
  page: z.coerce.number().int().min(1).optional(),
  q: z
    .string()
    .trim()
    .default('')
    .refine((value) => value === '' || SAFE_SEARCH_PATTERN.test(value), {
      message: 'q may only contain letters, numbers, hyphens and underscores',
    }),
  status: z.enum(['active', 'retired']).nullable().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  min_kwh: z.coerce.number().nonnegative().optional(),
  max_kwh: z.coerce.number().nonnegative().optional(),
})

/**
 * GET /api/v1/certificates
 *
 * Cursor-based pagination via `cursor` (opaque ISO timestamp of `issued_at`)
 * and `limit` (max 100). Returns `{ data, next_cursor, has_more, total }`.
 *
 * Backward-compatible: `page` + `limit` offset pagination is still accepted
 * but `cursor` takes precedence when both are present.
 *
 * Filter params:
 *   q          — prefix search on certificate id or meter_id (via readings join)
 *   status     — "active" | "retired"
 *   date_from  — ISO date string (inclusive lower bound on issued_at)
 *   date_to    — ISO date string (inclusive upper bound on issued_at)
 *   min_kwh    — inclusive lower bound on kwh
 *   max_kwh    — inclusive upper bound on kwh
 *
 * Cursor design:
 *   - The cursor encodes the `issued_at` timestamp of the last-seen row.
 *   - The DB query uses `.lt('issued_at', cursor)` which hits the indexed
 *     column directly — no sequential scan or OFFSET needed.
 *   - `next_cursor` in the response is the `issued_at` of the last row
 *     returned; pass it as `cursor` in the next request.
 *   - When `has_more` is false, `next_cursor` is null.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const queryParams = Object.fromEntries(searchParams.entries())
  const parsedQuery = QuerySchema.safeParse(queryParams)

  if (!parsedQuery.success) {
    return NextResponse.json({ error: parsedQuery.error.flatten() }, { status: 400 })
  }

  const {
    limit,
    cursor,
    page,
    q,
    status,
    date_from: dateFrom,
    date_to: dateTo,
    min_kwh: minKwh,
    max_kwh: maxKwh,
  } = parsedQuery.data

  const db = createServiceClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (db as any)
    .from('certificates')
    .select(
      'id, kwh, issued_at, expires_at, retired, retired_at, retired_by, mint_tx_hash, readings!inner(meter_id)',
      { count: 'exact' }
    )
    .order('issued_at', { ascending: false })
    .limit(limit + 1) // fetch one extra to detect whether there is a next page

  // Cursor-based pagination (preferred): filter by indexed issued_at column
  if (cursor) {
    query = query.lt('issued_at', cursor)
  } else if (page && page > 1) {
    // Fallback: offset pagination for backward compat (deprecated)
    query = query.range((page - 1) * limit, page * limit)
  }

  if (status === 'active') query = query.eq('retired', false)
  if (status === 'retired') query = query.eq('retired', true)
  if (dateFrom) query = query.gte('issued_at', dateFrom)
  if (dateTo) query = query.lte('issued_at', dateTo + 'T23:59:59.999Z')
  if (minKwh !== undefined) query = query.gte('kwh', minKwh)
  if (maxKwh !== undefined) query = query.lte('kwh', maxKwh)

  // Text search: match cert id prefix OR meter_id prefix via the joined reading.
  // `q` has already been validated against SAFE_SEARCH_PATTERN by QuerySchema,
  // so it cannot break out of the PostgREST filter expression. The `%` wildcard
  // is appended outside the interpolated value.
  if (q) {
    query = query.or(`id.ilike.${q}%,readings.meter_id.ilike.${q}%`)
  }

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as Array<{
    id: string
    kwh: number
    issued_at: string
    expires_at: string | null
    retired: boolean
    retired_at: string | null
    retired_by: string | null
    mint_tx_hash: string | null
    readings: { meter_id: string } | { meter_id: string }[]
  }>

  const hasMore = rows.length > limit
  const page_data = hasMore ? rows.slice(0, limit) : rows
  const next_cursor = hasMore ? page_data[page_data.length - 1].issued_at : null

  // Flatten the joined meter_id onto each row
  const normalized = page_data.map(({ readings, ...cert }) => ({
    ...cert,
    meter_id: Array.isArray(readings) ? readings[0]?.meter_id : readings?.meter_id ?? null,
  }))

  return NextResponse.json({
    data: normalized,
    next_cursor,
    has_more: hasMore,
    total: count ?? 0,
  })
}

const IssueSchema = z.object({
  cooperative_id: z.string().uuid(),
  reading_ids: z.array(z.string().uuid()).min(1),
})

/**
 * POST /api/v1/certificates
 *
 * Issues certificates for the given readings by minting SKWH tokens on
 * Stellar. When the owning cooperative has opted in to EVM NFTs
 * (`evm_nft_enabled`), an ERC-721 token is also minted on the secondary
 * chain via the bridge microservice, with metadata pointing at
 * `/verify/[id]`. EVM mint failures are non-fatal: the Stellar issuance
 * stands and the EVM status is recorded for later retry.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = IssueSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { cooperative_id: cooperativeId, reading_ids: readingIds } = parsed.data
  const db = createServiceClient()

  // Verify the cooperative exists and read its EVM opt-in flag
  const { data: cooperative, error: coopError } = await db
    .from('cooperatives')
    .select('id, evm_nft_enabled')
    .eq('id', cooperativeId)
    .single()

  if (coopError || !cooperative) {
    return NextResponse.json({ error: 'Cooperative not found' }, { status: 404 })
  }

  // Mint the SKWH tokens on Stellar
  let minted: Array<{ id: string; kwh: number; mint_tx_hash: string }>
  try {
    minted = await mintCertificates({ cooperativeId, readingIds })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Mint failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const evmEnabled = Boolean(
    (cooperative as { evm_nft_enabled?: boolean | null }).evm_nft_enabled
  )

  const results: Array<{
    id: string
    kwh: number
    mint_tx_hash: string
    evm_token_id: string | null
    evm_tx_hash: string | null
    evm_issuance_status: 'skipped' | 'pending' | 'minted' | 'failed'
  }> = []

  for (const cert of minted) {
    let evmTokenId: string | null = null
    let evmTxHash: string | null = null
    let evmStatus: 'skipped' | 'pending' | 'minted' | 'failed' = 'skipped'

    if (evmEnabled) {
      evmStatus = 'pending'
      try {
        const evm = await mintEvmNft({
          certificateId: cert.id,
          cooperativeId,
          kwh: cert.kwh,
          metadataUri: `/verify/${cert.id}`,
        })
        evmTokenId = evm.tokenId
        evmTxHash = evm.txHash
        evmStatus = 'minted'
      } catch {
        // Non-fatal: Stellar issuance already succeeded; record for retry
        evmStatus = 'failed'
      }
    }

    const { error: updateError } = await db
      .from('certificates')
      .update({
        evm_token_id: evmTokenId,
        evm_tx_hash: evmTxHash,
        evm_issuance_status: evmStatus,
      })
      .eq('id', cert.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    results.push({
      id: cert.id,
      kwh: cert.kwh,
      mint_tx_hash: cert.mint_tx_hash,
      evm_token_id: evmTokenId,
      evm_tx_hash: evmTxHash,
      evm_issuance_status: evmStatus,
    })
  }

  return NextResponse.json({ data: results }, { status: 201 })
}
