// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11, LIVE: a real OpenRouter model, added the way an admin adds it (the
// catalogue, the test call), runs two agent turns that must call a tool, at
// reasoning "medium". DeepSeek V4.1 Flash takes the efforts low and high, so
// medium is sent as low (A10). Every request carries the routing options.
//
// Paid (a few cents), so it lives in the `live` suite, which keeps the real
// provider keys and is run by hand:
//   bun run scripts/test-run.ts live --file src/tests/live/openrouter.live.test.ts
// It FAILS, never skips, when OPENROUTER_API_KEY is missing.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000f2001"
const USER_ID = "00000000-0000-4000-8000-0000000f2002"
const THREAD_ID = "00000000-0000-4000-8000-0000000f2003"
const UPSTREAM = "deepseek/deepseek-v4.1-flash"
const KEY = `openrouter/${UPSTREAM}`
const ITEM_TITLE = "Orbital Relay OR-4471"

interface SentRequest {
  model?: string
  provider?: unknown
  reasoning?: { effort?: string }
}

const sent: SentRequest[] = []
let fetchSpy: ReturnType<typeof spyOn> | null = null

describe("OpenRouter, live (S11)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    delete process.env.OPENROUTER_BASE_URL
    const realFetch = globalThis.fetch
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith("https://openrouter.ai/api/v1/chat/completions") && init?.body) {
        try {
          sent.push(JSON.parse(String(init.body)) as SentRequest)
        } catch {}
      }
      return realFetch(input as never, init)
    }) as typeof fetch)

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'OpenRouterLive', 'openrouter-live') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'openrouter-live@test.com', 'OpenRouter Live') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id, agent_reasoning_levels)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'openrouter-live-chat', 'agent_chat', ${USER_ID}, ${KEY}, ${JSON.stringify({ [KEY]: "medium" })}::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO app_test.items (org_id, title, status, team, sensitivity) VALUES (${ORG_ID}, ${ITEM_TITLE}, 'open', 'alpha', 'public')`
  })

  afterAll(async () => {
    fetchSpy?.mockRestore()
    await sql`DELETE FROM app_test.items WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("adds DeepSeek V4.1 Flash and runs two tool-calling turns on it at reasoning medium", async () => {
    // Fail loudly: a missing key is a broken run, not a skipped one.
    expect(process.env.OPENROUTER_API_KEY ?? "").toMatch(/^sk-or-/)

    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "OpenRouter Live",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    const add = await app.request("/api/settings/ai/openrouter/models", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ upstreamId: UPSTREAM }),
    })
    const addBody = (await add.json()) as { data?: { key?: string }; error?: { message?: string } }
    expect(addBody.error?.message ?? null).toBeNull()
    expect(add.status).toBe(201)
    expect(addBody.data?.key).toBe(KEY)

    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const asks = [
      "What items do we have in the test app right now? I need their exact titles.",
      "Check the test app again and tell me the current status of that item.",
    ]
    for (const [i, content] of asks.entries()) {
      const msgId = `00000000-0000-4000-8000-0000000f201${i}`
      const before = sent.length
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${content}, '{}')`
      const result = await invokeAgentForThread(
        THREAD_ID,
        msgId,
        {
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: { "test:team": ["alpha"], "test:sensitivity": ["public"] },
        },
        ORG_ID,
      )
      expect(result.finishReason).not.toBe("error")

      const [reply] = await sql`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1`
      const meta = (reply?.metadata ?? {}) as { toolCalls?: Array<{ toolName?: string }> }
      const toolNames = (meta.toolCalls ?? []).map((t) => String(t.toolName))
      expect(toolNames.length).toBeGreaterThan(0)
      expect(String(reply?.content ?? "").trim().length).toBeGreaterThan(0)

      const turnRequests = sent.slice(before)
      expect(turnRequests.length).toBeGreaterThan(0)
      for (const r of turnRequests) {
        expect(r.model).toBe(UPSTREAM)
        expect(r.provider).toEqual({ data_collection: "deny", require_parameters: true })
        expect(r.reasoning).toEqual({ effort: "low" })
      }

      const [usage] = await sql`
        SELECT input_tokens, output_tokens, raw_cost FROM kernel.credit_transactions
        WHERE org_id = ${ORG_ID} AND model = ${KEY} ORDER BY created_at DESC LIMIT 1`
      expect(Number(usage?.input_tokens)).toBeGreaterThan(0)
      expect(Number(usage?.output_tokens)).toBeGreaterThan(0)
      console.log(
        `[openrouter-live] turn ${i + 1}: tools=${toolNames.join(",")} inputTokens=${usage?.input_tokens} outputTokens=${usage?.output_tokens} rawCostEur=${usage?.raw_cost} effortSent=${turnRequests[0]?.reasoning?.effort} requests=${turnRequests.length} reply=${JSON.stringify(String(reply?.content).slice(0, 120))}`,
      )
    }
  }, 240_000)
})
