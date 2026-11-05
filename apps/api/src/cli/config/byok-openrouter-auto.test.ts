// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE OPENROUTER KEY IS ENOUGH TO CHAT: a fresh instance provisioned by
// `liaison config apply` with a `byok` section holding an OpenRouter key and
// nothing else is ready for a conversation, with no dashboard step. The apply
// validates the key, makes OpenRouter's default model Auto, and the first
// agent turn runs on it with the org's own key.
//
// OpenRouter is a local stub (tests/openai-compatible-stub.ts) at the HTTP
// boundary: no paid model is ever called.
//
// THE MUTATIONS THAT PROVE THIS BITES
//  * Drop the `ensureOpenRouterAuto` step from the byok provisioner AND the
//    pre-check self-heal: the turn fails on Auto with nothing to run.
//  * Restore the global Auto pick: the turn asks for Google's model and fails
//    on a key the org never had; the stub sees no chat request.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { runConfigApply } from "~/cli/config/apply"
import { validateConfig } from "~/cli/config/schema"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { OPENROUTER_CATALOGUE_CACHE_KEY } from "~/modules/agent/credits/openrouter-catalogue"
import { OPENROUTER_AUTO_DEFAULT_KEY } from "~/modules/agent/credits/openrouter-default"
import {
  type OpenAICompatibleStub,
  STUB_OPENROUTER_CATALOGUE,
  startOpenAICompatibleStub,
} from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ENV = [
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
]
const saved: Record<string, string | undefined> = {}
const ORG_KEY = "sk-or-v1-config-apply-only-key"

let stub: OpenAICompatibleStub
let orgId = ""
let threadId = ""

describe("config apply with an OpenRouter key alone", () => {
  beforeAll(async () => {
    await acquireTestLock()
    _setEdition("self_hosted")
    for (const k of ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    stub = startOpenAICompatibleStub({
      catalogue: STUB_OPENROUTER_CATALOGUE,
      answer: "pong, OpenRouter answered",
      // In an agent turn, call the kernel's tool search (harmless, always loaded).
      preferTool: (names) => {
        const search = names.find((n) => n.endsWith("tool_search"))
        return search ? { name: search, args: { query: "items" } } : null
      },
    })
    process.env.OPENROUTER_BASE_URL = `${stub.url}/api/v1`
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
  })

  afterAll(async () => {
    stub.stop()
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    if (orgId) {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
      if (threadId) {
        await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
        await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
      }
    }
    for (const k of ENV) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
      else delete process.env[k]
    }
    _setEdition(null)
    await releaseTestLock()
  })

  it("leaves the org ready to chat, and the first turn runs on OpenRouter", async () => {
    const slug = `or-only-${crypto.randomUUID().slice(0, 12)}`
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@or-only.example`
    const parsed = validateConfig({
      org: { slug, name: "OpenRouter Only" },
      admin: { email, name: "Robin Owner" },
      byok: { openrouter: { apiKey: ORG_KEY } },
    })
    if (!parsed.ok) throw new Error(parsed.message)

    const logs: string[] = []
    const res = await runConfigApply({
      config: parsed.config,
      format: "json",
      dryRun: false,
      validateByok: true,
      echoSupplied: false,
      log: (m) => logs.push(m),
    })
    expect(res.exitCode).toBe(0)
    expect(JSON.stringify(res.report)).not.toContain(ORG_KEY)

    // The key was validated against OpenRouter, with the org's own key.
    expect(
      stub.requests.some(
        (r) => r.path === "/api/v1/key" && r.authorization === `Bearer ${ORG_KEY}`,
      ),
    ).toBe(true)
    expect(logs.some((l) => l.includes("Auto runs on OpenRouter's default model"))).toBe(true)

    const [org] = await sql`SELECT id, settings FROM kernel.organizations WHERE slug = ${slug}`
    if (!org) throw new Error("org not created")
    orgId = String(org.id)
    const models = (org.settings as { ai?: { models?: { autoModelKey?: string } } }).ai?.models
    expect(models?.autoModelKey).toBe(OPENROUTER_AUTO_DEFAULT_KEY)

    const [owner] =
      await sql`SELECT id FROM kernel.users WHERE org_id = ${orgId} AND email = ${email.toLowerCase()}`
    if (!owner) throw new Error("owner not created")
    const userId = String(owner.id)

    threadId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${threadId}, ${orgId}, 'or-only-chat', 'agent_chat', ${userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${userId}, ${orgId})`
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${messageId}, ${threadId}, ${orgId}, ${userId}, 'user', 'Hello, are you there?', '{}')`

    const before = stub.requests.length
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const result = await invokeAgentForThread(
      threadId,
      messageId,
      { userId, orgId, scopes: ["*"], dimensionGrants: {} },
      orgId,
    )
    expect(result.finishReason).not.toBe("error")

    // The turn reached OpenRouter with its default model and the org's own key.
    const turn = stub.requests
      .slice(before)
      .filter((r) => r.path === "/api/v1/chat/completions" && r.body.stream === true)
    expect(turn.length).toBeGreaterThanOrEqual(1)
    expect(turn[0]!.body.model).toBe("deepseek/deepseek-v4.1-flash")
    expect(turn[0]!.authorization).toBe(`Bearer ${ORG_KEY}`)

    const [reply] = await sql`
      SELECT content FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    expect(String(reply?.content)).toContain("pong")

    const [usage] = await sql`
      SELECT model FROM kernel.credit_transactions
      WHERE org_id = ${orgId} AND model = ${OPENROUTER_AUTO_DEFAULT_KEY} LIMIT 1`
    expect(usage?.model).toBe(OPENROUTER_AUTO_DEFAULT_KEY)
  }, 90_000)
})
