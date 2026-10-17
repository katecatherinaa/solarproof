'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Wifi, WifiOff, Radio } from 'lucide-react'
import { ErrorBoundary } from '@/components/error-boundary'

interface ChartPoint {
  label: string
  energy: number
}

const POLL_INTERVAL_MS = 30_000

async function fetchRecentReadings(): Promise<ChartPoint[]> {
  try {
    const res = await fetch('/api/readings?limit=20')
    if (!res.ok) return []
    const json = await res.json()
    const rows: { timestamp: string; kwh: number }[] = json.data ?? []
    return rows
      .slice()
      .reverse()
      .map((r) => ({
        label: new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        energy: r.kwh,
      }))
  } catch {
    return []
  }
}

type ConnectionStatus = 'connecting' | 'live' | 'polling' | 'error'

function DashboardChartContent() {
  const [data, setData] = useState<ChartPoint[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    setStatus('polling')
    fetchRecentReadings().then((d) => { if (mountedRef.current && d.length) setData(d) })
    pollRef.current = setInterval(() => {
      fetchRecentReadings().then((d) => { if (mountedRef.current && d.length) setData(d) })
    }, POLL_INTERVAL_MS)
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const appendReading = useCallback((kwh: number, timestamp: string) => {
    setData((prev) => {
      const point: ChartPoint = {
        label: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        energy: kwh,
      }
      const next = [...prev, point]
      return next.length > 20 ? next.slice(next.length - 20) : next
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true

    // Load initial data via REST
    fetchRecentReadings().then((d) => { if (mountedRef.current && d.length) setData(d) })

    // Attempt WebSocket connection
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/readings`)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) return
        setStatus('live')
        stopPolling()
      }

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        try {
          const reading = JSON.parse(event.data as string)
          appendReading(reading.kwh, reading.timestamp)
        } catch { /* ignore malformed messages */ }
      }

      ws.onerror = () => {
        if (!mountedRef.current) return
        setStatus('error')
        startPolling()
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        if (status !== 'live') return
        setStatus('polling')
        startPolling()
      }
    } catch {
      startPolling()
    }

    return () => {
      mountedRef.current = false
      wsRef.current?.close()
      wsRef.current = null
      stopPolling()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusConfig: Record<ConnectionStatus, { icon: React.ReactNode; label: string; color: string }> = {
    connecting: { icon: <Radio className="h-3 w-3 animate-pulse" />, label: 'Connecting…', color: 'text-gray-400' },
    live:       { icon: <Wifi className="h-3 w-3" />,               label: 'Live',        color: 'text-green-500' },
    polling:    { icon: <WifiOff className="h-3 w-3" />,            label: 'Polling',     color: 'text-amber-500' },
    error:      { icon: <WifiOff className="h-3 w-3" />,            label: 'Offline',     color: 'text-red-500' },
  }

  const { icon, label, color } = statusConfig[status]
  const dataSummary = data.length
    ? `${data.length} recent readings from ${data[0].label} to ${data[data.length - 1].label}. Latest value: ${data[data.length - 1].energy.toFixed(3)} kWh.`
    : 'No readings loaded yet.'
  const updateMode = status === 'live'
    ? 'Updates in real time from the meter feed.'
    : status === 'polling'
      ? 'Updates every 30 seconds while live feed is unavailable.'
      : 'Waiting for meter readings.'

  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <figure aria-labelledby="live-generation-title" aria-describedby="live-generation-desc">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-gray-500">Energy trend</p>
            <h2 id="live-generation-title" className="mt-2 text-2xl font-semibold text-gray-900">Live generation</h2>
          </div>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${color}`} aria-live="polite">
            {icon}
            {label}
          </span>
        </div>
        <p id="live-generation-desc" className="sr-only">
          Area chart of the most recent meter readings showing kilowatt-hours generated over time. {updateMode} {dataSummary}
        </p>
        <p id="live-generation-legend" className="sr-only">
          Legend: Energy output in kWh, shown as an amber filled area.
        </p>
        <div
          className="h-72 min-h-[18rem] w-full"
          role="img"
          aria-labelledby="live-generation-title"
          aria-describedby="live-generation-desc live-generation-legend"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="energyGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280' }} />
              <Tooltip wrapperStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 10px 30px rgba(15, 23, 42, 0.08)' }} />
              <Area
                type="monotone"
                dataKey="energy"
                stroke="#f59e0b"
                fill="url(#energyGradient)"
                strokeWidth={3}
                isAnimationActive={false}
                name="Energy (kWh)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </figure>
    </section>
  )
}

export function DashboardChart() {
  return (
    <ErrorBoundary inline label="Dashboard chart">
      <DashboardChartContent />
    </ErrorBoundary>
  )
}
