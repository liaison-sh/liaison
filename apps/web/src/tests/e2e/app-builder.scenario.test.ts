// SPDX-License-Identifier: FSL-1.1-ALv2
// App builder: a draft made from the store-crud template is listed on the App
// store page, opens in its builder tab, checks clean and runs a read-only
// preview of its list tool from the inline form.
//
// The builder exists only where organisations may have their own apps
// (LIAISON_CUSTOM_APPS, off by default on a self-hosted server like the shared
// test stack), so this file runs on a worker of its own with the switch on.
import { createProfiledE2ETest } from "./fixtures/profiled-test"
import { expect } from "./fixtures/test"
import { seedFactory } from "./helpers/seed"

const test = createProfiledE2ETest({
  workerIdOffset: 300,
  portCount: 2,
  before: async () => ({ env: { LIAISON_CUSTOM_APPS: "on" }, teardowns: [] }),
})

test("a draft checks and previews in the builder tab", async ({
  authenticatedPage,
  env,
  world,
}) => {
  const page = authenticatedPage
  const draft = await seedFactory<{ id: string; appName: string }>(
    env,
    world.org.id,
    "apps.builderDraft",
    { baseName: `e2e-${Date.now().toString(36)}`, title: "E2E returns", template: "store-crud" },
  )

  await page.goto(`http://localhost:${env.ports[1]}/settings/store`)
  await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  await page.getByTestId(`builder-draft-${draft.id}`).click()

  await expect(page.getByTestId("builder-title")).toHaveText("E2E returns")
  await expect(page).toHaveURL(new RegExp(`/apps/builder/${draft.id}$`))
  await expect(page.getByTestId("builder-no-build")).toBeVisible()

  await page.getByTestId("builder-check").click()
  await expect(page.getByTestId("builder-build-ok")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("builder-version-1")).toHaveAttribute("data-build", "ok")

  await page.getByTestId("builder-preview").click()
  await page.getByTestId("builder-preview-entry").selectOption("tool:items_list")
  await page.getByTestId("builder-preview-params").fill('{"limit": 5}')
  await page.getByTestId("builder-preview-run").click()
  const outcome = page.getByTestId("builder-preview-outcome")
  await expect(outcome).toHaveAttribute("data-ok", "true", { timeout: 30_000 })
  await expect(outcome).toContainText("items_list")
  await expect(page.getByTestId("builder-preview-value")).toBeVisible()
})
