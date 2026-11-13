// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The secret card, end to end in the browser: the agent asks for a secret with
// request_secret, a card appears under its message, the person types the secret
// there and saves, and the agent carries on from the saved line, never seeing
// the secret. Only the MODEL is scripted (agent-turn.ts): request_secret, the
// key and credentials routes, the server's completion check and the agent's
// follow-up turn all run for real. Afterwards the secret is searched for in the
// conversation, the approvals, the audit log, the outbox and every websocket
// frame the browser received.
//
// Two flows: a model provider key, and the credentials of an API connector the
// org already has an adapter for. Screenshots go to PW_SHOT_DIR.
import { randomUUID } from "node:crypto"
import path from "node:path"
import { api } from "@liaison/test-helpers"
import { openAgentConversation, sendInConversation } from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, waitForTurnEnd } from "./agent-turn"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { SHOT_DIR } from "./helpers/shot-dir"

const ASKED_KEY = "I put a card here for your OpenRouter key."
const ASKED_CRM = "I put a card here for the CRM credentials."

test("the agent asks for a secret through a card and never sees it", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(180_000)
  await seedModelPricingAndCredits(env, world.org.id)
  const token = qa.admin.token
  // A real key when the run has one: the card is the only place it is typed.
  const providerKey =
    process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 12
      ? process.env.OPENROUTER_API_KEY
      : `sk-or-v1-e2e-${randomUUID().replaceAll("-", "")}`
  const crmToken = `crm-e2e-${randomUUID()}`
  const identifier = `crm-${randomUUID().slice(0, 6)}`

  const adapter = await api(env.serverUrl, `/api/api-connector/adapters/${identifier}`, {
    method: "PUT",
    token,
    body: {
      id: identifier,
      name: "Example CRM",
      version: "1.0.0",
      baseUrl: "https://crm.example.com/api",
      auth: { type: "bearer" },
      operations: [
        {
          name: "find_customer",
          description: "Find companies by contact email.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: { email: { type: "string" } } },
          query: { email: "{email}" },
          items: "/data",
          fields: ["id", "name"],
          role: "customer.lookup",
        },
      ],
    },
  })
  expect(adapter.status, JSON.stringify(adapter.body)).toBe(200)

  const threadId = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId,
    steps: [
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "request secret" } }] },
      {
        toolCalls: [
          {
            name: "kernel__request_secret",
            args: { kind: "byok", target: { provider: "openrouter" } },
          },
        ],
      },
      { text: ASKED_KEY },
      // The follow-up turn after the save answers from the line it was shown.
      { echo: 'OpenRouter API key saved by [^\\]"]*' },
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "request secret" } }] },
      {
        toolCalls: [
          {
            name: "kernel__request_secret",
            args: {
              kind: "connection_credentials",
              target: { app: "api-connector", connection: "api", identifier },
            },
          },
        ],
      },
      { text: ASKED_CRM },
      { echo: 'api-connector api credentials [^\\]"]*saved by [^\\]"]*' },
    ],
  })

  const frames: string[] = []
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => frames.push(String(f.payload)))
    ws.on("framesent", (f) => frames.push(String(f.payload)))
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  const conversation = await openAgentConversation(page)

  // 1. A model provider key.
  await sendInConversation(page, conversation, "add my OpenRouter key")
  await waitForTurnEnd(env, { threadId, token, contains: ASKED_KEY })
  const keyCard = conversation.getByTestId("secret-request-form").first()
  await expect(keyCard).toBeVisible({ timeout: 20_000 })
  await expect(conversation.getByTestId("secret-request-destination-provider").first()).toHaveText(
    "openrouter",
  )
  await page.screenshot({ path: path.join(SHOT_DIR, "p2-byok-card.png") })
  const keyField = conversation.getByTestId("secret-request-field-apiKey").first()
  await keyField.fill(providerKey)
  await expect(keyField).toHaveAttribute("type", "password")
  await page.screenshot({ path: path.join(SHOT_DIR, "p2-byok-typed.png") })
  await conversation.getByTestId("secret-request-save").first().click()
  await expect(conversation.getByTestId("secret-request-saved").first()).toContainText(
    providerKey.slice(-4),
    { timeout: 20_000 },
  )
  const followUp = await waitForTurnEnd(env, {
    threadId,
    token,
    contains: "OpenRouter API key saved",
  })
  expect(followUp).toContain(`(ends ${providerKey.slice(-4)})`)
  await expect(conversation).toContainText("OpenRouter API key saved", { timeout: 20_000 })
  await page.screenshot({ path: path.join(SHOT_DIR, "p2-byok-saved.png") })

  // 2. An API connector's credentials, with where they go named on the card.
  await sendInConversation(page, conversation, "connect our CRM API")
  await waitForTurnEnd(env, { threadId, token, contains: ASKED_CRM })
  const tokenField = conversation.getByTestId("secret-request-field-token").last()
  await expect(tokenField).toBeVisible({ timeout: 20_000 })
  await expect(conversation.getByTestId("secret-request-destination-baseUrl").last()).toHaveText(
    "https://crm.example.com",
  )
  await page.screenshot({ path: path.join(SHOT_DIR, "p2-connector-card.png") })
  await tokenField.fill(crmToken)
  await conversation.getByTestId("secret-request-save").last().click()
  await expect(conversation.getByTestId("secret-request-saved").last()).toBeVisible({
    timeout: 20_000,
  })
  await waitForTurnEnd(env, {
    threadId,
    token,
    contains: "api-connector api credentials",
  })
  await page.screenshot({ path: path.join(SHOT_DIR, "p2-connector-saved.png") })

  // 3. Stored where it belongs, and nowhere else.
  const status = await api(env.serverUrl, "/api/api-connector/adapters", { token })
  expect(JSON.stringify(status.body)).toContain(identifier)
  const ks = `${env.schemaPrefix}kernel`
  const surfaces: Record<string, string> = {}
  for (const [name, query] of [
    ["messages", `SELECT content, metadata FROM "${ks}".messages WHERE org_id = $1`],
    ["approvals", `SELECT row_to_json(a) AS r FROM "${ks}".approval_requests a WHERE org_id = $1`],
    ["audit", `SELECT row_to_json(a) AS r FROM "${ks}".audit_log a WHERE org_id = $1`],
    ["outbox", `SELECT row_to_json(p) AS r FROM "${ks}".pending_events p WHERE org_id = $1`],
    ["requests", `SELECT row_to_json(s) AS r FROM "${ks}".secret_requests s WHERE org_id = $1`],
  ] as const) {
    surfaces[name] = JSON.stringify(await env.db.sql.unsafe(query, [world.org.id]))
  }
  surfaces.websocket = frames.join("\n")
  for (const secret of [providerKey, crmToken]) {
    const found = Object.entries(surfaces)
      .filter(([, text]) => text.includes(secret))
      .map(([name]) => name)
    expect(found, "a typed secret leaked").toEqual([])
  }
  // The searched surfaces are real: the conversation and the frames hold the flow.
  expect(surfaces.messages).toContain("secret-request-result")
  expect(surfaces.websocket.length).toBeGreaterThan(1000)
})
