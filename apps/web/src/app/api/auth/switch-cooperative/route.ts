import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const ACCESS_TOKEN_COOKIE = 'sp_access_token';

interface Membership {
  cooperative_id: string;
  name?: string;
  role?: string;
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase admin credentials are not configured');
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getSupabaseAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase credentials are not configured');
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function extractBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieToken = req.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  return cookieToken ?? null;
}

function normalizeMemberships(raw: unknown): Membership[] {
  if (!Array.isArray(raw)) return [];
  const result: Membership[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push({ cooperative_id: entry });
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const id =
        (typeof obj.cooperative_id === 'string' && obj.cooperative_id) ||
        (typeof obj.id === 'string' && obj.id) ||
        null;
      if (id) {
        result.push({
          cooperative_id: id,
          name: typeof obj.name === 'string' ? obj.name : undefined,
          role: typeof obj.role === 'string' ? obj.role : undefined,
        });
      }
    }
  }
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    const requestedCooperativeId =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).cooperative_id
        : undefined;

    if (typeof requestedCooperativeId !== 'string' || !requestedCooperativeId) {
      return NextResponse.json(
        { error: 'cooperative_id is required' },
        { status: 400 }
      );
    }

    const anonClient = getSupabaseAnon();
    const { data: userData, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return NextResponse.json(
        { error: 'Invalid or expired session' },
        { status: 401 }
      );
    }

    const user = userData.user;
    const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>;

    const memberships = normalizeMemberships(
      appMetadata.cooperatives ?? appMetadata.memberships
    );

    const membership = memberships.find(
      (m) => m.cooperative_id === requestedCooperativeId
    );

    if (!membership) {
      return NextResponse.json(
        { error: 'You do not have access to this cooperative' },
        { status: 403 }
      );
    }

    const adminClient = getSupabaseAdmin();

    let cooperativeName = membership.name;
    if (!cooperativeName) {
      const { data: coopRow, error: coopError } = await adminClient
        .from('cooperatives')
        .select('id, name')
        .eq('id', requestedCooperativeId)
        .maybeSingle();

      if (coopError) {
        return NextResponse.json(
          { error: 'Failed to load cooperative' },
          { status: 500 }
        );
      }
      if (!coopRow) {
        return NextResponse.json(
          { error: 'Cooperative not found' },
          { status: 404 }
        );
      }
      cooperativeName = coopRow.name as string;
    }

    const updatedAppMetadata: Record<string, unknown> = {
      ...appMetadata,
      cooperative_id: requestedCooperativeId,
    };

    const { error: updateError } = await adminClient.auth.admin.updateUserById(
      user.id,
      { app_metadata: updatedAppMetadata }
    );

    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to switch cooperative' },
        { status: 500 }
      );
    }

    const { data: signInData, error: signInError } =
      await adminClient.auth.admin.generateLink({
        type: 'magiclink',
        email: user.email as string,
      });

    let newAccessToken: string | null = null;

    if (!signInError && signInData?.properties?.hashed_token) {
      const { data: verifyData, error: verifyError } =
        await anonClient.auth.verifyOtp({
          type: 'magiclink',
          token_hash: signInData.properties.hashed_token,
        });
      if (!verifyError && verifyData?.session?.access_token) {
        newAccessToken = verifyData.session.access_token;
      }
    }

    if (!newAccessToken) {
      const { data: refreshed, error: refreshError } =
        await adminClient.auth.admin.getUserById(user.id);
      if (refreshError || !refreshed?.user) {
        return NextResponse.json(
          { error: 'Failed to reissue access token' },
          { status: 500 }
        );
      }
      return NextResponse.json(
        {
          error:
            'Cooperative updated but a new access token could not be issued; please sign in again',
        },
        { status: 500 }
      );
    }

    const response = NextResponse.json({
      cooperative_id: requestedCooperativeId,
      cooperative_name: cooperativeName ?? null,
      access_token: newAccessToken,
    });

    response.cookies.set({
      name: ACCESS_TOKEN_COOKIE,
      value: newAccessToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>