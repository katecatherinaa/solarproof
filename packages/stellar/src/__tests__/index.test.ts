import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTransaction,
  addressToScVal,
  amountToScVal,
  bytesToScVal,
  kwhToStroops,
  stroopsToKwh,
  getRpcServer,
  NETWORKS,
} from '../index'
import {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Contract,
  xdr,
} from '@stellar/stellar-sdk'
import * as SorobanRpc from '@stellar/stellar-sdk/rpc'

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MINTER_KEYPAIR = Keypair.random()
const RECIPIENT_ADDRESS = Keypair.random().publicKey()
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
const READING_HASH = new Uint8Array(32).fill(0xab)

/** Minimal mock of a Stellar account returned by server.getAccount(). */
function mockAccount(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    id: publicKey,
  }
}

/**
 * Build a mock SorobanRpc.Server.
 * `getAccount` returns a minimal account stub.
 * `prepareTransaction` returns the transaction unchanged so we can inspect it.
 */
function mockServer() {
  return {
    getAccount: vi.fn().mockResolvedValue(mockAccount(MINTER_KEYPAIR.publicKey())),
    prepareTransaction: vi.fn().mockImplementation(async (tx) => tx),
  } as unknown as SorobanRpc.Server
}

// ---------------------------------------------------------------------------
// buildTransaction — shared helper used by all three tx types
// ---------------------------------------------------------------------------

describe('buildTransaction', () => {
  let server: ReturnType<typeof mockServer>

  beforeEach(() => {
    server = mockServer()
  })

  it('fetches the source account before building', async () => {
    await buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
      bytesToScVal(READING_HASH),
    ])
    expect(server.getAccount).toHaveBeenCalledWith(MINTER_KEYPAIR.publicKey())
  })

  it('calls prepareTransaction to attach resource fees', async () => {
    await buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
      bytesToScVal(READING_HASH),
    ])
    expect(server.prepareTransaction).toHaveBeenCalledOnce()
  })

  it('returns the prepared transaction object', async () => {
    const tx = await buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
      bytesToScVal(READING_HASH),
    ])
    // prepareTransaction mock returns the tx unchanged; verify it is truthy
    expect(tx).toBeTruthy()
  })

  it('throws when getAccount rejects (invalid source key)', async () => {
    server.getAccount = vi.fn().mockRejectedValue(new Error('Account not found'))
    await expect(
      buildTransaction(server, 'INVALID', CONTRACT_ID, 'anchor', [])
    ).rejects.toThrow('Account not found')
  })

  it('throws when prepareTransaction rejects (simulation failure)', async () => {
    server.prepareTransaction = vi.fn().mockRejectedValue(new Error('Simulation failed'))
    await expect(
      buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
        bytesToScVal(READING_HASH),
      ])
    ).rejects.toThrow('Simulation failed')
  })
})

// ---------------------------------------------------------------------------
// build_anchor_tx — anchor a reading hash in audit_registry
// ---------------------------------------------------------------------------

describe('build_anchor_tx (buildTransaction with method="anchor")', () => {
  let server: ReturnType<typeof mockServer>

  beforeEach(() => {
    server = mockServer()
  })

  it('builds an anchor transaction with a bytes argument', async () => {
    const tx = await buildTransaction(
      server,
      MINTER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      'anchor',
      [bytesToScVal(READING_HASH)]
    )
    expect(tx).toBeTruthy()
    expect(server.prepareTransaction).toHaveBeenCalledOnce()
  })

  it('rejects when reading hash is empty (zero-length bytes)', async () => {
    // An empty hash would anchor nothing — the contract would reject it,
    // but we verify the RPC simulation path is still called.
    server.prepareTransaction = vi.fn().mockRejectedValue(new Error('invalid hash length'))
    await expect(
      buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
        bytesToScVal(new Uint8Array(0)),
      ])
    ).rejects.toThrow('invalid hash length')
  })

  it('uses testnet passphrase by default', async () => {
    // Capture the transaction passed to prepareTransaction and check its network.
    let capturedTx: any
    server.prepareTransaction = vi.fn().mockImplementation(async (tx) => {
      capturedTx = tx
      return tx
    })
    await buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'anchor', [
      bytesToScVal(READING_HASH),
    ])
    expect(capturedTx.networkPassphrase).toBe(Networks.TESTNET)
  })
})

// ---------------------------------------------------------------------------
// build_mint_tx — mint energy_token certificates
// ---------------------------------------------------------------------------

describe('build_mint_tx (buildTransaction with method="mint")', () => {
  let server: ReturnType<typeof mockServer>

  beforeEach(() => {
    server = mockServer()
  })

  it('builds a mint transaction with address and amount arguments', async () => {
    const tx = await buildTransaction(
      server,
      MINTER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      'mint',
      [addressToScVal(RECIPIENT_ADDRESS), amountToScVal(kwhToStroops(10))]
    )
    expect(tx).toBeTruthy()
    expect(server.prepareTransaction).toHaveBeenCalledOnce()
  })

  it('rejects when recipient address is invalid', async () => {
    expect(() => addressToScVal('NOT_A_VALID_ADDRESS')).toThrow()
  })

  it('encodes 0 kWh as 0 stroops', async () => {
    // Zero-amount mints are valid at the transaction-building level;
    // the contract may reject them, but the builder should not.
    const tx = await buildTransaction(
      server,
      MINTER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      'mint',
      [addressToScVal(RECIPIENT_ADDRESS), amountToScVal(kwhToStroops(0))]
    )
    expect(tx).toBeTruthy()
  })

  it('encodes fractional kWh correctly (0.1 kWh = 1_000_000 stroops)', async () => {
    const stroops = kwhToStroops(0.1)
    expect(stroops).toBe(1_000_000n)
  })
})

// ---------------------------------------------------------------------------
// build_retire_tx — retire (burn) energy_token certificates
// ---------------------------------------------------------------------------

describe('build_retire_tx (buildTransaction with method="retire")', () => {
  let server: ReturnType<typeof mockServer>

  beforeEach(() => {
    server = mockServer()
  })

  it('builds a retire transaction with address and amount arguments', async () => {
    const tx = await buildTransaction(
      server,
      MINTER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      'retire',
      [addressToScVal(RECIPIENT_ADDRESS), amountToScVal(kwhToStroops(5))]
    )
    expect(tx).toBeTruthy()
    expect(server.prepareTransaction).toHaveBeenCalledOnce()
  })

  it('rejects when simulation fails (e.g. insufficient balance)', async () => {
    server.prepareTransaction = vi.fn().mockRejectedValue(new Error('insufficient balance'))
    await expect(
      buildTransaction(server, MINTER_KEYPAIR.publicKey(), CONTRACT_ID, 'retire', [
        addressToScVal(RECIPIENT_ADDRESS),
        amountToScVal(kwhToStroops(9999)),
      ])
    ).rejects.toThrow('insufficient balance')
  })

  it('uses mainnet passphrase when network="mainnet"', async () => {
    let capturedTx: any
    server.prepareTransaction = vi.fn().mockImplementation(async (tx) => {
      capturedTx = tx
      return tx
    })
    await buildTransaction(
      server,
      MINTER_KEYPAIR.publicKey(),
      CONTRACT_ID,
      'retire',
      [addressToScVal(RECIPIENT_ADDRESS), amountToScVal(kwhToStroops(1))],
      'mainnet'
    )
    expect(capturedTx.networkPassphrase).toBe(Networks.PUBLIC)
  })
})

// ---------------------------------------------------------------------------
// ScVal encoding helpers
// ---------------------------------------------------------------------------

describe('addressToScVal', () => {
  it('encodes a valid G-address without throwing', () => {
    expect(() => addressToScVal(RECIPIENT_ADDRESS)).not.toThrow()
  })

  it('throws on an invalid address string', () => {
    expect(() => addressToScVal('bad')).toThrow()
  })
})

describe('amountToScVal', () => {
  it('encodes zero', () => {
    expect(() => amountToScVal(0n)).not.toThrow()
  })

  it('encodes large i128 values without overflow', () => {
    // Max i128 = 2^127 - 1
    const maxI128 = (2n ** 127n) - 1n
    expect(() => amountToScVal(maxI128)).not.toThrow()
  })
})

describe('bytesToScVal', () => {
  it('encodes a 32-byte hash', () => {
    expect(() => bytesToScVal(READING_HASH)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// kwhToStroops / stroopsToKwh round-trip
// ---------------------------------------------------------------------------

describe('kwhToStroops', () => {
  it('converts 1 kWh to 10_000_000 stroops', () => {
    expect(kwhToStroops(1)).toBe(10_000_000n)
  })

  it('converts 0.1 kWh to 1_000_000 stroops', () => {
    expect(kwhToStroops(0.1)).toBe(1_000_000n)
  })

  it('rounds floating-point imprecision correctly', () => {
    // 0.3 in IEEE 754 is slightly less than 0.3; Math.round prevents truncation.
    expect(kwhToStroops(0.3)).toBe(3_000_000n)
  })

  it('converts 0 kWh to 0 token units', () => {
    expect(kwhToStroops(0)).toBe(0n)
  })

  it('converts 12.5 kWh to 125_000_000 stroops', () => {
    expect(kwhToStroops(12.5)).toBe(125_000_000n)
  })

  it('converts 0.0000001 kWh (minimum precision) to 1 stroop', () => {
    expect(kwhToStroops(0.0000001)).toBe(1n)
  })
})

describe('stroopsToKwh', () => {
  it('converts 10_000_000 stroops to 1 kWh', () => {
    expect(stroopsToKwh(10_000_000n)).toBe(1)
  })

  it('round-trips kwhToStroops → stroopsToKwh', () => {
    expect(stroopsToKwh(kwhToStroops(12.5))).toBeCloseTo(12.5)
  })
})

// ---------------------------------------------------------------------------
// getRpcServer
// ---------------------------------------------------------------------------

describe('getRpcServer', () => {
  it('uses the testnet RPC URL by default', () => {
    expect(NETWORKS.testnet.rpcUrl).toBe('https://soroban-testnet.stellar.org')
  })

  it('uses the mainnet RPC URL when network="mainnet"', () => {
    expect(NETWORKS.mainnet.rpcUrl).toBe('https://soroban-mainnet.stellar.org')
  })

  it('uses testnet network passphrase', () => {
    expect(NETWORKS.testnet.networkPassphrase).toBe(Networks.TESTNET)
  })
})
