// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"

test.describe("Light mode", () => {
  test("switching to Light mode flips data-theme and applies light palette", async ({
    page,
    env,
  }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)

    const themeSelect = page.getByTestId("settings-theme-select")
    await expect(themeSelect).toBeVisible({ timeout: 30000 })

    await themeSelect.selectOption("light")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim(),
    )
    expect(bg).toBe("#fafafa")
  })

  test("reload preserves Light preference (FOUC-free first paint)", async ({ page, env }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await page.getByTestId("settings-theme-select").selectOption("light")
    // Wait for the PUT to land so the server has the preference.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await page.reload()
    // data-theme set by pre-paint inline script before Solid mounts.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  })

  test("System mode follows OS prefers-color-scheme", async ({ browser, env }) => {
    const darkCtx = await browser.newContext({ colorScheme: "dark" })
    const darkPage = await darkCtx.newPage()
    await loginAs(darkPage, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await darkPage.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await darkPage.getByTestId("settings-theme-select").selectOption("system")
    await expect(darkPage.locator("html")).toHaveAttribute("data-theme", "dark")
    await darkCtx.close()

    const lightCtx = await browser.newContext({ colorScheme: "light" })
    const lightPage = await lightCtx.newPage()
    await loginAs(lightPage, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await lightPage.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    // theme=system on the server; data-theme should resolve light here.
    await expect(lightPage.locator("html")).toHaveAttribute("data-theme", "light")
    await lightCtx.close()
  })
})
