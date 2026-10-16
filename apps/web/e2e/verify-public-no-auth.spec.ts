/**
 * Playwright tests for the public verifier page — no-auth access (#108).
 *
 * These tests cover the unauthenticated public access scenario where any
 * visitor (no session cookie, incognito-equivalent context) can verify a
 * certificate by ID or transaction hash.
 *
 * All network calls to `/api/verify` are intercepted via `page.route` so the
 * tests are fully deterministic and do not require a live backend.
 */

import { BrowserContext, expect, Page, test } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixtures — shared mock data
// ---------------------------------------------------------------------------

const VALID_CERT_ID = 'pub-cert-abc123'
const VALID_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const INVALID_CERT_ID = 'does-not-exist-000'

const validCertResponse = {
  certificate: {
    id: VALID_CERT_ID,
    kwh: 100,
    issued_at: '2025-06-01T12:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  },
  on_chain: {
    anchor_tx: VALID_TX_HASH,
    anchor_explorer: `https://stellar.expert/explorer/testnet/tx/${VALID_TX_HASH}`,
    mint_tx: 'mint_tx_pub_abc123',
    mint_explorer: `https://stellar.expert/explorer/testnet/tx/mint_tx_pub_abc123`,
  },
  meter_proof: {
    meter_id: 'meter-pub-001',
    reading_hash: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    signature_hex: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
    kwh: 100,
    timestamp: '2025-06-01T11:59:00.000Z',
    verified: true,
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register route intercepts for /api/verify on `page`.
 *
 * - `?id=<VALID_CERT_ID>`     → 200 with full certificate payload
 * - `?tx=<VALID_TX_HASH>`     → 200 with full certificate payload
 * - `?id=<INVALID_CERT_ID>`   → 404 with error body
 * - anything else             → continues to the real network
 */
async function mockVerifyApi(page: Page): Promise<void> {
  await page.route('**/api/verify**', async (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get('id')
    const tx = url.searchParams.get('tx')

    if (id === VALID_CERT_ID || tx === VALID_TX_HASH) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(validCertResponse),
      })
      return
    }

    if (id === INVALID_CERT_ID) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Certificate not found' }),
      })
      return
    }

    await route.continue()
  })
}

// ---------------------------------------------------------------------------
// Test group — unauthenticated (default browser context, no cookies)
// ---------------------------------------------------------------------------

test.describe('Public verifier — unauthenticated access', () => {
  test.beforeEach(async ({ page }) => {
    await mockVerifyApi(page)
  })

  // ── Test 1: verify valid certificate by ID → full chain of custody ────────

  test('verify valid certificate by ID shows full chain of custody', async ({ page }) => {
    await page.goto('/verify')

    // Fill certificate ID into the search field.
    const input = page.locator('input[name="id"], input[placeholder*="certificate"], input[placeholder*="ID"]').first()
    await input.fill(VALID_CERT_ID)

    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])

    // Certificate verified confirmation.
    await expect(
      page.locator('text=Certificate verified').first(),
    ).toBeVisible({ timeout: 10000 })

    // Full chain of custody panel should be present.
    await expect(
      page.locator('[data-testid="chain-of-custody"], text=chain of custody, text=On-chain proof').first(),
    ).toBeVisible({ timeout: 10000 })

    // Ed25519 signature verification badge.
    await expect(
      page.locator('text=Ed25519 verified, text=signature verified').first(),
    ).toBeVisible({ timeout: 10000 })

    // On-chain anchor and mint transaction info visible.
    await expect(
      page.locator(`text=${VALID_TX_HASH}, [href*="${VALID_TX_HASH}"]`).first(),
    ).toBeVisible({ timeout: 10000 })
  })

  // ── Test 2: verify by transaction hash → shows certificate ────────────────

  test('verify by transaction hash shows certificate details', async ({ page }) => {
    await page.goto('/verify')

    // Some implementations expose a "verify by tx hash" tab or the same input
    // accepts hashes — fill in the tx hash.
    const input = page.locator(
      'input[name="tx"], input[name="hash"], input[placeholder*="hash"], input[placeholder*="transaction"], input[name="id"], input[placeholder*="certificate"]',
    ).first()
    await input.fill(VALID_TX_HASH)

    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])

    // A certificate result must appear — either the verified confirmation or
    // the certificate ID is shown somewhere on the page.
    await expect(
      page.locator(`text=Certificate verified, text=${VALID_CERT_ID}`).first(),
    ).toBeVisible({ timeout: 10000 })
  })

  // ── Test 3: invalid ID → shows not-found error ────────────────────────────

  test('invalid certificate ID shows not-found error message', async ({ page }) => {
    await page.goto('/verify')

    const input = page.locator('input[name="id"], input[placeholder*="certificate"], input[placeholder*="ID"]').first()
    await input.fill(INVALID_CERT_ID)

    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])

    // An error/alert element with a "not found" message must be visible.
    await expect(
      page.locator(
        'div[role="alert"], [data-testid="error-message"], text=not found, text=Certificate not found',
      ).first(),
    ).toBeVisible({ timeout: 10000 })

    // No chain-of-custody panel must appear for an invalid certificate.
    await expect(
      page.locator('[data-testid="chain-of-custody"]'),
    ).not.toBeVisible()
  })

  // ── Test 4: page is accessible without a session cookie ───────────────────

  test('verifier page loads without a session cookie (no auth required)', async ({ page }) => {
    // Ensure no auth cookies are present by clearing storage before navigation.
    await page.context().clearCookies()

    await mockVerifyApi(page)
    await page.goto('/verify')

    // The page must load without redirecting to a login page.
    await expect(page).not.toHaveURL(/\/login|\/signin|\/auth/, { timeout: 10000 })

    // The verify form/button must be present even without authentication.
    await expect(
      page.locator('button:has-text("Verify"), [data-testid="verify-button"]').first(),
    ).toBeVisible({ timeout: 10000 })
  })
})

// ---------------------------------------------------------------------------
// Test group — incognito context (no persistent session)
// ---------------------------------------------------------------------------

test.describe('Public verifier — incognito context (no session)', () => {
  let incognitoContext: BrowserContext
  let incognitoPage: Page

  test.beforeEach(async ({ browser }) => {
    // Create a completely fresh browser context: no cookies, no localStorage,
    // no service workers — equivalent to opening a private/incognito window.
    incognitoContext = await browser.newContext({
      storageState: undefined,
    })
    incognitoPage = await incognitoContext.newPage()
    await mockVerifyApi(incognitoPage)
  })

  test.afterEach(async () => {
    await incognitoContext.close()
  })

  test('unauthenticated user can verify a valid certificate in incognito mode', async () => {
    await incognitoPage.goto('/verify')

    // Must not redirect to login.
    await expect(incognitoPage).not.toHaveURL(/\/login|\/signin|\/auth/, { timeout: 10000 })

    const input = incognitoPage.locator(
      'input[name="id"], input[placeholder*="certificate"], input[placeholder*="ID"]',
    ).first()
    await input.fill(VALID_CERT_ID)

    await Promise.all([
      incognitoPage.waitForResponse('**/api/verify**'),
      incognitoPage.click('button:has-text("Verify")'),
    ])

    await expect(
      incognitoPage.locator('text=Certificate verified').first(),
    ).toBeVisible({ timeout: 10000 })
  })

  test('unauthenticated user sees not-found error for invalid ID in incognito mode', async () => {
    await incognitoPage.goto('/verify')

    const input = incognitoPage.locator(
      'input[name="id"], input[placeholder*="certificate"], input[placeholder*="ID"]',
    ).first()
    await input.fill(INVALID_CERT_ID)

    await Promise.all([
      incognitoPage.waitForResponse('**/api/verify**'),
      incognitoPage.click('button:has-text("Verify")'),
    ])

    await expect(
      incognitoPage.locator(
        'div[role="alert"], text=not found, text=Certificate not found',
      ).first(),
    ).toBeVisible({ timeout: 10000 })
  })
})
