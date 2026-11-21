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
  // Restrict powerful browser features to same-origin only.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  // NOTE: The Content-Security-Policy header is intentionally NOT set here.
  // A per-request nonce must be generated for each request, which is not
  // possible from a static `headers()` config. The CSP (including
  // `script-src 'self' 'nonce-{value}' 'strict-dynamic'`) is emitted by
  // `src/middleware.ts`, which also forwards the nonce to the app via the
  // `x-nonce` request header so inline scripts (Next.js hydration and the
  // Sentry loader) can be tagged with it. Setting a second CSP header here
  // would conflict with the middleware-generated one and cause the browser
  // to enforce the intersection of both policies, breaking hydration.
  // See SECURITY.md for the full policy.
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
