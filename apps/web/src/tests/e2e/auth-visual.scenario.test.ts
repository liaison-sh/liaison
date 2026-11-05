// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "./fixtures/test"

// ─────────────────────────────────────────────────────────────────────────────
// Visual Regression Tests — Screenshot baselines
//
// No QA scenario equivalent — these are automated visual regression checks.
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: find input inside a container that has a label. */
function labeledInput(page: import("@playwright/test").Page, labelText: string) {
  return page.locator(`div:has(> label:text-is("${labelText}")) input`).first()
}

/** Helper: wait for fonts to load and UI to settle. */
async function waitForFontsAndSettle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready)
  // Small delay for font rendering to complete — genuine rendering settle time
  await page.waitForTimeout(200)
}

test.describe("Auth Pages", () => {
  test("visual: login page", async ({ page, env }) => {
    const vitePort = env.ports[1]

    await page.goto(`http://localhost:${vitePort}/login`)
    await expect(page.getByText("Sign in to your workspace")).toBeVisible()
    await waitForFontsAndSettle(page)

    await expect(page.getByTestId("auth-card")).toBeVisible()
    // Full-page screenshot — card height varies by OAuth provider state (worker-dependent),
    // but the viewport (1440x900) is always the same.
    await expect(page).toHaveScreenshot("login-default.png", {
      maxDiffPixelRatio: 0.05,
      fullPage: false,
    })
  })

  test("visual: register page", async ({ page, env }) => {
    const vitePort = env.ports[1]

    await page.goto(`http://localhost:${vitePort}/register`)
    await expect(page.getByText("Create your account")).toBeVisible()
    await waitForFontsAndSettle(page)

    await expect(page.getByTestId("auth-card")).toBeVisible()
    await expect(page).toHaveScreenshot("register-default.png", {
      maxDiffPixelRatio: 0.05,
      fullPage: false,
    })
  })
})

test.describe("Shell Layout", () => {
  test("visual: shell full layout", async ({ authenticatedPage }) => {
    await waitForFontsAndSettle(authenticatedPage)

    await expect(authenticatedPage.locator("[data-shell]")).toHaveScreenshot("shell-full.png", {
      maxDiffPixelRatio: 0.05,
      mask: [authenticatedPage.locator('[data-testid="sidebar"]')],
    })
  })
})

test.describe("Activity Bar", () => {
  test("visual: activity bar home active", async ({ authenticatedPage }) => {
    await waitForFontsAndSettle(authenticatedPage)

    const activityBar = authenticatedPage.locator('[data-testid="activity-bar"]')
    await expect(activityBar).toHaveScreenshot("activity-bar-home.png", {
      maxDiffPixelRatio: 0.05,
    })
  })

  test("visual: activity bar settings active", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.keyboard.press("Escape")
    await authenticatedPage.mouse.click(720, 450)
    await waitForFontsAndSettle(authenticatedPage)

    const activityBar = authenticatedPage.locator('[data-testid="activity-bar"]')
    await expect(activityBar).toHaveScreenshot("activity-bar-settings.png", {
      maxDiffPixelRatio: 0.05,
    })
  })
})

test.describe("Settings", () => {
  test("visual: settings profile", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(authenticatedPage.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 5000,
    })
    await expect(labeledInput(authenticatedPage, "Display name")).toBeVisible({ timeout: 5000 })
    await waitForFontsAndSettle(authenticatedPage)

    const content = authenticatedPage.getByTestId("settings-content")
    await expect(content).toHaveScreenshot("settings-profile.png", {
      maxDiffPixelRatio: 0.05,
    })
  })

  test("visual: toast success", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(labeledInput(authenticatedPage, "Display name")).toBeVisible({ timeout: 5000 })

    await authenticatedPage.getByRole("button", { name: /save changes/i }).click()
    const toast = authenticatedPage.getByText("Profile updated")
    await expect(toast).toBeVisible({ timeout: 5000 })
  })
})
