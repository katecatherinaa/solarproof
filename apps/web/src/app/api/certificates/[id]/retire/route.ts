import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { retireCertificate } from '@/lib/stellar'
import { fireWebhook } from '@/lib/webhooks'
import { triggerIRecRetirement } from '@/lib/irec-bridge'
import { sendRetiredEmail } from '@/lib/email'
import { emitCertificateEvent } from '@/lib/notifications'

const RetireSchema = z.object({ wallet_address: z.string().trim().min(1) })
const ParamsSchema = z.object({ id: z.string().uuid() })

/**
 * POST /api/certificates/:id/retire
 *
 * Retires a certificate by calling the energy_token burn function on Soroban,
 * records the retirement in Supabase, and emits a retirement_events audit record.
 *
 * Body: { wallet_address }
 * Returns 409 if certificate already retired.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsedParams = ParamsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: parsedParams.error.flatten() }, { status: 400 })
  }
  const { id } = parsedParams.data

  const body = await req.json().catch(() => null)
  const parsed = RetireSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { wallet_address } = parsed.data
  const db = createServiceClient()

  const { data: cert } = await db.from('certificates').select('*').eq('id', id).single()
  if (!cert) {
    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  }

  if (cert.retired) {
    return NextResponse.json({ error: 'Certificate already retired' }, { status: 409 })
  }

  if (cert.expires_at && new Date(cert.expires_at).getTime() <= Date.now()) {
    return NextResponse.json(
      {
        error: `Certificate expired on ${new Date(cert.expires_at).toISOString()} and can no longer be retired`,
      },
      { status: 400 }
    )
  }

  // Call energy_token burn on Soroban
  let retireTxHash: string
  try {
    retireTxHash = await retireCertificate(wallet_address, cert.kwh)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Retire transaction failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const retiredAt = new Date().toISOString()

  // Update certificate with retirement details and tx hash
  const { data: updated, error: updateErr } = await db
    .from('certificates')
    .update({
      retired: true,
      retired_at: retiredAt,
      retired_by: wallet_address,
      retire_tx_hash: retireTxHash,
    })
    .eq('id', id)
    .select()
    .single()

  if (updateErr || !updated) {
    return NextResponse.json({ error: 'Failed to update certificate status' }, { status: 500 })
  }

  void emitCertificateEvent(updated.cooperative_id, updated.id, 'retired', {
    retired_by: updated.retired_by ?? wallet_address,
    retire_tx_hash: retireTxHash,
    kwh: cert.kwh,
  })

  void fireWebhook(updated.cooperative_id, 'retire', {
    certificate_id: updated.id,
    retired_by: updated.retired_by,
    retire_tx_hash: retireTxHash,
  })

  const notifyEmail = process.env.NOTIFICATION_EMAIL
  if (notifyEmail) {
    void sendRetiredEmail(notifyEmail, {
      certificate_id: updated.id,
      retired_by: updated.retired_by ?? wallet_address,
      retire_tx_hash: retireTxHash,
      kwh: cert.kwh,
    })
  }

  // Level 3 integration: Bridge retirement to I-REC registry
  void triggerIRecRetirement({
    beneficiary: wallet_address,
    volumeWh: cert.kwh * 1000,
    vintageStart: new Date(cert.issued_at).toISOString(),
    vintageEnd: new Date(cert.expires_at ?? cert.issued_at).toISOString(),
    notes: `Retired via SolarProof: ${cert.id}`,
  })

  return NextResponse.json({
    id: updated.id,
    retired: updated.retired,
    retired_at: updated.retired_at,
    retired_by: updated.retired_by,
    retire_tx_hash: retireTxHash,
  })
}
