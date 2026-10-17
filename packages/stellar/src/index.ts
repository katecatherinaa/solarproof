import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk'
import * as SorobanRpc from '@stellar/stellar-sdk/rpc'

/** RPC endpoints and network passphrases for each supported Stellar network. */
export const NETWORKS = {
  testnet: {
    networkPassphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    networkPassphrase: Networks.PUBLIC,
    rpcUrl: 'https://soroban-mainnet.stellar.org',
  },
} as const

export type NetworkName = keyof typeof NETWORKS

/**
 * Contract IDs keyed by network then contract name.
 * Testnet IDs are read from environment variables so they can be rotated
 * without a code change. Mainnet IDs are left empty until mainnet deployment.
 */
export const CONTRACT_IDS: Record<NetworkName, Record<string, string>> = {
  testnet: {
    energy_token: process.env.NEXT_PUBLIC_ENERGY_TOKEN_ID ?? '',
    audit_registry: process.env.NEXT_PUBLIC_AUDIT_REGISTRY_ID ?? '',
    community_governance: process.env.NEXT_PUBLIC_COMMUNITY_GOVERNANCE_ID ?? '',
  },
  mainnet: {
    energy_token: '',
    audit_registry: '',
    community_governance: '',
  },
}

/**
 * Create a Soroban RPC server instance for the given network.
 * `allowHttp` is explicitly false to prevent accidental plaintext connections.
 *
 * @param network - Target network (defaults to 'testnet').
 */
export function getRpcServer(network: NetworkName = 'testnet') {
  return new SorobanRpc.Server(NETWORKS[network].rpcUrl, { allowHttp: false })
}

/**
 * Build and simulate a Soroban contract-call transaction.
 *
 * The flow is:
 * 1. Fetch the source account's current sequence number from the RPC.
 * 2. Construct a `TransactionBuilder` with a 30-second timeout — Stellar
 *    transactions expire if not submitted within the validity window.
 * 3. Call `server.prepareTransaction()` which runs a simulation, applies
 *    the resource fee estimate, and returns a transaction ready to sign.
 *
 * The caller is responsible for signing and submitting the returned transaction.
 *
 * @param server - Soroban RPC server (use `getRpcServer()`).
 * @param sourcePublicKey - G-address of the account paying the fee.
 * @param contractId - Deployed contract address (C-address).
 * @param method - Contract function name to invoke.
 * @param args - Encoded `xdr.ScVal` arguments for the contract call.
 * @param network - Network the transaction targets (defaults to 'testnet').
 * @returns A simulated, fee-bumped transaction ready to be signed.
 */
export async function buildTransaction(
  server: SorobanRpc.Server,
  sourcePublicKey: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  network: NetworkName = 'testnet'
) {
  const account = await server.getAccount(sourcePublicKey)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS[network].networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    // 30-second validity window — long enough for normal submission latency
    // but short enough to prevent stale transactions from being replayed later.
    .setTimeout(30)
    .build()

  // prepareTransaction simulates the call and attaches the resource fee.
  // Without this step the transaction would be rejected by the network.
  return server.prepareTransaction(tx)
}

// Re-export SDK helpers so callers don't need to import stellar-sdk directly.
export { nativeToScVal, scValToNative, Address }

/**
 * Encode a Stellar G-address as an `xdr.ScVal` of type `address`.
 * Soroban contract functions that accept an `Address` parameter require
 * this encoding — passing a raw string will cause a type mismatch error.
 *
 * @param address - A valid Stellar G-address string.
 */
export function addressToScVal(address: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(address), { type: 'address' })
}

/**
 * Encode a `bigint` amount as an `xdr.ScVal` of type `i128`.
 * Token amounts in Soroban use `i128` to support values larger than `u64` max.
 * All energy token amounts are expressed in stroops (1 kWh = 10^7 stroops).
 *
 * @param amount - Amount in stroops as a `bigint`.
 */
export function amountToScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: 'i128' })
}

/**
 * Encode a `Uint8Array` as an `xdr.ScVal` of type `bytes`.
 * Used to pass the 32-byte SHA-256 reading hash to `audit_registry.anchor()`.
 *
 * @param bytes - Raw byte array (e.g. a SHA-256 digest).
 */
export function bytesToScVal(bytes: Uint8Array): xdr.ScVal {
  return nativeToScVal(bytes, { type: 'bytes' })
}

/**
 * Convert kilowatt-hours to token units (stroops).
 *
 * SolarProof uses a fixed scale of 1 kWh = 10^7 stroops, matching the
 * SEP-41 `decimals = 7` setting. This allows fractional kWh values down to
 * 0.0000001 kWh to be represented as integers on-chain.
 *
 * `Math.round` is applied before converting to `bigint` to avoid floating-
 * point truncation errors (e.g. 0.1 kWh → 99 instead of 100).
 *
 * @param kwh - Energy amount in kilowatt-hours (may be fractional).
 * @returns Equivalent amount in stroops as a `bigint`.
 */
export const kwhToStroops = (kwh: number): bigint => BigInt(Math.round(kwh * 1e7))

/**
 * Convert stroops back to kilowatt-hours.
 *
 * @param stroops - Amount in stroops as a `bigint`.
 * @returns Energy amount in kilowatt-hours.
 */
export const stroopsToKwh = (stroops: bigint): number => Number(stroops) / 1e7

/** Build a stellar.expert deep link for a transaction or contract address. */
export function stellarExplorerUrl(
  type: 'tx' | 'contract',
  id: string,
  network: NetworkName = 'testnet'
): string {
  const net = network === 'mainnet' ? 'public' : 'testnet'
  const path = type === 'tx' ? 'tx' : 'contract'
  return `https://stellar.expert/explorer/${net}/${path}/${id}`
}
