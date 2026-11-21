import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('getCorsHeaders', () => {
  const PROD_ORIGIN = 'https://solarproof.vercel.app'
  const DEV_ORIGIN = 'http://localhost:3000'
  const UNKNOWN_ORIGIN = 'https://evil.example.com'

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null for a null origin', async () => {
    const { getCorsHeaders } = await import('./cors')
    expect(getCorsHeaders(null)).toBeNull()
  })

  it('returns null for an unknown origin', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(getCorsHeaders(UNKNOWN_ORIGIN)).toBeNull()
  })

  it('allows a configured production origin', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    const headers = getCorsHeaders(PROD_ORIGIN)
    expect(headers).not.toBeNull()
    expect(headers!['Access-Control-Allow-Origin']).toBe(PROD_ORIGIN)
    expect(headers!['Access-Control-Allow-Credentials']).toBe('true')
    expect(headers!['Vary']).toBe('Origin')
  })

  it('allows localhost in development even without explicit config', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '')
    vi.stubEnv('NODE_ENV', 'development')
    const { getCorsHeaders } = await import('./cors')
    const headers = getCorsHeaders(DEV_ORIGIN)
    expect(headers).not.toBeNull()
    expect(headers!['Access-Control-Allow-Origin']).toBe(DEV_ORIGIN)
  })

  it('blocks localhost in production when not explicitly configured', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(getCorsHeaders(DEV_ORIGIN)).toBeNull()
  })

  it('allows multiple configured origins', async () => {
    const origins = `${PROD_ORIGIN},https://staging.solarproof.vercel.app`
    vi.stubEnv('CORS_ALLOWED_ORIGINS', origins)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(getCorsHeaders('https://staging.solarproof.vercel.app')).not.toBeNull()
    expect(getCorsHeaders(PROD_ORIGIN)).not.toBeNull()
  })

  it('includes allowed methods and headers', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    const headers = getCorsHeaders(PROD_ORIGIN)!
    expect(headers['Access-Control-Allow-Methods']).toContain('POST')
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization')
  })

  it('rejects a wildcard origin in production', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '*')
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(() => getCorsHeaders(PROD_ORIGIN)).toThrow()
  })

  it('rejects a wildcard mixed with other origins in production', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', `${PROD_ORIGIN},*`)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(() => getCorsHeaders(PROD_ORIGIN)).toThrow()
  })

  it('applies the default allowlist when the env var is unset in production', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '')
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(getCorsHeaders(PROD_ORIGIN)).not.toBeNull()
    expect(getCorsHeaders('https://staging.solarproof.vercel.app')).not.toBeNull()
    expect(getCorsHeaders(UNKNOWN_ORIGIN)).toBeNull()
    expect(getCorsHeaders(DEV_ORIGIN)).toBeNull()
  })

  it('rejects invalid origin strings in production', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'not-a-valid-origin')
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(() => getCorsHeaders(PROD_ORIGIN)).toThrow()
  })

  it('rejects origins with a path or trailing slash in production', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', `${PROD_ORIGIN}/api`)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    expect(() => getCorsHeaders(PROD_ORIGIN)).toThrow()
  })

  it('tolerates a wildcard in development', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '*')
    vi.stubEnv('NODE_ENV', 'development')
    const { getCorsHeaders } = await import('./cors')
    expect(() => getCorsHeaders(DEV_ORIGIN)).not.toThrow()
    expect(getCorsHeaders(DEV_ORIGIN)).not.toBeNull()
  })

  it('sets credentials mode on allowed origins', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    const headers = getCorsHeaders(PROD_ORIGIN)!
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('exposes the expected allowed methods', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    const methods = getCorsHeaders(PROD_ORIGIN)!['Access-Control-Allow-Methods']
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(method)
    }
  })

  it('exposes the expected allowed headers', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { getCorsHeaders } = await import('./cors')
    const headers = getCorsHeaders(PROD_ORIGIN)!
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type')
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization')
  })
})

describe('CORS middleware', () => {
  const PROD_ORIGIN = 'https://solarproof.vercel.app'
  const UNKNOWN_ORIGIN = 'https://evil.example.com'

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function makeRequest(method: string, origin: string | null): Request {
    const headers = new Headers()
    if (origin !== null) headers.set('origin', origin)
    return new Request('https://api.solarproof.vercel.app/api/analyze', {
      method,
      headers,
    })
  }

  it('answers preflight OPTIONS with the correct allowed methods', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    const response = handleCors(makeRequest('OPTIONS', PROD_ORIGIN))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(204)
    expect(response!.headers.get('Access-Control-Allow-Origin')).toBe(PROD_ORIGIN)
    const methods = response!.headers.get('Access-Control-Allow-Methods') ?? ''
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(method)
    }
    expect(response!.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('sets credentials header on preflight responses', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    const response = handleCors(makeRequest('OPTIONS', PROD_ORIGIN))
    expect(response!.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('returns 403 for an unlisted origin', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    const response = handleCors(makeRequest('GET', UNKNOWN_ORIGIN))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(403)
  })

  it('returns 403 for an unlisted origin on preflight', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    const response = handleCors(makeRequest('OPTIONS', UNKNOWN_ORIGIN))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(403)
  })

  it('passes through requests without an origin', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    expect(handleCors(makeRequest('GET', null))).toBeNull()
  })

  it('passes through allowed non-preflight requests', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', PROD_ORIGIN)
    vi.stubEnv('NODE_ENV', 'production')
    const { handleCors } = await import('./cors')
    expect(handleCors(makeRequest('POST', PROD_ORIGIN))).toBeNull()
  })
})
