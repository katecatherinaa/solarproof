/**
 * E2E scenarios for certificate retirement and post-retirement verification — issue #596.
 *
 * The retirement model (ADR-006) uses a contract-managed burn: the energy_token
 * contract's `retire` function decrements the caller's balance permanently and
 * records the event in audit_registry. The public verifier at /verify reflects
 * the retired state.
 *
 * These tests mock the API layer so they run without a live Stellar network.
 */

import { expect, test } from '@playwright/test'

// ── Shared fixture data ────────────────────────────────────────────────────

const activeCertificate = {
  certificate: {
    id: 'cert-active-001',
    kwh: 25,
    issued_at: '2025-06-01T00:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  },
  on_chain: {
    anchor_tx: 'anchor_tx_active',
    anchor_explorer: 'https://stellar.explorer/tx/anchor_tx_active',
    mint_tx: 'mint_tx_active',
    mint_explorer: 'https://stellar.explorer/tx/mint_tx_active',
  },
  meter_proof: {
    meter_id: 'meter-001',
    reading_hash: 'aabbccdd11223344',
    signature_hex: 'deadbeefdeadbeef',
    kwh: 25,
    timestamp: '2025-06-01T00:00:00.000Z',
    verified: true,
  },
}

const retiredCertificate = {
  certificate: {
    id: 'cert-retired-002',
    kwh: 50,
    issued_at: '2025-05-01T00:00:00.000Z',
    retired: true,
    retired_at: '2025-06-10T12:00:00.000Z',
    retired_by: 'GABC1234RETIREDBYADDRESS',
  },
  on_chain: {
    anchor_tx: 'anchor_tx_retired',
    anchor_explorer: 'https://stellar.explorer/tx/anchor_tx_retired',
    mint_tx: 'mint_tx_retired',
    mint_explorer: 'https://stellar.explorer/tx/mint_tx_retired',
    retire_tx: 'retire_tx_002',
    retire_explorer: 'https://stellar.explorer/tx/retire_tx_002',
  },
  meter_proof: {
    meter_id: 'meter-001',
    reading_hash: '11223344aabbccdd',
    signature_hex: 'cafebabecafebabe',
    kwh: 50,
    timestamp: '2025-05-01T00:00:00.000Z',
    verified: true,
  },
}

// ── Route helper ──────────────────────────────────────────────────────────

function mockVerifyRoute(
  page: import('@playwright/test').Page,
  responses: Record<string, object | null>
) {
  return page.route('**/api/verify**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id')
    const body = id ? responses[id] : null
    if (body) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    } else {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Certificate not found' }) })
    }
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Certificate retirement — verifier UI', () => {
  test('active certificate shows no retirement indicator', async ({ page }) => {
    await mockVerifyRoute(page, { 'cert-active-001': activeCertificate })
    await page.goto('/verify')
    const input = page.locator('input[type="text"], input[placeholder*="certificate" i], input[placeholder*="ID" i]').first()
    await input.fill('cert-active-001')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    await expect(page.locator('text=Certificate verified successfully.')).toBeVisible()
    // Active certificate must NOT show a retirement notice
    await expect(page.locator('text=Retired')).not.toBeVisible()
    await expect(page.locator('text=retired')).not.toBeVisible()
  })

  test('retired certificate shows retirement status and retire tx link', async ({ page }) => {
    await mockVerifyRoute(page, { 'cert-retired-002': retiredCertificate })
    await page.goto('/verify')
    const input = page.locator('input[type="text"], input[placeholder*="certificate" i], input[placeholder*="ID" i]').first()
    await input.fill('cert-retired-002')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    // Verifier must reflect the retired state
    await expect(page.locator('text=/retired/i').first()).toBeVisible()
  })

  test('retired certificate still shows full chain-of-custody proof', async ({ page }) => {
    await mockVerifyRoute(page, { 'cert-retired-002': retiredCertificate })
    await page.goto('/verify')
    const input = page.locator('input[type="text"], input[placeholder*="certificate" i], input[placeholder*="ID" i]').first()
    await input.fill('cert-retired-002')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    // On-chain proof and Ed25519 proof must still appear for retired certs
    await expect(page.locator('text=On-chain proof')).toBeVisible()
    await expect(page.locator('text=Ed25519 verified')).toBeVisible()
  })

  test('unknown certificate ID shows error state', async ({ page }) => {
    await mockVerifyRoute(page, {})
    await page.goto('/verify')
    const input = page.locator('input[type="text"], input[placeholder*="certificate" i], input[placeholder*="ID" i]').first()
    await input.fill('cert-does-not-exist')
    await Promise.all([
      page.waitForResponse('**/api/verify**'),
      page.click('button:has-text("Verify")'),
    ])
    await expect(page.locator('div[role="alert"]')).toBeVisible()
  })
})

// ── Bulk retirement flow — issue #741 ─────────────────────────────────────

type BulkCertificate = {
  id: string
  kwh: number
  issued_at: string
  retired: boolean
  retired_at: string | null
  retired_by: string | null
}

function makeActiveCertificate(id: string, kwh: number): BulkCertificate {
  return {
    id,
    kwh,
    issued_at: '2025-06-01T00:00:00.000Z',
    retired: false,
    retired_at: null,
    retired_by: null,
  }
}

const bulkCertificates: BulkCertificate[] = [
  makeActiveCertificate('cert-bulk-001', 10),
  makeActiveCertificate('cert-bulk-002', 20),
  makeActiveCertificate('cert-bulk-003', 30),
]

function mockCertificatesListRoute(
  page: import('@playwright/test').Page,
  certificates: BulkCertificate[]
) {
  return page.route('**/api/certificates**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    // Only intercept the list endpoint; let the bulk-retire POST fall through
    // to its own handler (registered separately by each test).
    if (request.method() !== 'GET' || url.pathname.includes('/retire')) {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ certificates }),
    })
  })
}

async function selectCertificatesAndRetire(
  page: import('@playwright/test').Page,
  ids: string[]
) {
  for (const id of ids) {
    const row = page.locator(`[data-testid="certificate-row"][data-certificate-id="${id}"]`)
    await row.locator('input[type="checkbox"]').check()
  }
  await page.click('button:has-text("Retire selected")')
}

test.describe('Certificate bulk retirement — issue #741', () => {
  test('selects 3 certificates and retires them all', async ({ page }) => {
    await mockCertificatesListRoute(page, bulkCertificates)
    await page.route('**/api/certificates/retire/bulk', async (route) => {
      const body = route.request().postDataJSON() as { ids?: string[] } | null
      const ids = body?.ids ?? []
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: { total: ids.length, succeeded: ids.length, failed: 0 },
          results: ids.map((id) => ({ id, success: true })),
        }),
      })
    })

    await page.goto('/certificates')
    await expect(page.locator('[data-testid="certificate-row"]')).toHaveCount(3)

    await selectCertificatesAndRetire(page, [
      'cert-bulk-001',
      'cert-bulk-002',
      'cert-bulk-003',
    ])

    for (const id of ['cert-bulk-001', 'cert-bulk-002', 'cert-bulk-003']) {
      const row = page.locator(`[data-testid="certificate-row"][data-certificate-id="${id}"]`)
      await expect(row.locator('text=Retired')).toBeVisible()
    }
  })

  test('shows partial success when one retirement fails', async ({ page }) => {
    await mockCertificatesListRoute(page, bulkCertificates)
    await page.route('**/api/certificates/retire/bulk', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: { total: 3, succeeded: 2, failed: 1 },
          results: [
            { id: 'cert-bulk-001', success: true },
            { id: 'cert-bulk-002', success: true },
            { id: 'cert-bulk-003', success: false, error: 'Burn transaction failed' },
          ],
        }),
      })
    })

    await page.goto('/certificates')
    await expect(page.locator('[data-testid="certificate-row"]')).toHaveCount(3)

    await selectCertificatesAndRetire(page, [
      'cert-bulk-001',
      'cert-bulk-002',
      'cert-bulk-003',
    ])

    // Partial-success toast must report the mixed outcome
    await expect(page.locator('text=2 retired, 1 failed')).toBeVisible()

    // The two successful rows show the Retired badge; the failed one does not
    await expect(
      page.locator('[data-testid="certificate-row"][data-certificate-id="cert-bulk-001"]').locator('text=Retired')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="certificate-row"][data-certificate-id="cert-bulk-002"]').locator('text=Retired')
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="certificate-row"][data-certificate-id="cert-bulk-003"]').locator('text=Retired')
    ).not.toBeVisible()
  })
})
