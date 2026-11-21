import { test, expect } from '@playwright/test'

/**
 * E2E: connect wallet → view dashboard
 *
 * The dashboard is gated by WalletGate — it renders a "Connect Wallet" prompt
 * until a Freighter wallet is connected. In CI there is no real wallet extension,
 * so we mock the Freighter API on the window object before the page loads.
 */
test.describe('Dashboard — wallet gate', () => {
  test.beforeEach(async ({ page }) => {
    // Inject a minimal Freighter mock so WalletGate considers the wallet connected
    await page.addInitScript(() => {
      const mockPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
      ;(window as unknown as Record<string, unknown>).freighter = {
        isConnected: () => Promise.resolve(true),
        getPublicKey: () => Promise.resolve(mockPublicKey),
        getNetwork: () => Promise.resolve('TESTNET'),
        signTransaction: () => Promise.reject(new Error('not needed')),
      }
    })
  })

  test('shows dashboard content after wallet is connected', async ({ page }) => {
    await page.goto('/dashboard')
    // WalletGate should pass through — dashboard heading must be visible
    await expect(page.locator('h1, h2').filter({ hasText: /dashboard/i }).first()).toBeVisible({
      timeout: 15000,
    })
  })

  test('shows connect-wallet prompt when wallet is not connected', async ({ page }) => {
    // No mock injected — WalletGate should render the connect prompt
    await page.goto('/dashboard')
    await expect(
      page.locator('button, [role="button"]').filter({ hasText: /connect/i }).first()
    ).toBeVisible({ timeout: 10000 })
  })
})

/**
 * E2E: cooperative dashboard per-meter kWh breakdown chart
 *
 * The dashboard renders a stacked bar chart of kWh per meter per period, fed by
 * the server-side aggregated endpoint. A period selector (day / week / month)
 * refetches the aggregation, clicking a meter bar navigates to the meter detail
 * page, and an accessible data table can be toggled on and off.
 */
test.describe('Dashboard — per-meter kWh breakdown chart', () => {
  const mockPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'

  test.beforeEach(async ({ page }) => {
    // Inject a minimal Freighter mock so WalletGate considers the wallet connected
    await page.addInitScript(() => {
      const mockPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
      ;(window as unknown as Record<string, unknown>).freighter = {
        isConnected: () => Promise.resolve(true),
        getPublicKey: () => Promise.resolve(mockPublicKey),
        getNetwork: () => Promise.resolve('TESTNET'),
        signTransaction: () => Promise.reject(new Error('not needed')),
      }
    })
  })

  test('renders the stacked bar chart with per-meter series', async ({ page }) => {
    await page.goto('/dashboard')

    const chart = page.locator('[data-testid="meter-kwh-chart"]').first()
    await expect(chart).toBeVisible({ timeout: 15000 })

    // Each meter contributes a series/legend entry to the stacked chart
    const series = chart.locator('[data-testid="meter-series"]')
    await expect(series.first()).toBeVisible({ timeout: 15000 })
    expect(await series.count()).toBeGreaterThan(0)
  })

  test('period selector switches granularity and refetches aggregation', async ({ page }) => {
    await page.goto('/dashboard')

    const chart = page.locator('[data-testid="meter-kwh-chart"]').first()
    await expect(chart).toBeVisible({ timeout: 15000 })

    const periodSelector = page.locator('[data-testid="period-selector"]').first()
    await expect(periodSelector).toBeVisible({ timeout: 10000 })

    for (const period of ['day', 'week', 'month']) {
      const requestPromise = page.waitForRequest(
        (request) =>
          request.url().includes('/api/') &&
          request.url().toLowerCase().includes('aggregat') &&
          request.url().toLowerCase().includes(period),
        { timeout: 15000 }
      )

      const option = periodSelector
        .locator(`button, [role="radio"], [role="tab"], option`)
        .filter({ hasText: new RegExp(`^${period}$`, 'i') })
        .first()
      await expect(option).toBeVisible({ timeout: 10000 })
      await option.click()

      // Selecting a period must trigger a server-side refetch for that granularity
      await requestPromise
      await expect(chart).toBeVisible({ timeout: 15000 })
    }
  })

  test('clicking a meter bar navigates to the meter detail page', async ({ page }) => {
    await page.goto('/dashboard')

    const chart = page.locator('[data-testid="meter-kwh-chart"]').first()
    await expect(chart).toBeVisible({ timeout: 15000 })

    const meterBar = chart.locator('[data-testid="meter-bar"]').first()
    await expect(meterBar).toBeVisible({ timeout: 15000 })
    await meterBar.click()

    await expect(page).toHaveURL(/\/meters\/[^/?#]+/, { timeout: 15000 })
  })

  test('data table toggle shows and hides the accessible table', async ({ page }) => {
    await page.goto('/dashboard')

    const chart = page.locator('[data-testid="meter-kwh-chart"]').first()
    await expect(chart).toBeVisible({ timeout: 15000 })

    const toggle = page
      .locator('button, [role="button"], [role="switch"]')
      .filter({ hasText: /data table|show table|table view/i })
      .first()
    await expect(toggle).toBeVisible({ timeout: 10000 })

    const table = page.locator('[data-testid="meter-kwh-table"]').first()

    await toggle.click()
    await expect(table).toBeVisible({ timeout: 10000 })
    // Table must expose column headers for screen readers
    await expect(table.locator('th').first()).toBeVisible({ timeout: 10000 })

    await toggle.click()
    await expect(table).toBeHidden({ timeout: 10000 })
  })
})

/**
 * E2E: persistent dashboard filter settings
 *
 * Filter state (date range, meter selection, certificate status) should be
 * persisted to localStorage per-user and restored on the next page load.
 * The "Reset filters" button must clear the stored state and restore defaults.
 */
test.describe('Dashboard — persistent filter settings', () => {
  const mockPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'

  test.beforeEach(async ({ page }) => {
    // Inject a minimal Freighter mock so WalletGate considers the wallet connected
    await page.addInitScript(() => {
      const mockPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
      ;(window as unknown as Record<string, unknown>).freighter = {
        isConnected: () => Promise.resolve(true),
        getPublicKey: () => Promise.resolve(mockPublicKey),
        getNetwork: () => Promise.resolve('TESTNET'),
        signTransaction: () => Promise.reject(new Error('not needed')),
      }
    })
  })

  test('persists filter state to localStorage on change', async ({ page }) => {
    await page.goto('/certificates')

    const statusFilter = page.locator('select[name="status"], [data-testid="status-filter"]').first()
    await expect(statusFilter).toBeVisible({ timeout: 15000 })
    await statusFilter.selectOption({ index: 1 })

    // Stored state must be scoped per-user (keyed by the connected public key)
    const stored = await page.evaluate(() => {
      const entries: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key) entries[key] = localStorage.getItem(key) ?? ''
      }
      return entries
    })
    const matchingKeys = Object.keys(stored).filter((key) => key.includes(mockPublicKey))
    expect(matchingKeys.length).toBeGreaterThan(0)
  })

  test('restores filter state on next page load', async ({ page }) => {
    await page.goto('/certificates')

    const statusFilter = page.locator('select[name="status"], [data-testid="status-filter"]').first()
    await expect(statusFilter).toBeVisible({ timeout: 15000 })
    await statusFilter.selectOption({ index: 1 })
    const selectedValue = await statusFilter.inputValue()

    await page.reload()

    const restoredFilter = page
      .locator('select[name="status"], [data-testid="status-filter"]')
      .first()
    await expect(restoredFilter).toBeVisible({ timeout: 15000 })
    await expect(restoredFilter).toHaveValue(selectedValue)
  })

  test('"Reset filters" clears stored state and restores defaults', async ({ page }) => {
    await page.goto('/certificates')

    const statusFilter = page.locator('select[name="status"], [data-testid="status-filter"]').first()
    await expect(statusFilter).toBeVisible({ timeout: 15000 })
    const defaultValue = await statusFilter.inputValue()
    await statusFilter.selectOption({ index: 1 })

    const resetButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /reset filters/i })
      .first()
    await expect(resetButton).toBeVisible({ timeout: 10000 })
    await resetButton.click()

    await expect(statusFilter).toHaveValue(defaultValue)

    await page.reload()
    const restoredFilter = page
      .locator('select[name="status"], [data-testid="status-filter"]')
      .first()
    await expect(restoredFilter).toBeVisible({ timeout: 15000 })
    await expect(restoredFilter).toHaveValue(defaultValue)
  })
})
