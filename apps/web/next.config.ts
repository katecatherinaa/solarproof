import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n.ts')

// OWASP-recommended security headers applied to every route.
// Documented in SECURITY.md — keep both in sync when changing values.
const securityHeaders = [
  // HSTS: enforce HTTPS for at least one year, including all subdomains.
  // Only emitted in production so local development over HTTP is unaffected.
  ...(process.env.NODE_ENV === 'production'
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
  // Prevent the app from being framed (clickjacking protection).
  { key: 'X-Frame-Options', value: 'DENY' },
  // Disable MIME type sniffing.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Limit referrer information leaked to other origins.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Restrict powerful browser features: deny camera, microphone, geolocation,
  // payment and USB access to the app and any embedding iframes.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  {
    // Enforce mode (not Report-Only) in all environments.
    // Violations are POSTed to /api/csp-report which forwards them to Sentry.
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co https://soroban-testnet.stellar.org https://soroban.stellar.org wss://*.supabase.co",
      "frame-ancestors 'none'",
      "report-uri /api/csp-report",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  transpilePackages: ['@solarproof/stellar'],
  serverExternalPackages: [
    '@stellar/stellar-sdk',
    '@grpc/grpc-js',
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/otlp-grpc-exporter-base',
    'bullmq',
    'ioredis',
  ],
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve = config.resolve ?? {}
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        fs: false,
        net: false,
        tls: false,
        path: false,
        stream: false,
        os: false,
        http: false,
        https: false,
        zlib: false,
      }
    } else {
      // Externalize Node-only packages that webpack can't bundle for the edge/instrumentation context
      const nodeOnlyPackages = [
        '@grpc/grpc-js',
        '@opentelemetry/sdk-node',
        '@opentelemetry/exporter-logs-otlp-grpc',
        '@opentelemetry/otlp-grpc-exporter-base',
        'bullmq',
        'ioredis',
      ]
      const existingExternals = config.externals ?? []
      config.externals = [
        ...(Array.isArray(existingExternals) ? existingExternals : [existingExternals]),
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (request && nodeOnlyPackages.some(pkg => request === pkg || request.startsWith(pkg + '/'))) {
            return callback(null, `commonjs ${request}`)
          }
          callback()
        },
      ]
    }
    return config
  },
  async headers() {
    // Apply security headers to all routes, including API and static assets.
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}

export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: { disable: true },
  disableLogger: true,
})
