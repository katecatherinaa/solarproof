/**
 * TTL management utilities for Soroban contract storage entries.
 *
 * Soroban persistent ledger entries expire if their TTL is not extended.
 * This module provides helpers to:
 *   1. Calculate how many ledger sequences remain until expiry.
 *   2. Determine whether an entry needs extending (within WARNING_LEDGERS).
 *   3. Build the `stellar contract extend-footprint-ttl` shell command.
 *
 * Acceptance criteria (issue #25):
 *   - Entries within 7 days of expiry are flagged for extension.
 *   - 7 days ≈ 7 * 24 * 3600 / 5 = 120,960 ledgers (5 s per ledger).
 */

/** Average ledger close time in seconds on Stellar mainnet/testnet. */
export const LEDGER_CLOSE_SECONDS = 5

/** Ledgers per day. */
export const LEDGERS_PER_DAY = (24 * 60 * 60) / LEDGER_CLOSE_SECONDS // 17 280

/** Entries whose remaining TTL (in ledgers) falls below this threshold are extended. */
export const WARNING_LEDGERS = 7 * LEDGERS_PER_DAY // 120 960 (~7 days)

/** How many ledgers to extend to (bump TTL to this many ledgers from now). */
export const EXTEND_TO_LEDGERS = 30 * LEDGERS_PER_DAY // 518 400 (~30 days)

export interface TtlEntry {
  /** Contract address (C...). */
  contractId: string
  /** Storage key identifier (hex or label — used only in logs/commands). */
  keyLabel: string
  /** Current ledger sequence number. */
  currentLedger: number
  /** Ledger sequence at which this entry expires. */
  expiryLedger: number
}

export interface TtlCheckResult extends TtlEntry {
  remainingLedgers: number
  remainingDays: number
  needsExtension: boolean
}

/**
 * Evaluate whether a single entry needs TTL extension.
 */
export function checkTtlEntry(entry: TtlEntry): TtlCheckResult {
  const remainingLedgers = entry.expiryLedger - entry.currentLedger
  const remainingDays = remainingLedgers / LEDGERS_PER_DAY
  const needsExtension = remainingLedgers < WARNING_LEDGERS
  return { ...entry, remainingLedgers, remainingDays, needsExtension }
}

/**
 * Filter a list of entries to only those that need extension.
 */
export function filterExpiring(entries: TtlEntry[]): TtlCheckResult[] {
  return entries.map(checkTtlEntry).filter(e => e.needsExtension)
}

/**
 * Build the `stellar contract extend-footprint-ttl` CLI command for an entry.
 *
 * @param entry   The TTL entry to extend.
 * @param network Stellar network name ('testnet' | 'mainnet').
 * @param rpcUrl  Soroban RPC URL.
 */
export function buildExtendCommand(
  entry: TtlEntry,
  network: string,
  rpcUrl: string
): string {
  return (
    `stellar contract extend-footprint-ttl` +
    ` --id ${entry.contractId}` +
    ` --ledgers-to-extend ${EXTEND_TO_LEDGERS}` +
    ` --network ${network}` +
    ` --rpc-url ${rpcUrl}`
  )
}
