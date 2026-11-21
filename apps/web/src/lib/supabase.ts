/**
 * Centralized Supabase client initialization.
 *
 * Two clients are exported from this single module:
 *
 * - `supabase`            — browser/anon client, safe to use in client
 *                           components. Uses the public anon key and
 *                           respects Row-Level Security policies.
 *
 * - `createServiceClient` — server-only factory that creates a service-role
 *                           client. Bypasses RLS. Call this only from API
 *                           routes or Server Components — never import it
 *                           in client-side code.
 *
 * Both clients are typed with the generated `Database` interface so all
 * table/column access is fully type-checked at compile time.
 *
 * Environment variables required:
 *   NEXT_PUBLIC_SUPABASE_URL        — Supabase project URL (public)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   — Supabase anon/public key
 *   SUPABASE_SERVICE_ROLE_KEY       — Supabase service-role secret (server only)
 *
 * Environment variables optional (production connection pooling):
 *   PGBOUNCER_URL                   — PgBouncer pooled connection string. When
 *                                     set, server-side clients connect through
 *                                     PgBouncer instead of the direct Supabase
 *                                     URL, preventing connection exhaustion
 *                                     under serverless concurrency.
 *   PGBOUNCER_POOL_SIZE             — Max connections per serverless instance
 *                                     (defaults to 10). Tune to expected
 *                                     concurrency / instance count.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { env } from '@/env'

const DEFAULT_POOL_SIZE = 10

/**
 * Resolve the connection URL for server-side clients. Prefers the PgBouncer
 * pooled connection string when configured, falling back to the direct
 * Supabase URL for local/dev environments.
 */
function getServerConnectionUrl(): string {
  return env.PGBOUNCER_URL || env.NEXT_PUBLIC_SUPABASE_URL
}

/**
 * Resolve the per-instance connection pool size from PGBOUNCER_POOL_SIZE.
 * Falls back to a conservative default when unset or invalid.
 */
function getPoolSize(): number {
  const parsed = Number(env.PGBOUNCER_POOL_SIZE)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_SIZE
}

export const supabase = createClient<Database>(
  env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost',
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
)

/**
 * Anon client — uses the public anon key; RLS is enforced.
 * Use for public read-only endpoints (e.g. /api/verify) that require no auth.
 * Connects through PgBouncer when PGBOUNCER_URL is configured.
 */
export function createAnonClient() {
  return createClient<Database>(
    getServerConnectionUrl(),
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false },
      db: { poolSize: getPoolSize() },
    }
  )
}

/**
 * Service-role client — bypasses RLS. Use ONLY in trusted server contexts:
 *   - Writing readings, certificates, jobs (device-submitted, already verified)
 *   - Audit log writes (must never be gated by operator RLS)
 *   - Background job processing (no user JWT available)
 *   - Webhook fan-out (cross-cooperative queries)
 *   - Health checks (needs cross-tenant visibility)
 * See docs/adr/007-supabase-service-role-usage.md for the full justification.
 */
export function createServiceClient() {
  return createClient<Database>(
    getServerConnectionUrl(),
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
      db: { poolSize: getPoolSize() },
    }
  )
}
