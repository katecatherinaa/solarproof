import { NextRequest, NextResponse } from 'next/server'
import { createUserClient } from '@/lib/supabase'

/**
 * GET /api/jobs/[id] — query job status
 *
 * Uses createUserClient() (RLS-enforced) rather than createServiceClient().
 * The jobs table has an RLS policy allowing the owning cooperative to read
 * its own job rows, so service-role privileges are not required here.
 * See docs/adr/007 for the service-role audit policy.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createUserClient()

  const { data, error } = await db
    .from('jobs')
    .select('id, type, status, attempts, result, error, created_at, updated_at')
    .eq('id', id)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  return NextResponse.json(data)
}