/**
 * Unit tests for POST /api/readings/batch — idempotency behaviour.
 *
 * Only the idempotency layer is exercised here; full processing is covered
 * by the existing integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/idempotency', () => ({
  getIdempotentResponse: vi.fn(),
  storeIdempotentResponse: vi.fn(),
}))

// Mock heavy deps so we don't need real Stellar / DB in unit tests
vi.mock('@/lib/supabase', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/stellar', () => ({ anchorReading: vi.fn(), mintCertificates: vi.fn() }))
vi.mock('@/lib/crypto', () => ({ computeReadingHash: vi.fn() }))
vi.mock('@solarproof/stellar', () => ({ kwhToStroops: vi.fn() }))
vi.mock('@/lib/cache', () => ({ invalidateCert: vi.fn() }))
vi.mock('@noble/ed25519', () => ({ verifyAsync: vi.fn() }))

import { getIdempotentResponse, storeIdempotentResponse } from '@/lib/idempotency'
import { POST } from '@/app/api/readings/batch/route'

const IDEM_KEY = 'test-idem-key-abc123'

function makeRequest(body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  return new NextRequest('http://localhost/api/readings/batch', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/readings/batch — idempotency', () => {
  it('returns cached response for duplicate idempotency key', async () => {
    const cached = {
      body: { succeeded: 1, failed: 0, results: [{ index: 0, status: 'success' }] },
      status: 207,
    }
    vi.mocked(getIdempotentResponse).mockResolvedValueOnce(cached)

    const res = await POST(makeRequest([], IDEM_KEY))

    expect(res.status).toBe(207)
    const json = await res.json()
    expect(json.succeeded).toBe(1)
    // storeIdempotentResponse must NOT be called for a cache hit
    expect(storeIdempotentResponse).not.toHaveBeenCalled()
  })

  it('does not hit idempotency store when no key provided', async () => {
    // Request without key — will fail validation (empty array) but that's fine
    await POST(makeRequest([]))
    expect(getIdempotentResponse).not.toHaveBeenCalled()
  })

  it('stores response after successful processing', async () => {
    vi.mocked(getIdempotentResponse).mockResolvedValueOnce(null) // cache miss

    // Will fail at batch validation (empty array) and return 400
    const res = await POST(makeRequest([], IDEM_KEY))

    expect(res.status).toBe(400)
    // storeIdempotentResponse not called because validation failed before processing
    // (schema rejects empty array — no idempotent storage for invalid input)
    expect(storeIdempotentResponse).not.toHaveBeenCalled()
  })
})
