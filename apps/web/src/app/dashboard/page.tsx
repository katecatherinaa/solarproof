'use client'

import { useQuery } from '@tanstack/react-query'
import { WalletGate } from '@/components/wallet-gate'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
} from 'recharts'
import { useTheme } from 'next-themes'
import { Zap, Award, Leaf, TrendingUp, Download } from 'lucide-react'
import { AccessibleLegend } from '@/components/accessible-chart-legend'
import { StatCardSkeleton, ChartSkeleton, TableRowSkeleton } from '@/components/skeleton'
import { useState, useMemo, memo } from 'react'
import { useRealtimeReadings } from '@/hooks/use-realtime-readings'
import { ErrorBoundary } from '@/components/error-boundary'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Reading {
  id: string
  meter_id: string
  kwh: number
  timestamp: string
  verified: boolean
}

interface AnalyticsSummary {
  total_kwh: number
  certificates_issued: number
  certificates_retired: number
  active_meters: number
}

interface TrendBucket {
  bucket: string
  kwh: number
  certs_issued: number
  certs_retired: number
}

interface MeterStat {
  meter_id: string
  meter_name: string
  total_kwh: number
  reading_count: number
  certs_generated: number
}

interface AnalyticsResponse {
  summary: AnalyticsSummary
  trends: TrendBucket[]
  meter_stats: MeterStat[]
  range: { start: string; end: string; granularity: string }
}

type Period = 'day' | 'month' | 'year'

const RANGE_LABELS: Record<'30d' | '90d' | 'ytd' | 'all', string> = {
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  ytd: 'year to date',
  all: 'all time',
}

function describeTrendPeriod(trends: TrendBucket[] | undefined, rangeLabel: string): string {
  if (!trends?.length) return `No data available for the ${rangeLabel} period.`
  const first = new Date(trends[0].bucket).toLocaleDateString()
  const last = new Date(trends[trends.length - 1].bucket).toLocaleDateString()
  return `${trends.length} periods from ${first} to ${last}.`
}

function describeGenerationTrend(trends: TrendBucket[] | undefined, range: '30d' | '90d' | 'ytd' | 'all'): string {
  const rangeLabel = RANGE_LABELS[range]
  const period = describeTrendPeriod(trends, rangeLabel)
  const totalKwh = (trends ?? []).reduce((sum, bucket) => sum + bucket.kwh, 0)
  const totalText = trends?.length ? ` Total generation shown: ${totalKwh.toLocaleString()} kWh.` : ''
  return `Area chart of cooperative energy output in kilowatt-hours over the ${rangeLabel}. ${period}${totalText}`
}

function describeCertificateActivity(
  trends: TrendBucket[] | undefined,
  range: '30d' | '90d' | 'ytd' | 'all',
  granularity: Period,
): string {
  const rangeLabel = RANGE_LABELS[range]
  const period = describeTrendPeriod(trends, rangeLabel)
  const issued = (trends ?? []).reduce((sum, bucket) => sum + bucket.certs_issued, 0)
  const retired = (trends ?? []).reduce((sum, bucket) => sum + bucket.certs_retired, 0)
  const totalsText = trends?.length
    ? ` Totals in view: ${issued.toLocaleString()} issued and ${retired.toLocaleString()} retired.`
    : ''
  return `Line chart comparing certificates issued and retired over the ${rangeLabel}, grouped by ${granularity}.${period ? ` ${period}` : ''}${totalsText}`
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchAnalytics(params: { date_from?: string; date_to?: string; granularity?: Period }): Promise<AnalyticsResponse> {
  const query = new URLSearchParams()
  if (params.date_from) query.set('date_from', params.date_from)
  if (params.date_to) query.set('date_to', params.date_to)
  if (params.granularity) query.set('granularity', params.granularity)
  
  const res = await fetch(`/api/cooperative/stats?${query.toString()}`)
  if (!res.ok) throw new Error('Failed to load analytics')
  return res.json()
}

async function fetchReadings(): Promise<Reading[]> {
  const res = await fetch('/api/readings')
  if (!res.ok) throw new Error('Failed to load readings')
  return res.json()
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
interface StatCardProps {
  label: string
  value: string | number
  icon: React.ElementType
  description?: string
}

const StatCard = memo(function StatCard({ label, value, icon: Icon, description }: StatCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</span>
        <Icon className="h-5 w-5 text-yellow-500" aria-hidden="true" />
      </div>
      <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {description && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">{description}</p>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Accessible chart colours
// ---------------------------------------------------------------------------
function useChartColors() {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  return {
    grid: dark ? '#374151' : '#e5e7eb',
    text: dark ? '#9ca3af' : '#6b7280',
    area: '#f59e0b',
    areaFill: dark ? '#f59e0b33' : '#fef3c7',
    bar1: '#f59e0b',
    bar2: '#0ea5e9',
    line1: '#10b981', // green
    line2: '#ef4444', // red
    tooltip: {
      bg: dark ? '#1f2937' : '#ffffff',
      border: dark ? '#374151' : '#e5e7eb',
      text: dark ? '#f9fafb' : '#111827',
    },
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function exportCsv(data: object[], filename: string) {
  if (!data || data.length === 0) return
  const rows = data as Record<string, unknown>[]
  const headers = Object.keys(rows[0]).join(',')
  const body = rows.map((row) => Object.values(row).map(v => `"${v}"`).join(',')).join('\n')
  const blob = new Blob([`${headers}\n${body}`], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------
export default function DashboardPage() {
  const [granularity, setGranularity] = useState<Period>('day')
  const [range, setRange] = useState<'30d' | '90d' | 'ytd' | 'all'>('30d')
  
  const dateParams = useMemo(() => {
    const now = new Date()
    let from: Date | undefined
    if (range === '30d') from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    if (range === '90d') from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    if (range === 'ytd') from = new Date(now.getFullYear(), 0, 1)
    if (range === 'all') from = new Date(0) // 1970-01-01
    
    return {
      date_from: from?.toISOString(),
      date_to: now.toISOString(),
      granularity,
    }
  }, [range, granularity])

  const { isConnected, error: wsError } = useRealtimeReadings()

  const {
    data: analytics,
    isLoading: analyticsLoading,
    error: analyticsError,
  } = useQuery({ 
    queryKey: ['analytics', dateParams.date_from, dateParams.date_to, dateParams.granularity],
    queryFn: () => fetchAnalytics(dateParams) 
  })

  const {
    data: readings,
    isLoading: readingsLoading,
    error: readingsError,
  } = useQuery({ 
    queryKey: ['readings'], 
    queryFn: fetchReadings,
    refetchInterval: isConnected ? false : 30000,
  })

  const colors = useChartColors()
  
  const chartData = useMemo(() => {
    return (analytics?.trends || []).map(t => ({
      ...t,
      date: new Date(t.bucket).toLocaleDateString('en-US', { 
        month: 'short', 
        day: granularity === 'day' ? 'numeric' : undefined,
        year: granularity === 'year' ? 'numeric' : '2-digit'
      })
    }))
  }, [analytics?.trends, granularity])

  const stats = analytics?.summary || { total_kwh: 0, certificates_issued: 0, certificates_retired: 0, active_meters: 0 }

  return (
    <WalletGate>
    <div className="mx-auto max-w-7xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Analytics</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Energy generation and certificate trends.</p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Range Selector */}
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-1 dark:border-gray-800 dark:bg-gray-950">
            {(['30d', '90d', 'ytd', 'all'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium uppercase transition-colors ${
                  range === r 
                    ? 'bg-yellow-400 text-gray-900' 
                    : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900'
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <div className="h-6 w-px bg-gray-200 dark:bg-gray-800" />

          {/* Connection status */}
          <div className="flex items-center gap-2">
            {isConnected ? (
              <span className="flex h-2 w-2 rounded-full bg-green-500" />
            ) : (
              <span className="flex h-2 w-2 rounded-full bg-gray-300" />
            )}
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              {isConnected ? 'Live' : 'History'}
            </span>
          </div>
        </div>
      </header>

      {/* Stat cards */}
      <section aria-labelledby="stats-heading" className="mb-8">
        <h2 id="stats-heading" className="sr-only">Key statistics</h2>
        {analyticsError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">Failed to load analytics.</p>
        )}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {analyticsLoading ? (
            <><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /></>
          ) : (
            <>
              <StatCard label="Energy Generated" value={`${stats.total_kwh.toLocaleString()} kWh`} icon={Zap} description={range === 'all' ? 'All time' : `Last ${range}`} />
              <StatCard label="Certs Issued" value={stats.certificates_issued.toLocaleString()} icon={Award} description="Minted in period" />
              <StatCard label="Certs Retired" value={stats.certificates_retired.toLocaleString()} icon={Leaf} description="Burned in period" />
              <StatCard label="Active Meters" value={stats.active_meters.toLocaleString()} icon={TrendingUp} description="Reporting now" />
            </>
          )}
        </div>
      </section>

      {/* Main Charts */}
      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        {/* Generation Trend */}
        <ErrorBoundary inline label="Generation trend">
        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <figure aria-labelledby="generation-trend-title" aria-describedby="generation-trend-desc">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h3 id="generation-trend-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Generation trend</h3>
                <p className="text-xs text-gray-500">kWh output over time</p>
              </div>
              <button
                onClick={() => exportCsv(analytics?.trends || [], 'generation-trends.csv')}
                className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400"
                aria-label="Export generation trend data as CSV"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <p id="generation-trend-desc" className="sr-only">
              {describeGenerationTrend(analytics?.trends, range)}
            </p>
            <p id="generation-trend-legend" className="sr-only">
              Legend: kWh generation, shown as an amber filled area.
            </p>
            <div
              className="h-64 w-full"
              role="img"
              aria-labelledby="generation-trend-title"
              aria-describedby="generation-trend-desc generation-trend-legend"
            >
              {analyticsLoading ? <ChartSkeleton title="Generation trend" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: colors.text }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: colors.text }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: colors.tooltip.bg, border: `1px solid ${colors.tooltip.border}`, borderRadius: '8px', fontSize: '12px' }}
                    />
                    <Area type="monotone" dataKey="kwh" stroke={colors.area} fill={colors.areaFill} strokeWidth={2} name="kWh" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </figure>
        </div>
        </ErrorBoundary>

        {/* Issuance vs Retirement */}
        <ErrorBoundary inline label="Certificates activity">
        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <figure aria-labelledby="certs-activity-title" aria-describedby="certs-activity-desc">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h3 id="certs-activity-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Certificates activity</h3>
                <p className="text-xs text-gray-500">Issued vs retired trends</p>
              </div>
              <fieldset className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-800">
                <legend className="sr-only">Certificate activity time grouping</legend>
                {(['day', 'month'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGranularity(g)}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase transition-colors ${
                      granularity === g ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </fieldset>
            </div>
            <p id="certs-activity-desc" className="sr-only">
              {describeCertificateActivity(analytics?.trends, range, granularity)}
            </p>
            <div
              className="h-64 w-full"
              role="img"
              aria-labelledby="certs-activity-title"
              aria-describedby="certs-activity-desc"
            >
              {analyticsLoading ? <ChartSkeleton title="Certificates activity" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: colors.text }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: colors.text }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: colors.tooltip.bg, border: `1px solid ${colors.tooltip.border}`, borderRadius: '8px', fontSize: '12px' }}
                    />
                    <Legend
                      content={() => (
                        <AccessibleLegend
                          items={[
                            { value: 'Issued', description: 'Issued: certificates minted in each period, shown as a green line' },
                            { value: 'Retired', description: 'Retired: certificates burned in each period, shown as a red line' },
                          ]}
                        />
                      )}
                    />
                    <Line type="monotone" dataKey="certs_issued" stroke={colors.line1} strokeWidth={2} dot={false} name="Issued" />
                    <Line type="monotone" dataKey="certs_retired" stroke={colors.line2} strokeWidth={2} dot={false} name="Retired" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </figure>
        </div>
        </ErrorBoundary>
      </section>

      {/* Per-Meter Breakdown */}
      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Per-meter performance</h2>
          <button
            onClick={() => exportCsv(analytics?.meter_stats || [], 'meter-performance.csv')}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 bg-white text-sm dark:divide-gray-800 dark:bg-gray-900">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Meter</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Generation</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Readings</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Certs</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {analyticsLoading ? (
                <><TableRowSkeleton cols={5} /><TableRowSkeleton cols={5} /><TableRowSkeleton cols={5} /></>
              ) : analytics?.meter_stats.map((m) => (
                <tr key={m.meter_id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40">
                  <td className="px-6 py-4">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{m.meter_name}</div>
                    <div className="text-[10px] font-mono text-gray-400">{m.meter_id}</div>
                  </td>
                  <td className="px-6 py-4 text-right font-semibold text-gray-900 dark:text-gray-100">{m.total_kwh.toLocaleString()} kWh</td>
                  <td className="px-6 py-4 text-right text-gray-600 dark:text-gray-400">{m.reading_count.toLocaleString()}</td>
                  <td className="px-6 py-4 text-right text-gray-600 dark:text-gray-400">{m.certs_generated.toLocaleString()}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div
                        className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
                        role="img"
                        aria-label={`${m.meter_name} share of total generation: ${((m.total_kwh / (stats.total_kwh || 1)) * 100).toFixed(1)} percent`}
                      >
                        <div
                          className="h-full bg-yellow-400"
                          style={{ width: `${(m.total_kwh / (stats.total_kwh || 1)) * 100}%` }}
                          aria-hidden="true"
                        />
                      </div>
                      <span className="text-[10px] font-bold text-gray-500">
                        {((m.total_kwh / (stats.total_kwh || 1)) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Activity */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Recent readings</h2>
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 bg-white text-sm dark:divide-gray-800 dark:bg-gray-900">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {readingsLoading ? (
                <><TableRowSkeleton cols={4} /><TableRowSkeleton cols={4} /></>
              ) : readings?.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="px-6 py-3 font-mono text-[10px] text-gray-500">{r.id}</td>
                  <td className="px-6 py-3 text-gray-900 dark:text-gray-100 font-medium">{r.kwh.toFixed(3)} kWh</td>
                  <td className="px-6 py-3 text-gray-500">{new Date(r.timestamp).toLocaleString()}</td>
                  <td className="px-6 py-3 text-right">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${r.verified ? 'bg-green-100 text-green-700 dark:bg-green-900/30' : 'bg-yellow-100 text-yellow-700'}`}>
                      {r.verified ? 'Verified' : 'Pending'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
    </WalletGate>
  )
}
