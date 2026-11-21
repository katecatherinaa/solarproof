'use client'

import { useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { usePersistentFilters } from '@/hooks/use-persistent-filters'

const OPTIONS = [10, 25, 50] as const

const NAMESPACE = 'certificates'
const PAGE_SIZE_KEY = 'limit'

export function PageSizeSelect({ current }: { current: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { filters, setFilter, clearFilters } = usePersistentFilters(NAMESPACE)

  const persistedLimit = filters[PAGE_SIZE_KEY]
  const urlLimit = searchParams.get('limit')

  // On mount, initialize from the persisted value when the URL param is absent.
  useEffect(() => {
    if (urlLimit) return
    if (!persistedLimit) return
    const parsed = Number(persistedLimit)
    if (!OPTIONS.includes(parsed as (typeof OPTIONS)[number])) return
    if (parsed === current) return

    const params = new URLSearchParams(searchParams.toString())
    params.set('limit', String(parsed))
    params.delete('cursor') // reset to first page on size change
    router.replace(`${pathname}?${params.toString()}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value

    // Persist the selected page size so it survives a hard refresh.
    setFilter(PAGE_SIZE_KEY, value)

    const params = new URLSearchParams(searchParams.toString())
    params.set('limit', value)
    params.delete('cursor') // reset to first page on size change
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
      <label htmlFor="page-size">Per page</label>
      <select
        id="page-size"
        value={current}
        onChange={handleChange}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        {OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  )
}

// Exported so the certificates page's Clear filters action can reset the
// persisted page size along with the other persisted filters.
export function clearPersistedPageSize(
  clearFilters: ReturnType<typeof usePersistentFilters>['clearFilters'],
) {
  clearFilters()
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>