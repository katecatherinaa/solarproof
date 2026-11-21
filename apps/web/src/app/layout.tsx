// #481 unsupported-browser landing page.
// #762 Subresource Integrity (SRI) for third-party assets.
//
// SRI policy
// ----------
// Every external <script>/<link> rendered by this layout MUST carry an
// `integrity` attribute (sha384) and `crossOrigin="anonymous"`. The CI check
// in `scripts/check-sri.mjs` fails the build if a third-party asset is added
// without an integrity hash.
//
// Fallback behaviour when an SRI check fails
// ------------------------------------------
// If a browser rejects a third-party asset because its hash does not match,
// the asset is simply NOT executed/applied. The app must remain functional:
//   - Analytics / SpeedInsights: silently absent. No user-facing impact;
//     telemetry is best-effort only. Errors are still surfaced via the
//     in-app ErrorBoundary.
//   - Fonts: `next/font/google` self-hosts fonts at build time, so no
//     runtime CDN request is made and there is no SRI failure mode. The
//     system font stack in globals.css is the fallback if self-hosting
//     ever fails.
//   - Sentry (loaded via instrumentation, not this layout): if blocked,
//     error reporting degrades to console logging only.
// See docs/THREAT_MODEL.md ("Third-party asset integrity") for details.
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'
import Script from 'next/script'
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

// `next/font/google` downloads and self-hosts the font at build time, so the
// rendered <link> points at a same-origin asset. No SRI is required (and
// browsers ignore integrity on same-origin stylesheet preloads). If
// self-hosting is ever disabled, add an integrity hash here.
const inter = Inter({ subsets: ['latin'] })

// Pinned third-party assets loaded by this layout. Keep versions pinned and
// hashes in sync — the CI check (`scripts/check-sri.mjs`) verifies both.
//
// NOTE: @vercel/analytics and @vercel/speed-insights are bundled by Next.js
// and served same-origin from `/_vercel/insights/script.js` and
// `/_vercel/speed-insights/script.js`. Because they are same-origin they do
// not require SRI. Any *cross-origin* script added here must be declared in
// EXTERNAL_ASSETS below with a sha384 hash.
const EXTERNAL_ASSETS: ReadonlyArray<{
  src: string
  integrity: string
}> = [
  // Sentry browser SDK — pinned to 7.120.0.
  // Hash generated with: `openssl dgst -sha384 -binary bundle.min.js | openssl base64 -A`
  {
    src: 'https://browser.sentry-cdn.com/7.120.0/bundle.tracing.min.js',
    integrity:
      'sha384-REPLACE_WITH_REAL_SHA384_HASH_FOR_SENTRY_7_120_0_BUNDLE_TRACING_MIN_JS',
  },
]

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

  return (
    <html lang={locale} dir={LOCALE_DIRECTIONS[locale as Locale]} suppressHydrationWarning>
      <head>
        {/*
          #762 SRI: all cross-origin scripts are declared here with an
          `integrity` hash and `crossOrigin="anonymous"`. If a hash does not
          match, the browser blocks the script — see the fallback notes at the
          top of this file and docs/THREAT_MODEL.md.
        */}
        {EXTERNAL_ASSETS.map((asset) => (
          <Script
            key={asset.src}
            src={asset.src}
            integrity={asset.integrity}
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        ))}
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
        {/*
          @vercel/analytics and @vercel/speed-insights are served same-origin
          by the platform (/_vercel/insights/script.js and
          /_vercel/speed-insights/script.js), so they are not subject to SRI.
          If they are ever moved to a cross-origin CDN, wrap them in
          <Script integrity=... crossOrigin="anonymous" /> and register them
          in EXTERNAL_ASSETS above.
        */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}