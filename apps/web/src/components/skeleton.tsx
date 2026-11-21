import { cn } from '@/lib/utils'

interface SkeletonProps {
  className?: string
}

/** Base animated skeleton block */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-gray-200 dark:bg-gray-700',
        className
      )}
    />
  )
}

/** Skeleton that matches a stat card (number + label) */
export function StatCardSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading statistic"
      className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
    >
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="h-8 w-16" />
    </div>
  )
}

/** Skeleton that matches a chart panel */
export function ChartSkeleton({ title }: { title?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={title ? `Loading ${title} chart` : 'Loading chart'}
      className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
    >
      {title && <Skeleton className="mb-4 h-5 w-40" />}
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

/** Skeleton that matches a data table row */
export function TableRowSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

/** Skeleton for the certificate list page — card grid */
export function CertificateListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading certificates"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
        >
          <Skeleton className="mb-3 h-4 w-24" />
          <Skeleton className="mb-2 h-6 w-16" />
          <Skeleton className="mb-4 h-3 w-32" />
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Skeleton that matches a single certificate table row */
export function CertificateRowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

/** Skeleton for the certificate table — header plus N skeleton rows */
export function CertificateTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading certificates"
      className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 dark:border-gray-800">
          <tr>
            {Array.from({ length: 5 }).map((_, i) => (
              <th key={i} scope="col" className="px-4 py-3">
                <Skeleton className="h-4 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
          {Array.from({ length: rows }).map((_, i) => (
            <CertificateRowSkeleton key={i} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Skeleton that matches a governance proposal card */
export function ProposalCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-3/4 max-w-xs" />
        </div>
        <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
      </div>
      <Skeleton className="mb-3 h-2 w-full rounded-full" />
      <div className="flex gap-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  )
}

/** Skeleton for the governance proposals list */
export function ProposalListSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading proposals"
      className="space-y-4"
    >
      {Array.from({ length: count }).map((_, i) => (
        <ProposalCardSkeleton key={i} />
      ))}
    </div>
  )
}

/** Skeleton for a Section/Row panel (verify page style) */
export function SectionSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading section"
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <Skeleton className="mb-3 h-3 w-20" />
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}
