/**
 * CORS policy for SolarProof API routes.
 *
 * Allowed origins are controlled by the CORS_ALLOWED_ORIGINS environment
 * variable (comma-separated list). When unset, an explicit default allowlist
 * is used. In development, http://localhost:3000 is always permitted.
 * Credentials mode is enabled so the browser sends cookies.
 *
 * In production, wildcard origins (`*` or entries containing `*`) are
 * rejected at startup with a clear error. Each configured entry must be a
 * well-formed origin URL (scheme + host, no path/query/fragment).
 */

const DEV_ORIGINS = ['http://localhost:3000']

/** Explicit default allowlist used when CORS_ALLOWED_ORIGINS is unset. */
const DEFAULT_ORIGINS = [
  'https://solarproof.vercel.app',
  'https://staging.solarproof.vercel.app',
]

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Correlation-Id',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
} as const

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/** Validate that a single entry is a well-formed origin URL. */
function isValidOrigin(entry: string): boolean {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return false
  }
  // Origin must be scheme + host only (no path, query, or fragment).
  if (url.pathname !== '/' && url.pathname !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (!url.protocol || !url.host) return false
  // Reconstruct the canonical origin and require an exact match so that
  // entries like "https://example.com/" are normalized consistently.
  return url.origin === entry || `${url.origin}/` === entry
}

/**
 * Parse and validate the CORS_ALLOWED_ORIGINS env var into a Set of allowed
 * origins. Throws in production if any entry is a wildcard or malformed.
 */
export function getAllowedOrigins(): Set<string> {
  const raw = process.env.CORS_ALLOWED_ORIGINS
  const production = isProduction()

  let configured: string[]
  if (raw === undefined || raw.trim() === '') {
    configured = [...DEFAULT_ORIGINS]
  } else {
    configured = raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  }

  const origins: string[] = []
  for (const entry of configured) {
    if (entry === '*' || entry.includes('*')) {
      if (production) {
        throw new Error(
          `Invalid CORS_ALLOWED_ORIGINS: wildcard origin "${entry}" is not permitted in production. ` +
            'Enumerate explicit origins instead.',
        )
      }
      // In non-production, skip wildcard entries rather than allowing them.
      continue
    }
    if (!isValidOrigin(entry)) {
      if (production) {
        throw new Error(
          `Invalid CORS_ALLOWED_ORIGINS: "${entry}" is not a well-formed origin URL.`,
        )
      }
      continue
    }
    origins.push(entry)
  }

  if (!production) {
    origins.push(...DEV_ORIGINS)
  }

  return new Set(origins)
}

/**
 * Validate the CORS configuration at startup. Throws if the configuration is
 * invalid for the current environment. Returns the resolved allowlist.
 */
export function validateCorsOrigins(): Set<string> {
  return getAllowedOrigins()
}

/**
 * Return CORS response headers for the given request origin.
 * Returns null if the origin is not allowed.
 */
export function getCorsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin) return null
  const allowed = getAllowedOrigins()
  if (!allowed.has(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    ...CORS_HEADERS,
  }
}