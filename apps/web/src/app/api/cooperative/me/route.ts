import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireAuth, isAuthError } from '@/lib/auth'

/** GET /api/cooperative/me — get current user's cooperative details */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  // Service role required (justified): cooperative membership lookup needs to
  // resolve the cooperative row from app_metadata.cooperative_id without a
  // user-scoped RLS read policy on the cooperatives table. No user-scoped
  // alternative is feasible because createUserClient() would be subject to RLS
  // and there is no policy granting members read access to their cooperative.
  // See docs/adr/007-supabase-service-role-usage.md
  const db = createServiceClient()
  const { data, error } = await db
    .from('cooperatives')
    .select('id, name, account_type, admin_address, suspended, created_at')
    .eq('id', auth.cooperativeId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}