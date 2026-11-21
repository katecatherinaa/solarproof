import { expect, test } from '@playwright/test'

const validTxHash = 'a'.repeat(64)

const validResponse = {
  certificate: {
    id: 'valid-certificate-id',
    kwh: 42,
    issued_at: '2025-01-01T00:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  },
  on_chain: {
    anchor_tx: 'anchor_tx_123',
    anchor_explorer: 'https://stellar.explorer/tx/anchor_tx_123',
    mint_tx: 'mint_tx_123',
    mint_explorer: 'https://stellar.explorer/tx/mint_tx_123',
  },
  meter_proof: {
    meter_id: 'meter-123',
    reading_hash: 'abcdef1234567890',
    signature_hex: 'deadbeefdeadbeefdeadbeefdeadbeef',
    kwh: 42,
    timestamp: '2025-01-01T00:00:00.000Z',
    verified: true,
  },
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/verify**', async (route) => {
    const url = route.request().url()
    const parsedUrl = new URL(url)
    const queryId = parsedUrl.searchParams.get('id')

    if (queryId === 'valid-certificate-id') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(validResponse),
      })
      return
    }

    if (queryId === 'invalid-certificate-id') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Certificate not found' }),
      })
      return
    }

    const queryTx = parsedUrl.searchParams.get('tx')
    if (queryTx === validTxHash) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(validResponse),
      })
      return
    }

    if (queryTx) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Certificate not found' }),
      })
      return
    }

    await route.continue()
  })
})

test('submits a valid certificate ID and shows verified proof steps', async ({ page }) => {
  await page.goto('/verify')
  await Promise.all([
    page.waitForResponse('**/api/verify**'),
    page.click('button:has-text("Verify")'),
  ])
  await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()
  await expect(page.locator('text=Certificate verified — full chain of custody confirmed')).toBeVisible()
  await expect(page.locator('text=On-chain proof')).toBeVisible()
  await expect(page.locator('text=Ed25519 verified')).toBeVisible()
})

test('submits an invalid certificate ID and shows an error state', async ({ page }) => {
  await page.goto('/verify')
  await Promise.all([
    page.waitForResponse('**/api/verify**'),
    page.click('button:has-text("Verify")'),
  ])
  await expect(page.locator('div[role="alert"]', { hasText: 'Certificate not found' })).toBeVisible()
})

test('resolves a certificate from a tx hash query param', async ({ page }) => {
  await page.goto(`/verify?tx=${validTxHash}`)
  await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()
  await expect(page.locator('text=On-chain proof')).toBeVisible()
})

test('search input accepts a 64-char hex tx hash', async ({ page }) => {
  await page.goto('/verify')
  await page.fill('input[name="certificateId"]', validTxHash)
  await Promise.all([
    page.waitForResponse('**/api/verify**'),
    page.click('button:has-text("Verify")'),
  ])
  await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()
})

test('shows a clear not-found message for an unknown tx hash', async ({ page }) => {
  const unknownTxHash = 'b'.repeat(64)
  await page.goto('/verify')
  await page.fill('input[name="certificateId"]', unknownTxHash)
  await Promise.all([
    page.waitForResponse('**/api/verify**'),
    page.click('button:has-text("Verify")'),
  ])
  await expect(page.locator('div[role="alert"]', { hasText: 'Certificate not found' })).toBeVisible()
})

test.describe('kiosk mode', () => {
  test('activates kiosk layout with full-screen container and enlarged touch targets', async ({ page }) => {
    await page.goto('/verify?kiosk=1')

    const kioskContainer = page.locator('[data-kiosk="true"]')
    await expect(kioskContainer).toBeVisible()

    const verifyButton = page.locator('button:has-text("Verify")')
    await expect(verifyButton).toBeVisible()

    const box = await verifyButton.boundingBox()
    expect(box).not.toBeNull()
    // Touch-friendly target: at least 48x48 CSS pixels (WCAG 2.1 AA / 2.5.5).
    expect(box!.height).toBeGreaterThanOrEqual(48)
    expect(box!.width).toBeGreaterThanOrEqual(48)
  })

  test('auto-resets to home state after 60s inactivity and clears the query', async ({ page }) => {
    await page.clock.install()
    await page.goto('/verify?kiosk=1')

    await expect(page.locator('[data-kiosk="true"]')).toBeVisible()

    await page.fill('input[name="certificateId"]', 'valid-certificate-id')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()

    // Advance past the 60s inactivity window.
    await page.clock.fastForward(61_000)

    await expect(page.locator('text=Certificate verified successfully.')).toBeHidden()
    await expect(page.locator('input[name="certificateId"]')).toHaveValue('')
    await expect(page).toHaveURL(/\/verify$/)
  })

  test('interacting with the page resets the inactivity timer', async ({ page }) => {
    await page.clock.install()
    await page.goto('/verify?kiosk=1')

    await expect(page.locator('[data-kiosk="true"]')).toBeVisible()

    await page.fill('input[name="certificateId"]', 'valid-certificate-id')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()

    // Wait most of the inactivity window, then interact to reset the timer.
    await page.clock.fastForward(50_000)
    await page.click('body')

    // Another 50s should not trigger the reset because the timer restarted.
    await page.clock.fastForward(50_000)
    await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()

    // Past the full 60s since the last interaction, the reset should occur.
    await page.clock.fastForward(11_000)
    await expect(page.locator('text=Certificate verified successfully.')).toBeHidden()
    await expect(page).toHaveURL(/\/verify$/)
  })
})
