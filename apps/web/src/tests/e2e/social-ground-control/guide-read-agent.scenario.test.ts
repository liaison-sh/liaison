// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B-NEW-5 — the social guide, read by the agent, on the conversation surface
// (§1 #8 / §9 #11 / §10).
//
// B0 reads the `social-overview` guide via the production `skill_read` path but
// invokes it directly (the `_test` route). This scenario proves the §1 #8 user
// journey: a question in the real agent loop loads the social guide through the
// real tool bridge, and the guide's own content is what comes back.
//
// P4c-T21b: this used to drive the retired right-rail `agent-panel` against a
// LIVE auto-mode model and assert a regex over whatever the model happened to
// say — a 150s test whose only failure mode that mattered was the model's mood.
// The turn is now scripted on the SERVER (`agent-turn.ts`): the MODEL's choice
// of tool is scripted, `kernel__skill_read` itself runs for real, and the
// assertion moved from "the prose mentions a guide word" to "the body the tool
// returned IS the guide" — read off the turn's persisted `metadata.toolCalls`.
//
// This file is ADDITIVE — it does NOT truncate the worker-shared agent tables.
import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { assertSocialBundle, expect, test } from "./helpers/social-fixtures"
import { installSocialApp, readGuide, resetSocialMock } from "./helpers/social-harness"

const ANSWER = "Here is what the Social app can do, straight from its guide."

test.describe("Social Ground Control guide read agent", () => {
  test("agent reads the social guide to answer what can I do", async ({ page, env, world, qa }) => {
    assertSocialBundle()

    await resetSocialMock(env.serverUrl, qa.admin.token)
    // Real install → reconcile seeds the social-overview guide into the skill registry.
    await installSocialApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
    })

    // Deterministic backstop (B0's path): the guide is readable via the production
    // skill_read tool — proves the asset exists before we exercise the agent loop.
    const guide = await readGuide({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
    })
    expect(guide.error, JSON.stringify(guide)).toBeUndefined()
    expect(guide.name).toBe("social-overview")
    expect((guide.body ?? "").length).toBeGreaterThan(120)

    // Pricing + credits before the page loads.
    await seedModelPricingAndCredits(env, world.org.id)

    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        { toolCalls: [{ name: "kernel__skill_read", args: { name: "social-overview" } }] },
        { text: ANSWER },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "What can I do with the Social app?")
    await waitForTurnEnd(env, { threadId, token, contains: ANSWER })

    // The guide read renders in THIS turn (the DM is worker-scoped).
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: "straight from its guide" })
      .last()
    await expect(turnRow).toBeVisible({ timeout: 30_000 })
    await expect(turnRow.locator('[data-tool-name="kernel__skill_read"]').first()).toBeVisible({
      timeout: 20_000,
    })

    // THE GROUNDING, on the result the agent was actually handed: the tool
    // returned the social guide's own body, not an empty or wrong skill.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: ANSWER,
      expect: "kernel__skill_read",
    })
    const read = calls.find((c) => c.toolName === "kernel__skill_read")?.result
    const readText = typeof read === "string" ? read : JSON.stringify(read)
    expect(readText, `skill_read returned nothing useful: ${readText?.slice(0, 400)}`).toContain(
      "social-overview",
    )
    // Guide-sourced concepts — the morning-digest routine, brand-voice replies,
    // the approval flow, the monitored platforms.
    expect(readText).toMatch(/morning-digest|brand voice|approv|triage|facebook|instagram|youtube/i)
  })
})
