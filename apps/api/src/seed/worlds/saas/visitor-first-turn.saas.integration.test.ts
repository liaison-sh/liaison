// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A VISITOR'S FIRST TURN on the software world, freshly seeded as a visitor org
// at the board date: a question about a prospect who has no Stripe customer.
// The turn runs through the REAL agent loop (context, tool list, tool search,
// tool execution) against a local OpenRouter stub that answers with a scripted
// model, so no model is ever called. Each read the script makes must answer:
// a read that finds nothing says so, and none comes back as a failed call,
// which the trace would show as an app that "did not answer".
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/visitor-first-turn.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
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

/** The software world's catalog apps, installed the way a demo box has them. */
const CATALOG_WORLD_APPS = ["invoicing", "stripe"]
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
// A new org every run: the namespace database outlives a run, and a re-seed adopts what it finds.
const ORG_SLUG = `saas-first-turn-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}
const QUESTION =
  "The prospect from the brasserie says they are leaving. What does that mean for the business, and what should I do?"

/** The reads a model makes on a first question about a prospect, as the walk saw them. */
const READS = [
  "stripe__customers_search",
  "kernel__companies_search",
  "kernel__companies_read",
  "stripe__customers_get",
  "projects__deals_search",
  "kernel__approvals_list",
  "stripe__mrr_query",
] as const

/** One tool call the scripted model makes, by a matcher over the tools the turn can call. */
interface ScriptCall {
  tool: RegExp
  args: () => Record<string, unknown>
}

/** Seeded ids the script reads with (set once the world is seeded). */
const ids = { company: "" }

const SEARCH = (query: string): ScriptCall => ({
  tool: /^kernel__tool_search$/,
  args: () => ({ query }),
})

/** The visitor's per-turn step budget (spec: 8 steps and 6 searches). */
const VISITOR_STEPS = 8

const SEARCHES: ScriptCall[] = [
  SEARCH("find a Stripe customer by name"),
  SEARCH("customer subscription and card"),
  SEARCH("company account manager"),
  SEARCH("deals of a company"),
  SEARCH("approvals waiting on me"),
  SEARCH("monthly recurring revenue"),
]
const READ_CALLS: Record<(typeof READS)[number], ScriptCall> = {
  stripe__customers_search: {
    tool: /^stripe__customers_search$/,
    args: () => ({ query: "Lumen" }),
  },
  kernel__companies_search: {
    tool: /^kernel__companies_search$/,
    args: () => ({ query: "Lumen" }),
  },
  kernel__companies_read: {
    tool: /^kernel__companies_read$/,
    args: () => ({ companyId: ids.company }),
  },
  stripe__customers_get: {
    tool: /^stripe__customers_get$/,
    args: () => ({ companyId: ids.company }),
  },
  projects__deals_search: {
    tool: /^projects__deals_search$/,
    args: () => ({ companyId: ids.company }),
  },
  kernel__approvals_list: { tool: /^kernel__approvals_list$/, args: () => ({}) },
  stripe__mrr_query: { tool: /^stripe__mrr_query$/, args: () => ({}) },
}
const ANSWER_TEXT = "Here is what it means for the business."

/** What the scripted model does this turn: its searches, then the reads it calls. */
const script: { searches: ScriptCall[]; reads: readonly (typeof READS)[number][] } = {
  searches: SEARCHES,
  reads: READS,
}

/** A call's result said the tool was only loaded, not run. */
const notRun = (result: string) => result.includes("did not run")

let world: SeedDemoWorldResult
let stub: ReturnType<typeof Bun.serve>
let appsRoot: string | null = null
const saved: Record<string, string | undefined> = {}
// The visitor budget is not under test here: room for the turn, restored after.
const BUDGET_KEYS = [
  "LIAISON_DEMO_BUDGET_PER_EMAIL_EUR",
  "LIAISON_DEMO_BUDGET_PER_NETWORK_EUR",
  "LIAISON_DEMO_BOX_DAILY_EUR",
  "LIAISON_DEMO_BOX_HOURLY_EUR",
] as const
const savedBudgets: Partial<Record<(typeof BUDGET_KEYS)[number], number>> = {}
const savedAlert = env.LIAISON_DEMO_ALERT_EMAIL
const savedCapture = env.LIAISON_DEMO_MAIL_CAPTURE

/** What the stub saw: the tools each step offered, the calls it made and their results. */
const offeredPerStep: string[][] = []
const called: Array<{ id: string; name: string; via: "direct" | "entry" }> = []
const skipped: string[] = []
const results = new Map<string, string>()
let cursor = 0

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function answer(body: {
  messages: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}): Response {
  const offered = (body.tools ?? []).map((t) => t.function?.name ?? "")
  offeredPerStep.push(offered)
  for (const m of body.messages) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(
        m.tool_call_id,
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
    }
  }
  // Tools loaded outside the fixed list are described in the conversation and
  // called through kernel__call_tool, as a model does.
  const viaEntry = offered.includes("kernel__call_tool")
    ? [
        ...new Set(
          [
            ...JSON.stringify(body.messages).matchAll(
              /\\"name\\":\\"([a-z0-9-]+__[A-Za-z0-9_]+)\\"/g,
            ),
          ].map((m) => m[1] as string),
        ),
      ].filter((n) => !offered.includes(n))
    : []
  const callable = [...offered, ...viaEntry]
  cursor += 1
  const ran = new Set(
    called.filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? "")).map((c) => c.name),
  )
  const pending = script.reads.filter((r) => !ran.has(r))
  const step: ScriptCall[] | null =
    cursor === 1
      ? script.searches
      : pending.length > 0 && cursor < VISITOR_STEPS
        ? pending.map((r) => READ_CALLS[r])
        : null
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" }
  const usage = { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 }
  // A call whose tool the turn cannot call is skipped, and named.
  const calls = step
    ? step.filter((c) => {
        const ok = callable.some((n) => c.tool.test(n))
        if (!ok) skipped.push(String(c.tool))
        return ok
      })
    : []
  if (calls.length === 0) {
    const text = ANSWER_TEXT
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ])
  }
  const toolCalls = calls.map((c, index) => {
    const target = callable.find((n) => c.tool.test(n)) ?? ""
    const direct = offered.includes(target)
    const args = c.args()
    const id = `call_${cursor}_${index}`
    called.push({ id, name: target, via: direct ? "direct" : "entry" })
    const input = direct ? args : { name: target, arguments: args }
    return {
      index,
      id,
      type: "function",
      function: {
        name: direct ? target : "kernel__call_tool",
        arguments: JSON.stringify(input),
      },
    }
  })
  return sse([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls } }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
  ])
}

type Row = Record<string, unknown>
async function rows(orgId: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(orgId, "saas-first-turn-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-first-turn-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) await installFromDist(app, crypto.randomUUID())
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
  process.env.OPENROUTER_API_KEY = "sk-or-first-turn-stub-key"
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
  for (const k of BUDGET_KEYS) {
    savedBudgets[k] = env[k]
    env[k] = 10_000
  }
  env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
  env.LIAISON_DEMO_MAIL_CAPTURE = true
  registerDemoAlertMailer(async () => {})
  DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
    emailNormalized: `first-turn-${Date.now()}@example.com`,
    network: "192.0.2.0/24",
  }))
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: OWNER,
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(async () => {
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

describe("a visitor's first turn, with a scripted model", () => {
  it("every read of a first question about a prospect answers, none fails, the one with no Stripe customer included", async () => {
    expect(world.failures).toEqual([])
    const orgId = world.orgId
    const ownerId = world.org.ownerUserId as string
    const [company] = await rows(
      orgId,
      sql`SELECT id::text AS id FROM kernel.companies WHERE org_id = ${orgId} AND name = 'Brasserie Lumen'`,
    )
    ids.company = String(company?.id ?? "")
    expect(ids.company).not.toBe("")

    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), ownerId)
    const dm = await withPrivilegedDb(orgId, "saas-first-turn-dm", async (tx) => {
      const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: ownerId })
      if (!agentId) throw new Error("the owner has no personal agent")
      return createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId })
    })
    if (!dm) throw new Error("no conversation with the personal agent")
    const posted = await asUser(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: ownerId,
          threadId: dm.id,
          content: QUESTION,
          authorType: "user",
          requiredScopes: [],
        } as never,
      ),
    )
    if (!posted) throw new Error("the visitor's question was not posted")
    const outcome = await invokeAgentForThread(dm.id, posted.id, actor, orgId)

    console.log(
      `CALLED ${called.map((c) => `${c.name}(${c.via})`).join(", ")}\nSKIPPED ${skipped.join(", ")}`,
    )
    for (const c of called)
      console.log(`RESULT ${c.name}: ${(results.get(c.id) ?? "").slice(0, 400)}`)
    expect(skipped).toEqual([])
    expect(outcome.finishReason).toBe("stop")

    // The trace's own verdict on each stored call: none failed.
    const stored = await rows(
      orgId,
      sql`SELECT metadata->'toolCalls' AS calls FROM kernel.messages
          WHERE org_id = ${orgId} AND thread_id = ${dm.id}::uuid AND author_type <> 'user'`,
    )
    const calls = stored
      .flatMap((r) => (Array.isArray(r.calls) ? r.calls : []))
      .map((c) => c as { name?: string; status?: string; result?: unknown })
    const failed = calls
      .filter(
        (c) =>
          c.status === "error" ||
          (c.result !== null &&
            typeof c.result === "object" &&
            (c.result as { error?: unknown }).error != null),
      )
      .map((c) => `${c.name}: ${JSON.stringify(c.result).slice(0, 300)}`)
    expect(failed).toEqual([])
    // Every read ran.
    const ran = new Set(
      called
        .filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? ""))
        .map((c) => c.name),
    )
    expect([...READS].filter((r) => !ran.has(r))).toEqual([])
    expect(cursor).toBeLessThanOrEqual(VISITOR_STEPS)

    // The prospect has no Stripe customer, and the read says so in words.
    const get = called.find(
      (c) => c.name === "stripe__customers_get" && !notRun(results.get(c.id) ?? ""),
    )
    expect(results.get(get?.id ?? "") ?? "").toContain("No Stripe customer is linked")
  }, 600_000)
})
