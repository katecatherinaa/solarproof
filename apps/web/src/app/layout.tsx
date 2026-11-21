// #481 unsupported-browser landing page.
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'
import { Providers } from './providers'
import { Navbar } from '@/components/navbar'
import { ErrorBoundary } from '@/components/error-boundary'
import { NavigationProgress } from '@/components/navigation-progress'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getLocale } from 'next-intl/server'
import { LOCALE_DIRECTIONS, type Locale } from '@/lib/locales'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'SolarProof — Cryptographic Renewable Energy Certification on Stellar',
  description:
    'End-to-end cryptographic proof of renewable energy. Every kWh signed at the meter, anchored on Stellar, publicly verifiable.',
  openGraph: {
    title: 'SolarProof',
    description: 'Cryptographic renewable energy certification on Stellar',
    url: 'https://solarproof.vercel.app',
    siteName: 'SolarProof',
  },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang={locale} dir={LOCALE_DIRECTIONS[locale as Locale]} suppressHydrationWarning>
      <head>
        {/* Sentry bootstrap — nonce satisfies the CSP without unsafe-inline. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `window.__solarproof_nonce__ = ${JSON.stringify(nonce ?? '')};`,
          }}
        />
      </head>
      <body className={inter.className}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-gray-950 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          Skip to main content
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <NavigationProgress />
            <Navbar locale={locale as Locale} />
            <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-50 dark:bg-gray-950">
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
          </Providers>
        </NextIntlClientProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
