/**
 * Validates that all required service secrets are present at startup.
 * Import this module early (e.g. in next.config.ts) so missing env vars
 * cause a hard crash with a clear message rather than a runtime error
 * deep inside a request handler.
 *
 * Resolves #545
 * Resolves #763 (bot protection env vars)
 */

const REQUIRED_SERVER_SECRETS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MINTER_SECRET_KEY',
] as const

const REQUIRED_PUBLIC_VARS = [
  'NEXT_PUBLIC_STELLAR_NETWORK',
  'NEXT_PUBLIC_ENERGY_TOKEN_ID',
  'NEXT_PUBLIC_AUDIT_REGISTRY_ID',
] as const

/**
 * Bot protection (Cloudflare Turnstile) configuration.
 *
 * The site key is public and is embedded in the /verify page; the secret key
 * is server-only and is used by /api/verify/[id] to validate the challenge
 * token. Both are required so that the public verify endpoint cannot be
 * scraped to enumerate certificates.
 */
const REQUIRED_BOT_PROTECTION_VARS = [
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
] as const

export type BotProtectionConfig = {
  siteKey: string
  secretKey: string
}

/**
 * Parses and validates the CORS_ALLOWED_ORIGINS environment variable.
 *
 * The variable is a comma-separated list of origins. Each entry must be a
 * valid origin URL. In production, wildcard entries (`*` or origins
 * containing `*`) are rejected outright so a misconfiguration cannot
 * silently open the API to every origin.
 *
 * Resolves #777
 */
export function validateCorsOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') {
    return []
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const wildcardEntries: string[] = []
  const invalidEntries: string[] = []

  for (const entry of entries) {
    if (entry === '*' || entry.includes('*')) {
      wildcardEntries.push(entry)
      continue
    }

    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      invalidEntries.push(entry)
      continue
    }

    // An origin must not carry a path, query, or fragment.
    if (
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      invalidEntries.push(entry)
    }
  }

  if (isProduction && wildcardEntries.length > 0) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS contains wildcard entries which are not allowed in production:\n  ${wildcardEntries.join('\n  ')}\n\nEnumerate explicit origins (e.g. https://solarproof.vercel.app) instead of using wildcards.`,
    )
  }

  if (invalidEntries.length > 0) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS contains invalid origin entries:\n  ${invalidEntries.join('\n  ')}\n\nEach entry must be a valid origin URL such as https://solarproof.vercel.app.`,
    )
  }

  return entries
}

export function validateEnv(): void {
  const missing: string[] = []

  for (const key of [
    ...REQUIRED_SERVER_SECRETS,
    ...REQUIRED_PUBLIC_VARS,
    ...REQUIRED_BOT_PROTECTION_VARS,
  ]) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join('\n  ')}\n\nCopy .env.example to .env.local and fill in the values.`,
    )
  }

  validateCorsOrigins(process.env.CORS_ALLOWED_ORIGINS)
}

/**
 * Returns the validated bot protection configuration.
 * Throws if either key is missing so misconfiguration fails loudly.
 */
export function getBotProtectionConfig(): BotProtectionConfig {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const secretKey = process.env.TURNSTILE_SECRET_KEY

  if (!siteKey || !secretKey) {
    throw new Error(
      'Bot protection is not configured: NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be set.',
    )
  }

  return { siteKey, secretKey }
}