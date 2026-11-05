// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two turns of ONE agent in one conversation, as the Team chat scenario plays
// them: the person asks their agent to research a question, then asks it to
// turn the answer into a task while the first answer is still coming (a demo
// visitor's newer request replaces the older turn, which then says so). The
// thread must show the conversation as the database holds it at every point:
// the person's messages, the agent's live turn, its answers with their
// citations, and nothing the agent wrote missing.
//
// Before the fix the live state was keyed on the agent alone: the newer turn's
// start wiped the older one's block, the older turn's reply then ended the
// newer one's, and the server's stream registry dropped the newer turn when
// the older one ended, so the conversation showed no agent turn at all while
// the agent was still answering, even after a reload.
//
// The agent's turns run on the e2e lane's scripted model
// (`LIAISON_MODEL_PROVIDER=scripted`); everything else is the real server.
import { api } from "@liaison/test-helpers"
import { sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn } from "./agent-turn"
import { createProfiledE2ETest, type ProfiledWorkerEnv } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"

const test = createProfiledE2ETest({
  workerIdOffset: 240,
  portCount: 2,
  before: async () => ({ env: {}, teardowns: [] }),
})

const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"

const RESEARCH_ANSWER =
  "From 2027 the battery passport applies to EV and industrial batteries over 2 kWh. Sources: " +
  "[Regulation 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj/eng), " +
  "[Commission guidance](https://single-market-economy.ec.europa.eu/battery-passport-guidance) and " +
  "[Data points](https://single-market-economy.ec.europa.eu/battery-passport-data-points)."
const TASK_ANSWER =
  "I created the task for Tobias with the three sources: " +
  "[Regulation 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj/eng), " +
  "[Commission guidance](https://single-market-economy.ec.europa.eu/battery-passport-guidance) and " +
  "[Data points](https://single-market-economy.ec.europa.eu/battery-passport-data-points)."

async function token(env: ProfiledWorkerEnv): Promise<string> {
  const res = await api(env.serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  return res.body.data.accessToken as string
}

interface Row {
  id: string
  authorType: string
  content: string | null
}

async function threadMessages(env: ProfiledWorkerEnv, t: string, threadId: string) {
  const res = await api(env.serverUrl, `/api/threads/${threadId}/messages?limit=50`, { token: t })
  return ((res.body?.data ?? []) as Row[]).filter((m) => m.authorType !== "system")
}

test("a newer turn of the same agent keeps both turns on screen, live and after a reload", async ({
  page,
  env,
  world,
}) => {
  test.setTimeout(180_000)
  await seedModelPricingAndCredits(env, world.org.id)
  await api(env.serverUrl, "/api/_test/agent-script", { method: "DELETE" })
  const t = await token(env)
  const threadId = await agentDmThreadId(env, t)
  // Steps are served in the order the turns ask for them: the research turn
  // takes the first and is still answering when the follow-up's turn takes the
  // second, which answers well after the first one landed.
  // A step waits at most 5 s: the follow-up's turn looks a tool up a few times before it answers.
  const lookUp = (delayMs: number) => ({
    delayMs,
    toolCalls: [{ name: "kernel__tool_search", args: { query: "select:kernel__web_search" } }],
  })
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      {
        reasoning: "Looking up the battery passport rules.",
        text: RESEARCH_ANSWER,
        delayMs: 5_000,
      },
      { reasoning: "Turning the answer into a task.", ...lookUp(5_000) },
      lookUp(5_000),
      lookUp(5_000),
      lookUp(5_000),
      { delayMs: 5_000, text: TASK_ANSWER },
    ],
  })

  await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
  const base = `http://localhost:${env.ports[1]}`
  await page.goto(`${base}/threads/${threadId}`)
  const conversation = page
    .locator('[data-tab-active="true"]')
    .filter({ has: page.getByTestId("compose-editor") })
    .first()
  await expect(conversation).toBeVisible({ timeout: 30_000 })
  const live = conversation.getByTestId("agent-stream-block")

  // Ask: the agent's turn shows at once.
  await sendInConversation(
    page,
    conversation,
    "Research the EU battery passport rules, with sources.",
  )
  await expect(live).toHaveCount(1, { timeout: 15_000 })
  // Follow up while it answers: BOTH turns show, the first one is not wiped.
  await sendInConversation(page, conversation, "Turn this into a task for Tobias.")
  await expect(live).toHaveCount(2, { timeout: 10_000 })

  // The first answer lands: it shows with its citations, and the newer turn is
  // still on screen working (its block was ended by the first reply before).
  await expect(conversation.getByTestId("message-citations")).toHaveCount(1, { timeout: 20_000 })
  await expect(conversation.getByTestId("message-citation")).toHaveCount(3)
  await expect(live).toHaveCount(1)

  // A reload mid-turn seeds the newer turn from the server: still on screen.
  await page.reload()
  await expect(conversation).toBeVisible({ timeout: 30_000 })
  await expect(conversation.getByTestId("agent-stream-block")).toHaveCount(1, { timeout: 15_000 })

  // Both answers land; the thread shows every message the database holds.
  await expect
    .poll(
      async () =>
        (await threadMessages(env, t, threadId)).filter((m) => m.content === TASK_ANSWER).length,
      { timeout: 40_000 },
    )
    .toBe(1)
  await expect(conversation.getByTestId("message-citations")).toHaveCount(2, { timeout: 15_000 })
  await expect(conversation.getByTestId("agent-stream-block")).toHaveCount(0, { timeout: 15_000 })
  for (const message of await threadMessages(env, t, threadId)) {
    await expect(
      conversation.locator(`[data-message-id="${message.id}"]`).first(),
      `${message.authorType} message ${message.id} is on screen`,
    ).toBeVisible()
  }
})
