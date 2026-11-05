// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Settings defects (P1), end to end in the browser.
 *
 * (a) Settings -> AI models lists only what can run: every provider the API
 *     reports as not usable gets one locked row (with the key form behind it),
 *     and none of that provider's built-in models fills the table. The expected
 *     locked set is read from GET /api/settings/ai/models, so the test follows
 *     whatever keys the deployment under test carries.
 * (b) The GitLab settings card with no connection opens the credential form in
 *     the card itself: the URL does not change.
 * (c) /settings/invoicing renders inside the Settings layout (settings sidebar,
 *     `settings-content`), not as an Invoicing app tab with the app sidebar.
 */

import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { seedModelPricing } from "./helpers/agent-seed"
import { installInvoicingApp } from "./invoicing/helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./invoicing/helpers/invoicing-bundle"

interface ModelsPayload {
  providers: { provider: string; usable: boolean }[]
  auto: { modelKey: string | null }
  models: { key: string; provider: string; native: boolean }[]
}

test("AI models: each provider without a usable key is one locked row, its models are not listed", async ({
  authenticatedPage,
  env,
  qa,
}) => {
  const page = authenticatedPage
  // The built-in model list comes from the pricing seed.
  await seedModelPricing(env)
  const res = await api(env.serverUrl, "/api/settings/ai/models", { token: qa.admin.token })
  expect(res.status).toBe(200)
  const payload = (res.body as { data: ModelsPayload }).data
  const locked = payload.providers.filter((p) => !p.usable).map((p) => p.provider)
  // Without one keyless provider the page has nothing to lock and this test
  // would prove nothing.
  expect(locked.length).toBeGreaterThan(0)

  await page.goto(`http://localhost:${env.ports[1]}/settings/ai-models`)
  await expect(page.getByTestId("ai-models-table")).toBeVisible({ timeout: 15_000 })

  for (const provider of locked) {
    await expect(page.getByTestId(`provider-locked-${provider}`)).toHaveCount(1)
    const card = page.getByTestId(`provider-card-${provider}`)
    await expect(card).toHaveAttribute("data-locked", "true")
  }
  for (const m of payload.models.filter((m) => locked.includes(m.provider))) {
    const row = page.getByTestId(`ai-model-row-${m.key}`)
    if (m.native && m.key !== payload.auto.modelKey) {
      await expect(row, `${m.key} of keyless ${m.provider} is listed`).toHaveCount(0)
    } else {
      // An added model (or the one Auto names) stays, flagged.
      await expect(page.getByTestId(`ai-model-key-removed-${m.key}`)).toBeVisible()
    }
  }

  // A provider that can run keeps its built-in models in the table, so the
  // table is not trivially empty.
  const usable = new Set(payload.providers.filter((p) => p.usable).map((p) => p.provider))
  const runnable = payload.models.filter((m) => m.native && usable.has(m.provider))
  expect(runnable.length).toBeGreaterThan(0)
  for (const m of runnable) {
    await expect(page.getByTestId(`ai-model-row-${m.key}`)).toHaveCount(1)
  }

  // The locked row still takes a key.
  const first = locked[0] as string
  await page.getByTestId(`provider-configure-${first}`).click()
  await expect(page.getByTestId(`provider-key-input-${first}`)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("ai-models-locked.png") })
})

test("GitLab card with no connection: Connect opens the credential form in the card", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  // The old address lands on the GitLab card of Settings > Connectors.
  const url = `http://localhost:${env.ports[1]}/settings/gitlab`
  await page.goto(url)
  const body = page.getByTestId("connector-body-gitlab")
  // No connection: one empty state, the card's own Connect (no status box above it).
  const cta = body.getByTestId("connections-connect-gitlab")
  await expect(cta).toBeVisible({ timeout: 15_000 })
  await expect(body.getByTestId("connections-status")).toHaveCount(0)
  await expect(cta).toBeVisible()
  const before = page.url()
  await cta.click()

  const inline = body.getByTestId("gitlab-inline-connect")
  await expect(inline).toBeVisible({ timeout: 10_000 })
  await expect(inline.getByTestId("connect-app-dialog")).toBeVisible({ timeout: 10_000 })
  await expect(inline.getByTestId("connect-submit")).toBeVisible()
  expect(page.url()).toBe(before)
  await expect(
    page.getByTestId("settings-content").getByTestId("connector-card-gitlab"),
  ).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("gitlab-inline-connect.png") })
})

test("/settings/invoicing renders in the Settings layout, not the Invoicing app", async ({
  authenticatedPage,
  env,
  world,
  qa,
}) => {
  test.setTimeout(120_000)
  expect(existsSync(INVOICING_BUNDLE)).toBe(true)
  await installInvoicingApp({
    serverUrl: env.serverUrl,
    token: qa.admin.token,
    orgId: world.org.id,
    bundlePath: INVOICING_BUNDLE,
    issuerCountry: "FR",
  })
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings/invoicing`)
  const content = page.getByTestId("settings-content")
  await expect(content.getByTestId("invoicing-settings").first()).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/\/settings\/apps\/invoicing/)
  await expect(page.getByTestId("settings-link-app:invoicing")).toBeVisible()
  await expect(page.getByTestId("invoicing-sidebar")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("settings-invoicing.png") })
})
