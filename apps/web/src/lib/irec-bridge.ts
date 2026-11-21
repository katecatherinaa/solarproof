import { logger } from '@/lib/logger'

export interface IRecRetirementPayload {
  beneficiary: string
  volumeWh: number
  vintageStart: string
  vintageEnd: string
  notes: string
  /**
   * Certificate validity period start (ISO 8601). Optional.
   * Forwarded to the I-REC registry so it can validate the certificate
   * is still within its validity window at retirement time.
   */
  validityStart?: string
  /**
   * Certificate validity period end / expiry (ISO 8601). Optional.
   * Forwarded to the I-REC registry so it can reject retirements of
   * expired certificates.
   */
  validityEnd?: string
}

/**
 * Proof of Concept API Adapter for I-REC Registry.
 * 
 * In a full integration, this would authenticate via OAuth 2.0 
 * and POST to the I-REC registry's retirement endpoint.
 */
export async function triggerIRecRetirement(payload: IRecRetirementPayload, correlationId?: string): Promise<boolean> {
  const log = correlationId ? logger.withCorrelationId(correlationId) : logger

  log.info('irec.bridge.retirement_initiated', { payload })

  try {
    // Simulated API call to I-REC Registry
    // const response = await fetch('https://api.irec.example.com/v1/retirements', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     beneficiary: payload.beneficiary,
    //     volumeWh: payload.volumeWh,
    //     vintage: { start: payload.vintageStart, end: payload.vintageEnd },
    //     validity: { start: payload.validityStart, end: payload.validityEnd },
    //     notes: payload.notes,
    //   }),
    // })
    // if (!response.ok) throw new Error('I-REC API failed')
    
    // Simulating delay
    await new Promise(resolve => setTimeout(resolve, 500))

    log.info('irec.bridge.retirement_success', {
      beneficiary: payload.beneficiary,
      volumeWh: payload.volumeWh,
      validityStart: payload.validityStart,
      validityEnd: payload.validityEnd,
    })
    return true
  } catch (error) {
    log.error('irec.bridge.retirement_failed', { error: error instanceof Error ? error.message : 'Unknown error' })
    return false
  }
}

export interface EvmNftConfig {
  /** ERC-721 contract address on the EVM chain (e.g. Polygon mainnet). */
  contractAddress: string
  /** Chain ID of the target EVM network (e.g. 137 for Polygon mainnet). */
  chainId: number
  /** RPC endpoint used to submit the mint transaction. */
  rpcUrl: string
  /** Private key / signer reference used by the bridge to sign the mint tx. */
  signerKey?: string
}

export interface EvmMintParams {
  certificateId: string
  /** Cooperative-level opt-in flag. */
  evmNftEnabled: boolean
  /** EVM configuration; may be absent if not configured for the cooperative. */
  evmConfig?: EvmNftConfig | null
  /** Existing EVM token id, if the certificate was already minted (idempotency). */
  evmTokenId?: string | number | null
  /** Public host used to build the metadata URI (e.g. https://app.example.com). */
  host: string
  /** Recipient address for the NFT. */
  recipient?: string
  correlationId?: string
}

export interface EvmMintResult {
  minted: boolean
  skipped: boolean
  tokenId?: string
  tokenUri?: string
  reason?: string
}

/**
 * Builds the metadata URI pointing to the certificate verification page.
 */
export function buildEvmTokenUri(host: string, certificateId: string): string {
  const normalizedHost = host.replace(/\/+$/, '')
  return `${normalizedHost}/verify/${encodeURIComponent(certificateId)}`
}

/**
 * Optionally mints an ERC-721 NFT on an EVM chain (e.g. Polygon) for a certificate.
 *
 * This is called after a successful Stellar mint. It is:
 *  - opt-in per cooperative (evmNftEnabled)
 *  - idempotent (skips if evmTokenId is already set)
 *  - non-fatal (failures are logged and never fail the Stellar issuance)
 */
export async function mintEvmNft(params: EvmMintParams): Promise<EvmMintResult> {
  const { certificateId, evmNftEnabled, evmConfig, evmTokenId, host, recipient } = params
  const log = params.correlationId ? logger.withCorrelationId(params.correlationId) : logger

  // Opt-in check
  if (!evmNftEnabled) {
    return { minted: false, skipped: true, reason: 'evm_nft_disabled' }
  }

  // Idempotency: already minted
  if (evmTokenId !== undefined && evmTokenId !== null && evmTokenId !== '') {
    log.info('evm.bridge.mint_skipped_already_minted', { certificateId, evmTokenId })
    return { minted: false, skipped: true, reason: 'already_minted', tokenId: String(evmTokenId) }
  }

  // Config presence check
  if (!evmConfig || !evmConfig.contractAddress || !evmConfig.rpcUrl) {
    log.warn('evm.bridge.mint_skipped_no_config', { certificateId })
    return { minted: false, skipped: true, reason: 'evm_config_missing' }
  }

  const tokenUri = buildEvmTokenUri(host, certificateId)

  log.info('evm.bridge.mint_initiated', {
    certificateId,
    chainId: evmConfig.chainId,
    contractAddress: evmConfig.contractAddress,
    tokenUri,
    recipient,
  })

  try {
    // In a full integration this would use an EVM client (e.g. viem/ethers) to
    // call the ERC-721 `safeMint(address to, string tokenURI)` method on the
    // configured contract and await the transaction receipt.
    //
    // const client = createWalletClient({ chain, transport: http(evmConfig.rpcUrl) })
    // const hash = await client.writeContract({
    //   address: evmConfig.contractAddress,
    //   abi: ERC721_MINT_ABI,
    //   functionName: 'safeMint',
    //   args: [recipient, tokenUri],
    // })
    // const receipt = await publicClient.waitForTransactionReceipt({ hash })
    // const tokenId = parseMintEvent(receipt)

    // Simulated mint
    await new Promise(resolve => setTimeout(resolve, 300))
    const tokenId = `evm-${certificateId}`

    log.info('evm.bridge.mint_success', {
      certificateId,
      tokenId,
      tokenUri,
      chainId: evmConfig.chainId,
    })

    return { minted: true, skipped: false, tokenId, tokenUri }
  } catch (error) {
    // Never fail the Stellar issuance because of an EVM mint failure.
    log.error('evm.bridge.mint_failed', {
      certificateId,
      chainId: evmConfig.chainId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return {
      minted: false,
      skipped: false,
      reason: error instanceof Error ? error.message : 'unknown_error',
      tokenUri,
    }
  }
}