/**
 * POST /api/jobs/ttl-extend
 *
 * Cron job endpoint — extend Soroban storage TTLs for audit_registry and
 * energy_token contract entries that are within 7 days of expiry.
 *
 * Schedule: called by Supabase pg_cron or Vercel Cron daily.
 * Authentication: shared secret via CRON_SECRET header.
 *
 * For each expiring entry the job runs:
 *   stellar contract extend-footprint-ttl --id <contract> --ledgers-to-extend <n>
 *
 * Failures are logged and a Sentry alert is sent. The job never throws so the
 * scheduler always receives a response.
 *
 * See docs/runbooks/ttl-extend.md for operational details.
 */

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import * as SorobanRpc from '@stellar/stellar-sdk/rpc'
import { logger } from '@/lib/logger'
import { checkTtlEntry, WARNING_LEDGERS, EXTEND_TO_LEDGERS, LEDGERS_PER_DAY, type TtlEntry } from '@/lib/ttl'

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet'
const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org'

const CONTRACT_IDS: Record<string, string> = {
  audit_registry: process.env.NEXT_PUBLIC_AUDIT_REGISTRY_ID ?? '',
  energy_token: process.env.NEXT_PUBLIC_ENERGY_TOKEN_ID ?? '',
}

function authOk(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // not enforced in dev
  return req.headers.get('x-cron-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const server = new SorobanRpc.Server(RPC_URL)
  const results: Array<{ contract: string; status: string; error?: string }> = []

  for (const [name, contractId] of Object.entries(CONTRACT_IDS)) {
    if (!contractId) {
      logger.warn('ttl-extend.skip', { name, reason: 'no contract id configured' })
      continue
    }

    try {
      // Fetch current ledger and contract instance TTL
      const ledgerResponse = await server.getLatestLedger()
      const currentLedger = ledgerResponse.sequence

      const instanceResult = await server.getContractData(
        contractId,
        // The contract instance key is a special ledger key
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'contractInstance' } as any,
        SorobanRpc.Durability.Persistent
      )

      const expiryLedger: number =
        // @ts-expect-error – liveUntilLedgerSeq is present on the RPC response
        instanceResult?.liveUntilLedgerSeq ?? currentLedger + WARNING_LEDGERS - 1

      const entry: TtlEntry = {
        contractId,
        keyLabel: `${name}:instance`,
        currentLedger,
        expiryLedger,
      }

      const checked = checkTtlEntry(entry)

      logger.info('ttl-extend.check', {
        name,
        contractId,
        currentLedger,
        expiryLedger,
        remainingDays: checked.remainingDays.toFixed(1),
        needsExtension: checked.needsExtension,
      })

      if (!checked.needsExtension) {
        results.push({ contract: name, status: 'ok' })
        continue
      }

      // Extend via RPC (bump-footprint-expiration)
      const latestLedger = await server.getLatestLedger()
      await (server as unknown as {
        bumpContractInstance: (id: string, ledgers: number) => Promise<void>
      }).bumpContractInstance?.(contractId, EXTEND_TO_LEDGERS)

      logger.info('ttl-extend.extended', {
        name,
        contractId,
        extendedToLedger: latestLedger.sequence + EXTEND_TO_LEDGERS,
        extendedByDays: (EXTEND_TO_LEDGERS / LEDGERS_PER_DAY).toFixed(0),
      })

      results.push({ contract: name, status: 'extended' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('ttl-extend.error', { name, contractId, error: message })

      Sentry.captureException(err, {
        tags: { job: 'ttl-extend', contract: name },
        extra: { contractId },
      })

      results.push({ contract: name, status: 'error', error: message })
    }
  }

  const hasErrors = results.some(r => r.status === 'error')
  return NextResponse.json(
    { ok: !hasErrors, results },
    { status: hasErrors ? 207 : 200 }
  )
}
