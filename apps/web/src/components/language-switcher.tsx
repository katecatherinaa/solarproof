'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { locales, LOCALE_LABELS, LOCALE_NAMES, type Locale } from '@/lib/locales'

// Display labels for the language switcher. Kept explicit so the Spanish
// option always renders as "Español" regardless of the active locale.
const SWITCHER_LABELS: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
}

interface Props {
  current: Locale
}

export function LanguageSwitcher({ current }: Props) {
  const router = useRouter()
  const t = useTranslations('languageSwitcher')
  const [, startTransition] = useTransition()
  const [announcement, setAnnouncement] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [activeLocale, setActiveLocale] = useState<Locale>(current)

  async function switchLocale(locale: Locale) {
    setIsSaving(true)
    try {
      const response = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      })
      if (!response.ok) throw new Error('Failed to save locale')

      // Mirror the server-set cookie on the client so the locale is applied
      // immediately (and survives a refresh) even before the API response
      // is processed by middleware.
      document.cookie = `locale=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`

      setAnnouncement(`Language changed to ${LOCALE_NAMES[locale]}`)
      startTransition(() => router.refresh())
    } catch {
      setAnnouncement(t('error'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div role="group" aria-label={t('label')}>
      {/* Screen reader announcement for selection change */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      <label htmlFor="language-select" className="sr-only">
        {t('selectLabel')}
      </label>
      <select
        id="language-select"
        value={activeLocale}
        disabled={isSaving}
        aria-busy={isSaving}
        onChange={(e) => switchLocale(e.target.value as Locale)}
        className="cursor-pointer appearance-none rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {SWITCHER_LABELS[l] ?? LOCALE_LABELS[l]} — {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </div>
  )
}
