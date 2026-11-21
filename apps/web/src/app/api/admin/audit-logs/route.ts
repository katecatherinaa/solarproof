import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase'

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.enum(['verify_chain']).optional(),
})

/**
 * Computes the SHA-256 hash of an audit_log row's content.
 * The hash is computed over a canonical, deterministic serialization of the
 * row's fields (excluding prev_hash itself, which is the link to the previous
 * row). Keys are sorted so the hash is stable regardless of column order.
 */
function computeRowHash(row: Record<string, unknown>): string {
  const { prev_hash: _prevHash, ...content } = row
  const canonical = JSON.stringify(content, Object.keys(content).sort())
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * GET /api/admin/audit-logs
 * Returns paginated audit logs. Requires SUPABASE_SERVICE_ROLE_KEY (server-only).
 * Query params: limit (default 50), offset (default 0)
 *
 * When ?action=verify_chain is supplied, walks all audit_logs rows in timestamp
 * order, recomputes each row's hash and compares it to the stored prev_hash of
 * the next row. Returns { valid, checked, first_mismatch } with 200 on success
 * or 409 when tampering is detected.
 */
export async function GET(req: NextRequest) {
  const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries())
  const parsed = QuerySchema.safeParse(queryParams)

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { limit, offset, action } = parsed.data

  // Service role required: admin compliance export needs cross-tenant audit log
  // visibility. See docs/adr/007-supabase-service-role-usage.md
  const db = createServiceClient()

  if (action === 'verify_chain') {
    return verifyChain(db)
  }

  const { data, error, count } = await db
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .order('timestamp', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, total: count, limit, offset })
}

type ServiceClient = ReturnType<typeof createServiceClient>

interface ChainMismatch {
  index: number
  id: unknown
  timestamp: unknown
  expected_prev_hash: string
  stored_prev_hash: string
}

/**
 * Walks the full audit_logs chain in timestamp order and verifies that each
 * row's prev_hash matches the recomputed hash of its predecessor.
 */
async function verifyChain(db: ServiceClient) {
  const pageSize = 1000
  const rows: Record<string, unknown>[] = []
  let from = 0

  // Fetch all rows in timestamp order, paginating to avoid result-size limits.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await db
      .from('audit_logs')
      .select('*')
      .order('timestamp', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!data || data.length === 0) {
      break
    }

    rows.push(...(data as Record<string, unknown>[]))

    if (data.length < pageSize) {
      break
    }

    from += pageSize
  }

  let checked = 0
  let firstMismatch: ChainMismatch | null = null

  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i]
    const next = rows[i + 1]

    const expectedPrevHash = computeRowHash(current)
    const storedPrevHash = next.prev_hash

    checked++

    if (storedPrevHash !== expectedPrevHash) {
      firstMismatch = {
        index: i + 1,
        id: next.id,
        timestamp: next.timestamp,
        expected_prev_hash: expectedPrevHash,
        stored_prev_hash:
          typeof storedPrevHash === 'string' ? storedPrevHash : String(storedPrevHash),
      }
      break
    }
  }

  const valid = firstMismatch === null
  const body = { valid, checked, first_mismatch: firstMismatch }

  return NextResponse.json(body, { status: valid ? 200 : 409 })
}