// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Interleaved-timeline browser E2E. Drives the REAL conversation in a real
// browser against a SERVER-scripted turn that runs:
//
//     reasoning -> tool A -> reasoning -> tool B -> answer
//
// and asserts the settled turn shows each tool call ANCHORED BETWEEN the
// thinking segments (the timeline fix) rather than both tools dumped after the
// whole thinking block.
//
// P4c-T21 re-pointed every locator at the one conversation surface
// (`openAgentConversation`: a Home tab or an expanded dock tab) after T17
// retired the panel. P4c-T21b replaces what the locators could not reach: the
// TURN. The panel's client-side stream is gone, so the script now lives on the
// server (`agent-turn.ts` -> `POST /api/_test/agent-script`, replayed by
// `modules/agent/providers/scripted-model-provider.ts`). Only the model is scripted: both
// tool calls below are executed FOR REAL through the tool bridge, against this
// world's own threads.
import { loginAsAdmin, openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"

const ANSWER = "Here is what I found in your orders thread."
const EXPECTED_ORDER = ["thought", "kernel__threads_search", "thought", "kernel__threads_read"]

test.describe("Agent timeline — tool calls interleave with thinking (visual + order)", () => {
  test("renders reasoning -> tool -> reasoning -> tool in the conversation", async ({
    page,
    env,
    world,
  }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    // Script the SERVER's turn. Each step's tool call runs for real; the step
    // after it is produced only once that tool's result is back, which is what
    // makes the rendered order a property of the turn rather than of a stub.
    const threadId = await agentDmThreadId(env, world.admin.token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        {
          reasoning: "First, I need to find the relevant thread.",
          toolCalls: [{ name: "kernel__threads_search", args: { query: "orders" } }],
        },
        {
          reasoning: "Found it. Now I will open that thread to read it.",
          toolCalls: [{ name: "kernel__threads_read", args: { threadId } }],
        },
        { text: ANSWER },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // P4c-T21: the conversation, on whichever surface it is standing.
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "what is happening with my orders?")

    await waitForTurnEnd(env, { threadId, token: world.admin.token, contains: ANSWER })

    // Read native DOM order off THIS turn's message row (a Playwright
    // comma-locator can resolve empty mid-transition; querySelectorAll is a
    // stable single snapshot). Scoped to the row, not the conversation: the
    // `world` fixture is worker-scoped, so the same DM can already carry
    // earlier tests' turns and their tool rows.
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: "orders thread" })
      .last()
    const readOrder = () =>
      turnRow.evaluate((root) =>
        Array.from(
          root.querySelectorAll('[data-testid="thinking-block"],[data-testid="tool-call-row"]'),
        ).map((el) =>
          el.getAttribute("data-testid") === "tool-call-row"
            ? el.getAttribute("data-tool-name")
            : "thought",
        ),
      )

    // Assert the SETTLED, persisted render — the interleave survives
    // streaming -> persisted (the store upgrades the message metadata from the
    // finalize broadcast). This is the durable end state a user sees.
    await expect(conversation).toContainText("orders thread", { timeout: 30000 })
    await expect(turnRow).toBeVisible({ timeout: 20000 })
    await expect.poll(readOrder, { timeout: 20000, intervals: [250] }).toEqual(EXPECTED_ORDER)
  })
})
