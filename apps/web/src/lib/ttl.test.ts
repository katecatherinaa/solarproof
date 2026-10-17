import { describe, it, expect } from 'vitest'
import {
  checkTtlEntry,
  filterExpiring,
  buildExtendCommand,
  WARNING_LEDGERS,
  EXTEND_TO_LEDGERS,
  LEDGERS_PER_DAY,
  type TtlEntry,
} from './ttl'

const BASE: TtlEntry = {
  contractId: 'CABC123',
  keyLabel: 'audit_registry:instance',
  currentLedger: 1_000_000,
  expiryLedger: 1_000_000 + WARNING_LEDGERS + 1, // just outside warning window
}

describe('checkTtlEntry', () => {
  it('calculates remaining ledgers correctly', () => {
    const result = checkTtlEntry(BASE)
    expect(result.remainingLedgers).toBe(WARNING_LEDGERS + 1)
  })

  it('marks entry as not needing extension when > 7 days remain', () => {
    const result = checkTtlEntry(BASE)
    expect(result.needsExtension).toBe(false)
  })

  it('marks entry as needing extension when exactly at warning boundary', () => {
    const entry: TtlEntry = { ...BASE, expiryLedger: BASE.currentLedger + WARNING_LEDGERS }
    const result = checkTtlEntry(entry)
    expect(result.needsExtension).toBe(true)
  })

  it('marks entry as needing extension when 1 day remains', () => {
    const entry: TtlEntry = { ...BASE, expiryLedger: BASE.currentLedger + LEDGERS_PER_DAY }
    const result = checkTtlEntry(entry)
    expect(result.needsExtension).toBe(true)
  })

  it('marks entry as needing extension when already expired', () => {
    const entry: TtlEntry = { ...BASE, expiryLedger: BASE.currentLedger - 1 }
    const result = checkTtlEntry(entry)
    expect(result.needsExtension).toBe(true)
    expect(result.remainingLedgers).toBe(-1)
  })

  it('converts remaining ledgers to days correctly', () => {
    const entry: TtlEntry = { ...BASE, expiryLedger: BASE.currentLedger + LEDGERS_PER_DAY * 3 }
    const result = checkTtlEntry(entry)
    expect(result.remainingDays).toBeCloseTo(3, 1)
  })
})

describe('filterExpiring', () => {
  it('returns only entries that need extension', () => {
    const entries: TtlEntry[] = [
      { ...BASE, keyLabel: 'ok', expiryLedger: BASE.currentLedger + WARNING_LEDGERS + 100 },
      { ...BASE, keyLabel: 'expiring', expiryLedger: BASE.currentLedger + 1 },
    ]
    const result = filterExpiring(entries)
    expect(result).toHaveLength(1)
    expect(result[0].keyLabel).toBe('expiring')
  })

  it('returns empty array when no entries are expiring', () => {
    const entries: TtlEntry[] = [
      { ...BASE, expiryLedger: BASE.currentLedger + WARNING_LEDGERS + 9999 },
    ]
    expect(filterExpiring(entries)).toHaveLength(0)
  })
})

describe('buildExtendCommand', () => {
  it('builds a valid CLI command', () => {
    const cmd = buildExtendCommand(BASE, 'testnet', 'https://soroban-testnet.stellar.org')
    expect(cmd).toContain('stellar contract extend-footprint-ttl')
    expect(cmd).toContain(`--id ${BASE.contractId}`)
    expect(cmd).toContain(`--ledgers-to-extend ${EXTEND_TO_LEDGERS}`)
    expect(cmd).toContain('--network testnet')
  })
})
