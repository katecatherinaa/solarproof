import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { db } from '@/lib/db';
import { certificates, readings, meters } from '@/lib/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

const querySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format')
      .optional(),
    date_from: dateString.optional(),
    date_to: dateString.optional(),
    format: z.enum(['json', 'csv', 'pdf']).optional().default('json'),
  })
  .refine((data) => data.month || (data.date_from && data.date_to), {
    message: 'either month or both date_from and date_to must be provided',
  })
  .refine((data) => !(data.date_from && data.date_to) || data.date_from <= data.date_to, {
    message: 'date_from must be before or equal to date_to',
  });

function monthRange(month: string): { start: Date; end: Date } {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function dateRange(dateFrom: string, dateTo: string): { start: Date; end: Date } {
  const [fromYear, fromMonth, fromDay] = dateFrom.split('-').map(Number);
  const [toYear, toMonth, toDay] = dateTo.split('-').map(Number);
  const start = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay, 0, 0, 0, 0));
  // Inclusive end date: cover the whole day by using the start of the next day.
  const end = new Date(Date.UTC(toYear, toMonth - 1, toDay + 1, 0, 0, 0, 0));
  return { start, end };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function pdfEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Builds a minimal, dependency-free PDF document from a list of text lines.
 * Uses the built-in Helvetica font and a single page (sufficient for a
 * monthly summary report).
 */
function buildPdf(title: string, lines: string[]): Uint8Array {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const lineHeight = 14;
  const fontSize = 10;

  const contentParts: string[] = [];
  contentParts.push('BT');
  contentParts.push(`/F1 14 Tf`);
  contentParts.push(`1 0 0 1 ${margin} ${pageHeight - margin} Tm`);
  contentParts.push(`(${pdfEscape(title)}) Tj`);
  contentParts.push(`/F1 ${fontSize} Tf`);
  contentParts.push(`0 -${lineHeight * 2} Td`);
  for (const line of lines) {
    contentParts.push(`(${pdfEscape(line)}) Tj`);
    contentParts.push(`0 -${lineHeight} Td`);
  }
  contentParts.push('ET');
  const content = contentParts.join('\n');

  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`
  );
  objects.push(
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

interface MeterSummary {
  meterId: string;
  meterName: string | null;
  totalKwhProduced: number;
  certificatesIssued: number;
  certificatesRetired: number;
  kwhRetired: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const cooperativeId = auth.user.cooperativeId;
  if (!cooperativeId) {
    return NextResponse.json(
      { error: 'User is not associated with a cooperative' },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    month: url.searchParams.get('month') ?? undefined,
    date_from: url.searchParams.get('date_from') ?? undefined,
    date_to: url.searchParams.get('date_to') ?? undefined,
    format: url.searchParams.get('format') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { month, date_from, date_to, format } = parsed.data;
  const { start, end } =
    date_from && date_to ? dateRange(date_from, date_to) : monthRange(month as string);
  const reportLabel =
    date_from && date_to ? `${date_from}_to_${date_to}` : (month as string);

  const rows = await db
    .select({
      certificateId: certificates.id,
      kwh: readings.kwh,
      retiredAt: certificates.retiredAt,
      retiredBy: certificates.retiredBy,
    })
    .from(certificates)
    .innerJoin(readings, eq(certificates.readingId, readings.id))
    .innerJoin(meters, eq(readings.meterId, meters.id))
    .where(
      and(
        eq(meters.cooperativeId, cooperativeId),
        eq(certificates.retired, true),
        gte(certificates.retiredAt, start),
        lt(certificates.retiredAt, end)
      )
    );

  // Production summary: aggregate readings and certificates per meter for the
  // requested period.
  const meterRows = await db
    .select({
      meterId: meters.id,
      meterName: meters.name,
      totalKwhProduced: sql<string>`coalesce(sum(${readings.kwh}), 0)`,
      certificatesIssued: sql<string>`count(${certificates.id})`,
      certificatesRetired: sql<string>`count(${certificates.id}) filter (where ${certificates.retired} = true)`,
      kwhRetired: sql<string>`coalesce(sum(${certificates.kwh}), 0) filter (where ${certificates.retired} = true)`,
    })
    .from(meters)
    .leftJoin(readings, eq(readings.meterId, meters.id))
    .leftJoin(certificates, eq(certificates.readingId, readings.id))
    .where(
      and(
        eq(meters.cooperativeId, cooperativeId),
        gte(readings.readingAt, start),
        lt(readings.readingAt, end)
      )
    )
    .groupBy(meters.id, meters.name);

  const perMeter: MeterSummary[] = meterRows.map((row) => ({
    meterId: row.meterId,
    meterName: row.meterName ?? null,
    totalKwhProduced: Number(Number(row.totalKwhProduced ?? 0).toFixed(3)),
    certificatesIssued: Number(row.certificatesIssued ?? 0),
    certificatesRetired: Number(row.certificatesRetired ?? 0),
    kwhRetired: Number(Number(row.kwhRetired ?? 0).toFixed(3)),
  }));

  const productionSummary = {
    totalKwhProduced: Number(
      perMeter.reduce((sum, m) => sum + m.totalKwhProduced, 0).toFixed(3)
    ),
    certificatesIssued: perMeter.reduce((sum, m) => sum + m.certificatesIssued, 0),
    certificatesRetired: perMeter.reduce((sum, m) => sum + m.certificatesRetired, 0),
    kwhRetired: Number(perMeter.reduce((sum, m) => sum + m.kwhRetired, 0).toFixed(3)),
    perMeter,
  };

  if (format === 'csv') {
    const lines: string[] = [];
    lines.push(['section', 'meter_id', 'meter_name', 'total_kwh_produced', 'certificates_issued', 'certificates_retired', 'kwh_retired'].join(','));
    for (const m of perMeter) {
      lines.push(
        [
          csvEscape('production_summary'),
          csvEscape(m.meterId),
          csvEscape(m.meterName),
          csvEscape(m.totalKwhProduced),
          csvEscape(m.certificatesIssued),
          csvEscape(m.certificatesRetired),
          csvEscape(m.kwhRetired),
        ].join(',')
      );
    }
    lines.push(
      [
        csvEscape('production_summary_total'),
        csvEscape(''),
        csvEscape(''),
        csvEscape(productionSummary.totalKwhProduced),
        csvEscape(productionSummary.certificatesIssued),
        csvEscape(productionSummary.certificatesRetired),
        csvEscape(productionSummary.kwhRetired),
      ].join(',')
    );
    lines.push('');
    lines.push(['certificate_id', 'kwh', 'retired_at', 'retired_by'].join(','));
    for (const row of rows) {
      lines.push(
        [
          csvEscape(row.certificateId),
          csvEscape(row.kwh),
          csvEscape(row.retiredAt ? new Date(row.retiredAt).toISOString() : ''),
          csvEscape(row.retiredBy),
        ].join(',')
      );
    }
    const csv = lines.join('\r\n') + '\r\n';
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="retirement-report-${reportLabel}.csv"`,
      },
    });
  }

  if (format === 'pdf') {
    const pdfLines: string[] = [];
    pdfLines.push(`Cooperative: ${cooperativeId}`);
    pdfLines.push(`Period: ${reportLabel}`);
    pdfLines.push('');
    pdfLines.push('Production Summary');
    pdfLines.push(
      `Total kWh produced: ${productionSummary.totalKwhProduced}`
    );
    pdfLines.push(`Certificates issued: ${productionSummary.certificatesIssued}`);
    pdfLines.push(`Certificates retired: ${productionSummary.certificatesRetired}`);
    pdfLines.push(`kWh retired: ${productionSummary.kwhRetired}`);
    pdfLines.push('');
    pdfLines.push('By Meter');
    if (perMeter.length === 0) {
      pdfLines.push('No production data for the selected period.');
    } else {
      for (const m of perMeter) {
        pdfLines.push(
          `${m.meterName ?? m.meterId}: produced ${m.totalKwhProduced} kWh, ` +
            `issued ${m.certificatesIssued}, retired ${m.certificatesRetired} ` +
            `(${m.kwhRetired} kWh)`
        );
      }
    }
    const pdf = buildPdf(`Retirement Report ${reportLabel}`, pdfLines);
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="retirement-report-${reportLabel}.pdf"`,
      },
    });
  }

  let totalKwh = 0;
  const buyerMap = new Map<
    string,
    { retiredBy: string; totalKwh: number; certificateIds: string[] }
  >();
  const certificateIds: string[] = [];

  for (const row of rows) {
    const kwh = Number(row.kwh ?? 0);
    totalKwh += kwh;
    certificateIds.push(row.certificateId);

    const buyerKey = row.retiredBy ?? 'unknown';
    const existing = buyerMap.get(buyerKey);
    if (existing) {
      existing.totalKwh += kwh;
      existing.certificateIds.push(row.certificateId);
    } else {
      buyerMap.set(buyerKey, {
        retiredBy: buyerKey,
        totalKwh: kwh,
        certificateIds: [row.certificateId],
      });
    }
  }

  const perBuyer = Array.from(buyerMap.values()).map((b) => ({
    retiredBy: b.retiredBy,
    totalKwh: Number(b.totalKwh.toFixed(3)),
    certificateCount: b.certificateIds.length,
    certificateIds: b.certificateIds,
  }));

  return NextResponse.json({
    month: month ?? null,
    dateFrom: date_from ?? null,
    dateTo: date_to ?? null,
    cooperativeId,
    productionSummary,
    totalKwhRetired: Number(totalKwh.toFixed(3)),
    certificateCount: certificateIds.length,
    certificateIds,
    perBuyer,
  });
}