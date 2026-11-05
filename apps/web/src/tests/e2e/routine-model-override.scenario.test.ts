// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent App: Routines — per-routine agent model + reasoning level override.
 *
 * Covers the feature added in 806b44b6: RoutineCreate's "Agent model" select
 * (the models the server serves the org, GET /api/credits/models read
 * through lib/model-groups.ts) + ReasoningLevelRow (shown once a model with
 * reasoning support is picked), RoutineDetail's read-only "Agent model" row
 * in view mode and the same controls in edit mode, and persistence via
 * POST/PUT /api/agent/routines (agentModelId, agentReasoningLevel).
 *
 * Run via Strobe:
 *   debug_test projectRoot=... suite=e2e test="Agent App: Routine model override"
 *
 * Describe title is metachar-free per the Strobe regex memory rule.
 */
import { loginAsAmina, openAgentRoutines } from "./agent-bootstrap"
import { expect, test } from "./fixtures/test"
import { alignOwnAgentCeiling, seedModelPricingAndCredits } from "./helpers/agent-seed"
import { clearAgentAppTables, restoreAgentAppBaseline } from "./helpers/agent-test-fixtures"

test.describe("Agent App: Routine model override", () => {
  // This file calls clearAgentAppTables, which truncates the worker-shared
  // skills/routines seed. Restore the baseline so later files in the reused
  // Playwright worker still see it (same contract agent-routines.scenario.test.ts
  // follows).
  test.afterAll(async ({ env }) => {
    await restoreAgentAppBaseline(env)
  })

  test("create with a pinned model + reasoning level, then view/edit/persist in detail", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(120_000)
    // Model capability resolution (getReasoningCapability) reads the
    // model_pricing seed — without it gemini-flash-latest resolves as an
    // unknown model and the reasoning row never renders.
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentRoutines(page)

    // ─── 1. Create flow — pick model + reasoning, fill minimal fields ───────
    await page.getByTestId("routines-new-routine").click()
    await page.getByTestId("routine-create").waitFor({ state: "visible" })
    await page.getByTestId("routines-new-name").fill("model-override-test")
    // Recurring is the default kind; weekdays is the default preset — leave as-is,
    // this scenario only cares about the model/reasoning controls.
    await page.getByTestId("schedule-preset-daily").click()
    await page.getByTestId("schedule-time").fill("08:00")
    await page.getByTestId("routines-new-prompt").fill("say hi")

    // A routine runs at its agent's FULL ceiling, so writing one needs every
    // scope in that ceiling; visibility has nothing to do with it. Amina is an
    // ordinary member whose seeded agent carries a wider ceiling than her own
    // grants, so the save is refused until the ceiling is put back where the
    // product provisions it. Prove the refusal first, then align and retry.
    await page.getByTestId("routine-model-select").selectOption("gemini-flash-latest")
    await expect(page.getByTestId("reasoning-row")).toBeVisible()
    await page.getByTestId("reasoning-level-medium").click()
    await expect(page.getByTestId("reasoning-level-medium")).toHaveAttribute("aria-pressed", "true")

    // Screenshot: create form with model select + reasoning row visible.
    await page.screenshot({
      path: "test-results/routine-model-override/01-create-form.png",
      fullPage: true,
    })

    // Under-scoped author: the product refuses and names the missing scopes.
    await page.getByTestId("routines-new-save").click()
    await expect(page.getByTestId("routines-new-error")).toContainText("full ceiling", {
      timeout: 10_000,
    })
    await expect(page.getByTestId("routine-detail")).toHaveCount(0)

    await alignOwnAgentCeiling(env, world.org.id, qa.amina.id)
    await page.getByTestId("routines-new-save").click()
    // On save the create tab closes and the routine's own detail tab opens.
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })

    // ─── 2. Detail view — read-only Agent model row ─────────────────────────
    await expect(page.getByTestId("routine-model-text")).toContainText("Gemini Flash")
    await expect(page.getByTestId("routine-model-text")).toContainText("Reasoning: medium")

    await page.screenshot({
      path: "test-results/routine-model-override/02-detail-view.png",
      fullPage: true,
    })

    // ─── 3. Edit mode — change reasoning high, back to medium, save ─────────
    // The Edit affordance renders from the server's per-row `canWrite`, which
    // the routines store fetched before the ceiling was aligned. Reload so the
    // page asks again rather than reading that stale answer.
    await page.reload()
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })
    await page.getByTestId("routine-edit").click()
    await page.getByTestId("routine-edit-form").waitFor({ state: "visible" })

    // The edit select is pre-populated from the routine's persisted model.
    await expect(page.getByTestId("routine-edit-model-select")).toHaveValue("gemini-flash-latest")
    await expect(page.getByTestId("reasoning-level-medium")).toHaveAttribute("aria-pressed", "true")

    await page.screenshot({
      path: "test-results/routine-model-override/03-edit-mode.png",
      fullPage: true,
    })

    await page.getByTestId("reasoning-level-high").click()
    await expect(page.getByTestId("reasoning-level-high")).toHaveAttribute("aria-pressed", "true")
    await page.getByTestId("reasoning-level-medium").click()
    await expect(page.getByTestId("reasoning-level-medium")).toHaveAttribute("aria-pressed", "true")

    await page.getByTestId("routine-edit-save").click()
    await expect(page.getByTestId("routine-edit-form")).not.toBeVisible({ timeout: 10_000 })

    // Persisted immediately in the (non-reloaded) view.
    await expect(page.getByTestId("routine-model-text")).toContainText("Gemini Flash")
    await expect(page.getByTestId("routine-model-text")).toContainText("Reasoning: medium")

    // ─── 4. Reload — assert persistence survives a full page reload ────────
    await page.reload()
    await expect(page.getByTestId("routine-detail")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("routine-model-text")).toContainText("Gemini Flash", {
      timeout: 10_000,
    })
    await expect(page.getByTestId("routine-model-text")).toContainText("Reasoning: medium")
  })
})
