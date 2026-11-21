import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAnonClient } from '@/lib/supabase'
import { getCachedCert, setCachedCert } from '@/lib/cache'
import { stellarExplorerUrl, type NetworkName } from '@solarproof/stellar'
import { env } from '@/env'

// UUID or 64-char hex hash (reading_hash / tx_hash)
const VerifyQuerySchema = z.object({
  id: z.string().trim().regex(/^[0-9a-f]{64}$|^[0-9a-f-]{36}$/i, 'id must be a UUID or 64-char hex hash'),
})

/**
 * GET /api/verify?id=<certificate_id_or_reading_hash_or_tx_hash>
 *
 * Public endpoint — no auth required.
 * Returns the full chain of custody for a certificate.
 * Results are cached in Redis for 60 s (TTL defined in cache.ts).
 */
export async function GET(req: NextRequest) {
  const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries())
  const parsed = VerifyQuerySchema.safeParse(queryParams)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { id } = parsed.data

  // Cache lookup
  const cached = await getCachedCert<unknown>(id)
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=30',
        'X-Cache': 'HIT',
      },
    })
  }

  // Try certificate ID first, then reading_hash, then mint_tx_hash, then anchor_tx_hash
  // Use separate parameterised filters instead of raw .or() interpolation
  const db = createAnonClient()
  let cert = null
  for (const column of ['id', 'reading_hash', 'mint_tx_hash', 'anchor_tx_hash'] as const) {
    const { data } = await db.from('certificates').select('*').eq(column, id).maybeSingle()
    if (data) { cert = data; break }
  }

  if (!cert) {
    return NextResponse.json(
      { error: 'Certificate not found', message: `No certificate found for "${id}".` },
      { status: 404 },
    )
  }

  // Fetch the associated reading for full audit trail
  const { data: reading } = await db
    .from('readings')
    .select('*')
    .eq('id', cert.reading_id)
    .single()

  const network = (env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet') as NetworkName

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
      anchor_explorer: stellarExplorerUrl('tx', cert.anchor_tx_hash, network),
      mint_tx: cert.mint_tx_hash,
      mint_explorer: stellarExplorerUrl('tx', cert.mint_tx_hash, network),
      energy_token_id: env.NEXT_PUBLIC_ENERGY_TOKEN_ID,
      energy_token_explorer: stellarExplorerUrl('contract', env.NEXT_PUBLIC_ENERGY_TOKEN_ID, network),
      audit_registry_id: env.NEXT_PUBLIC_AUDIT_REGISTRY_ID,
      audit_registry_explorer: stellarExplorerUrl('contract', env.NEXT_PUBLIC_AUDIT_REGISTRY_ID, network),
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
