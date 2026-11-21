import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@cubelake/db';
import { sendCooperativeSummaryReport } from '@cubelake/email';
import { generateCooperativeSummaryReport } from '@/lib/cooperative-report';

export const dynamic = 'force-dynamic';

function getPreviousMonthRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return { start, end };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { start, end } = getPreviousMonthRange();

  try {
    const cooperatives = await prisma.cooperative.findMany({
      where: {
        monthlyReportEnabled: true,
      },
      select: {
        id: true,
        name: true,
        contactEmail: true,
      },
    });

    const results: Array<{
      cooperativeId: string;
      status: 'sent' | 'skipped' | 'error';
      error?: string;
    }> = [];

    for (const cooperative of cooperatives) {
      try {
        if (!cooperative.contactEmail) {
          results.push({
            cooperativeId: cooperative.id,
            status: 'skipped',
            error: 'No contact email configured',
          });
          continue;
        }

        const report = await generateCooperativeSummaryReport({
          cooperativeId: cooperative.id,
          startDate: start,
          endDate: end,
        });

        await sendCooperativeSummaryReport({
          to: cooperative.contactEmail,
          cooperativeName: cooperative.name,
          startDate: start,
          endDate: end,
          report,
        });

        results.push({
          cooperativeId: cooperative.id,
          status: 'sent',
        });
      } catch (error) {
        results.push({
          cooperativeId: cooperative.id,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      processed: results.length,
      sent: results.filter((r) => r.status === 'sent').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
    });
  } catch (error) {
    console.error('Cooperative report cron failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}