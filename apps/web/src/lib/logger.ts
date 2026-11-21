/**
 * Structured JSON logger — ships to Logtail (Better Stack) in production.
 *
 * Usage:
 *   import { logger } from '@/lib/logger'
 *   logger.info('reading.anchored', { txHash, kwh })
 *   logger.error('mint.failed', { error, readingId })
 *
 *   // With correlation ID:
 *   const log = logger.withCorrelationId('req-abc-123')
 *   log.info('reading.anchored', { txHash })
 *
 *   // Request-scoped structured logging (captures route/method/status/duration):
 *   const log = createRequestLogger(req)
 *   log.info('certificates.list', { count: 20 })
 *   log.end(200)  // emits a request.complete entry with duration
 *
 *   // Redact PII before logging:
 *   const safe = redact({ meter_id, signature_hex, kwh })
 *   log.info('reading.received', safe)
 *
 * Required env var (production):
 *   LOGTAIL_SOURCE_TOKEN — from Better Stack → Sources → your source
 *
 * Optional env var:
 *   LOG_LEVEL — one of debug|info|warn|error (default: info)
 */

import * as Sentry from '@sentry/nextjs'
import { NextRequest } from 'next/server'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function configuredLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return (raw in LEVELS ? raw : 'info') as Level
}

/**
 * Keys whose values are automatically replaced with "[REDACTED]".
 * Matches any key containing these substrings (case-insensitive).
 * See docs/SECURE_LOGGING.md for the full policy.
 */
const REDACT_PATTERN = /key|secret|token|password|sig|hex|private/i

/**
 * Truncate a hex string to its first 8 characters, appending an ellipsis.
 * Non-string values are coerced to string first.
 */
function truncateHex(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value)
  return str.length > 8 ? `${str.slice(0, 8)}…` : str
}

/**
 * Recursively redact sensitive values from an object before logging.
 *
 * Special-cased fields (checked before the generic REDACT_PATTERN):
 *   - `pubkey_hex`    → truncated to first 8 chars (e.g. `abc12345…`)
 *   - `signature_hex` → replaced with "[REDACTED]"
 *
 * Any other key matching REDACT_PATTERN has its value replaced with "[REDACTED]".
 * Arrays and nested objects are redacted recursively.
 *
 * @example
 *   redact({ meter_id, signature_hex, pubkey_hex, kwh })
 *   // → { meter_id, signature_hex: '[REDACTED]', pubkey_hex: 'abc12345…', kwh }
 */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'pubkey_hex') {
      out[k] = truncateHex(v)
    } else if (k === 'signature_hex') {
      out[k] = '[REDACTED]'
    } else if (REDACT_PATTERN.test(k)) {
      out[k] = '[REDACTED]'
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item !== null && typeof item === 'object'
          ? redact(item as Record<string, unknown>)
          : item,
      )
    } else if (v !== null && typeof v === 'object') {
      out[k] = redact(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

interface LogEntry {
  level: Level
  event: string
  timestamp: string
  correlationId?: string
  route?: string
  method?: string
  [key: string]: unknown
}

async function ship(entry: LogEntry) {
  const token = process.env.LOGTAIL_SOURCE_TOKEN
  if (!token) return // local dev — stdout only

  await fetch('https://in.logs.betterstack.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(entry),
  }).catch(() => {
    // never let logging break the request
  })
}

function log(
  level: Level,
  event: string,
  meta: Record<string, unknown> = {},
  correlationId?: string,
  route?: string,
  method?: string,
) {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return

  // Centralized redaction — applied here so call sites cannot leak sensitive fields.
  const safeMeta = redact(meta)

  const entry: LogEntry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlationId } : {}),
    ...(route ? { route } : {}),
    ...(method ? { method } : {}),
    ...safeMeta,
  }
  // Always write to stdout (captured by Vercel function logs too)
  console[level === 'debug' ? 'log' : level](JSON.stringify(entry))
  // Ship to Logtail asynchronously — do not await
  void ship(entry)
  // Add Sentry breadcrumb for observability correlation
  if (correlationId) {
    Sentry.addBreadcrumb({
      category: 'log',
      message: event,
      level: level === 'warn' ? 'warning' : level,
      data: { correlationId, route, method, ...safeMeta },
    })
  }
}

export interface Logger {
  debug: (event: string, meta?: Record<string, unknown>) => void
  info:  (event: string, meta?: Record<string, unknown>) => void
  warn:  (event: string, meta?: Record<string, unknown>) => void
  error: (event: string, meta?: Record<string, unknown>) => void
  withCorrelationId: (id: string) => Omit<Logger, 'withCorrelationId'>
}

export const logger: Logger = {
  debug: (event, meta) => log('debug', event, meta),
  info:  (event, meta) => log('info',  event, meta),
  warn:  (event, meta) => log('warn',  event, meta),
  error: (event, meta) => log('error', event, meta),
  withCorrelationId: (id: string) => ({
    debug: (event, meta) => log('debug', event, meta, id),
    info:  (event, meta) => log('info',  event, meta, id),
    warn:  (event, meta) => log('warn',  event, meta, id),
    error: (event, meta) => log('error', event, meta, id),
  }),
}

// ── Request-scoped logger ─────────────────────────────────────────────────────

/**
 * PII field names that must not appear in logs per docs/SECURE_LOGGING.md.
 * Values for these keys are always redacted regardless of REDACT_PATTERN.
 */
const PII_FIELDS = new Set(['meter_id', 'email', 'operator_email'])

/**
 * Redact known PII fields from a meta object.
 * meter_id and operator email are redacted as per docs/SECURE_LOGGING.md.
 */
export function redactPii(meta: Record<string, unknown>): Record<string, unknown> {
  const out = redact(meta) // structural redaction first
  for (const field of PII_FIELDS) {
    if (field in out) out[field] = '[REDACTED]'
  }
  return out
}

export interface RequestLogger extends Omit<Logger, 'withCorrelationId'> {
  /** Emit a `request.complete` log entry with status code and elapsed duration. */
  end: (status: number, meta?: Record<string, unknown>) => void
}

/**
 * Create a request-scoped logger that automatically includes the correlation ID,
 * HTTP method, and route path in every log entry.
 *
 * Reads (or generates) `X-Correlation-ID` from the incoming request headers.
 * The correlation ID is also set on the active Sentry scope for distributed tracing.
 *
 * @example
 *   export async function POST(req: NextRequest) {
 *     const log = createRequestLogger(req)
 *     log.info('certificates.retire.start', { id })
 *     // ... process ...
 *     log.end(200)
 *   }
 */
export function createRequestLogger(req: NextRequest): RequestLogger {
  const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID()
  const method = req.method.toUpperCase()
  const route = req.nextUrl.pathname
  const startMs = Date.now()

  // Attach correlation ID to Sentry scope for this request
  Sentry.getCurrentScope().setTag('correlationId', correlationId)
  Sentry.getCurrentScope().setExtra('route', route)
  Sentry.getCurrentScope().setExtra('method', method)

  const scoped = {
    debug: (event: string, meta?: Record<string, unknown>) =>
      log('debug', event, meta ?? {}, correlationId, route, method),
    info: (event: string, meta?: Record<string, unknown>) =>
      log('info', event, meta ?? {}, correlationId, route, method),
    warn: (event: string, meta?: Record<string, unknown>) =>
      log('warn', event, meta ?? {}, correlationId, route, method),
    error: (event: string, meta?: Record<string, unknown>) =>
      log('error', event, meta ?? {}, correlationId, route, method),
    end: (status: number, meta?: Record<string, unknown>) => {
      const duration = Date.now() - startMs
      const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      log(level, 'request.complete', { status, duration_ms: duration, ...(meta ?? {}) }, correlationId, route, method)
    },
  }

  return scoped
}
