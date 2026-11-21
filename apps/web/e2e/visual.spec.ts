import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for key UI components.
 *
 * These tests render the Navbar, CertificateCard, MeterRow and DashboardChart
 * components via a dedicated component harness route (`/visual-harness`) and
 * compare screenshots against committed baselines.
 *
 * Generating / updating baselines:
 *   pnpm playwright test --update-snapshots
 *
 * Baselines are stored in the repo under `apps/web/e2e/visual.spec.ts-snapshots/`.
 * OS-specific renders are gitignored (see `.gitignore`) so each platform keeps
 * its own snapshots locally; CI runs on a single pinned platform.
 *
 * CI fails when the pixel diff exceeds a 1% threshold
 * (`maxDiffPixelRatio: 0.01`).
 */

const MAX_DIFF_PIXEL_RATIO = 0.01;

test.describe('Visual regression', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the component harness route that renders each component
    // in isolation with deterministic data.
    await page.goto('/visual-harness');
    // Wait for fonts and layout to settle before capturing screenshots.
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
  });

  test('Navbar renders correctly', async ({ page }) => {
    const navbar = page.getByTestId('visual-navbar');
    await expect(navbar).toBeVisible();
    await expect(navbar).toHaveScreenshot('navbar.png', {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });

  test('CertificateCard renders correctly', async ({ page }) => {
    const certificateCard = page.getByTestId('visual-certificate-card');
    await expect(certificateCard).toBeVisible();
    await expect(certificateCard).toHaveScreenshot('certificate-card.png', {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });

  test('MeterRow renders correctly', async ({ page }) => {
    const meterRow = page.getByTestId('visual-meter-row');
    await expect(meterRow).toBeVisible();
    await expect(meterRow).toHaveScreenshot('meter-row.png', {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });

  test('DashboardChart renders correctly', async ({ page }) => {
    const dashboardChart = page.getByTestId('visual-dashboard-chart');
    await expect(dashboardChart).toBeVisible();
    // Charts may animate on mount; wait for the animation to finish.
    await page.waitForTimeout(500);
    await expect(dashboardChart).toHaveScreenshot('dashboard-chart.png', {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });
});