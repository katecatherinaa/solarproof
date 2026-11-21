export const locales = ['en', 'es', 'fr', 'de', 'ar', 'pt-BR'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'en'

export const SUPPORTED_LOCALES = locales

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'EN',
  es: 'ES',
  fr: 'FR',
  de: 'DE',
  ar: 'AR (preview)',
  'pt-BR': 'PT-BR',
}
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ar: 'Arabic (RTL preview)',
  'pt-BR': 'Português (BR)',
}

export const LOCALE_DIRECTIONS: Record<Locale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  es: 'ltr',
  fr: 'ltr',
  de: 'ltr',
  ar: 'rtl',
  'pt-BR': 'ltr',
}

export const LOCALE_FORMATS: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ar: 'ar',
  'pt-BR': 'pt-BR',
}

export function getFormatLocale(locale: Locale): string {
  return LOCALE_FORMATS[locale] ?? LOCALE_FORMATS[defaultLocale]
}

export function formatDate(
  date: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(getFormatLocale(locale), options).format(date)
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(getFormatLocale(locale), options).format(value)
}