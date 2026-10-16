'use client'

import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Award, Leaf, Search, X, FileDown, AlertTriangle } from 'lucide-react'
import { RetireModal } from '@/components/retire-modal'
import { TransferModal } from '@/components/transfer-modal'
import { useToast } from '@/components/toast'
import { useWallet } from '@/hooks/useWallet'
import { WalletGate } from '@/components/wallet-gate'
import { TableRowSkeleton } from '@/components/skeleton'

const MAX_BULK = 100

interface Certificate {
  id: string
  kwh: number
  issued_at: string
  retired: boolean
  retired_at: string | null
  retired_by: string | null
  mint_tx_hash: string | null
  meter_id: string | null
}

interface CertificatesResponse {
  data: Certificate[]
  next_cursor: string | null
  total: number
}

async function fetchCertificates(params: URLSearchParams): Promise<CertificatesResponse> {
  const res = await fetch(`/api/certificates?${params.toString()}`)
  if (!res.ok) throw new Error('Failed to load certificates')
  return res.json()
}

// ── Bulk Retire Confirmation Modal ─────────────────────────────────────────────

function BulkRetireConfirmModal({
  count,
  onConfirm,
  onClose,
}: {
  count: number
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-retire-title"
      aria-describedby="bulk-retire-desc"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        {/* Header */}
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden="true" />
          </div>
          <div>
            <h2
              id="bulk-retire-title"
              className="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              Retire {count} certificate{count !== 1 ? 's' : ''}?
            </h2>
            <p
              id="bulk-retire-desc"
              className="mt-1 text-sm text-gray-600 dark:text-gray-400"
            >
              This will permanently retire{' '}
              <strong className="font-semibold text-gray-900 dark:text-gray-100">
                {count} certificate{count !== 1 ? 's' : ''}
              </strong>
              . Retirement is <span className="font-semibold text-red-600 dark:text-red-400">irreversible</span> — retired
              certificates cannot be transferred or used again.
            </p>
          </div>
        </div>

        {/* Warning box */}
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          ⚠ This action cannot be undone. Please confirm you want to proceed.
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose() }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Retire {count} certificate{count !== 1 ? 's' : ''}
          </button>
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute right-4 top-4 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export default function CertificatesPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const qc = useQueryClient()
  const { toast, dismiss } = useToast()
  const { address, connected } = useWallet()
  const [retiring, setRetiring] = useState<Certificate | null>(null)
  const [transferring, setTransferring] = useState<Certificate | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkRetiring, setBulkRetiring] = useState(false)
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)

  // Read filter state from URL
  const q = searchParams.get('q') ?? ''
  const status = searchParams.get('status') ?? ''
  const dateFrom = searchParams.get('date_from') ?? ''
  const dateTo = searchParams.get('date_to') ?? ''

  // Local draft state for the search input (debounced via form submit)
  const [draft, setDraft] = useState(q)

  function pushParams(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v)
      else params.delete(k)
    }
    params.delete('cursor') // reset pagination on filter change
    router.push(`${pathname}?${params.toString()}`)
  }

  function clearFilters() {
    setDraft('')
    router.push(pathname)
  }

  const hasFilters = q || status || dateFrom || dateTo

  const queryParams = new URLSearchParams()
  if (q) queryParams.set('q', q)
  if (status) queryParams.set('status', status)
  if (dateFrom) queryParams.set('date_from', dateFrom)
  if (dateTo) queryParams.set('date_to', dateTo)

  const { data: response, isLoading, error } = useQuery({
    queryKey: ['certificates', q, status, dateFrom, dateTo],
    queryFn: () => fetchCertificates(queryParams),
  })

  const data = response?.data ?? []

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      pushParams({ q: draft })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, searchParams]
  )

  async function handleTransfer(toAddress: string) {
    if (!transferring) return
    const pendingId = toast('pending', 'Submitting transfer transaction…')
    try {
      const res = await fetch(`/api/certificates/${transferring.id}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_address: address, to_address: toAddress }),
      })
      dismiss(pendingId)
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'Unknown error' }))
        toast('error', msg ?? 'Transfer failed')
        return
      }
      toast('success', 'Certificate transferred successfully')
      setTransferring(null)
      qc.invalidateQueries({ queryKey: ['certificates'] })
    } catch (err) {
      dismiss(pendingId)
      toast('error', err instanceof Error ? err.message : 'Transfer failed')
    }
  }

  async function handleRetire(reason: string) {
    if (!retiring) return
    const pendingId = toast('pending', 'Submitting retirement transaction…')
    try {
      const res = await fetch(`/api/certificates/${retiring.id}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: address, reason }),
      })
      dismiss(pendingId)
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'Unknown error' }))
        toast('error', msg ?? 'Retirement failed')
        return
      }
      toast('success', 'Certificate retired successfully')
      setRetiring(null)
      qc.invalidateQueries({ queryKey: ['certificates'] })
    } catch (err) {
      dismiss(pendingId)
      toast('error', err instanceof Error ? err.message : 'Retirement failed')
    }
  }

  const activeData = data.filter((c) => !c.retired)

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleSelectAll() {
    const activeIds = activeData.map((c) => c.id)
    const allSelected = activeIds.every((id) => selected.has(id))
    setSelected(allSelected ? new Set() : new Set(activeIds.slice(0, MAX_BULK)))
  }

  async function handleBulkRetire() {
    if (!selected.size || !address) return
    setBulkRetiring(true)
    const pendingId = toast('pending', `Retiring ${selected.size} certificate(s)…`)
    try {
      const res = await fetch('/api/certificates/retire/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certificate_ids: [...selected], wallet_address: address }),
      })
      dismiss(pendingId)
      const json = await res.json().catch(() => ({}))
      const { summary } = json
      if (summary) {
        toast(
          summary.failed === 0 ? 'success' : 'error',
          `${summary.succeeded} retired, ${summary.failed} failed`
        )
      } else {
        toast('error', 'Bulk retirement failed')
      }
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['certificates'] })
    } catch (err) {
      dismiss(pendingId)
      toast('error', err instanceof Error ? err.message : 'Bulk retirement failed')
    } finally {
      setBulkRetiring(false)
    }
  }

  return (
    <WalletGate>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Certificates</h1>

        {/* Filter bar */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          {/* Search */}
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
              <input
                type="search"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Cert ID or meter ID…"
                aria-label="Search by certificate ID or meter ID"
                className="w-56 rounded-md border border-gray-300 bg-white py-1.5 ps-8 pe-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-yellow-400 px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-yellow-500"
            >
              Search
            </button>
          </form>

          {/* Status filter */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="status-filter" className="text-xs text-gray-500 dark:text-gray-400">
              Status
            </label>
            <select
              id="status-filter"
              value={status}
              onChange={(e) => pushParams({ status: e.target.value })}
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="retired">Retired</option>
            </select>
          </div>

          {/* Date range */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="date-from" className="text-xs text-gray-500 dark:text-gray-400">
              From
            </label>
            <input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => pushParams({ date_from: e.target.value })}
              aria-label="Filter from date"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="date-to" className="text-xs text-gray-500 dark:text-gray-400">
              To
            </label>
            <input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => pushParams({ date_to: e.target.value })}
              aria-label="Filter to date"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          {/* Clear filters */}
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              aria-label="Clear all filters"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </button>
          )}

          {response && (
            <span className="ms-auto text-xs text-gray-400 dark:text-gray-500">
              {response.total} result{response.total !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Bulk retire bar */}
        {selected.size > 0 && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-2 dark:border-yellow-700 dark:bg-yellow-900/20">
            <span className="text-sm text-yellow-800 dark:text-yellow-300">
              {selected.size} certificate{selected.size !== 1 ? 's' : ''} selected
            </span>
            <button
              onClick={() => setShowBulkConfirm(true)}
              disabled={bulkRetiring || !connected}
              className="ms-auto rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {bulkRetiring ? 'Retiring…' : 'Retire selected'}
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
              aria-label="Clear selection"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            Failed to load certificates.
          </p>
        )}

        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
          <div className="overflow-x-auto">
            <table
              className="min-w-full divide-y divide-gray-200 bg-white text-sm dark:divide-gray-800 dark:bg-gray-900"
              aria-label="Energy certificates"
              aria-busy={isLoading}
            >
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50">
                  <th scope="col" className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all active certificates"
                      checked={activeData.length > 0 && activeData.every((c) => selected.has(c.id))}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                  </th>
                  {['Certificate ID', 'Meter ID', 'kWh', 'Issued', 'Status', 'Action'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {isLoading ? (
                  <>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <TableRowSkeleton key={i} cols={7} />
                    ))}
                  </>
                ) : data.length > 0 ? (
                  data.map((cert) => (
                    <tr key={cert.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-4 py-3">
                        {!cert.retired && (
                          <input
                            type="checkbox"
                            aria-label={`Select certificate ${cert.id.slice(0, 8)}`}
                            checked={selected.has(cert.id)}
                            onChange={() => toggleSelect(cert.id)}
                            className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                          />
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {cert.id.slice(0, 8)}…
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {cert.meter_id ? `${cert.meter_id.slice(0, 8)}…` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{cert.kwh.toFixed(3)}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {new Date(cert.issued_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        {cert.retired ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            <Leaf className="h-3 w-3" aria-hidden="true" />
                            Retired
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                            <Award className="h-3 w-3" aria-hidden="true" />
                            Active
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!cert.retired && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setTransferring(cert)}
                              disabled={!connected}
                              aria-label={`Transfer certificate ${cert.id.slice(0, 8)}`}
                              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Transfer
                            </button>
                            <button
                              onClick={() => setRetiring(cert)}
                              disabled={!connected}
                              aria-label={`Retire certificate ${cert.id.slice(0, 8)}`}
                              className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Retire
                            </button>
                            <a
                              href={`/api/certificates/${cert.id}/irec-export${address ? `?holder=${encodeURIComponent(address)}` : ''}`}
                              download={`irec-${cert.id}.xml`}
                              aria-label={`Export certificate ${cert.id.slice(0, 8)} as I-REC XML`}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                            >
                              <FileDown className="h-3 w-3" aria-hidden="true" />
                              I-REC
                            </a>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                      No certificates found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {retiring && (
          <RetireModal
            certificateId={retiring.id}
            kwh={retiring.kwh}
            onConfirm={handleRetire}
            onClose={() => setRetiring(null)}
          />
        )}

        {transferring && (
          <TransferModal
            certificateId={transferring.id}
            kwh={transferring.kwh}
            onConfirm={handleTransfer}
            onClose={() => setTransferring(null)}
          />
        )}

        {showBulkConfirm && (
          <BulkRetireConfirmModal
            count={selected.size}
            onConfirm={handleBulkRetire}
            onClose={() => setShowBulkConfirm(false)}
          />
        )}
      </div>
    </WalletGate>
  )
}
