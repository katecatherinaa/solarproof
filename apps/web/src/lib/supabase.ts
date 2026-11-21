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
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { env } from '@/env'

export const supabase = createClient<Database>(
  env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost',
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
)

/**
 * Anon client — uses the public anon key; RLS is enforced.
 * Use for public read-only endpoints (e.g. /api/verify) that require no auth.
 */
export function createAnonClient() {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  )
}

/**
 * User-scoped client — forwards the caller's access token so RLS is enforced
 * as that user. This is the DEFAULT for authenticated API routes and Server
 * Components. Prefer this over `createServiceClient` unless the service-role
 * bypass is explicitly justified (see docs/adr/007-supabase-service-role-usage.md).
 *
 * @param accessToken The caller's Supabase access token (JWT). When omitted,
 *                    falls back to the anon key (RLS still enforced).
 */
export function createUserClient(accessToken?: string) {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : undefined,
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
 *
 * AUDIT (#765): every call site MUST carry a comment referencing
 * docs/adr/007-supabase-service-role-usage.md explaining why RLS bypass is
 * required. If you cannot justify it, use `createUserClient()` instead.
 */
export function createServiceClient() {
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )
}
