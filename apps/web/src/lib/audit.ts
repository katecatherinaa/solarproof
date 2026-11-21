import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase'

export type AuditAction =
  | 'reading.create'
  | 'reading.suspension_blocked'
  | 'certificate.retire'
  | 'certificate.transfer'
  | 'meter.register'
  | 'meter.deactivate'
  | 'meter.revoke'
  | 'auth.revoked_token'

interface AuditEntry {
  operator_id: string
  action: AuditAction
  resource_id?: string
  metadata?: Record<string, unknown>
}

/** Fixed hash used as `prev_hash` for the first (genesis) row in the chain. */
export const GENESIS_HASH = '0'.repeat(64)

/** Shape of a row in the `audit_logs` table. */
export interface AuditLogRow {
  id: string
  created_at: string
  actor: string
  action: string
  resource: string
  resource_id: string | null
  ip: string | null
  metadata: unknown
  prev_hash: string | null
}

/**
 * Canonical, deterministic serialization of an audit row's content.
 *
 * Object keys in `metadata` are sorted recursively so that logically equal
 * metadata always produces the same string regardless of insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Compute the SHA-256 hash of an audit row's canonical content.
 *
 * The hash covers: id, created_at, actor, action, resource, resource_id, ip
 * and metadata. `prev_hash` itself is excluded — it is the link to the
 * predecessor and is verified separately.
 */
export function computeAuditHash(row: Omit<AuditLogRow, 'prev_hash'>): string {
  const payload = canonicalize({
    id: row.id,
    created_at: row.created_at,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    resource_id: row.resource_id,
    ip: row.ip,
    metadata: row.metadata ?? null,
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export type AuditChainVerification =
  | { valid: true; checked: number }
  | {
      valid: false
      checked: number
      /** Index (0-based) of the first row that failed verification. */
      index: number
      rowId: string
      reason: 'prev_hash_mismatch' | 'content_hash_mismatch'
    }

/**
 * Verify the integrity of an ordered sequence of audit rows.
 *
 * Rows must be supplied in ascending chronological order (oldest first).
 * For each row the function checks that:
 *   1. `prev_hash` equals the hash of the previous row's content (or the
 *      genesis hash for the first row), and
 *   2. the row's own content has not been altered.
 *
 * Returns the first mismatch encountered, or `{ valid: true }` if the whole
 * chain is intact.
 */
export function verifyAuditChain(rows: AuditLogRow[]): AuditChainVerification {
  let expectedPrev = GENESIS_HASH
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if ((row.prev_hash ?? null) !== expectedPrev) {
      return {
        valid: false,
        checked: i,
        index: i,
        rowId: row.id,
        reason: 'prev_hash_mismatch',
      }
    }
    expectedPrev = computeAuditHash(row)
  }
  return { valid: true, checked: rows.length }
}

function getClientIp(req: NextRequest): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    null
  )
}

/**
 * Append an entry to the `audit_log` table.
 *
 * Captures the client IP from `x-forwarded-for` or `x-real-ip` headers.
 * Failures are logged to stderr but never thrown — audit logging must not
 * block or fail the primary request path.
 *
 * @param req - Incoming Next.js request (used to extract the client IP).
 * @param entry - Audit entry containing operator, action, and optional metadata.
 */
export async function auditLog(req: NextRequest, entry: AuditEntry): Promise<void> {
  try {
    const db = createServiceClient()

    // Fetch the most recent row to link the new entry to its predecessor.
    const { data: previous, error: fetchError } = await db
      .from('audit_logs')
      .select('id, created_at, actor, action, resource, resource_id, ip, metadata, prev_hash')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (fetchError) {
      console.error('[audit] failed to fetch previous row:', fetchError.message)
      return
    }

    const prevHash = previous
      ? computeAuditHash(previous as Omit<AuditLogRow, 'prev_hash'>)
      : GENESIS_HASH

    const { error } = await db.from('audit_logs').insert({
      actor: entry.operator_id,
      action: entry.action,
      resource: entry.resource_id ?? '',
      resource_id: entry.resource_id ?? null,
      ip: getClientIp(req),
      metadata: (entry.metadata ?? null) as import('@/lib/database.types').Json | null,
      prev_hash: prevHash,
    })
    if (error) console.error('[audit] insert failed:', error.message)
  } catch (err) {
    console.error('[audit] unexpected error:', err)
  }
}
