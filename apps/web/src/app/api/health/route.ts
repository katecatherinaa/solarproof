import { NextResponse } from 'next/server'
import {
  checkDatabase,
  checkStellarRpc,
  checkRedisUpstash,
  checkRedisBull,
  checkConnectionPool,
  type CheckResult,
  type CheckStatus,
} from '@/lib/health-checks'

/** GET /api/health — service health with DB + Stellar RPC checks */
export async function GET() {
  const checks = await Promise.all([
    checkDatabase(),
    checkStellarRpc(),
    checkRedisUpstash(),
    checkRedisBull(),
    checkConnectionPool(),
  ])

  const [db, stellar, upstash, bull, pool] = checks

  const overallStatus: CheckStatus =
    [db, stellar, upstash, bull, pool].some(c => c.status === 'error')
      ? 'error'
      : [db, stellar, upstash, bull, pool].some(c => c.status === 'degraded')
      ? 'degraded'
      : 'ok'

  const httpStatus = overallStatus === 'error' ? 503 : 200

  // Build stellar-specific degraded message per acceptance criteria
  const stellarField: CheckResult & { message?: string } = stellar.status !== 'ok'
    ? { ...stellar, message: stellar.error === 'unreachable' || stellar.status === 'error' ? 'unreachable' : 'slow' }
    : stellar

  return NextResponse.json(
    {
      status: overallStatus,
      ts: Date.now(),
      checks: {
        database: db,
        stellar_rpc: stellarField,
        redis_upstash: upstash,
        redis_bull: bull,
        connection_pool: pool,
      },
      ...(stellar.status !== 'ok' ? { stellar: stellarField.status === 'error' ? 'unreachable' : 'degraded' } : {}),
    },
    { status: httpStatus }
  )
}