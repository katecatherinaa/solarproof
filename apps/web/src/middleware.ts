import { NextRequest, NextResponse } from 'next/server'
import { getCorsHeaders } from '@/lib/cors'
import { checkCsrf } from '@/lib/csrf'

export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'pt-BR', 'ar'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]

/** API routes that are exempt from CSRF validation (machine-to-machine, no browser session). */
const CSRF_EXEMPT_PATHS = [
  '/api/readings',       // Ed25519-signed meter submissions — no browser session
  '/api/v1/readings',
  '/api/webhooks',       // Inbound webhook callbacks from external services
  '/api/v1/webhooks',
  '/api/csrf',           // Token issuance endpoint itself
]

function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/**
 * Generates a cryptographically random, base64-encoded nonce suitable for use
 * in a Content-Security-Policy `nonce-{value}` source expression.
 */
function generateCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Builds the Content-Security-Policy header value for a given nonce.
 * Inline scripts are allowed only via the per-request nonce; 'unsafe-inline'
 * is intentionally omitted from script-src. style-src retains 'unsafe-inline'
 * because Next.js injects inline styles that are not nonce-aware.
 */
function buildCspHeader(nonce: string): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://js.sentry-cdn.com https://browser.sentry-cdn.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    'report-uri /api/csp-report',
  ]
  return directives.join('; ')
}

/** Methods that carry a request body and must declare a JSON Content-Type. */
const JSON_BODY_METHODS = ['POST', 'PUT', 'PATCH']

/**
 * Returns true when the request's Content-Type is acceptable for a JSON endpoint.
 * Accepts `application/json` with optional parameters (e.g. `; charset=utf-8`).
 * Multipart requests (file uploads) are always allowed through.
 */
function hasAcceptableContentType(req: NextRequest): boolean {
  const contentType = req.headers.get('content-type')
  if (!contentType) return false

  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  if (mediaType === 'multipart/form-data') return true
  return mediaType === 'application/json'
}

/**
 * Middleware that:
 * 1. Enforces CORS policy — restricts origins to CORS_ALLOWED_ORIGINS + localhost in dev.
 * 2. Handles OPTIONS preflight requests.
 * 3. Enforces CSRF token validation on all non-GET browser-facing API routes.
 * 4. Rejects POST/PUT/PATCH /api/** requests without a JSON Content-Type (415).
 * 5. Injects a correlation ID into every API request.
 * 6. Redirects unversioned /api/* routes to /api/v1/* with a deprecation header.
 *
 * Content-Type enforcement:
 *   - POST/PUT/PATCH requests to /api/** must send `Content-Type: application/json`
 *     (parameters such as `; charset=utf-8` are allowed).
 *   - `multipart/form-data` requests (file uploads) are passed through.
 *   - GET/HEAD/OPTIONS/DELETE requests are unaffected.
 *   - Missing or incorrect Content-Type returns HTTP 415 Unsupported Media Type.
 *
 * CSRF enforcement (double-submit cookie pattern):
 *   - All POST/PUT/PATCH/DELETE /api/** routes require a valid X-CSRF-Token header
 *     that matches the csrf_token cookie value.
 *   - Machine-to-machine routes (readings, webhooks) are exempt — they use
 *     Ed25519 signatures or HMAC webhook secrets instead.
 *   - Obtain a token via GET /api/csrf before submitting.
 *   - Missing or invalid token returns HTTP 403.
 *
 * Correlation ID:
 *   - Reads `X-Correlation-Id` from the incoming request if present.
 *   - Otherwise generates a new UUID v4.
 *   - Forwards the ID in the `X-Correlation-Id` response header.
 *
 * API versioning:
 *   - Requests to /api/<route> (not already /api/v1/) are redirected to
 *     /api/v1/<route> with a 308 Permanent Redirect and a Deprecation header.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const origin = req.headers.get('origin')
  const corsHeaders = getCorsHeaders(origin)

  // ── HTTPS redirect ────────────────────────────────────────────────────────
  // In production, redirect plain HTTP to HTTPS with a 301 permanent redirect.
  // Vercel/CDN handles this at the edge, but the middleware acts as a safety net.
  if (
    process.env.NODE_ENV === 'production' &&
    req.headers.get('x-forwarded-proto') === 'http'
  ) {
    const httpsUrl = req.nextUrl.clone()
    httpsUrl.protocol = 'https:'
    return NextResponse.redirect(httpsUrl, { status: 301 })
  }

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    if (corsHeaders) {
      return new NextResponse(null, { status: 204, headers: corsHeaders })
    }
    // Origin not allowed — return 403
    return new NextResponse(null, { status: 403 })
  }

  // ── Content-Type validation ──────────────────────────────────────────────
  // Reject state-mutating API requests that do not declare a JSON body.
  // This blocks CSRF via HTML form submission (which sends
  // application/x-www-form-urlencoded or multipart/form-data) when CSRF
  // protections have gaps. Multipart uploads and GET/HEAD/OPTIONS/DELETE
  // requests are unaffected.
  if (
    pathname.startsWith('/api/') &&
    JSON_BODY_METHODS.includes(req.method) &&
    !hasAcceptableContentType(req)
  ) {
    const corr = req.headers.get('x-correlation-id') ?? crypto.randomUUID()
    const unsupported = NextResponse.json(
      { error: 'Unsupported Media Type', message: 'Content-Type must be application/json' },
      { status: 415 },
    )
    unsupported.headers.set('x-correlation-id', corr)
    if (corsHeaders) {
      for (const [k, v] of Object.entries(corsHeaders)) {
        unsupported.headers.set(k, v)
      }
    }
    return unsupported
  }

  // ── CSRF enforcement ─────────────────────────────────────────────────────
  // Validate CSRF token for all state-mutating API requests that originate
  // from a browser session. Machine-to-machine routes are exempted.
  if (pathname.startsWith('/api/') && !isCsrfExempt(pathname)) {
    const csrfError = checkCsrf(req)
    if (csrfError) {
      // Attach correlation ID to CSRF error responses too
      const corr = req.headers.get('x-correlation-id') ?? crypto.randomUUID()
      csrfError.headers.set('x-correlation-id', corr)
      return csrfError
    }
  }

  // ── API versioning redirect ───────────────────────────────────────────────
  // Match /api/<segment> but NOT /api/v1/... or /api/docs or /api/admin
  const unversioned = pathname.match(/^\/api\/(?!v\d+\/|admin\/)(.+)$/)
  if (unversioned) {
    const url = req.nextUrl.clone()
    url.pathname = `/api/v1/${unversioned[1]}`
    const redirect = NextResponse.redirect(url, { status: 301 })
    redirect.headers.set('Deprecation', 'true')
    redirect.headers.set('Link', `<${url.toString()}>; rel="successor-version"`)
    redirect.headers.set('API-Version', 'v1')
    // Propagate correlation ID on the redirect response too
    const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID()
    redirect.headers.set('x-correlation-id', correlationId)
    if (corsHeaders) {
      for (const [k, v] of Object.entries(corsHeaders)) {
        redirect.headers.set(k, v)
      }
    }
    return redirect
  }

  // ── Verify endpoint abuse protection ──────────────────────────────────────
  // Rate limit all public verifier paths: /api/verify, /api/verify/[id],
  // /api/v1/verify and /api/v1/verify/[id].
  const isVerifyPath = /^\/api\/(v1\/)?verify(\/|$)/.test(pathname)
  if (isVerifyPath) {
    const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID()
    const clientIp = getClientIp(req)

    // Optional bot detection (Cloudflare Turnstile / hCaptcha) for high-volume use.
    // Only enforced when the corresponding secret is configured.
    if (process.env.TURNSTILE_SECRET_KEY || process.env.HCAPTCHA_SECRET_KEY) {
      const botToken =
        req.headers.get('cf-turnstile-response') ??
        req.headers.get('x-hcaptcha-response')
      if (!botToken) {
        const forbidden = NextResponse.json(
          { error: 'Bot verification required' },
          { status: 403 },
        )
        forbidden.headers.set('x-correlation-id', correlationId)
        if (corsHeaders) {
          for (const [k, v] of Object.entries(corsHeaders)) {
            forbidden.headers.set(k, v)
          }
        }
        return forbidden
      }
    }

    const limit = checkVerifyRateLimit(clientIp)
    if (!limit.allowed) {
      const retryAfter = Math.max(0, Math.ceil((limit.reset - Date.now()) / 1000))
      const tooMany = NextResponse.json(
        { error: 'Too Many Requests', retryAfter },
        { status: 429 },
      )
      tooMany.headers.set('Retry-After', String(retryAfter))
      tooMany.headers.set('X-RateLimit-Limit', String(limit.limit))
      tooMany.headers.set('X-RateLimit-Remaining', String(limit.remaining))
      tooMany.headers.set('X-RateLimit-Reset', String(limit.reset))
      tooMany.headers.set('x-correlation-id', correlationId)
      if (corsHeaders) {
        for (const [k, v] of Object.entries(corsHeaders)) {
          tooMany.headers.set(k, v)
        }
      }
      return tooMany
    }
  }

  // ── Correlation ID injection ──────────────────────────────────────────────
  const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID()

  // ── CSP nonce ─────────────────────────────────────────────────────────────
  // Generate a fresh nonce per request so inline scripts (Next.js hydration,
  // Sentry bootstrap) can be allow-listed without 'unsafe-inline'.
  const cspNonce = generateCspNonce()

  const res = NextResponse.next({
    request: {
      headers: new Headers({
        ...Object.fromEntries(req.headers),
        'x-correlation-id': correlationId,
        'x-csp-nonce': cspNonce,
      }),
    },
  })
  res.headers.set('x-correlation-id', correlationId)
  res.headers.set('API-Version', 'v1')
  res.headers.set('Content-Security-Policy', buildCspHeader(cspNonce))

  // ── Attach CORS headers ───────────────────────────────────────────────────
  if (corsHeaders) {
    for (const [k, v] of Object.entries(corsHeaders)) {
      res.headers.set(k, v)
    }
  }

  return res
}

export const config = {
  matcher: [
    // Run on all routes for HTTPS redirect
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
