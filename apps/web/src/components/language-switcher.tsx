'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { locales, LOCALE_LABELS, LOCALE_NAMES, type Locale } from '@/lib/locales'

interface Props {
  current: Locale
}

export function LanguageSwitcher({ current }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [announcement, setAnnouncement] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  async function switchLocale(locale: Locale) {
    setIsSaving(true)
    try {
      const response = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      })
      if (!response.ok) throw new Error('Failed to save locale')

      setAnnouncement(`Language changed to ${LOCALE_NAMES[locale]}`)
      startTransition(() => router.refresh())
    } catch {
      setAnnouncement('Unable to change language. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div role="group" aria-label="Language selector">
      {/* Screen reader announcement for selection change */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      <label htmlFor="language-select" className="sr-only">
        Select language
      </label>
      <select
        id="language-select"
        value={current}
        onChange={(e) => switchLocale(e.target.value as Locale)}
        disabled={isSaving}
        className="cursor-pointer appearance-none rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]} — {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </div>
  )
}
