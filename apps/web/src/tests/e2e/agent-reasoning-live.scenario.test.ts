// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REASONING, ON THE THREAD SURFACE.
//
// This used to be a matrix of REAL provider round-trips (Anthropic / OpenAI /
// Google), each screenshotted into `./reasoning-live-screenshots/` and asserted
// on nothing: it self-skipped without provider keys, it drove the retired
// `agent-panel`, and its only real check was "a thinking block appeared, or
// didn't". It cost three live LLM calls to prove less than one scripted turn.
//
// P4c-T21b: the turn is scripted on the SERVER (`agent-turn.ts`), so the
// reasoning text is chosen by the test and can therefore be ASSERTED. The
// surface under test is the one the thread view actually has (T10's
// `AgentTurnBlock` -> `AgentActivity` -> `ThinkingBlock`):
//
//   - reasoning renders as a collapsed thinking block on the settled turn,
//   - it is expandable, and the body carries the reasoning verbatim,
//   - reasoning that arrives BETWEEN two tool calls stays anchored between them
//     (the timeline), rather than being hoisted above both.
//
// What is deliberately NOT claimed here: that any particular provider emits
// reasoning. That is a provider contract, covered by the reasoning unit tests
// (`modules/agent/providers/reasoning.ts`), not something a browser scenario can pin.
import { loginAsAdmin, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"

const FIRST_THOUGHT = "REASONING-E2E-STEP-ONE: I should look for the orders thread first."
const SECOND_THOUGHT = "REASONING-E2E-STEP-TWO: now I can open it and read it."
const ANSWER = "REASONING-E2E-ANSWER: here is the summary you asked for."

test.describe("Agent reasoning renders on the thread surface", () => {
  test("a scripted turn's thinking is shown, expandable and interleaved", async ({
    page,
    env,
    world,
  }) => {
    await seedModelPricingAndCredits(env, world.org.id)

    const token = world.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        {
          reasoning: FIRST_THOUGHT,
          toolCalls: [{ name: "kernel__threads_search", args: { query: "orders" } }],
        },
        {
          reasoning: SECOND_THOUGHT,
          toolCalls: [{ name: "kernel__threads_read", args: { threadId } }],
        },
        { text: ANSWER },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "what is happening with my orders?")
    await waitForTurnEnd(env, { threadId, token, contains: ANSWER })

    // Scoped to THIS turn: the DM is worker-scoped and carries earlier turns.
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: "REASONING-E2E-ANSWER" })
      .last()
    await expect(turnRow).toBeVisible({ timeout: 30000 })

    // Two thinking blocks, collapsed by default (ThinkingBlock opens only on a
    // click), so the reasoning text is NOT on screen yet.
    const blocks = turnRow.locator('[data-testid="thinking-block"]')
    await expect.poll(() => blocks.count(), { timeout: 20000, intervals: [250] }).toBe(2)
    await expect(turnRow).not.toContainText(FIRST_THOUGHT)

    // Expanding the first one shows its reasoning verbatim.
    await blocks.first().getByRole("button").click()
    await expect(blocks.first()).toContainText(FIRST_THOUGHT, { timeout: 10000 })
    await blocks.nth(1).getByRole("button").click()
    await expect(blocks.nth(1)).toContainText(SECOND_THOUGHT, { timeout: 10000 })

    // The interleave: each thought is anchored BEFORE the tool call it preceded,
    // not hoisted above both. Read as one native DOM snapshot — a Playwright
    // comma-locator can resolve empty mid-transition.
    const order = await turnRow.evaluate((root) =>
      Array.from(
        root.querySelectorAll('[data-testid="thinking-block"],[data-testid="tool-call-row"]'),
      ).map((el) =>
        el.getAttribute("data-testid") === "tool-call-row"
          ? el.getAttribute("data-tool-name")
          : "thought",
      ),
    )
    expect(order).toEqual(["thought", "kernel__threads_search", "thought", "kernel__threads_read"])
  })
})
