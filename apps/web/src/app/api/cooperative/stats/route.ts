import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { requireAuth, isAuthError } from '@/lib/auth'

const StatsQuerySchema = z.object({
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
})

interface MeterSeriesRow {
  bucket: string
  meter_id: string
  meter_name: string
  kwh: number | string
}

/**
 * GET /api/cooperative/stats
 * Returns cooperative-level stats: summary, trends, and per-meter breakdown.
 * Query params: date_from, date_to, granularity
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  const { searchParams } = new URL(req.url)
  const parsed = StatsQuerySchema.safeParse(Object.fromEntries(searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { date_from, date_to, granularity } = parsed.data
  // Service role required: analytics RPCs call cross-table aggregations that
  // span readings and meters; these functions run as SECURITY DEFINER and
  // require the service role to invoke. See docs/adr/007-supabase-service-role-usage.md
  const db = createServiceClient()

  // Defaults: last 30 days
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const defaultTo = now.toISOString()

  const start = date_from ?? defaultFrom
  const end = date_to ?? defaultTo

  // Execute analytics RPCs in parallel
  const [summaryResult, trendsResult, meterResult, meterSeriesResult] = await Promise.all([
    // Aggregate summary for the selected range
    db.rpc('get_cooperative_trends', {
      target_cooperative_id: auth.cooperativeId,
      start_date: start,
      end_date: end,
      granularity: 'year', // Using 'year' for summary to get a single row usually, but we'll sum it
    }),
    // Trend data for charts
    db.rpc('get_cooperative_trends', {
      target_cooperative_id: auth.cooperativeId,
      start_date: start,
      end_date: end,
      granularity: granularity,
    }),
    // Per-meter breakdown
    db.rpc('get_cooperative_meter_stats', {
      target_cooperative_id: auth.cooperativeId,
      start_date: start,
      end_date: end,
    }),
    // Per-meter kWh time series for the stacked bar chart
    db.rpc('get_cooperative_meter_kwh_series', {
      target_cooperative_id: auth.cooperativeId,
      start_date: start,
      end_date: end,
      granularity: granularity,
    }),
  ])

  if (summaryResult.error) return NextResponse.json({ error: summaryResult.error.message }, { status: 500 })
  if (trendsResult.error) return NextResponse.json({ error: trendsResult.error.message }, { status: 500 })
  if (meterResult.error) return NextResponse.json({ error: meterResult.error.message }, { status: 500 })
  if (meterSeriesResult.error) return NextResponse.json({ error: meterSeriesResult.error.message }, { status: 500 })

  // Normalize the per-meter series into a stable shape for the dashboard chart
  const meter_series = ((meterSeriesResult.data ?? []) as MeterSeriesRow[]).map((row) => ({
    bucket: row.bucket,
    meter_id: row.meter_id,
    meter_name: row.meter_name,
    kwh: Math.round(Number(row.kwh) * 1000) / 1000,
  }))

  // Calculate summary totals from the trends results
  const summary = (summaryResult.data as { kwh: number; certs_issued: number; certs_retired: number }[]).reduce(
    (acc, curr) => ({
      total_kwh: acc.total_kwh + Number(curr.kwh),
      certificates_issued: acc.certificates_issued + Number(curr.certs_issued),
      certificates_retired: acc.certificates_retired + Number(curr.certs_retired),
    }),
    { total_kwh: 0, certificates_issued: 0, certificates_retired: 0 }
  )

  // Also get active meters count (total, not just in range)
  const { count: active_meters } = await db
    .from('meters')
    .select('id', { count: 'exact', head: true })
    .eq('cooperative_id', auth.cooperativeId)
    .eq('active', true)

  return NextResponse.json({
    summary: {
      ...summary,
      total_kwh: Math.round(summary.total_kwh * 1000) / 1000,
      active_meters: active_meters ?? 0,
    },
    trends: trendsResult.data,
    meter_stats: meterResult.data,
    meter_series,
    range: { start, end, granularity },
  })
}
