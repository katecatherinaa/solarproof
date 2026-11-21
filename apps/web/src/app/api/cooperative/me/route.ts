import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireAuth, isAuthError } from '@/lib/auth'

/** GET /api/cooperative/me — get current user's cooperative details */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isAuthError(auth)) return auth

  // Service role required: cooperative membership lookup needs to resolve the
  // cooperative row from app_metadata.cooperative_id without a user-scoped RLS
  // read policy on the cooperatives table. See docs/adr/007-supabase-service-role-usage.md
  const db = createServiceClient()
  const { data, error } = await db
    .from('cooperatives')
    .select('id, name, account_type, admin_address, suspended, created_at')
    .eq('id', auth.cooperativeId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Resolve the list of cooperatives the authenticated user can switch to.
  // Membership is derived from the user's roles in app_metadata; an operator
  // account may manage multiple cooperatives.
  const cooperativeIds = Array.from(
    new Set(
      (auth.roles ?? [])
        .map((role) => role.cooperative_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  )

  let availableCooperatives: { id: string; name: string }[] = []
  if (cooperativeIds.length > 0) {
    const { data: cooperatives, error: cooperativesError } = await db
      .from('cooperatives')
      .select('id, name')
      .in('id', cooperativeIds)
      .order('name', { ascending: true })

    if (cooperativesError) {
      return NextResponse.json({ error: cooperativesError.message }, { status: 500 })
    }
    availableCooperatives = cooperatives ?? []
  }

  return NextResponse.json({
    ...data,
    available_cooperatives: availableCooperatives,
  })
}