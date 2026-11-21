import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface CertificateRow {
  id: string;
  kwh: number;
  issued_at: string;
  expires_at: string | null;
  retired: boolean;
  cooperatives: { name: string } | { name: string }[] | null;
}

function getCooperativeName(
  cooperatives: CertificateRow['cooperatives']
): string | null {
  if (!cooperatives) return null;
  if (Array.isArray(cooperatives)) {
    return cooperatives[0]?.name ?? null;
  }
  return cooperatives.name ?? null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function parseDate(value: string | null): string | null {
  if (!value || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const { searchParams } = request.nextUrl;

  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = Math.min(
    parsePositiveInt(searchParams.get('limit'), DEFAULT_LIMIT),
    MAX_LIMIT
  );

  const cooperative = searchParams.get('cooperative')?.trim() ?? '';
  const dateFrom = parseDate(searchParams.get('date_from'));
  const dateTo = parseDate(searchParams.get('date_to'));
  const minKwh = parseNumber(searchParams.get('min_kwh'));
  const maxKwh = parseNumber(searchParams.get('max_kwh'));

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('certificates')
    .select(
      'id, kwh, issued_at, expires_at, retired, cooperatives!inner(name)',
      { count: 'exact' }
    )
    .eq('verified', true)
    .order('issued_at', { ascending: false })
    .range(from, to);

  if (cooperative) {
    query = query.ilike('cooperatives.name', `%${cooperative}%`);
  }

  if (dateFrom) {
    query = query.gte('issued_at', dateFrom);
  }

  if (dateTo) {
    query = query.lte('issued_at', dateTo);
  }

  if (minKwh !== null) {
    query = query.gte('kwh', minKwh);
  }

  if (maxKwh !== null) {
    query = query.lte('kwh', maxKwh);
  }

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json(
      { error: 'Failed to fetch certificates' },
      { status: 500 }
    );
  }

  const rows = (data ?? []) as unknown as CertificateRow[];

  const certificates = rows.map((row) => ({
    id: row.id,
    kwh: row.kwh,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    retired: row.retired,
    cooperative_name: getCooperativeName(row.cooperatives),
  }));

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return NextResponse.json({
    data: certificates,
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    },
  });
}