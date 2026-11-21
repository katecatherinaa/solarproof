import { createServiceClient } from '@/lib/supabase'
import { env } from '@/env'

export const DEGRADED_THRESHOLD_MS = 300
export const TIMEOUT_MS = 450
/** Timeout for Stellar RPC checks (3 s per acceptance criteria). */
export const STELLAR_TIMEOUT_MS = 3000

export type CheckStatus = 'ok' | 'degraded' | 'error'

export interface CheckResult {
  status: CheckStatus
  latency_ms: number
  error?: string
  /** Pool saturation ratio (active / max connections), when applicable. */
  saturation?: number
}

/** Saturation ratio above which the connection pool is reported as degraded. */
export const POOL_SATURATION_THRESHOLD = 0.8
=======

export async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  try {
    const result = await Promise.race([promise, timeout])
    clearTimeout(timer!)
    return result
  } catch (err) {
    clearTimeout(timer!)
    throw err
  }
}

export async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now()
  try {
    const db = createServiceClient()
    await withTimeout(
      db.from('cooperatives').select('id', { count: 'exact', head: true }),
      TIMEOUT_MS
    )
    const latency_ms = Date.now() - start
    return { status: latency_ms > DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok', latency_ms }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(err) }
  }
}

export async function checkStellarRpc(): Promise<CheckResult> {
  const start = Date.now()
  try {
    const res = await withTimeout(
      fetch(env.NEXT_PUBLIC_STELLAR_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedger', params: { xdr: false } }),
      }),
      STELLAR_TIMEOUT_MS
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const latency_ms = Date.now() - start
    return { status: latency_ms > DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok', latency_ms }
  } catch (err) {
    return {
      status: 'error',
      latency_ms: Date.now() - start,
      error: 'unreachable',
    }
  }
}

/**
 * Checks PgBouncer pool saturation by querying the pooler admin/stats endpoint
 * (or Supabase pooler metrics) exposed at PGBOUNCER_URL.
 *
 * Reports `active / max` connections as a saturation ratio and returns
 * 'degraded' when saturation exceeds POOL_SATURATION_THRESHOLD.
 */
export async function checkConnectionPool(): Promise<CheckResult> {
  const start = Date.now()
  const url = process.env.PGBOUNCER_URL
  if (!url) return { status: 'degraded', latency_ms: 0, error: 'PGBOUNCER_URL not configured' }
  try {
    const res = await withTimeout(
      fetch(`${url.replace(/\/$/, '')}/stats`, {
        headers: process.env.PGBOUNCER_ADMIN_TOKEN
          ? { Authorization: `Bearer ${process.env.PGBOUNCER_ADMIN_TOKEN}` }
          : {},
      }),
      TIMEOUT_MS
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as {
      active?: number
      max?: number
      pools?: Array<{ active?: number; max?: number }>
    }
    // Support both a flat shape and PgBouncer's per-pool stats array.
    const active =
      typeof body.active === 'number'
        ? body.active
        : (body.pools ?? []).reduce((sum, p) => sum + (p.active ?? 0), 0)
    const max =
      typeof body.max === 'number'
        ? body.max
        : (body.pools ?? []).reduce((sum, p) => sum + (p.max ?? 0), 0)
    const latency_ms = Date.now() - start
    if (!max || max <= 0) {
      return { status: 'degraded', latency_ms, error: 'pool max connections unavailable' }
    }
    const saturation = active / max
    const status: CheckStatus =
      saturation > POOL_SATURATION_THRESHOLD || latency_ms > DEGRADED_THRESHOLD_MS
        ? 'degraded'
        : 'ok'
    return { status, latency_ms, saturation }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(err) }
  }
}

export async function checkRedisUpstash(): Promise<CheckResult> {
  const start = Date.now()
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url) return { status: 'degraded', latency_ms: 0 }
  try {
    const res = await withTimeout(
      fetch(`${url}/get/__health__`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      TIMEOUT_MS
    )
    const latency_ms = Date.now() - start
    return { status: res.ok ? (latency_ms > DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok') : 'error', latency_ms }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(err) }
  }
}

export async function checkRedisBull(): Promise<CheckResult> {
  const start = Date.now()
  try {
    const { getRedisConnection } = await import('@/lib/redis')
    const conn = getRedisConnection()
    const pong = await withTimeout(conn.ping(), TIMEOUT_MS)
    const latency_ms = Date.now() - start
    return { status: pong === 'PONG' ? (latency_ms > DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok') : 'error', latency_ms }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, error: String(err) }
  }
}
