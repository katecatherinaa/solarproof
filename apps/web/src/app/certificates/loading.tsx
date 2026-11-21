import { Award } from 'lucide-react'
import { CertificateTableSkeleton, Skeleton } from '@/components/skeleton'

export default function CertificatesLoading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Award className="h-6 w-6 shrink-0 text-yellow-500" aria-hidden="true" />
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">
            Certificates
          </h1>
        </div>
        <Skeleton className="h-8 w-32" />
      </header>

      <div aria-busy="true" aria-label="Loading certificates">
        <CertificateTableSkeleton rows={10} />
      </div>
    </div>
  )
}
