/**
 * Mobile and desktop viewport scenario coverage — issue #591.
 *
 * Verifies that key user flows work and render correctly on both mobile and
 * desktop viewports. The Playwright project matrix (playwright.config.ts)
 * runs these tests on real mobile device emulations (Pixel 5, iPhone 13) as
 * well as Desktop Chrome/Firefox/Safari, so individual tests here do not need
 * to set a viewport manually.
 */

import { expect, test } from '@playwright/test'

const validResponse = {
  certificate: {
    id: 'cert-viewport-test',
    kwh: 10,
    issued_at: '2025-06-01T00:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  },
  on_chain: {
    anchor_tx: 'anchor_tx_viewport',
    anchor_explorer: 'https://stellar.explorer/tx/anchor_tx_viewport',
    mint_tx: 'mint_tx_viewport',
    mint_explorer: 'https://stellar.explorer/tx/mint_tx_viewport',
  },
  meter_proof: {
    meter_id: 'meter-viewport',
    reading_hash: '1234abcd',
    signature_hex: 'beefbeefbeefbeef',
    kwh: 10,
    timestamp: '2025-06-01T00:00:00.000Z',
    verified: true,
  },
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/verify**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(validResponse),
    })
  })
})

test('home page renders primary CTA on any viewport', async ({ page }) => {
  await page.goto('/')
  // The primary call-to-action must be visible without horizontal scroll
  const body = page.locator('body')
  await expect(body).toBeVisible()
  const scrollWidth: number = await page.evaluate(() => document.body.scrollWidth)
  const clientWidth: number = await page.evaluate(() => document.body.clientWidth)
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1) // no horizontal overflow
})

test('verify page is usable and shows result on any viewport', async ({ page }) => {
  await page.goto('/verify')
  // Form and submit button must be reachable without horizontal scroll
  const verifyButton = page.locator('button:has-text("Verify")')
  await expect(verifyButton).toBeVisible()
  await Promise.all([
    page.waitForResponse('**/api/verify**'),
    verifyButton.click(),
  ])
  await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()
})

test('navigation is accessible on any viewport', async ({ page }) => {
  await page.goto('/')
  // On mobile, a hamburger / menu toggle may be present instead of a full nav.
  // Either the nav links are visible or a menu toggle exists.
  const hasVisibleNav = await page.locator('nav a').first().isVisible().catch(() => false)
  const hasMenuToggle = await page
    .locator('[aria-label*="menu" i], [aria-label*="navigation" i], button[aria-expanded]')
    .first()
    .isVisible()
    .catch(() => false)
  expect(hasVisibleNav || hasMenuToggle).toBe(true)
})

/**
 * Admin panel responsive layout — issue #234.
 *
 * The admin panel must not break on tablet viewports (768–1024 px): the
 * sidebar collapses to an off-canvas drawer at the `md` breakpoint (768 px),
 * data tables scroll horizontally instead of overflowing the page, and the
 * page body itself never scrolls horizontally.
 */
const adminTableRows = Array.from({ length: 12 }, (_, i) => ({
  id: `cert-admin-${i}`,
  kwh: 100 + i,
  issued_at: '2025-06-01T00:00:00.000Z',
  retired: i % 2 === 0,
  retired_at: null,
  retired_by: null,
  meter_id: `meter-admin-${i}`,
  anchor_tx: `anchor_tx_admin_${i}`,
  mint_tx: `mint_tx_admin_${i}`,
}))

async function stubAdmin(page: import('@playwright/test').Page) {
  // Stub auth so the admin route renders without a real session.
  await page.route('**/api/auth/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'admin-viewport', email: 'admin@example.com', role: 'admin' },
        authenticated: true,
      }),
    })
  })
  await page.route('**/api/admin/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: adminTableRows, total: adminTableRows.length }),
    })
  })
}

async function expectNoBodyHorizontalScroll(page: import('@playwright/test').Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
}

test.describe('admin panel responsive layout (#234)', () => {
  test.beforeEach(async ({ page }) => {
    await stubAdmin(page)
  })

  test('768px: sidebar is off-canvas and tables scroll horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/admin')
    await expect(page.locator('main, [role="main"]').first()).toBeVisible()

    await expectNoBodyHorizontalScroll(page)

    // Sidebar must be off-canvas (hidden or translated out of view) at md.
    const sidebar = page.locator('[data-testid="admin-sidebar"], aside').first()
    const sidebarBox = await sidebar.boundingBox()
    const sidebarOffCanvas =
      sidebarBox === null || sidebarBox.x + sidebarBox.width <= 1 || !(await sidebar.isVisible())
    expect(sidebarOffCanvas).toBe(true)

    // Tables must be horizontally scrollable rather than overflowing the page.
    const tableWrapper = page
      .locator('[data-testid="admin-table-wrapper"], .table-wrapper, [role="region"]')
      .first()
    await expect(tableWrapper).toBeVisible()
    const wrapperOverflow = await tableWrapper.evaluate(
      (el) => getComputedStyle(el).overflowX,
    )
    expect(['auto', 'scroll']).toContain(wrapperOverflow)

    await expect(page).toHaveScreenshot('admin-768.png', { fullPage: true })
  })

  test('1024px: sidebar is visible and tables scroll horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/admin')
    await expect(page.locator('main, [role="main"]').first()).toBeVisible()

    await expectNoBodyHorizontalScroll(page)

    // Sidebar must be visible at the desktop/tablet-landscape breakpoint.
    const sidebar = page.locator('[data-testid="admin-sidebar"], aside').first()
    await expect(sidebar).toBeVisible()

    const tableWrapper = page
      .locator('[data-testid="admin-table-wrapper"], .table-wrapper, [role="region"]')
      .first()
    await expect(tableWrapper).toBeVisible()
    const wrapperOverflow = await tableWrapper.evaluate(
      (el) => getComputedStyle(el).overflowX,
    )
    expect(['auto', 'scroll']).toContain(wrapperOverflow)

    await expect(page).toHaveScreenshot('admin-1024.png', { fullPage: true })
  })
})
