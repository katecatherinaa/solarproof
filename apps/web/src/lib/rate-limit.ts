/**
 * In-memory IP-based rate limiter for public API endpoints.
 *
 * Abuse protection rules (documented):
 *   POST /api/readings — 10 requests / 60 s per IP
 *   GET  /api/verify   — 30 requests / 60 s per IP
 *
 * In production, replace the in-memory store with an edge KV store
 * (e.g. Upstash Redis / Vercel KV) so limits are enforced across all
 * serverless instances.
 */

interface Bucket {
  count: number
  resetAt: number
}

const store = new Map<string, Bucket>()

/**
 * Clear all rate-limit buckets. Intended for tests so state does not leak
 * between cases; safe to call at runtime (e.g. on hot reload).
 */
export function resetRateLimitStore(): void {
  store.clear()
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/** Verify endpoint policy for authenticated / verified callers: 30 requests / 60 s per IP. */
export const VERIFY_RATE_LIMIT = {
  limit: 30,
  windowMs: 60_000,
} as const

/** Verify endpoint policy for unverified callers: 5 requests / 60 s per IP. */
export const VERIFY_UNVERIFIED_RATE_LIMIT = {
  limit: 5,
  windowMs: 60_000,
} as const

/**
 * Rate-limit helper for the public verifier (authenticated tier).
 * Uses the key `<ip>:verify:<ip>` so it never collides with other routes.
 */
export function checkVerifyRateLimit(ip: string): RateLimitResult {
  return checkRateLimit(`ip:verify:${ip}`, VERIFY_RATE_LIMIT.limit, VERIFY_RATE_LIMIT.windowMs)
}

/**
 * Rate-limit helper for unverified callers of the public verifier.
 * Uses a distinct key (`ip:verify:unverified:<ip>`) so the stricter
 * unverified tier never collides with the authenticated tier.
 */
export function checkUnverifiedVerifyRateLimit(ip: string): RateLimitResult {
  return checkRateLimit(
    `ip:verify:unverified:${ip}`,
    VERIFY_UNVERIFIED_RATE_LIMIT.limit,
    VERIFY_UNVERIFIED_RATE_LIMIT.windowMs,
  )
}

/**
 * Returns true when the request carries a valid internal admin token,
 * allowing verification (bot challenge + rate limit) to be bypassed for
 * trusted service-to-service calls.
 */
export function hasAdminToken(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) return false

  const headers = req instanceof Request ? req.headers : (req as { headers: Headers }).headers
  const auth = headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
  const provided = bearer ?? headers.get('x-admin-token') ?? undefined

  if (!provided || provided.length !== expected.length) return false

  // Constant-time comparison to avoid leaking the token via timing.
  let mismatch = 0
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Applies the appropriate verify rate-limit tier for a request.
 * Admin-token callers bypass rate limiting entirely; unverified callers
 * get the stricter 5 req/min tier, verified callers the 30 req/min tier.
 */
export function checkVerifyRateLimitForRequest(
  req: Request,
  options: { verified: boolean },
): RateLimitResult {
  if (hasAdminToken(req)) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: 0 }
  }

  const ip = getClientIp(req)
  return options.verified ? checkVerifyRateLimit(ip) : checkUnverifiedVerifyRateLimit(ip)
}

/**
 * Check whether the given key (typically `<ip>:<route>`) is within
 * the allowed request window.
 *
 * @param key     Identifier for this client + route combination
 * @param limit   Maximum requests allowed per window
 * @param windowMs Duration of the rate-limit window in milliseconds
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  let bucket = store.get(key)

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs }
    store.set(key, bucket)
  }

  bucket.count += 1
  const remaining = Math.max(0, limit - bucket.count)
  const allowed = bucket.count <= limit
  return { allowed, remaining, resetAt: bucket.resetAt }
}

/**
 * Extract the real client IP from a Next.js request, respecting common
 * reverse-proxy headers (Vercel / Cloudflare / standard X-Forwarded-For).
 */
export function getClientIp(req: Request): string {
  const headers = req instanceof Request ? req.headers : (req as { headers: Headers }).headers
  return (
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    'unknown'
  )
}

type BotProvider = 'turnstile' | 'hcaptcha'

const SITEVERIFY_ENDPOINTS: Record<BotProvider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://hcaptcha.com/siteverify',
}

const TOKEN_HEADERS: Record<BotProvider, string> = {
  turnstile: 'cf-turnstile-response',
  hcaptcha: 'h-captcha-response',
}

function getBotProvider(): BotProvider | null {
  const provider = process.env.BOT_DETECTION_PROVIDER
  return provider === 'turnstile' || provider === 'hcaptcha' ? provider : null
}

function getBotSecret(provider: BotProvider): string | undefined {
  return provider === 'turnstile'
    ? process.env.TURNSTILE_SECRET_KEY
    : process.env.HCAPTCHA_SECRET_KEY
}

/**
 * Optional bot-detection hook for the public verifier.
 *
 * Disabled (returns true) unless `BOT_DETECTION_PROVIDER` is set to
 * 'turnstile' or 'hcaptcha'. When enabled, the client token is read from
 * the provider header (`cf-turnstile-response` / `h-captcha-response`) or,
 * failing that, from the JSON body, and verified against the provider's
 * siteverify endpoint using the matching secret env var.
 */
export async function verifyBotToken(req: Request): Promise<boolean> {
  const provider = getBotProvider()
  if (!provider) return true

  const secret = getBotSecret(provider)
  if (!secret) return false

  const headers = req instanceof Request ? req.headers : (req as { headers: Headers }).headers
  let token = headers.get(TOKEN_HEADERS[provider]) ?? undefined

  if (!token && req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const body = (await req.clone().json()) as Record<string, unknown>
      const fromBody = body?.[TOKEN_HEADERS[provider]]
      if (typeof fromBody === 'string') token = fromBody
    } catch {
      // No JSON body — fall through to failure below.
    }
  }

  if (!token) return false

  try {
    const res = await fetch(SITEVERIFY_ENDPOINTS[provider], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}
