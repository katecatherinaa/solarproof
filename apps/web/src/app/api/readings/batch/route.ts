import { NextRequest, NextResponse } from 'next/server'
import { verifyAsync } from '@noble/ed25519'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { anchorReading, mintCertificates } from '@/lib/stellar'
import { computeReadingHash } from '@/lib/crypto'
import { kwhToStroops } from '@solarproof/stellar'
import { invalidateCert } from '@/lib/cache'
import { getIdempotentResponse, storeIdempotentResponse } from '@/lib/idempotency'

const ReadingSchema = z.object({
  meter_id: z.string().uuid(),
  kwh: z.number().positive(),
  timestamp: z.number().int().positive(),
  signature_hex: z.string().trim().length(128),
})

const BatchSchema = z.array(ReadingSchema).min(1).max(100)

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return 'Unknown error' }
}

function isAlreadyAnchoredError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase()
  return msg.includes('alreadyanchored') || msg.includes('reading already anchored') || msg.includes('duplicate')
}

type ReadingResult =
  | { index: number; status: 'success'; reading_id: string; anchor_tx_hash: string; mint_tx_hash: string }
  | { index: number; status: 'error'; error: string; code: number }

/**
 * POST /api/readings/batch
 *
 * Accepts up to 100 signed meter readings. Each is validated, anchored,
 * and minted independently. Returns per-reading status.
 *
 * Supports idempotency via the `Idempotency-Key` header. Duplicate requests
 * with the same key return the cached response without re-processing.
 *
 * Body: Array of { meter_id, kwh, timestamp, signature_hex }
 */
export async function POST(req: NextRequest) {
  // --- Idempotency check ---
  const idempotencyKey = req.headers.get('Idempotency-Key')
  if (idempotencyKey) {
    const cached = await getIdempotentResponse(idempotencyKey)
    if (cached) {
      return NextResponse.json(cached.body, { status: cached.status })
    }
  }

  const body = await req.json().catch(() => null)
  const parsed = BatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const db = createServiceClient()
  const readings = parsed.data

type MeterRow = { id: string; pubkey_hex: string; cooperative_id: string; cooperatives: { admin_address: string } | null }

  // Fetch all unique meters in one query
  const meterIds = [...new Set(readings.map(r => r.meter_id))]
  const { data: meters } = await db
    .from('meters')
    .select('id, pubkey_hex, cooperative_id, revoked_at, cooperatives(admin_address)')
    .in('id', meterIds)
    .eq('active', true)
    .is('revoked_at', null) as { data: (MeterRow & { revoked_at: string | null })[] | null }

  const meterMap = new Map((meters ?? []).map(m => [m.id, m]))

  const results = await Promise.all(
    readings.map(async (reading, index): Promise<ReadingResult> => {
      const { meter_id, kwh, timestamp, signature_hex } = reading

      const meter = meterMap.get(meter_id)
      if (!meter) return { index, status: 'error', error: 'Meter not found or inactive', code: 404 }

      const kwhStroops = kwhToStroops(kwh)
      const readingHash = computeReadingHash(meter_id, kwhStroops, BigInt(timestamp))

      const sigValid = await verifyAsync(
        Buffer.from(signature_hex, 'hex'),
        readingHash,
        Buffer.from(meter.pubkey_hex, 'hex')
      ).catch(() => false)

      if (!sigValid) return { index, status: 'error', error: 'Invalid meter signature', code: 401 }

      const { data: row, error: insertErr } = await db
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

      if (insertErr || !row) return { index, status: 'error', error: 'Failed to save reading', code: 500 }

      let anchorTxHash: string
      try {
        anchorTxHash = await anchorReading({ readingHash })
        await db.from('readings').update({ anchored: true, anchor_tx_hash: anchorTxHash }).eq('id', row.id)
      } catch (err) {
        const error = isAlreadyAnchoredError(err) ? 'Reading already anchored' : extractErrorMessage(err)
        const code = isAlreadyAnchoredError(err) ? 409 : 500
        return { index, status: 'error', error, code }
      }

      try {
        const cooperative = meter.cooperatives as { admin_address: string } | null
        const recipient = cooperative?.admin_address
        if (!recipient) throw new Error('No cooperative admin address')

        const mintTxHash = await mintCertificates(recipient, kwh)
        await db.from('readings').update({ minted: true, mint_tx_hash: mintTxHash }).eq('id', row.id)
        await db.from('certificates').insert({
          cooperative_id: meter.cooperative_id,
          reading_id: row.id,
          reading_hash: readingHash.toString('hex'),
          anchor_tx_hash: anchorTxHash,
          mint_tx_hash: mintTxHash,
          kwh,
          issued_at: new Date().toISOString(),
          retired: false,
        })
        await invalidateCert(row.id, readingHash.toString('hex'), mintTxHash)

        return { index, status: 'success', reading_id: row.id, anchor_tx_hash: anchorTxHash, mint_tx_hash: mintTxHash }
      } catch (err) {
        return { index, status: 'error', error: extractErrorMessage(err), code: 500 }
      }
    })
  )

  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded
  const httpStatus = succeeded === 0 ? 400 : 207

  const responseBody = { succeeded, failed, results }

  if (idempotencyKey) {
    await storeIdempotentResponse(idempotencyKey, { body: responseBody, status: httpStatus })
  }

  return NextResponse.json(responseBody, { status: httpStatus })
}
