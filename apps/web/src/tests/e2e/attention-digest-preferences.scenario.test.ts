// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 PW-5] Attention preferences persist across reload — work hours, work
// days, timezone, validation. No clock advancement happens here (Amendment 2 —
// clock boundaries live in backend integration tests). Inline visuals V7
// (default state) and V8 (work-hours edited) cover the two terminal layouts.
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  })
  await page.waitForTimeout(ms)
}

/**
 * Screenshot the WHOLE panel. It scrolls inside the settings pane, so an
 * element screenshot at the 900px viewport painted only what the pane showed
 * and left the lower sections (work hours, devices) blank in the baseline.
 * Grow the viewport until the pane holds the entire panel, capture, restore.
 */
async function expectWholePanel(page: Page, panel: Locator, name: string): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("no viewport")
  const bottom = await panel.evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) p.scrollTop = 0
    const r = el.getBoundingClientRect()
    return Math.ceil(r.top + r.height)
  })
  // Headroom past the panel for the pane's bottom padding and the dock bar.
  await page.setViewportSize({ width: viewport.width, height: bottom + 200 })
  try {
    await settle(page)
    const clipped = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.bottom > window.innerHeight
    })
    expect(clipped, "the panel still overflows the grown viewport").toBe(false)
    await expect(panel).toHaveScreenshot(name, { maxDiffPixelRatio: 0.05 })
  } finally {
    await page.setViewportSize(viewport)
  }
}

test("attention.digest-preferences-persist-with-work-hours", async ({ page, env }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // Settings -> Notifications, reached through the old Attention path (it
  // redirects there) via the Vite-served URL.
  const vitePort = env.ports[1]
  await page.goto(`http://localhost:${vitePort}/settings/attention`)
  await expect(page).toHaveURL(/\/settings\/notifications$/, { timeout: 15_000 })
  const prefs = page.getByTestId("notification-settings")
  await expect(prefs).toBeVisible({ timeout: 15_000 })
  // Wait for the resource to settle so the radio group is rendered.
  await expect(page.getByTestId("attention-cadence-daily")).toBeVisible({ timeout: 10_000 })

  // [V7] Attention preferences default — Mon–Fri 09:00–17:00 schedule, save bar hidden.
  await settle(page)
  await expectWholePanel(page, prefs, "attention-preferences-default.png")

  // 1. Tighten the work window: drop Wednesday (mid-week) and adjust hours.
  await page.getByTestId("attention-workday-3").click()
  await page.getByTestId("attention-work-hours-start").fill("08:00")
  await page.getByTestId("attention-work-hours-end").fill("18:00")

  // 2. Timezone Europe/Paris
  await page.getByTestId("attention-timezone").selectOption("Europe/Paris")

  // [V8] Work-hours edited (Mon/Tue/Thu/Fri 08:00–18:00) + save bar visible.
  await settle(page)
  await expectWholePanel(page, prefs, "attention-preferences-work-edited.png")

  // Save and wait for the save bar to disappear (initial == latest).
  const saveResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/notifications/settings") &&
      response.request().method() === "PATCH",
  )
  await page.getByTestId("attention-save").click()
  const saveResponse = await saveResponsePromise
  expect(saveResponse.ok(), await saveResponse.text()).toBe(true)
  await expect(page.getByTestId("settings-save-bar")).toBeHidden({ timeout: 10_000 })

  // 4. Reload and assert persistence
  await page.reload()
  await expect(page.getByTestId("notification-settings")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("attention-cadence-daily").locator("input")).toBeChecked()
  await expect(page.getByTestId("attention-workday-1")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("attention-workday-3")).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByTestId("attention-workday-5")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("attention-work-hours-start")).toHaveValue("08:00")
  await expect(page.getByTestId("attention-work-hours-end")).toHaveValue("18:00")
  await expect(page.getByTestId("attention-timezone")).toHaveValue("Europe/Paris")

  // 5. Negative: deselecting every workday surfaces the inline error and keeps save disabled.
  for (const iso of [1, 2, 4, 5]) {
    await page.getByTestId(`attention-workday-${iso}`).click()
  }
  await expect(page.getByTestId("attention-workdays-error")).toBeVisible()
  const saveBtn = page.getByTestId("attention-save")
  if (await saveBtn.count()) {
    await expect(saveBtn).toBeDisabled()
  }
})
