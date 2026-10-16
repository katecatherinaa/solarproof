'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Clock, ExternalLink } from 'lucide-react'
import { Skeleton } from '@/components/skeleton'

export interface TransferEvent {
  id: string
  timestamp: string
  from_address: string
  to_address: string
  transfer_tx_hash?: string | null
}

interface Props {
  certificateId: string
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TransferHistoryTimeline({ certificateId }: Props) {
  const [events, setEvents] = useState<TransferEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        // Use the export endpoint which filters by resource_id (certificate_id)
        const res = await fetch(
          `/api/audit-log/export?certificate_id=${encodeURIComponent(certificateId)}`
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to load transfer history')
        }
        const csv = await res.text()
        if (cancelled) return

        // Parse CSV: header + rows
        const lines = csv.trim().split('\n')
        if (lines.length <= 1) { setEvents([]); return }

        const parsed: TransferEvent[] = []
        // headers: id,operator_id,action,resource_id,ip_address,metadata,created_at
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]
          if (!line.trim()) continue
          // Simple CSV parse — values are all double-quoted
          const cols = line.match(/"(?:[^"]|"")*"/g)
          if (!cols || cols.length < 7) continue
          const unquote = (s: string) => s.slice(1, -1).replace(/""/g, '"')
          const action = unquote(cols[2])
          if (action !== 'certificate.transfer') continue
          let metadata: Record<string, string> = {}
          try { metadata = JSON.parse(unquote(cols[5])) } catch { continue }
          if (!metadata.from_address || !metadata.to_address) continue
          parsed.push({
            id: unquote(cols[0]),
            timestamp: unquote(cols[6]),
            from_address: metadata.from_address,
            to_address: metadata.to_address,
            transfer_tx_hash: metadata.transfer_tx_hash ?? null,
          })
        }
        parsed.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        setEvents(parsed)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [certificateId])

  return (
    <section
      aria-labelledby="transfer-history-title"
      aria-busy={loading}
      className="mt-8 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <h2
        id="transfer-history-title"
        className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Transfer history
      </h2>

      {loading && (
        <ul aria-label="Loading transfer history" className="space-y-4">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-full max-w-sm" />
            </li>
          ))}
        </ul>
      )}

      {!loading && error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {!loading && !error && events.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No transfers have occurred for this certificate.
        </p>
      )}

      {!loading && !error && events.length > 0 && (
        <ol
          aria-label={`${events.length} transfer event${events.length === 1 ? '' : 's'}`}
          className="relative space-y-0"
        >
          {events.map((event, i) => {
            const isLast = i === events.length - 1
            return (
              <li
                key={event.id}
                aria-label={`Transfer ${i + 1}: from ${event.from_address} to ${event.to_address} on ${formatDate(event.timestamp)}`}
                className="flex gap-3"
              >
                {/* Timeline spine */}
                <div className="flex flex-col items-center" aria-hidden="true">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
                    <ArrowRight className="h-3 w-3 text-yellow-600 dark:text-yellow-400" />
                  </span>
                  {!isLast && (
                    <div className="mt-1 w-px flex-1 bg-gray-200 dark:bg-gray-700" />
                  )}
                </div>

                {/* Content */}
                <div className={`pb-5 min-w-0 flex-1 ${isLast ? 'pb-0' : ''}`}>
                  {/* Timestamp */}
                  <div className="mb-1 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                    <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <time dateTime={event.timestamp}>{formatDate(event.timestamp)}</time>
                  </div>

                  {/* From → To */}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs sm:text-sm">
                    <span
                      title={event.from_address}
                      className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                    >
                      {shortAddr(event.from_address)}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-gray-400" aria-hidden="true" />
                    <span
                      title={event.to_address}
                      className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                    >
                      {shortAddr(event.to_address)}
                    </span>

                    {event.transfer_tx_hash && (
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${event.transfer_tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`View transfer transaction ${event.transfer_tx_hash.slice(0, 12)}… on Stellar Explorer (opens in new tab)`}
                        className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        Explorer
                      </a>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
