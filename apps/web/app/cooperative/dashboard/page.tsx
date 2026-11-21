'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Period = 'day' | 'week' | 'month';

interface CooperativeStats {
  totalKwhGenerated: number;
  activeMeters: number;
  certificatesIssued: number;
  certificatesRetired: number;
  memberCount: number;
}

interface MeterKwh {
  meterId: string;
  meterName: string;
  kwh: number;
}

interface MeterBucket {
  period: string;
  meters: MeterKwh[];
}

interface StatsResponse {
  stats: CooperativeStats;
  buckets: MeterBucket[];
}

const EMPTY_STATS: CooperativeStats = {
  totalKwhGenerated: 0,
  activeMeters: 0,
  certificatesIssued: 0,
  certificatesRetired: 0,
  memberCount: 0,
};

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const CHART_COLORS = [
  '#059669',
  '#0ea5e9',
  '#6366f1',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
  '#ec4899',
  '#84cc16',
  '#f97316',
];

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

interface MeterSeries {
  meterId: string;
  meterName: string;
  color: string;
}

interface ChartRow {
  period: string;
  [meterId: string]: string | number;
}

export default function CooperativeDashboardPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>('day');
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/cooperative/stats?period=${encodeURIComponent(period)}`,
          { credentials: 'include' },
        );

        if (res.status === 401 || res.status === 403) {
          router.replace('/login');
          return;
        }

        if (!res.ok) {
          throw new Error('Failed to load cooperative dashboard');
        }

        const json = (await res.json()) as StatsResponse;
        if (!cancelled) {
          setData(json);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Something went wrong',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [router, period]);

  const stats = data?.stats ?? EMPTY_STATS;
  const buckets = data?.buckets ?? [];

  const meters = useMemo<MeterSeries[]>(() => {
    const seen = new Map<string, string>();
    for (const bucket of buckets) {
      for (const meter of bucket.meters) {
        if (!seen.has(meter.meterId)) {
          seen.set(meter.meterId, meter.meterName);
        }
      }
    }
    return Array.from(seen.entries()).map(([meterId, meterName], index) => ({
      meterId,
      meterName,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }));
  }, [buckets]);

  const chartRows = useMemo<ChartRow[]>(() => {
    return buckets.map((bucket) => {
      const row: ChartRow = { period: bucket.period };
      for (const meter of bucket.meters) {
        row[meter.meterId] = meter.kwh;
      }
      return row;
    });
  }, [buckets]);

  const hasData = buckets.length > 0 && meters.length > 0;

  function handleBarClick(meterId: string) {
    router.push(`/meters/${meterId}`);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Cooperative Dashboard
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Aggregate generation and certificate activity across your cooperative.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-gray-500">Loading dashboard…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="space-y-6">
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Total kWh generated"
              value={`${formatNumber(stats.totalKwhGenerated)} kWh`}
            />
            <StatCard
              label="Active meters"
              value={formatNumber(stats.activeMeters)}
            />
            <StatCard
              label="Certificates issued"
              value={formatNumber(stats.certificatesIssued)}
            />
            <StatCard
              label="Certificates retired"
              value={formatNumber(stats.certificatesRetired)}
            />
            <StatCard
              label="Members"
              value={formatNumber(stats.memberCount)}
            />
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">
                kWh per meter
              </h2>
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label="Select period"
              >
                {PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPeriod(option.value)}
                    aria-pressed={period === option.value}
                    className={
                      period === option.value
                        ? 'rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white'
                        : 'rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {!hasData ? (
              <p className="text-sm text-gray-500">
                No generation data available yet.
              </p>
            ) : (
              <>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis
                        tickFormatter={(value: number) => formatNumber(value)}
                      />
                      <Tooltip
                        formatter={(value: number, name: string) => [
                          `${formatNumber(value)} kWh`,
                          name,
                        ]}
                      />
                      <Legend />
                      {meters.map((meter) => (
                        <Bar
                          key={meter.meterId}
                          dataKey={meter.meterId}
                          name={meter.meterName}
                          stackId="kwh"
                          fill={meter.color}
                          cursor="pointer"
                          onClick={() => handleBarClick(meter.meterId)}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowTable((prev) => !prev)}
                    aria-expanded={showTable}
                    aria-controls="kwh-data-table"
                    className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {showTable ? 'Hide data table' : 'Show data table'}
                  </button>
                </div>

                {showTable && (
                  <div
                    id="kwh-data-table"
                    className="mt-4 overflow-x-auto"
                  >
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <caption className="mb-2 text-left text-sm text-gray-500">
                        kWh generated per meter per {period}
                      </caption>
                      <thead>
                        <tr>
                          <th
                            scope="col"
                            className="px-3 py-2 text-left font-semibold text-gray-900"
                          >
                            Period
                          </th>
                          {meters.map((meter) => (
                            <th
                              key={meter.meterId}
                              scope="col"
                              className="px-3 py-2 text-right font-semibold text-gray-900"
                            >
                              {meter.meterName}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {chartRows.map((row) => (
                          <tr key={row.period}>
                            <th
                              scope="row"
                              className="px-3 py-2 text-left font-medium text-gray-700"
                            >
                              {row.period}
                            </th>
                            {meters.map((meter) => {
                              const value = row[meter.meterId];
                              return (
                                <td
                                  key={meter.meterId}
                                  className="px-3 py-2 text-right text-gray-700"
                                >
                                  {typeof value === 'number'
                                    ? formatNumber(value)
                                    : '—'}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
