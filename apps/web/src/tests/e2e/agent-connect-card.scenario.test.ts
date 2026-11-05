// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connect card, end to end in a headless browser: the agent asks the
// person to connect their own Google Calendar (request_secret, kind
// oauth_connect, mode personal); the card shows "Connect with Google"; the
// click opens the consent popup; the test stack's stand-in provider
// (LIAISON_TEST_OAUTH_PROVIDER, the lane's mock OAuth server) approves and
// sends the popup to the real callback, which exchanges the code, stores the
// account and saves the card. The popup ends on the closing page and closes;
// the card turns to "Connected" by itself, and the agent carries on from the
// connected line. Only the MODEL is scripted (agent-turn.ts).
import path from "node:path"
import { openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { SHOT_DIR } from "./helpers/shot-dir"

const ASKED = "I put a card here to connect your Google Calendar."

test("the agent asks for a Google consent through a card; the popup connects it", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(180_000)
  if (!env.mockMcpOauth) throw new Error("the lane's mock OAuth server did not start")
  await seedModelPricingAndCredits(env, world.org.id)
  const token = qa.admin.token
  const threadId = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "request secret" } }] },
      {
        toolCalls: [
          {
            name: "kernel__request_secret",
            args: {
              kind: "oauth_connect",
              target: { app: "calendar", connection: "google-calendar", mode: "personal" },
            },
          },
        ],
      },
      { text: ASKED },
      // The follow-up turn answers from the connected line it was shown.
      { echo: 'calendar google-calendar connection \\(personal\\) connected by [^\\]"]*' },
    ],
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  const conversation = await openAgentConversation(page)
  await sendInConversation(page, conversation, "connect my Google Calendar")
  await waitForTurnEnd(env, { threadId, token, contains: ASKED })

  const button = conversation.getByTestId("secret-request-connect").first()
  await expect(button).toBeVisible({ timeout: 20_000 })
  await expect(button).toHaveText("Connect with Google")
  await expect(conversation.getByTestId("secret-request-destination-mode").first()).toHaveText(
    "Your own",
  )
  await page.screenshot({ path: path.join(SHOT_DIR, "p7-connect-card.png") })

  // The popup opens from the click itself (no blocker), goes to the provider,
  // comes back through the callback to the closing page, and closes.
  const popupPromise = page.waitForEvent("popup")
  await button.click()
  const popup = await popupPromise
  await popup.waitForURL(/\/api\/connections\/oauth-done\?result=connected/, { timeout: 30_000 })
  await popup.waitForEvent("close", { timeout: 10_000 })

  // The card turns to Connected by itself (the request's event), no reload.
  await expect(conversation.getByTestId("secret-request-connected").first()).toBeVisible({
    timeout: 20_000,
  })
  await page.screenshot({ path: path.join(SHOT_DIR, "p7-connect-connected.png") })
  const followUp = await waitForTurnEnd(env, { threadId, token, contains: "connected by" })
  expect(followUp).toContain("calendar google-calendar connection (personal) connected by")

  // The account is the person's own, stored by the grant.
  const ks = `${env.schemaPrefix}kernel`
  const rows = await env.db.sql.unsafe(
    `SELECT owner_type, status FROM "${ks}".connected_accounts
      WHERE org_id = $1 AND app_name = 'calendar' AND connection_name = 'google-calendar'
        AND status = 'active'`,
    [world.org.id],
  )
  expect(rows.map((r) => r.owner_type)).toEqual(["user"])
})
