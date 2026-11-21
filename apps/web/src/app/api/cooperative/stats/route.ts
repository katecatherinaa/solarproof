import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase'
import { requireAuth, isAuthError } from '@/lib/auth'

const StatsQuerySchema = z.object({
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  granularity: z.enum(['day', 'month', 'year']).default('day'),
})

const GoalQuerySchema = z.object({
  period: z.enum(['month', 'year']).default('month'),
  date: z.string().datetime().optional(),
})

const GoalUpdateSchema = z.object({
  period: z.enum(['month', 'year']).default('month'),
  period_start: z.string().datetime(),
  target_kwh: z.number().nonnegative(),
})

const BELOW_PACE_THRESHOLD = 0.8

type GoalRow = {
  id: string
  cooperative_id: string
  period: 'month' | 'year'
  period_start: string
  target_kwh: number
}

/**
 * Compute the start/end of the goal period containing `ref`.
 */
function resolvePeriod(period: 'month' | 'year', ref: Date): { start: Date; end: Date } {
  if (period === 'year') {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
    const end = new Date(Date.UTC(ref.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0))
    return { start, end }
  }
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return { start, end }
}

/**
 * GET /api/cooperative/stats/goal
 * Returns the cooperative's production goal for the period along with actual
 * production, progress percentage, and a below-80%-pace flag.
 */
export async function goalGET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  const { searchParams } = new URL(req.url)
  const parsed = GoalQuerySchema.safeParse(Object.fromEntries(searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { period } = parsed.data
  const ref = parsed.data.date ? new Date(parsed.data.date) : new Date()
  const { start, end } = resolvePeriod(period, ref)

  const db = createServiceClient()

  const { data: goalData, error: goalError } = await db
    .from('cooperative_goals')
    .select('id, cooperative_id, period, period_start, target_kwh')
    .eq('cooperative_id', auth.cooperativeId)
    .eq('period', period)
    .eq('period_start', start.toISOString())
    .maybeSingle()

  if (goalError) return NextResponse.json({ error: goalError.message }, { status: 500 })

  const goal = goalData as GoalRow | null

  // Actual production within the period
  const { data: trendsData, error: trendsError } = await db.rpc('get_cooperative_trends', {
    target_cooperative_id: auth.cooperativeId,
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    granularity: 'year',
  })

  if (trendsError) return NextResponse.json({ error: trendsError.message }, { status: 500 })

  const actual_kwh = ((trendsData as { kwh: number }[] | null) ?? []).reduce(
    (acc, curr) => acc + Number(curr.kwh),
    0
  )

  const target_kwh = goal ? Number(goal.target_kwh) : 0
  const progress_pct = target_kwh > 0 ? (actual_kwh / target_kwh) * 100 : 0

  // Expected pace: fraction of the period elapsed
  const nowMs = Date.now()
  const totalMs = end.getTime() - start.getTime()
  const elapsedMs = Math.min(Math.max(nowMs - start.getTime(), 0), totalMs)
  const elapsed_fraction = totalMs > 0 ? elapsedMs / totalMs : 0
  const expected_kwh = target_kwh * elapsed_fraction
  const pace_pct = expected_kwh > 0 ? (actual_kwh / expected_kwh) * 100 : 100
  const below_pace = target_kwh > 0 && pace_pct < BELOW_PACE_THRESHOLD * 100

  // Alert cooperative operators when production falls below 80% of target pace
  if (below_pace && goal) {
    const { error: notifyError } = await db.from('notifications').insert({
      cooperative_id: auth.cooperativeId,
      type: 'goal_below_pace',
      title: 'Production below goal pace',
      message: `Production is at ${Math.round(pace_pct)}% of the expected pace for the ${period} goal (${Math.round(actual_kwh)} / ${Math.round(target_kwh)} kWh).`,
      metadata: {
        goal_id: goal.id,
        period,
        period_start: start.toISOString(),
        actual_kwh,
        target_kwh,
        progress_pct,
        pace_pct,
      },
    })
    if (notifyError) {
      // Non-fatal: surface in logs but still return goal data
      console.error('Failed to create goal alert notification:', notifyError.message)
    }
  }

  return NextResponse.json({
    goal: goal
      ? {
          id: goal.id,
          period: goal.period,
          period_start: start.toISOString(),
          period_end: end.toISOString(),
          target_kwh,
        }
      : null,
    actual_kwh: Math.round(actual_kwh * 1000) / 1000,
    target_kwh,
    progress_pct: Math.round(progress_pct * 100) / 100,
    expected_kwh: Math.round(expected_kwh * 1000) / 1000,
    pace_pct: Math.round(pace_pct * 100) / 100,
    below_pace,
  })
}

/**
 * PUT /api/cooperative/stats/goal
 * Create or update the cooperative's production goal for a period.
 */
export async function goalPUT(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = GoalUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { period, target_kwh } = parsed.data
  const { start } = resolvePeriod(period, new Date(parsed.data.period_start))

  const db = createServiceClient()

  const { data, error } = await db
    .from('cooperative_goals')
    .upsert(
      {
        cooperative_id: auth.cooperativeId,
        period,
        period_start: start.toISOString(),
        target_kwh,
      },
      { onConflict: 'cooperative_id,period,period_start' }
    )
    .select('id, cooperative_id, period, period_start, target_kwh')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ goal: data })
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
  const [summaryResult, trendsResult, meterResult] = await Promise.all([
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
  ])

  if (summaryResult.error) return NextResponse.json({ error: summaryResult.error.message }, { status: 500 })
  if (trendsResult.error) return NextResponse.json({ error: trendsResult.error.message }, { status: 500 })
  if (meterResult.error) return NextResponse.json({ error: meterResult.error.message }, { status: 500 })

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
    range: { start, end, granularity },
  })
}
