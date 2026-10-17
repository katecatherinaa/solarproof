import { describe, it, expect } from 'vitest'
import { kwhToStroops, stroopsToKwh, NETWORKS, CONTRACT_IDS } from './index'

describe('kwhToStroops', () => {
  it('converts whole kWh', () => {
    expect(kwhToStroops(1)).toBe(10_000_000n)
  })

  it('converts fractional kWh', () => {
    expect(kwhToStroops(0.5)).toBe(5_000_000n)
  })

  it('converts zero', () => {
    expect(kwhToStroops(0)).toBe(0n)
  })

  it('rounds sub-unit values', () => {
    // 1.00000001 kWh rounds to 10_000_000 stroops at decimals=7.
    expect(kwhToStroops(1.00000001)).toBe(10_000_000n)
  })

  it('handles large values', () => {
    expect(kwhToStroops(1000)).toBe(10_000_000_000n)
  })
})

describe('stroopsToKwh', () => {
  it('converts stroops to kWh', () => {
    expect(stroopsToKwh(10_000_000n)).toBe(1)
  })

  it('converts zero', () => {
    expect(stroopsToKwh(0n)).toBe(0)
  })

  it('converts fractional result', () => {
    expect(stroopsToKwh(5_000_000n)).toBe(0.5)
  })

  it('round-trips with kwhToStroops', () => {
    const kwh = 12.5
    expect(stroopsToKwh(kwhToStroops(kwh))).toBe(kwh)
  })
})

describe('NETWORKS', () => {
  it('has testnet config', () => {
    expect(NETWORKS.testnet.rpcUrl).toContain('testnet')
    expect(NETWORKS.testnet.networkPassphrase).toBeTruthy()
  })

  it('has mainnet config', () => {
    expect(NETWORKS.mainnet.rpcUrl).toContain('mainnet')
    expect(NETWORKS.mainnet.networkPassphrase).toBeTruthy()
  })
})

describe('CONTRACT_IDS', () => {
  it('has testnet contract slots', () => {
    expect(CONTRACT_IDS.testnet).toHaveProperty('energy_token')
    expect(CONTRACT_IDS.testnet).toHaveProperty('audit_registry')
    expect(CONTRACT_IDS.testnet).toHaveProperty('community_governance')
  })
})
