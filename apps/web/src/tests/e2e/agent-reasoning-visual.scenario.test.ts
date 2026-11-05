// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Visual validation for the reasoning "thinking block". DETERMINISTIC: agent
// messages are seeded directly with reasoning metadata representing each
// provider EMISSION SHAPE — Anthropic full thinking text, OpenAI/Google thought
// SUMMARY, and tokens-only (redacted/encrypted reasoning) — so the rendered
// block can be screenshotted without any LLM call. Screenshots are written to
// /tmp/reasoning-shots/ for human/agent review (not pixel-diff baselines).

import { createUserWithScopes } from "@liaison/test-helpers"
import { expect } from "@playwright/test"
import { forceDarkMode, openAgentConversation } from "./agent-bootstrap"
import { loginAs, test } from "./fixtures/test"
import { seedAgentThread, seedModelPricingAndCredits } from "./helpers/agent-seed"

const SHOT_DIR = "/tmp/reasoning-shots"

// biome-ignore lint/suspicious/noExplicitAny: e2e worker env is loosely typed across helpers
async function seedAgentMessage(
  env: any,
  orgId: string,
  threadId: string,
  userId: string,
  content: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const ks = `${env.schemaPrefix}kernel`
  await env.db.sql`
    INSERT INTO ${env.db.sql(ks)}.messages
      (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes)
    VALUES (gen_random_uuid(), ${threadId}, ${orgId}, ${userId}, 'agent', ${content},
            ${env.db.sql.json(metadata)}, '{}')
  `
}

test.describe("Reasoning thinking-block — visual", () => {
  test.beforeEach(async ({ page, env, world }) => {
    await forceDarkMode(page)
    await seedModelPricingAndCredits(env, world.org.id)
  })

  test("thinking-block across provider emission shapes", async ({ page, env, world }) => {
    const user = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        email: `reasoning-${Date.now()}@test.local`,
        password: "ReaPass1!",
        name: "Reasoning Visual",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        schemaPrefix: env.schemaPrefix,
      },
    )
    const threadId = await seedAgentThread(env, world.org.id, user.id)

    // (a) FULL reasoning — Anthropic extended thinking streams the whole chain.
    await seedAgentMessage(
      env,
      world.org.id,
      threadId,
      user.id,
      "The sky looks blue because of Rayleigh scattering.",
      {
        modelId: "claude-opus-4-6",
        reasoningLevel: "high",
        reasoning:
          "Let me reason about why the sky is blue.\n\nSunlight contains every colour. As it crosses the atmosphere it scatters off air molecules. Shorter (blue) wavelengths scatter far more than longer (red) ones — Rayleigh scattering goes as 1/λ⁴ — so blue light is spread across the whole sky, which is what we see overhead.",
        usage: { inputTokens: 40, outputTokens: 30, reasoningTokens: 180 },
      },
    )

    // (b) SUMMARY-only reasoning — OpenAI / Google emit a short thought summary.
    await seedAgentMessage(
      env,
      world.org.id,
      threadId,
      user.id,
      "Refunded the order and emailed the customer.",
      {
        modelId: "gpt-5.4",
        reasoningLevel: "medium",
        reasoning:
          "Confirmed the order was refund-eligible, issued the refund, then notified the customer.",
        usage: { inputTokens: 60, outputTokens: 20, reasoningTokens: 90 },
      },
    )

    // (c) TOKENS-ONLY — redacted/encrypted reasoning: no readable text, only a count.
    await seedAgentMessage(env, world.org.id, threadId, user.id, "Done.", {
      modelId: "gpt-5.4",
      reasoningLevel: "high",
      usage: { inputTokens: 30, outputTokens: 5, reasoningTokens: 256 },
    })

    await loginAs(page, env, user.email, "ReaPass1!")
    await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)

    const blocks = page.locator('[data-testid="thinking-block"]')
    await blocks.first().waitFor({ state: "visible", timeout: 30_000 })
    // Full + summary + tokens-only all render a block.
    await expect(blocks).toHaveCount(3)

    // 1. Default collapsed state — three "Thought" affordances down the thread.
    await page.screenshot({ path: `${SHOT_DIR}/01-collapsed-all.png`, fullPage: true })

    // 2. Expand the first (full reasoning) block to reveal the chain of thought.
    await blocks.first().getByRole("button").click()
    await page.screenshot({ path: `${SHOT_DIR}/02-expanded-full.png`, fullPage: true })
  })

  test("model picker shows the segmented reasoning row for a capable model", async ({
    page,
    env,
    world,
  }) => {
    const user = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        email: `reasoning-pick-${Date.now()}@test.local`,
        password: "ReaPass1!",
        name: "Reasoning Picker",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        schemaPrefix: env.schemaPrefix,
      },
    )
    await loginAs(page, env, user.email, "ReaPass1!")
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // The agent panel is retired (P4c-T17): the conversation with the personal
    // agent is the surface, and the model chip is its composer's control.
    const conversation = await openAgentConversation(page)
    const trigger = conversation.getByRole("button", { name: "Select model" })
    await trigger.waitFor({ state: "visible", timeout: 30_000 })
    await trigger.click()
    // Pick a reasoning-capable starter model (this closes the popover)…
    await page.getByRole("menuitem", { name: "Claude Sonnet 4.6" }).click()
    // …then reopen: the segmented Reasoning row now shows for the selected model.
    await trigger.click()
    const row = page.getByTestId("reasoning-row")
    await row.waitFor({ state: "visible", timeout: 10_000 })
    await page.screenshot({ path: `${SHOT_DIR}/03-picker-reasoning-row.png` })
  })
})
