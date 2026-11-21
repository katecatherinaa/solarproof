'use client';

import { useEffect, useMemo, useState } from 'react';

interface TimeSeriesPoint {
  date: string;
  kwh: number;
}

interface CooperativeGoal {
  targetKwh: number;
  periodStart: string;
  periodEnd: string;
  actualKwh: number;
}

interface CooperativeStats {
  totalKwhGenerated: number;
  activeMeters: number;
  certificatesIssued: number;
  certificatesRetired: number;
  memberCount: number;
  kwhTimeSeries: TimeSeriesPoint[];
  goal?: CooperativeGoal | null;
}

interface CooperativeDashboardProps {
  cooperativeId: string;
  role?: string;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function GoalProgress({ goal }: { goal: CooperativeGoal }) {
  const { targetKwh, actualKwh, periodStart, periodEnd } = goal;

  const progressPct =
    targetKwh > 0 ? Math.min((actualKwh / targetKwh) * 100, 100) : 0;

  const expectedPacePct = useMemo(() => {
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();
    const now = Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return 0;
    }
    const elapsed = Math.min(Math.max(now - start, 0), end - start);
    return (elapsed / (end - start)) * 100;
  }, [periodStart, periodEnd]);

  const actualPct = targetKwh > 0 ? (actualKwh / targetKwh) * 100 : 0;
  const belowPace = actualPct < expectedPacePct * 0.8;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Production Goal
        </h2>
        <p className="text-sm text-gray-500">
          {new Date(periodStart).toLocaleDateString()} –{' '}
          {new Date(periodEnd).toLocaleDateString()}
        </p>
      </div>

      {belowPace && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          Production is below 80% of the expected pace for this period.
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-gray-900">
            {formatNumber(actualKwh)} kWh
          </span>
          <span className="text-gray-500">
            of {formatNumber(targetKwh)} kWh target
          </span>
        </div>
        <div
          className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={targetKwh}
          aria-valuenow={actualKwh}
          aria-label="Production goal progress"
        >
          <div
            className={`h-full rounded-full ${
              belowPace ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {progressPct.toFixed(1)}% of target achieved
        </p>
      </div>
    </div>
  );
}

function KwhChart({ data }: { data: TimeSeriesPoint[] }) {
  const max = useMemo(
    () => data.reduce((acc, point) => Math.max(acc, point.kwh), 0),
    [data],
  );

  if (data.length === 0) {
    return (
      <p className="text-sm text-gray-500">No generation data available yet.</p>
    );
  }

  return (
    <div className="flex h-48 items-end gap-1 overflow-x-auto">
      {data.map((point) => {
        const height = max > 0 ? Math.max((point.kwh / max) * 100, 2) : 2;
        return (
          <div
            key={point.date}
            className="flex min-w-[8px] flex-1 flex-col items-center justify-end"
            title={`${point.date}: ${formatNumber(point.kwh)} kWh`}
          >
            <div
              className="w-full rounded-t bg-emerald-500"
              style={{ height: `${height}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function CooperativeDashboard({
  cooperativeId,
  role,
}: CooperativeDashboardProps) {
  const [stats, setStats] = useState<CooperativeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCooperativeAdmin = role === 'cooperative_admin';

  useEffect(() => {
    if (!isCooperativeAdmin) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/cooperatives/${cooperativeId}/dashboard`,
        );
        if (!res.ok) {
          throw new Error('Failed to load cooperative dashboard');
        }
        const data = (await res.json()) as CooperativeStats;
        if (!cancelled) {
          setStats(data);
          setError(null);
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
  }, [cooperativeId, isCooperativeAdmin]);

  if (!isCooperativeAdmin) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600">
          You do not have permission to view the cooperative dashboard.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-500">Loading dashboard…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 sm:text-2xl">
          Cooperative Dashboard
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Aggregate performance across all cooperative members.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Total kWh Generated"
          value={formatNumber(stats.totalKwhGenerated)}
        />
        <StatCard
          label="Active Meters"
          value={formatNumber(stats.activeMeters)}
        />
        <StatCard
          label="Certificates Issued"
          value={formatNumber(stats.certificatesIssued)}
        />
        <StatCard
          label="Certificates Retired"
          value={formatNumber(stats.certificatesRetired)}
        />
        <StatCard label="Members" value={formatNumber(stats.memberCount)} />
      </div>

      {stats.goal ? (
        <GoalProgress goal={stats.goal} />
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">
            Production Goal
          </h2>
          <p className="mt-2 text-sm text-gray-500">
            No production goal configured for this cooperative yet.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          Aggregate kWh Over Time
        </h2>
        <div className="mt-4">
          <KwhChart data={stats.kwhTimeSeries} />
        </div>
      </div>
    </div>
  );
}
