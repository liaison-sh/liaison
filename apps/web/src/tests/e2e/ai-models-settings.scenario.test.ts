// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Settings -> AI -> AI models, end to end (S13).
 *
 * An admin saves an OpenRouter key, adds a model from OpenRouter's catalogue
 * (the add runs a real test call), switches one built-in model off and makes
 * the added model the one Auto runs. The composer's model menu then lists the
 * added model, no longer lists the switched-off one, and its Auto row names
 * the added model.
 *
 * OpenRouter is the stub global-setup starts (openrouter-stub-server.ts),
 * reached by the API server through OPENROUTER_BASE_URL: the key check hits
 * its GET /key, the catalogue its GET /models, and the test call its
 * POST /chat/completions, which answers with a call of the `ping` tool.
 */

import { MODEL_PRICING_SEED } from "../../../../../packages/shared/src/model-pricing-seed"
import { STUB_OPENROUTER_CATALOGUE } from "../../../../api/src/tests/openai-compatible-stub"
import { openAgentConversation } from "./agent-bootstrap"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { NEEDS_OPENROUTER_STUB_REASON, REAL_OPENROUTER } from "./helpers/live-llm"

// The catalogue row that calls tools and reasons (the stub's first row).
const ADDED = STUB_OPENROUTER_CATALOGUE[0]
const ADDED_KEY = `openrouter/${ADDED.id}`
// A built-in model whose provider has a key here, that Auto does not run.
const SWITCHED_OFF = MODEL_PRICING_SEED.find((m) => m.provider === "mistral")

test("AI models: add from OpenRouter, switch one off, set Auto; the composer follows", async ({
  page,
  env,
  world,
}) => {
  test.skip(REAL_OPENROUTER, NEEDS_OPENROUTER_STUB_REASON)
  test.setTimeout(120_000)
  if (!SWITCHED_OFF) throw new Error("The pricing seed lists no Mistral model")
  // Pricing (and the ECB rate the catalogue's EUR prices use), plus purchased
  // credits so the composer's model menu is unlocked.
  await seedModelPricingAndCredits(env, world.org.id, { purchased: "50.00000000" })
  await loginAs(page, env, "admin@test.com", "12345678")

  // Settings -> AI -> AI models.
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10_000 })
  await page.getByTestId("settings-group-ai").getByTestId("settings-link-kernel:ai-models").click()
  await page.waitForURL(/\/settings\/ai-models/, { timeout: 10_000 })
  await expect(page.getByTestId("ai-models-table")).toBeVisible({ timeout: 15_000 })

  // The catalogue asks for an OpenRouter key first.
  await page.getByTestId("ai-models-open-catalogue").click()
  await expect(page.getByTestId("catalogue-needs-key")).toBeVisible({ timeout: 10_000 })

  // Save one through the key form: the server checks it against the stub's /key.
  const card = page.getByTestId("provider-card-openrouter")
  await expect(card).toHaveAttribute("data-key-set", "false")
  await page.getByTestId("provider-configure-openrouter").click()
  await page.getByTestId("provider-key-input-openrouter").fill("sk-or-v1-playwright-stub-key")
  await page.getByTestId("provider-key-save-openrouter").click()
  await expect(card).toHaveAttribute("data-key-set", "true", { timeout: 10_000 })

  // The open catalogue loads in place and lists the stub's models; add the
  // tools + reasoning one.
  await expect(page.getByTestId("catalogue-needs-key")).toHaveCount(0, { timeout: 10_000 })
  const row = page.getByTestId(`catalogue-row-${ADDED.id}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText(ADDED.name)
  await page.getByTestId(`catalogue-add-${ADDED.id}`).click()
  const addedRow = page.getByTestId(`ai-model-row-${ADDED_KEY}`)
  await expect(addedRow).toBeVisible({ timeout: 30_000 })
  await expect(addedRow).toHaveAttribute("data-enabled", "true")
  await expect(page.getByTestId("catalogue-error")).toHaveCount(0)

  // Switch one built-in model off.
  const offRow = page.getByTestId(`ai-model-row-${SWITCHED_OFF.modelId}`)
  await expect(offRow).toHaveAttribute("data-enabled", "true")
  await page.getByTestId(`ai-model-switch-${SWITCHED_OFF.modelId}`).click()
  await expect(offRow).toHaveAttribute("data-enabled", "false")

  // Auto runs the added model.
  await page.getByTestId("ai-models-auto-select").selectOption(ADDED_KEY)
  await expect(addedRow).toHaveAttribute("data-auto", "true", { timeout: 10_000 })
  await expect(page.getByTestId("ai-models-auto-runs")).toContainText(ADDED.name)
  await expect(page.getByTestId("ai-models-auto-fallback")).toHaveCount(0)

  // The same session's composer: its model menu follows the page.
  const conversation = await openAgentConversation(page)
  await conversation.getByTestId("thread-model-chip").getByTestId("model-selector-label").click()
  await expect(page.getByTestId(`model-option-${ADDED_KEY}`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`model-option-${ADDED_KEY}`)).toContainText(ADDED.name)
  await expect(page.getByTestId(`model-option-${SWITCHED_OFF.modelId}`)).toHaveCount(0)
  await expect(page.getByTestId("model-option-auto")).toContainText(ADDED.name)

  // A fresh load reads the same list from the server.
  await page.keyboard.press("Escape")
  await page.goto(`http://localhost:${env.ports[1]}/`)
  const again = await openAgentConversation(page)
  await again.getByTestId("thread-model-chip").getByTestId("model-selector-label").click()
  await expect(page.getByTestId(`model-option-${ADDED_KEY}`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`model-option-${SWITCHED_OFF.modelId}`)).toHaveCount(0)
  await expect(page.getByTestId("model-option-auto")).toContainText(ADDED.name)
  await page.screenshot({ path: test.info().outputPath("composer-model-menu.png") })
})
