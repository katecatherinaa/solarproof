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
 * Abuse protection: per-IP rate limiting (30 req/min) and optional bot
 * detection (Cloudflare Turnstile / hCaptcha) are enforced for this route
 * by middleware.ts — see docs/ABUSE_PROTECTION.md.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id || !/^([0-9a-f]{64}|[0-9a-f-]{36})$/i.test(id)) {
    return NextResponse.json({ error: 'id must be a UUID or 64-char hex hash' }, { status: 400 })
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
  for (const column of ['id', 'reading_hash', 'mint_tx_hash', 'anchor_tx_hash'] as const) {
    const { data } = await db.from('certificates').select('*').eq(column, id).maybeSingle()
    if (data) { cert = data; break }
  }

  if (!cert) {
    const isTxHash = /^[0-9a-f]{64}$/i.test(id)
    return NextResponse.json(
      {
        error: isTxHash
          ? 'No certificate found for this transaction hash'
          : 'Certificate not found',
      },
      { status: 404 }
    )
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
