import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Zap,
  ShieldCheck,
  Link2,
  Award,
  FlameKindling,
  CheckCircle2,
  Clock,
  ExternalLink,
} from 'lucide-react'
import { createServiceClient } from '@/lib/supabase'
import { CertificateChain, type ChainStep } from '@/components/certificate-chain'
import { CopyableText } from '@/components/copy-button'
import { TransferHistoryTimeline } from '@/components/transfer-history-timeline'

// ---------------------------------------------------------------------------
// Data fetching (server-side, no auth required)
// ---------------------------------------------------------------------------
async function getCertificateChain(id: string) {
  const db = createServiceClient()

  const { data: cert } = await db
    .from('certificates')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (!cert) return null

  const { data: reading } = await db
    .from('readings')
    .select('*')
    .eq('id', cert.reading_id)
    .maybeSingle()

  return { cert, reading }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  return {
    title: `Certificate ${id.slice(0, 8)}… — SolarProof`,
    description: 'Full chain of custody: meter reading → Ed25519 proof → ledger anchor → certificate → retirement.',
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default async function CertificatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getCertificateChain(id)
  if (!data) notFound()

  // notFound() throws, so data is non-null here
  const { cert, reading } = data!

  const steps: ChainStep[] = [
    {
      icon: Zap,
      label: 'Meter reading',
      timestamp: reading?.timestamp ?? null,
      hash: reading?.reading_hash ?? null,
      hashLabel: 'Reading hash',
      status: reading ? 'done' : 'pending',
      detail: reading ? `${Number(reading.kwh).toFixed(3)} kWh · Meter ${reading.meter_id}` : undefined,
    },
    {
      icon: ShieldCheck,
      label: 'Ed25519 signature',
      timestamp: reading?.timestamp ?? null,
      hash: reading?.signature_hex ?? null,
      hashLabel: 'Signature',
      status: reading?.signature_hex ? 'done' : 'pending',
      detail: reading?.signature_hex ? 'Verified against meter public key' : undefined,
    },
    {
      icon: Link2,
      label: 'Ledger anchor',
      timestamp: cert.issued_at,
      hash: cert.anchor_tx_hash,
      hashLabel: 'Anchor tx',
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${cert.anchor_tx_hash}`,
      status: cert.anchor_tx_hash ? 'done' : 'pending',
    },
    {
      icon: Award,
      label: 'Certificate minted',
      timestamp: cert.issued_at,
      hash: cert.mint_tx_hash,
      hashLabel: 'Mint tx',
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${cert.mint_tx_hash}`,
      status: 'done',
      detail: `${Number(cert.kwh).toFixed(3)} kWh`,
    },
    {
      icon: FlameKindling,
      label: 'Retirement',
      timestamp: cert.retired_at,
      hash: cert.retired_by,
      hashLabel: 'Retired by',
      status: cert.retired ? 'done' : 'pending',
      detail: cert.retired
        ? `Retired ${cert.retired_at ? new Date(cert.retired_at).toLocaleString() : ''}`
        : 'Not yet retired — certificate is active',
    },
  ]

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      {/* Header */}
      <header className="mb-8">
        <div className="mb-1 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Link
            href="/verify"
            className="hover:underline focus:outline-none focus:ring-2 focus:ring-yellow-400 rounded"
          >
            Verify
          </Link>
          <span aria-hidden="true">/</span>
          <span className="font-mono">{id.slice(0, 8)}…</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 sm:text-3xl">
          Certificate
        </h1>
        <div className="mt-1">
          <CopyableText value={id} displayValue={id} mono className="text-xs text-gray-400 dark:text-gray-500 break-all" />
        </div>

        {/* Status badge */}
        <div className="mt-3">
          {cert.retired ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              <FlameKindling className="h-3.5 w-3.5" aria-hidden="true" />
              Retired
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Active · {Number(cert.kwh).toFixed(3)} kWh
            </span>
          )}
        </div>
      </header>

      {/* Chain of custody stepper */}
      <CertificateChain steps={steps} />

      {/* Transfer history timeline */}
      <TransferHistoryTimeline certificateId={id} />

      {/* Footer actions */}
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href={`/verify?id=${id}`}
          className="rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2"
        >
          Verify this certificate
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Dashboard
        </Link>
      </div>
    </div>
  )
}
