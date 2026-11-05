// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S12, SELF-HOSTED PROOF: a stub OpenAI-compatible server (Bun.serve) is added
// as an org's own server through the API, its model passes the test call, and
// an agent turn runs on it end to end, calling a tool and recording usage
// with token counts at cost 0.
//
// The same turn is the S4/S5 proof in the turn path: the conversation is
// pinned to a native model the admin then switched off, and Auto is set to the
// server's model, so the turn must fall back to Auto and land on the stub.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop `{ turn: true }` from the agent turn's pre-check: the pinned,
//    switched-off model is resolved instead and the stub sees no turn.
//  * Send the model KEY instead of its upstream id to the server: the stub's
//    recorded `model` is `custom/<id>/stub-llama` and the assertion fails.
//  * Drop `includeUsage` from the server's provider: the streamed turn reports
//    no tokens and the usage row assertion fails.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  type OpenAICompatibleStub,
  startOpenAICompatibleStub,
} from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000f1001"
const USER_ID = "00000000-0000-4000-8000-0000000f1002"
const THREAD_ID = "00000000-0000-4000-8000-0000000f1003"
const MSG_ID = "00000000-0000-4000-8000-0000000f1010"
const NATIVE = "custom-proof-native"

let stub: OpenAICompatibleStub
let token: string
const saved: Record<string, string | undefined> = {}
const ENV = ["LIAISON_ALLOW_PRIVATE_MODEL_SERVERS", "GOOGLE_API_KEY"]

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe("an org's own model server, end to end (S12)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ENV) saved[k] = process.env[k]
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    process.env.GOOGLE_API_KEY = "test-placeholder-google"
    stub = startOpenAICompatibleStub({
      answer: "pong, the stub server answered",
      // In an agent turn, call the kernel's tool search (harmless, always loaded).
      preferTool: (names) => {
        if (names.includes("ping")) return { name: "ping", args: {} }
        const search = names.find((n) => n.endsWith("tool_search"))
        return search ? { name: search, args: { query: "items" } } : null
      },
    })

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'OwnServerOrg', 'own-server-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'own-server@test.com', 'Own Server') ON CONFLICT DO NOTHING`
    await sql`
      INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('google', ${NATIVE}, 'Native (custom proof)', '1.00000000', '8.00000000', 1048576, false, 'starter')
      ON CONFLICT DO NOTHING`
    // A conversation pinned, before the admin's changes, to the native model.
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id) VALUES (${THREAD_ID}, ${ORG_ID}, 'own-server-chat', 'agent_chat', ${USER_ID}, ${NATIVE}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Own Server",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    stub.stop()
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${NATIVE}`
    for (const k of ENV) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
      else delete process.env[k]
    }
    await releaseTestLock()
  })

  it("adds the server and its model, then a turn on Auto runs on it and calls a tool", async () => {
    const server = await call("POST", "/api/settings/ai/servers", {
      name: "Stub server",
      baseURL: `${stub.url}/v1`,
    })
    expect(server.status).toBe(201)
    const serverId = server.json.data.id as string

    const added = await call("POST", `/api/settings/ai/servers/${serverId}/models`, {
      name: "stub-llama",
      contextWindow: 65536,
    })
    expect(added.status).toBe(201)
    const key = `custom/${serverId}/stub-llama`
    expect(added.json.data).toMatchObject({ key, tools: true, contextWindow: 65536 })

    const patched = await call("PATCH", "/api/settings/ai/models", {
      autoModelKey: key,
      disable: [NATIVE],
    })
    expect(patched.status).toBe(200)
    expect(patched.json.data.resolvedKey).toBe(key)

    const before = stub.requests.length
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${MSG_ID}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', 'Check the connection, please.', '{}')`
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const result = await invokeAgentForThread(
      THREAD_ID,
      MSG_ID,
      { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
      ORG_ID,
    )
    expect(result.finishReason).not.toBe("error")

    // The turn reached the stub with the server's own model name, streamed, with tools.
    const turn = stub.requests
      .slice(before)
      .filter((r) => r.path === "/v1/chat/completions" && r.body.stream === true)
    expect(turn.length).toBeGreaterThanOrEqual(2)
    expect(turn[0]!.body.model).toBe("stub-llama")
    expect(Array.isArray(turn[0]!.body.tools)).toBe(true)

    const [reply] = await sql`
      SELECT content, metadata FROM kernel.messages
      WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    expect(String(reply?.content)).toContain("pong")
    const meta = (reply?.metadata ?? {}) as { toolCalls?: Array<{ toolName?: string }> }
    expect((meta.toolCalls ?? []).some((t) => String(t.toolName).endsWith("tool_search"))).toBe(
      true,
    )

    const [usage] = await sql`
      SELECT model, input_tokens, output_tokens, raw_cost FROM kernel.credit_transactions
      WHERE org_id = ${ORG_ID} AND model = ${key} ORDER BY created_at DESC LIMIT 1`
    expect(usage?.model).toBe(key)
    expect(Number(usage?.input_tokens)).toBeGreaterThan(0)
    expect(Number(usage?.output_tokens)).toBeGreaterThan(0)
    expect(Number(usage?.raw_cost)).toBe(0)
  }, 60_000)
})
