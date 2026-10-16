'use client'

import { useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Search, CheckCircle, XCircle, Shield, ExternalLink, Copy, Download } from 'lucide-react'
import { SectionSkeleton } from '@/components/skeleton'
import { CopyableText } from '@/components/copy-button'
import { writeToClipboard } from '@/components/copy-button'
import { useToast } from '@/components/ToastProvider'

interface ChainOfCustody {
  certificate: {
    id: string
    kwh: number
    issued_at: string
    retired: boolean
    retired_at: string | null
    retired_by: string | null
  }
  on_chain: {
    anchor_tx: string
    anchor_explorer: string
    mint_tx: string
    mint_explorer: string
    energy_token_id: string
    energy_token_explorer: string
    audit_registry_id: string
    audit_registry_explorer: string
  }
  meter_proof: {
    meter_id: string
    reading_hash: string
    signature_hex: string
    kwh: number
    timestamp: string
    verified: boolean
  } | null
}

type StepStatus = 'pass' | 'fail' | 'pending'

interface Step {
  id: string
  label: string
  description: string
  status: StepStatus
  detail?: string
  link?: string
}

function buildSteps(data: ChainOfCustody): Step[] {
  const mp = data.meter_proof
  return [
    {
      id: 'meter',
      label: 'Meter Reading',
      description: 'Physical meter recorded a signed energy reading.',
      status: mp ? 'pass' : 'fail',
      detail: mp ? `${Number(mp.kwh).toFixed(3)} kWh · Meter ${mp.meter_id}` : 'No meter proof found.',
    },
    {
      id: 'signature',
      label: 'Ed25519 Signature',
      description: 'Device signature verified against the reading hash.',
      status: mp?.verified ? 'pass' : 'fail',
      detail: mp?.verified
        ? `Signature valid · ${mp.signature_hex.slice(0, 16)}…`
        : 'Signature could not be verified.',
    },
    {
      id: 'anchor',
      label: 'On-chain Anchor',
      description: 'Reading hash anchored to Stellar via audit_registry contract.',
      status: data.on_chain.anchor_tx ? 'pass' : 'fail',
      detail: data.on_chain.anchor_tx
        ? `Tx ${data.on_chain.anchor_tx.slice(0, 12)}…`
        : 'Anchor transaction not found.',
      link: data.on_chain.anchor_explorer,
    },
    {
      id: 'certificate',
      label: 'Certificate Minted',
      description: 'Energy token (1 token = 1 kWh) minted on Stellar.',
      status: data.on_chain.mint_tx ? 'pass' : 'fail',
      detail: data.on_chain.mint_tx
        ? `Tx ${data.on_chain.mint_tx.slice(0, 12)}… · ${Number(data.certificate.kwh).toFixed(3)} kWh`
        : 'Mint transaction not found.',
      link: data.on_chain.mint_explorer,
    },
    {
      id: 'retirement',
      label: 'Retirement',
      description: 'Certificate retired to prevent double-counting.',
      status: data.certificate.retired ? 'pass' : 'pending',
      detail: data.certificate.retired
        ? `Retired ${data.certificate.retired_at ? new Date(data.certificate.retired_at).toLocaleDateString() : ''}`
        : 'Not yet retired — certificate is still active.',
    },
  ]
}

export default function VerifyPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('id') ?? '')
  const [result, setResult] = useState<ChainOfCustody | null>(null)
  const [pageError, setPageError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const { pushToast } = useToast()

  async function handleDownloadAudit() {
    if (!result) return
    const certId = result.certificate.id
    setDownloadError(null)
    try {
      const res = await fetch(`/api/audit-log/export?certificate_id=${encodeURIComponent(certId)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const msg = body.error ?? 'Export failed. Please try again.'
        setDownloadError(msg)
        pushToast({ variant: 'error', title: 'Download failed', description: msg })
        return
      }
      const blob = await res.blob()
      const today = new Date().toISOString().slice(0, 10)
      const filename = `solarproof-audit-${certId}-${today}.csv`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      pushToast({ variant: 'success', title: 'Audit trail downloaded', description: filename })
    } catch {
      const msg = 'Network error — could not download audit trail.'
      setDownloadError(msg)
      pushToast({ variant: 'error', title: 'Download failed', description: msg })
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setPageError(null)
    setResult(null)
    router.replace(`/verify?id=${encodeURIComponent(q)}`)
    try {
      const res = await fetch(`/api/verify?id=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) {
        const message = data.error || 'Unable to verify certificate'
        setPageError(new Error(message))
        pushToast({ variant: 'error', title: 'Verification failed', description: message })
        return
      }

      setResult(data)
      pushToast({ variant: 'success', title: 'Certificate verified', description: 'Full chain of custody confirmed.' })
    } catch {
      setPageError(new Error('Network error — please try again.'))
    } finally {
      setLoading(false)
    }
  }

  async function copyLink() {
    try {
      await writeToClipboard(window.location.href)
      setCopied(true)
      pushToast({ variant: 'success', title: 'Link copied', description: 'Paste it anywhere to share this verification.' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      pushToast({ variant: 'error', title: 'Copy failed', description: 'Please copy the URL from your browser address bar.' })
    }
  }

  const steps = result ? buildSteps(result) : null
  const allPass = steps?.every((s) => s.status !== 'fail')

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <header className="mb-8 flex items-center gap-3">
        <Shield className="h-7 w-7 shrink-0 text-yellow-500" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">
            Certificate Verifier
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No login required. Enter a certificate ID, reading hash, or transaction hash.
          </p>
        </div>
      </header>

      <form onSubmit={handleVerify} className="mb-8" aria-label="Certificate verification form" noValidate>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="verify-query" className="sr-only">Certificate ID, reading hash, or transaction hash</label>
          <input
            id="verify-query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Certificate ID, reading hash, or tx hash…"
            aria-required="true"
            autoComplete="off"
            className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
          />
          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="flex items-center justify-center gap-2 rounded-lg bg-yellow-400 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            {loading ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </form>
      <p id="verify-hint" className="sr-only">Enter a certificate ID, reading hash, or transaction hash to verify the chain of custody.</p>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {loading && 'Verifying certificate, please wait.'}
        {pageError && `Error: ${pageError.message}`}
        {steps && !loading && (
          allPass
            ? `Verification complete. All ${steps.length} proof steps passed.`
            : `Verification complete. ${steps.filter(s => s.status === 'fail').length} of ${steps.length} steps failed.`
        )}
      </div>

      {pageError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {pageError.message}
        </div>
      )}

      {loading && (
        <div
          className="space-y-4"
          aria-busy="true"
          aria-label="Loading verification results"
        >
          <SectionSkeleton rows={5} />
        </div>
      )}

      {steps && !loading && (
        <div className="space-y-6">
          {/* Overall status */}
          <div
            role="status"
            className={`flex items-center justify-between gap-2 rounded-lg border p-4 ${
              allPass
                ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/40'
                : 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/40'
            }`}
          >
            <div className="flex items-center gap-2">
              {allPass ? (
                <CheckCircle className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
              ) : (
                <Shield className="h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-400" aria-hidden="true" />
              )}
              <span className={`font-medium text-sm ${allPass ? 'text-green-800 dark:text-green-300' : 'text-yellow-800 dark:text-yellow-300'}`}>
                {allPass ? 'Full chain of custody confirmed' : 'Partial verification — see steps below'}
              </span>
            </div>
            <button
              onClick={copyLink}
              aria-label="Copy shareable verification link"
              aria-pressed={copied}
              title="Copy shareable link"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-white/60 dark:hover:bg-gray-800/60"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              <span aria-live="polite">{copied ? 'Copied!' : 'Share'}</span>
            </button>
          </div>

          {/* Stepper */}
          <ol aria-label="Proof verification steps" className="relative space-y-0">
            {steps.map((step, i) => {
              const isLast = i === steps.length - 1
              const statusLabel = step.status === 'pass' ? 'Verified' : step.status === 'fail' ? 'Failed' : 'Pending'
              return (
                <li
                  key={step.id}
                  aria-label={`Step ${i + 1}: ${step.label} — ${statusLabel}`}
                  className="flex gap-4"
                >
                  {/* Connector line + icon */}
                  <div className="flex flex-col items-center">
                    <StepIcon status={step.status} />
                    {!isLast && (
                      <div className="mt-1 w-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
                    )}
                  </div>

                  {/* Content */}
                  <div className={`pb-6 ${isLast ? 'pb-0' : ''}`}>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {step.label}
                      <span className={`ms-2 text-xs font-normal ${
                        step.status === 'pass' ? 'text-green-600 dark:text-green-400' :
                        step.status === 'fail' ? 'text-red-600 dark:text-red-400' :
                        'text-gray-400 dark:text-gray-500'
                      }`} aria-hidden="true">
                        {step.status === 'pass' ? '✓ Verified' : step.status === 'fail' ? '✗ Failed' : '— Pending'}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{step.description}</p>
                    {step.detail && (
                      <p className={`mt-1 text-xs font-mono ${
                        step.status === 'fail' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300'
                      }`}>
                        {step.detail}
                        {step.link && (
                          <a
                            href={step.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`View ${step.label} on Stellar Explorer (opens in new tab)`}
                            className="ms-2 inline-flex items-center gap-0.5 text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Explorer <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        )}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>

          {result?.meter_proof && (
            <Section title="Meter proof">
              <Row label="Meter ID" value={result.meter_proof.meter_id} mono copyable />
              <Row
                label="Reading hash"
                value={result.meter_proof.reading_hash.slice(0, 16) + '…'}
                fullValue={result.meter_proof.reading_hash}
                mono
                copyable
              />
              <Row
                label="Signature"
                value={result.meter_proof.signature_hex.slice(0, 16) + '…'}
                fullValue={result.meter_proof.signature_hex}
                mono
                copyable
              />
              <Row label="kWh" value={Number(result.meter_proof.kwh).toFixed(3)} />
              <Row
                label="Timestamp"
                value={new Date(result.meter_proof.timestamp).toLocaleString()}
              />
              <Row label="Ed25519 verified" value="✓ Valid" />
            </Section>
          )}

          {/* Download audit trail */}
          <div className="flex flex-col gap-2">
            <button
              onClick={handleDownloadAudit}
              aria-label={`Download audit trail for certificate ${result.certificate.id} as CSV`}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download audit trail
            </button>
            {downloadError && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {downloadError}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</h3>
      <dl className="space-y-2 text-sm">{children}</dl>
    </div>
  )
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'pass') return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40" aria-hidden="true">
      <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
    </span>
  )
  if (status === 'fail') return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40" aria-hidden="true">
      <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
    </span>
  )
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-900" aria-hidden="true">
      <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
    </span>
  )
}

function Row({
  label,
  value,
  fullValue,
  mono,
  link,
  copyable,
}: {
  label: string
  value: string
  fullValue?: string
  mono?: boolean
  link?: string
  copyable?: boolean
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`break-all text-right text-gray-900 dark:text-gray-100 ${mono ? 'font-mono text-xs' : ''}`}>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
          >
            {value}
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
          </a>
        ) : copyable ? (
          <CopyableText value={fullValue || value} displayValue={value} mono={mono} />
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

function ThrowError({ error }: { error: Error }) {
  throw error
}
