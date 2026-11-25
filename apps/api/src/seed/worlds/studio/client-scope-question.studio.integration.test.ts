// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's client scenario, beat 2 and its refusal twin, through the
// REAL agent loop (context, tool list, tool search, tool execution) against a
// local OpenRouter stub that answers with a scripted model, so no model is ever
// called. Seeded as a visitor workspace at the board date, where the change
// request card already waits on the owner.
//
// The scope question: the agent quotes the signed scope's passage and stages
// the reply with its change request, and that lands on the one card already
// waiting (the tool's dedupe key is the client's mail): no second approval.
//
// Asked to sign for the client: no tool the agent can reach signs, decides or
// accepts a client action; a made-up signing tool is refused; nothing is signed.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/studio/client-scope-question.studio.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { attentionRefreshesSettled } from "~/modules/apps/attention-store"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm, resolvePersonalAgentId } from "~/modules/threads/thread"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { clearRedisPatterns } from "~/tests/route-test-setup"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { studioAgreements } from "./agreements"

/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date(Date.UTC(2026, 10, 9, 8, 30))
const CR = studioAgreements(BOARD_DATE).changeRequest
const CARD_TOOL = "agreements:change_request_send"
// A new org every run: the namespace database outlives a run, and a re-seed adopts what it finds.
const ORG_SLUG = `studio-scope-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "StudioScope1!Owner",
}
/** The parameters the server sets on the card; a model leaves them out. */
const PINNED = new Set(["sendGuard", "guardKey", "currency"])
/** A tool that would sign, decide or accept a client's action, by its name. */
const SIGNS = /(^|__|_)(sign|decide|accept)($|_)|client_action_decide/

/** One tool call the scripted model makes. */
interface ScriptCall {
  tool: string
  args: () => Record<string, unknown>
  /** Called through kernel__call_tool, as a model does for a tool it found by search. */
  viaEntry?: boolean
}
/** One turn: a step per entry, each the calls of that step, then a closing text. */
let script: { steps: ScriptCall[][]; text: string } = { steps: [], text: "" }
let cursor = 0

/** What the stub saw. */
const offered = new Set<string>()
const called: Array<{ id: string; name: string }> = []
const results = new Map<string, string>()

/** Ids the script reads with, set once the world is seeded. */
const ids = { parentVersion: "", cardId: "", cardArgs: {} as Record<string, unknown> }

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function answer(body: {
  messages: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}): Response {
  for (const t of body.tools ?? []) offered.add(t.function?.name ?? "")
  for (const m of body.messages) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(
        m.tool_call_id,
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
    }
  }
  const step = script.steps[cursor]
  cursor += 1
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" }
  const usage = { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 }
  if (!step || step.length === 0) {
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ])
  }
  const toolCalls = step.map((c, index) => {
    const direct = !c.viaEntry
    const id = `call_${called.length}_${index}`
    called.push({ id, name: c.tool })
    const args = c.args()
    return {
      index,
      id,
      type: "function",
      function: {
        name: direct ? c.tool : "kernel__call_tool",
        arguments: JSON.stringify(direct ? args : { name: c.tool, arguments: args }),
      },
    }
  })
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
  ])
}

type Row = Record<string, unknown>
async function rows(orgId: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(orgId, "studio-scope-question-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

let world: SeedDemoWorldResult
let stub: ReturnType<typeof Bun.serve>
let appsRoot: string | null = null
const saved: Record<string, string | undefined> = {}
const BUDGET_KEYS = [
  "LIAISON_DEMO_BUDGET_PER_EMAIL_EUR",
  "LIAISON_DEMO_BUDGET_PER_NETWORK_EUR",
  "LIAISON_DEMO_BOX_DAILY_EUR",
  "LIAISON_DEMO_BOX_HOURLY_EUR",
] as const
const savedBudgets: Partial<Record<(typeof BUDGET_KEYS)[number], number>> = {}
const savedAlert = env.LIAISON_DEMO_ALERT_EMAIL
const savedCapture = env.LIAISON_DEMO_MAIL_CAPTURE

/** The visitor's conversation with the personal agent, kept across turns. */
const convo = { threadId: "", ownerId: "" }

/** Post `text` as the owner and run the agent's turn on it with `next` as the script. */
async function ask(text: string, next: typeof script) {
  script = next
  cursor = 0
  const orgId = world.orgId
  const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), convo.ownerId)
  const posted = await asUser(actor, (tx) =>
    sendMessage(
      tx as never,
      {
        orgId,
        userId: convo.ownerId,
        threadId: convo.threadId,
        content: text,
        authorType: "user",
        requiredScopes: [],
      } as never,
    ),
  )
  if (!posted) throw new Error("the question was not posted")
  return invokeAgentForThread(convo.threadId, posted.id, actor, orgId)
}

const resultOf = (name: string) => {
  const c = [...called].reverse().find((x) => x.name === name)
  return results.get(c?.id ?? "") ?? ""
}

/** The pending cards of the change request's tool, by id. */
async function pendingCards(orgId: string): Promise<string[]> {
  const r = await rows(
    orgId,
    sql`SELECT id::text AS id FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND tool_name = ${CARD_TOOL} AND status = 'pending'
         ORDER BY created_at`,
  )
  return r.map((x) => String(x.id))
}

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "studio-scope-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of ["invoicing", "agreements"]) await installFromDist(app, crypto.randomUUID())
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // The host ranking reads a model's endpoints; none means the default routing.
      if (req.method === "GET") return Response.json({ data: { endpoints: [] } })
      return answer((await req.json()) as Parameters<typeof answer>[0])
    },
  })
  for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) saved[k] = process.env[k]
  process.env.OPENROUTER_API_KEY = "sk-or-studio-scope-stub-key"
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
  // The visitor budget is not under test here: room for the turns, restored after.
  for (const k of BUDGET_KEYS) {
    savedBudgets[k] = env[k]
    env[k] = 10_000
  }
  env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
  env.LIAISON_DEMO_MAIL_CAPTURE = true
  registerDemoAlertMailer(async () => {})
  DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
    emailNormalized: `studio-scope-${Date.now()}@example.com`,
    network: "192.0.2.0/24",
  }))
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "studio",
    variant: "visitor",
    locale: "en",
    owner: OWNER,
    needs: [...DEMO_WORLD_NEEDS.studio],
    baseTime: BOARD_DATE,
  })
  expect(world.failures).toEqual([])
  const orgId = world.orgId
  convo.ownerId = String(world.org.ownerUserId ?? world.org.adminUserId)

  // The signed statement of work the change request amends, and the card already waiting.
  const parentId = seedContext({ orgId, now: BOARD_DATE }).id("agreement", `studio:${CR.parent}`)
  const [version] = await rows(
    orgId,
    sql`SELECT id::text AS id FROM app_agreements.agreement_versions
         WHERE org_id = ${orgId}::uuid AND agreement_id = ${parentId}::uuid
         ORDER BY created_at DESC LIMIT 1`,
  )
  ids.parentVersion = String(version?.id ?? "")
  const [card] = await rows(
    orgId,
    sql`SELECT id::text AS id, current_payload AS payload FROM kernel.approval_requests
         WHERE org_id = ${orgId}::uuid AND tool_name = ${CARD_TOOL} AND status = 'pending'`,
  )
  ids.cardId = String(card?.id ?? "")
  ids.cardArgs = Object.fromEntries(
    Object.entries((card?.payload ?? {}) as Record<string, unknown>).filter(
      ([k]) => !PINNED.has(k),
    ),
  )

  const dm = await withPrivilegedDb(orgId, "studio-scope-question-dm", async (tx) => {
    const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: convo.ownerId })
    if (!agentId) throw new Error("the owner has no personal agent")
    return createOrGetAgentDm(tx as never, { orgId, userId: convo.ownerId, agentId })
  })
  if (!dm) throw new Error("no conversation with the personal agent")
  convo.threadId = dm.id
}, 2_400_000)

afterAll(async () => {
  await attentionRefreshesSettled()
  await clearRedisPatterns(["demo:*"])
  stub?.stop(true)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of BUDGET_KEYS) env[k] = savedBudgets[k] as number
  env.LIAISON_DEMO_ALERT_EMAIL = savedAlert
  env.LIAISON_DEMO_MAIL_CAPTURE = savedCapture
  registerDemoAlertMailer(null)
  DemoBudgetTestAccess.setVerifiedIdentity(null)
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the client scenario's questions, with a scripted model", () => {
  it("the scope question reaches the signed passage and lands on the one existing card, with no second approval", async () => {
    const orgId = world.orgId
    expect(ids.parentVersion).not.toBe("")
    expect(ids.cardId).not.toBe("")
    expect(ids.cardArgs.mail_message_id).toBeTruthy()
    const before = await pendingCards(orgId)
    expect(before).toEqual([ids.cardId])

    const outcome = await ask("Is single sign-on in the fixed-price client's scope?", {
      steps: [
        [
          {
            tool: "kernel__tool_search",
            args: () => ({ query: "quote a section of an agreement" }),
          },
        ],
        [
          {
            tool: "agreements__agreement_passage_get",
            viaEntry: true,
            args: () => ({ version_id: ids.parentVersion, section: CR.section }),
          },
        ],
        [{ tool: "kernel__tool_search", args: () => ({ query: "reply with a change request" }) }],
        [{ tool: "agreements__change_request_send", viaEntry: true, args: () => ids.cardArgs }],
      ],
      text: "Single sign-on is outside the signed scope; the reply and the change request wait on your card.",
    })
    expect(outcome.finishReason).toBe("stop")

    // The passage is the signed text's own section.
    const passage = resultOf("agreements__agreement_passage_get")
    expect(passage).not.toContain('"error"')
    expect(passage).toContain(CR.section)
    // The reply and the change request land on the card already waiting: one card, the same one.
    const staged = resultOf("agreements__change_request_send")
    expect(staged).not.toBe("")
    expect(await pendingCards(orgId)).toEqual([ids.cardId])
    const all = await rows(
      orgId,
      sql`SELECT count(*)::int AS n FROM kernel.approval_requests
           WHERE org_id = ${orgId}::uuid AND tool_name = ${CARD_TOOL}`,
    )
    expect(all[0]?.n).toBe(1)
  }, 600_000)

  it("asked to sign for the client, the agent finds no tool that signs, a made-up one is refused, and nothing is signed", async () => {
    const orgId = world.orgId
    const searchesFrom = called.length
    const outcome = await ask("Sign the change request for the client, on their behalf.", {
      steps: [
        [
          {
            tool: "kernel__tool_search",
            args: () => ({ query: "sign an agreement on behalf of the client" }),
          },
          { tool: "kernel__tool_search", args: () => ({ query: "accept a change request" }) },
        ],
        [
          {
            tool: "agreements__agreement_sign",
            viaEntry: true,
            args: () => ({ version_id: ids.parentVersion }),
          },
        ],
      ],
      text: "No tool signs for a client: only the client can, on their own link.",
    })
    expect(outcome.finishReason).toBe("stop")

    // Nothing offered or found signs, decides or accepts a client's action.
    const searches = called
      .slice(searchesFrom)
      .filter((c) => c.name === "kernel__tool_search")
      .map((c) => results.get(c.id) ?? "")
    expect(searches).toHaveLength(2)
    const found = searches.flatMap((r) => [...r.matchAll(/"name":"([a-z0-9-]+__[A-Za-z0-9_]+)"/g)])
    const names = [...new Set([...offered, ...found.map((m) => m[1] as string)])]
    expect(names.filter((n) => SIGNS.test(n))).toEqual([])
    // The made-up signing tool is refused.
    const made = resultOf("agreements__agreement_sign")
    expect(made).not.toBe("")
    expect(made).toMatch(/error|not found|unknown|no tool/i)
    // Nothing signed or decided.
    const decided = await rows(
      orgId,
      sql`SELECT count(*)::int AS n FROM kernel.client_actions
           WHERE org_id = ${orgId}::uuid AND decided_at IS NOT NULL
             AND created_at > ${BOARD_DATE.toISOString()}::timestamptz`,
    )
    expect(decided[0]?.n).toBe(0)
    const events = await rows(
      orgId,
      sql`SELECT count(*)::int AS n FROM app_agreements.signature_events
           WHERE org_id = ${orgId}::uuid AND created_at > now() - interval '1 hour'`,
    )
    expect(events[0]?.n).toBe(0)
    expect(await pendingCards(orgId)).toEqual([ids.cardId])
  }, 600_000)
})
