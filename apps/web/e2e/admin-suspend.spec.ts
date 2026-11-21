import { test, expect, Page } from '@playwright/test';

/**
 * E2E coverage for the admin operator suspend/unsuspend flow.
 *
 * Issue #751: A regression could allow suspended operators to continue
 * submitting readings. This spec verifies the admin page's suspend toggle
 * correctly reflects state changes in the UI.
 *
 * Credentials are read from test-only env vars:
 *   - E2E_ADMIN_TOKEN: admin session token seeded into sessionStorage
 *   - E2E_OPERATOR_NAME: name of the seeded operator to toggle (optional,
 *     defaults to 'Test Operator')
 */

const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN;
const OPERATOR_NAME = process.env.E2E_OPERATOR_NAME ?? 'Test Operator';

/**
 * Seeds the admin token into sessionStorage before the app boots so the
 * admin page renders in an authenticated state.
 */
async function seedAdminSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((adminToken: string) => {
    window.sessionStorage.setItem('adminToken', adminToken);
  }, token);
}

test.describe('Admin operator suspend/unsuspend flow', () => {
  test.skip(
    !ADMIN_TOKEN,
    'E2E_ADMIN_TOKEN is not set; skipping admin suspend E2E test.',
  );

  test.beforeEach(async ({ page }) => {
    await seedAdminSession(page, ADMIN_TOKEN as string);
  });

  test('suspends an operator and unsuspends them again', async ({ page }) => {
    await page.goto('/admin');

    // Locate the operator row by its accessible name.
    const operatorRow = page
      .getByRole('row')
      .filter({ hasText: OPERATOR_NAME });

    await expect(operatorRow).toBeVisible();

    // Initially the operator should be Active.
    await expect(operatorRow.getByText('Active')).toBeVisible();

    // Suspend the operator.
    await operatorRow
      .getByRole('button', { name: `Suspend ${OPERATOR_NAME}` })
      .click();

    // Assert the row now shows the Suspended badge.
    await expect(operatorRow.getByText('Suspended')).toBeVisible();
    await expect(operatorRow.getByText('Active')).toHaveCount(0);

    // Unsuspend the operator.
    await operatorRow
      .getByRole('button', { name: `Unsuspend ${OPERATOR_NAME}` })
      .click();

    // Assert the badge returns to Active.
    await expect(operatorRow.getByText('Active')).toBeVisible();
    await expect(operatorRow.getByText('Suspended')).toHaveCount(0);
  });
});