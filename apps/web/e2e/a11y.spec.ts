/**
 * Accessibility tests using axe-core — issue #124.
 *
 * These tests run axe-core on every major page and fail if critical or serious
 * violations are found. Baseline violations (if any) are documented below.
 */

import { test, expect } from '@playwright/test'
import { checkA11y } from './helpers/a11y'

test.describe('Accessibility (axe-core)', () => {
  test('skip link moves keyboard users to main content', async ({ page }) => {
    await page.goto('/')

    const skipLink = page.getByRole('link', { name: 'Skip to main content' })
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main-content')).toBeFocused()
  })

  test('verify page has no critical/serious violations', async ({ page }) => {
    await page.goto('/verify')
    await checkA11y(page)
  })

  test('home page has no critical/serious violations', async ({ page }) => {
    await page.goto('/')
    await checkA11y(page)
  })

  test('verify kiosk mode has no critical/serious violations', async ({ page }) => {
    await page.goto('/verify?kiosk=1')
    await checkA11y(page)
  })

  test('verify kiosk mode interactive elements meet touch target size', async ({ page }) => {
    await page.goto('/verify?kiosk=1')

    const interactive = page.locator(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
    )

    const count = await interactive.count()
    for (let i = 0; i < count; i++) {
      const el = interactive.nth(i)
      if (!(await el.isVisible())) continue

      const box = await el.boundingBox()
      if (!box) continue

      expect(
        box.width,
        `Interactive element ${i} width should be at least 44px`
      ).toBeGreaterThanOrEqual(44)
      expect(
        box.height,
        `Interactive element ${i} height should be at least 44px`
      ).toBeGreaterThanOrEqual(44)
    }
  })

  test('retire modal traps focus, closes on Escape, and has no violations', async ({ page }) => {
    await page.goto('/verify')

    const trigger = page.getByRole('button', { name: /retire/i }).first()
    await trigger.focus()
    await trigger.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Focus should move into the dialog on open
    await expect(dialog.locator(':focus')).toHaveCount(1)

    // Tab through all focusable elements and ensure focus stays inside the dialog
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      const focusInside = await dialog.evaluate((node) => node.contains(document.activeElement))
      expect(focusInside, 'Focus should remain trapped inside the retire modal').toBe(true)
    }

    // Run axe-core on the open dialog
    await checkA11y(page)

    // Escape closes the modal and restores focus to the trigger
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('transfer modal traps focus, closes on Escape, and has no violations', async ({ page }) => {
    await page.goto('/verify')

    const trigger = page.getByRole('button', { name: /transfer/i }).first()
    await trigger.focus()
    await trigger.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Focus should move into the dialog on open
    await expect(dialog.locator(':focus')).toHaveCount(1)

    // Tab through all focusable elements and ensure focus stays inside the dialog
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      const focusInside = await dialog.evaluate((node) => node.contains(document.activeElement))
      expect(focusInside, 'Focus should remain trapped inside the transfer modal').toBe(true)
    }

    // Run axe-core on the open dialog
    await checkA11y(page)

    // Escape closes the modal and restores focus to the trigger
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('verify kiosk mode interactive elements have visible focus indicators', async ({ page }) => {
    await page.goto('/verify?kiosk=1')

    const interactive = page.locator(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
    )

    const count = await interactive.count()
    for (let i = 0; i < count; i++) {
      const el = interactive.nth(i)
      if (!(await el.isVisible())) continue

      await el.focus()

      const hasFocusIndicator = await el.evaluate((node) => {
        const styles = window.getComputedStyle(node)
        const outlineStyle = styles.outlineStyle
        const outlineWidth = parseFloat(styles.outlineWidth || '0')
        const boxShadow = styles.boxShadow
        const borderColor = styles.borderColor
        const borderWidth = parseFloat(styles.borderWidth || '0')

        const hasOutline = outlineStyle !== 'none' && outlineWidth > 0
        const hasBoxShadow = boxShadow !== 'none' && boxShadow !== ''
        const hasBorder = borderWidth > 0 && borderColor !== ''

        return hasOutline || hasBoxShadow || hasBorder
      })

      expect(
        hasFocusIndicator,
        `Interactive element ${i} should have a visible focus indicator`
      ).toBe(true)
    }
  })
})

/**
 * Baseline violations (if any):
 *
 * None documented yet. If baseline violations are discovered that cannot be
 * fixed immediately, document them here with:
 *   - Rule ID
 *   - Impact level
 *   - Element selector
 *   - Reason for deferral
 *   - Tracking issue number
 *
 * Example:
 *   - color-contrast (moderate) on .footer-link — deferred to #999
 */