/**
 * Fuzz test for Ed25519 signature verification path — Issue #106
 *
 * Ensures that `verifyReadingSignature` (backed by @noble/ed25519) never
 * throws an unhandled exception and always returns a boolean when fed
 * random / malformed inputs.
 *
 * Acceptance criteria:
 *  ✓ Fuzz test generates random signature bytes, public keys, and messages
 *  ✓ Verification function never throws unhandled exception
 *  ✓ Always returns true/false deterministically
 *  ✓ 10,000 iterations minimum
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { verifyReadingSignature, computeReadingHash } from '@/lib/crypto'
import { kwhToStroops } from '@solarproof/stellar'

const ITERATIONS = 10_000

/** Produce a random Uint8Array of exactly `len` bytes. */
function randomBytes(len: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len))
}

/** Produce a random hex string of exactly `byteLen` bytes (2*byteLen chars). */
function randomHex(byteLen: number): string {
  return Buffer.from(randomBytes(byteLen)).toString('hex')
}

/**
 * Return a random hex string with an arbitrary byte length in [0, maxBytes].
 * This deliberately includes lengths that are *not* valid for Ed25519
 * (signature must be 64 bytes, public key must be 32 bytes).
 */
function randomMalformedHex(maxBytes = 128): string {
  const len = Math.floor(Math.random() * (maxBytes + 1))
  return Buffer.from(randomBytes(len)).toString('hex')
}

describe('Fuzz: Ed25519 signature verification (issue #106)', () => {
  it(`never throws over ${ITERATIONS} iterations with fully random inputs`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      // Completely random bytes — none of these are valid Ed25519 inputs.
      const sigHex = randomMalformedHex(128)      // 0–128 random bytes
      const pubkeyHex = randomMalformedHex(64)    // 0–64 random bytes
      const hash = Buffer.from(randomBytes(32))   // fixed 32-byte hash

      let result: boolean
      try {
        result = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      } catch (err) {
        throw new Error(
          `verifyReadingSignature threw on iteration ${i}: ${String(err)}\n` +
          `  sigHex    = ${sigHex.slice(0, 32)}…\n` +
          `  pubkeyHex = ${pubkeyHex.slice(0, 32)}…`
        )
      }

      // Must be a boolean
      expect(typeof result).toBe('boolean')
      // Random inputs virtually never produce a valid signature — it must be false
      expect(result).toBe(false)
    }
  }, 120_000) // generous timeout — 10 k async verify calls

  it(`never throws over ${ITERATIONS} iterations with correct-length random inputs`, async () => {
    // Use correct byte lengths (sig=64, pubkey=32) but still random content.
    for (let i = 0; i < ITERATIONS; i++) {
      const sigHex = randomHex(64)     // correct Ed25519 signature size
      const pubkeyHex = randomHex(32)  // correct Ed25519 public key size
      const hash = Buffer.from(randomBytes(32))

      let result: boolean
      try {
        result = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      } catch (err) {
        throw new Error(
          `verifyReadingSignature threw (correct lengths) on iteration ${i}: ${String(err)}`
        )
      }

      expect(typeof result).toBe('boolean')
    }
  }, 120_000)

  it('always returns deterministically for the same inputs', async () => {
    // Pick a fixed set of random inputs and verify that repeated calls
    // return the same result (i.e., no non-determinism or side-effects).
    const SAMPLES = 100
    const fixtures: Array<{ sigHex: string; pubkeyHex: string; hash: Buffer }> = []

    for (let i = 0; i < SAMPLES; i++) {
      fixtures.push({
        sigHex: randomMalformedHex(128),
        pubkeyHex: randomMalformedHex(64),
        hash: Buffer.from(randomBytes(32)),
      })
    }

    for (const { sigHex, pubkeyHex, hash } of fixtures) {
      const first = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      const second = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      expect(first).toBe(second)
    }
  }, 30_000)

  it('handles empty strings and zero-length inputs without throwing', async () => {
    const hash = Buffer.from(randomBytes(32))
    const cases = [
      { sigHex: '', pubkeyHex: '' },
      { sigHex: '', pubkeyHex: randomHex(32) },
      { sigHex: randomHex(64), pubkeyHex: '' },
      { sigHex: '00', pubkeyHex: '00' },
    ]

    for (const { sigHex, pubkeyHex } of cases) {
      let result: boolean
      try {
        result = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      } catch (err) {
        throw new Error(
          `verifyReadingSignature threw on edge-case input: ${String(err)}\n` +
          `  sigHex="${sigHex}" pubkeyHex="${pubkeyHex}"`
        )
      }
      expect(typeof result).toBe('boolean')
      expect(result).toBe(false)
    }
  })

  it('handles non-hex characters in inputs without throwing', async () => {
    const hash = Buffer.from(randomBytes(32))
    const nonHexCases = [
      { sigHex: 'gggggggg'.repeat(16), pubkeyHex: randomHex(32) },
      { sigHex: randomHex(64), pubkeyHex: 'zzzzzzzz'.repeat(8) },
      { sigHex: '!@#$%^&*'.repeat(16), pubkeyHex: randomHex(32) },
      { sigHex: 'null', pubkeyHex: 'undefined' },
    ]

    for (const { sigHex, pubkeyHex } of nonHexCases) {
      let result: boolean
      try {
        result = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      } catch (err) {
        throw new Error(
          `verifyReadingSignature threw on non-hex input: ${String(err)}`
        )
      }
      expect(typeof result).toBe('boolean')
      expect(result).toBe(false)
    }
  })

  it('fuzz the message/hash field alongside random keys', async () => {
    // Some implementations behave differently with unusual message lengths.
    for (let i = 0; i < 1_000; i++) {
      const sigHex = randomHex(64)
      const pubkeyHex = randomHex(32)
      // Vary the hash length (normally fixed at 32 bytes, but be adversarial)
      const hashLen = [0, 1, 16, 31, 32, 33, 64, 128][i % 8]
      const hash = Buffer.from(randomBytes(hashLen))

      let result: boolean
      try {
        result = await verifyReadingSignature(sigHex, hash, pubkeyHex)
      } catch (err) {
        throw new Error(
          `verifyReadingSignature threw on variable-hash-length input (len=${hashLen}) on iteration ${i}: ${String(err)}`
        )
      }
      expect(typeof result).toBe('boolean')
    }
  }, 60_000)

  it('correctly identifies valid signatures amid fuzz noise', async () => {
    // Sanity check: a real valid signature must still verify as true.
    const { getPublicKey, sign } = await import('@noble/ed25519')
    const privKey = randomBytes(32)
    const pubKey = await getPublicKey(privKey)
    const meterId = 'fuzz-sanity-meter'
    const hash = computeReadingHash(meterId, kwhToStroops(7.5), BigInt(1_700_000_000))
    const sig = await sign(hash, privKey)

    const result = await verifyReadingSignature(
      Buffer.from(sig).toString('hex'),
      hash,
      Buffer.from(pubKey).toString('hex')
    )
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property-based fuzz tests (fast-check) — Issue #754
//
// Generates arbitrary (meterId, kwh, timestamp) inputs and verifies:
//  ✓ computeReadingHash never throws for valid input types
//  ✓ computeReadingHash always returns a 32-byte Buffer
//  ✓ signing the hash then verifying returns true
//  ✓ tampering with any field or the signature causes verification to fail
// ---------------------------------------------------------------------------

/** Arbitrary meter IDs: reasonable length, including unicode. */
const meterIdArb = fc.string({ minLength: 0, maxLength: 128 })

/** Arbitrary finite, positive kWh values. */
const kwhArb = fc.double({
  min: Number.MIN_VALUE,
  max: 1e12,
  noNaN: true,
  noDefaultInfinity: true,
})

/** Arbitrary int64-safe timestamps (seconds). */
const timestampArb = fc.bigInt({
  min: BigInt('-9223372036854775808'),
  max: BigInt('9223372036854775807'),
})

/** Arbitrary positive integer stroop amounts (int64-safe). */
const stroopsArb = fc.bigInt({
  min: BigInt(0),
  max: BigInt('9223372036854775807'),
})

describe('Fuzz: computeReadingHash (fast-check, issue #754)', () => {
  it('never throws and always returns a 32-byte Buffer for valid inputs', () => {
    fc.assert(
      fc.property(meterIdArb, kwhArb, timestampArb, (meterId, kwh, timestamp) => {
        const stroops = kwhToStroops(kwh)
        const hash = computeReadingHash(meterId, stroops, timestamp)
        expect(Buffer.isBuffer(hash)).toBe(true)
        expect(hash.length).toBe(32)
      }),
      { numRuns: 1_000 }
    )
  })

  it('never throws for arbitrary integer stroop amounts', () => {
    fc.assert(
      fc.property(meterIdArb, stroopsArb, timestampArb, (meterId, stroops, timestamp) => {
        const hash = computeReadingHash(meterId, stroops, timestamp)
        expect(Buffer.isBuffer(hash)).toBe(true)
        expect(hash.length).toBe(32)
      }),
      { numRuns: 1_000 }
    )
  })

  it('is deterministic for identical inputs', () => {
    fc.assert(
      fc.property(meterIdArb, kwhArb, timestampArb, (meterId, kwh, timestamp) => {
        const stroops = kwhToStroops(kwh)
        const a = computeReadingHash(meterId, stroops, timestamp)
        const b = computeReadingHash(meterId, stroops, timestamp)
        expect(a.equals(b)).toBe(true)
      }),
      { numRuns: 500 }
    )
  })
})

describe('Fuzz: sign/verify round-trip (fast-check, issue #754)', () => {
  it('verifies signatures produced by signing the computed hash', async () => {
    const { getPublicKey, sign } = await import('@noble/ed25519')

    await fc.assert(
      fc.asyncProperty(
        meterIdArb,
        kwhArb,
        timestampArb,
        async (meterId, kwh, timestamp) => {
          const privKey = randomBytes(32)
          const pubKey = await getPublicKey(privKey)
          const hash = computeReadingHash(meterId, kwhToStroops(kwh), timestamp)
          const sig = await sign(hash, privKey)

          const ok = await verifyReadingSignature(
            Buffer.from(sig).toString('hex'),
            hash,
            Buffer.from(pubKey).toString('hex')
          )
          expect(ok).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  }, 120_000)

  it('rejects verification when the signature is tampered with', async () => {
    const { getPublicKey, sign } = await import('@noble/ed25519')

    await fc.assert(
      fc.asyncProperty(
        meterIdArb,
        kwhArb,
        timestampArb,
        async (meterId, kwh, timestamp) => {
          const privKey = randomBytes(32)
          const pubKey = await getPublicKey(privKey)
          const hash = computeReadingHash(meterId, kwhToStroops(kwh), timestamp)
          const sig = await sign(hash, privKey)

          // Flip one bit in the signature.
          const tampered = Uint8Array.from(sig)
          const bitIndex = Math.floor(Math.random() * (tampered.length * 8))
          tampered[bitIndex >> 3] ^= 1 << (bitIndex & 7)

          const ok = await verifyReadingSignature(
            Buffer.from(tampered).toString('hex'),
            hash,
            Buffer.from(pubKey).toString('hex')
          )
          expect(ok).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  }, 120_000)

  it('rejects verification when any reading field is tampered with', async () => {
    const { getPublicKey, sign } = await import('@noble/ed25519')

    await fc.assert(
      fc.asyncProperty(
        meterIdArb,
        kwhArb,
        timestampArb,
        fc.constantFrom('meterId', 'kwh', 'timestamp'),
        async (meterId, kwh, timestamp, field) => {
          const privKey = randomBytes(32)
          const pubKey = await getPublicKey(privKey)
          const stroops = kwhToStroops(kwh)
          const hash = computeReadingHash(meterId, stroops, timestamp)
          const sig = await sign(hash, privKey)

          // Recompute the hash with one field mutated.
          let tamperedHash: Buffer
          if (field === 'meterId') {
            tamperedHash = computeReadingHash(`${meterId}x`, stroops, timestamp)
          } else if (field === 'kwh') {
            tamperedHash = computeReadingHash(meterId, stroops + BigInt(1), timestamp)
          } else {
            tamperedHash = computeReadingHash(meterId, stroops, timestamp + BigInt(1))
          }

          // Only meaningful if the tampered hash actually differs.
          fc.pre(!tamperedHash.equals(hash))

          const ok = await verifyReadingSignature(
            Buffer.from(sig).toString('hex'),
            tamperedHash,
            Buffer.from(pubKey).toString('hex')
          )
          expect(ok).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  }, 120_000)
})
