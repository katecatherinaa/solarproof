import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Playwright E2E test for the meter key rotation flow.
 *
 * Covers issue #757:
 *  - Clicking 'Rotate key' on a meter
 *  - Success toast appears
 *  - New expiry date shown in meter detail (~90 days from now)
 *  - Old API key is rejected after rotation (401)
 */

const METER_NAME = `E2E Rotation Meter ${Date.now()}`;

interface MeterFixture {
  id: string;
  name: string;
  apiKey: string;
  expiresAt: string;
}

/**
 * Seed a meter via the API. Falls back to UI creation if the API is not
 * available in the current environment.
 */
async function seedMeter(
  request: APIRequestContext,
  page: Page,
): Promise<MeterFixture> {
  const res = await request.post('/api/meters', {
    data: {
      name: METER_NAME,
      unit: 'kWh',
    },
  });

  if (res.ok()) {
    const body = (await res.json()) as MeterFixture;
    return body;
  }

  // Fallback: create the meter through the UI.
  await page.goto('/meters');
  await page.getByRole('button', { name: /add meter|new meter|create meter/i }).click();
  await page.getByLabel(/name/i).fill(METER_NAME);
  await page.getByLabel(/unit/i).fill('kWh');
  await page.getByRole('button', { name: /save|create/i }).click();
  await expect(page.getByText(METER_NAME)).toBeVisible();

  // Fetch the created meter via API to get its id + key.
  const listRes = await request.get('/api/meters');
  expect(listRes.ok()).toBeTruthy();
  const meters = (await listRes.json()) as MeterFixture[];
  const created = meters.find((m) => m.name === METER_NAME);
  expect(created, 'seeded meter should exist').toBeTruthy();
  return created as MeterFixture;
}

/**
 * Parse a human-readable expiry date string into a Date.
 */
function parseExpiry(text: string): Date {
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Try to extract an ISO-ish date from surrounding text.
  const match = text.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/);
  if (match) {
    const d = new Date(match[0]);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Could not parse expiry date from: "${text}"`);
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

test.describe('Meter key rotation', () => {
  test('rotates the API key, shows a success toast, updates expiry, and rejects the old key', async ({
    page,
    request,
  }) => {
    const meter = await seedMeter(request, page);

    // Navigate to the meter detail view.
    await page.goto(`/meters/${meter.id}`);
    await expect(page.getByRole('heading', { name: new RegExp(meter.name, 'i') })).toBeVisible();

    // Capture the current expiry date shown in the detail view.
    const expiryLocator = page.getByTestId('meter-expiry').or(
      page.getByText(/expires/i),
    );
    await expect(expiryLocator.first()).toBeVisible();
    const beforeExpiryText = (await expiryLocator.first().textContent()) ?? '';
    const beforeExpiry = parseExpiry(beforeExpiryText);

    // Click 'Rotate key'.
    const rotateButton = page.getByRole('button', { name: /rotate key/i });
    await expect(rotateButton).toBeVisible();
    await rotateButton.click();

    // Confirm in any dialog that may appear.
    const confirmButton = page.getByRole('button', { name: /^(confirm|rotate|yes)/i });
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click();
    }

    // Assert success toast appears (role=status / aria-live container).
    const toast = page
      .getByRole('status')
      .filter({ hasText: /rotat|success|key/i })
      .or(page.locator('[aria-live="polite"], [aria-live="assertive"]').filter({ hasText: /rotat|success|key/i }));
    await expect(toast.first()).toBeVisible({ timeout: 10_000 });
    await expect(toast.first()).toContainText(/rotat|success/i);

    // Assert the displayed expiry date updates to ~90 days from now.
    await expect
      .poll(async () => {
        const text = (await expiryLocator.first().textContent()) ?? '';
        try {
          return parseExpiry(text);
        } catch {
          return null;
        }
      }, { timeout: 10_000 })
      .not.toBeNull();

    const afterExpiryText = (await expiryLocator.first().textContent()) ?? '';
    const afterExpiry = parseExpiry(afterExpiryText);
    const now = new Date();
    const daysFromNow = daysBetween(afterExpiry, now);

    expect(daysFromNow).toBeGreaterThan(85);
    expect(daysFromNow).toBeLessThan(95);
    // Expiry should have moved forward relative to the previous value.
    expect(afterExpiry.getTime()).toBeGreaterThanOrEqual(beforeExpiry.getTime());

    // Attempt to POST a reading with the OLD API key — should be rejected with 401.
    const oldKeyRes = await request.post('/api/readings', {
      headers: {
        Authorization: `Bearer ${meter.apiKey}`,
        'X-API-Key': meter.apiKey,
      },
      data: {
        meterId: meter.id,
        value: 1.23,
        timestamp: new Date().toISOString(),
      },
    });
    expect(oldKeyRes.status()).toBe(401);
  });
});