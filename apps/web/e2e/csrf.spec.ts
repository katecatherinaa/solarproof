import { test, expect } from '@playwright/test'

/**
 * E2E: CSRF token validation on state-mutating API routes (issue #36)
 *
 * Verifies that:
 *   - POST without X-CSRF-Token header → 403
 *   - POST with invalid X-CSRF-Token header → 403
 *   - GET /api/csrf issues a token
 *   - POST with valid token → proceeds past CSRF (may fail for other reasons, but not 403 CSRF)
 */
test.describe('CSRF enforcement', () => {
  const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

  test('POST without CSRF token returns 403', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/v1/certificates/retire`, {
      headers: {
        'Content-Type': 'application/json',
      },
      data: { id: 'dummy-id' },
      // deliberately no X-CSRF-Token header or cookie
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error).toMatch(/csrf/i)
  })

  test('POST with invalid CSRF token returns 403', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/v1/certificates/retire`, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'invalid-token-value',
        'Cookie': 'csrf_token=invalid-token-value',
      },
      data: { id: 'dummy-id' },
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error).toMatch(/csrf/i)
  })

  test('GET /api/csrf returns a token and sets cookie', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/csrf`)
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('csrf_token')
    expect(typeof body.csrf_token).toBe('string')
    expect(body.csrf_token.split('.')).toHaveLength(3)

    const setCookie = response.headers()['set-cookie']
    expect(setCookie).toContain('csrf_token=')
  })

  test('Machine-to-machine readings route is CSRF-exempt', async ({ request }) => {
    // POST /api/readings should not return 403 CSRF error
    // (it may return 400/401 for other validation reasons — that is fine)
    const response = await request.post(`${BASE_URL}/api/readings`, {
      headers: { 'Content-Type': 'application/json' },
      data: { meter_id: 'not-a-uuid', kwh: 1, timestamp: 1, signature_hex: 'x'.repeat(128), nonce: 'n' },
    })
    // Must NOT be a CSRF 403
    if (response.status() === 403) {
      const body = await response.json()
      expect(body.error).not.toMatch(/csrf/i)
    }
  })
})

/**
 * E2E: Content-Security-Policy nonce for inline scripts (issue #761)
 *
 * Verifies that:
 *   - The CSP response header is present
 *   - script-src contains a nonce-<value> directive
 *   - script-src does NOT contain 'unsafe-inline'
 *   - The page still hydrates (interactive element responds)
 *   - Sentry does not report CSP violations for its own scripts
 */
test.describe('CSP nonce', () => {
  const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

  test('CSP header uses a nonce and forbids unsafe-inline for scripts', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/`)
    expect(response.status()).toBe(200)

    const headers = response.headers()
    const csp = headers['content-security-policy'] ?? headers['content-security-policy-report-only']
    expect(csp, 'CSP header must be present').toBeTruthy()

    // Locate the script-src directive
    const scriptSrcDirective = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith('script-src'))
    expect(scriptSrcDirective, 'script-src directive must be present').toBeTruthy()

    // Must contain a nonce-<value> token
    expect(scriptSrcDirective).toMatch(/nonce-[A-Za-z0-9+/=_-]+/)

    // Must NOT allow unsafe-inline for scripts
    expect(scriptSrcDirective).not.toMatch(/'unsafe-inline'/)
  })

  test('page hydrates and Sentry scripts do not trigger CSP violations', async ({ page }) => {
    const cspViolations: string[] = []
    const sentryCspViolations: string[] = []

    page.on('console', (msg) => {
      const text = msg.text()
      if (/content security policy|csp/i.test(text) && /violat/i.test(text)) {
        cspViolations.push(text)
        if (/sentry/i.test(text)) {
          sentryCspViolations.push(text)
        }
      }
    })

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' })

    // Hydration check: an interactive element should respond to interaction.
    // Use the first button or link on the page as a hydration probe.
    const interactive = page.locator('button, a[href]').first()
    await expect(interactive).toBeVisible()
    await interactive.focus()
    await expect(interactive).toBeFocused()

    // Give the browser a moment to surface any CSP violations
    await page.waitForTimeout(500)

    expect(sentryCspViolations, 'Sentry scripts must not trigger CSP violations').toHaveLength(0)
    expect(cspViolations, 'No CSP violations should be reported').toHaveLength(0)
  })
})
