// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A DEMO VISITOR'S AGENT STEP SENDS, measured on a real seeded world.
//
// A visitor step on the box key holds its input's uncached worst cost in the
// visitor's budget as it leaves (estimated the strict visitor way: ASCII chars /
// 3 plus one per non-ASCII code point; step-token-cap.ts), so a guided step stays
// under 100,000 estimated tokens, and the whole "Everything" run must cost under
// EUR 0.10 on the pinned model. This seeds one visitor org with every
// need, then plays each scenario's agent turns through the REAL agent loop
// (context assembly, tool set, tool execution, step meter) against a local
// OpenRouter stub that answers with a scripted model: the calls a live run made
// (search the web, load an app's tools, read, create). Every request the loop
// sends is measured, so the numbers are the request bodies themselves.
//
//   cd apps/api && bun run ../../scripts/with-test-lock.ts -- \
//     bun test src/seed/tiers/demo/visitor-turn-size.integration.test.ts --timeout 2400000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  buildTriggerEventPreamble,
  resolveRoutineOwnerDimensionGrants,
} from "~/infra/jobs/kernel-jobs"
import { env } from "~/lib/env"
import { visitorStepsPerTurn } from "~/modules/agent/credits/credit-meter"
import { estimateVisitorTokens } from "~/modules/agent/providers/step-token-cap"
import { seedRoutineTickTools } from "~/modules/agent/routines/routine-tool-seed"
import { type RoutineTriggerEvent, runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { invokeAgentForThread, ROUTINE_RUN_PAUSE_NOTE } from "~/modules/agent/runtime/agent-service"
import { VISITOR_RESULT_LIMITS } from "~/modules/agent/runtime/result-truncation"
import { TURN_BUDGET_CHECK_IN_NOTE } from "~/modules/agent/runtime/turn-input-budget"
import { OPENROUTER_WEB_SEARCH_MODEL } from "~/modules/agent/tools/web-search-openrouter"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  VISITOR_CACHED_INPUT_USD_PER_M,
  VISITOR_ECB_USD_PER_EUR,
  VISITOR_INPUT_USD_PER_M,
  VISITOR_OUTPUT_USD_PER_M,
} from "~/modules/demo/demo-spend-ceiling"
import { createOrGetAgentDm, resolvePersonalAgentId } from "~/modules/threads/thread"
import { clearRedisPatterns } from "~/tests/route-test-setup"
import { stageDemoCatalog } from "../../../../test-support/seed/stage-demo-catalog"
import { PROSPECT_SCENARIO_ROUTINE, SUPPORT_SCENARIO_ROUTINE } from "./seed-agent-native"
import { type SeedDemoWorldResult, seedDemoWorld } from "./seed-demo"

const DB_URL = process.env.DATABASE_URL ?? ""
/**
 * The size a guided step stays under: its input hold (about 26,800 µEUR at this
 * size, demo-spend-ceiling.ts ONE STEP) keeps a scenario inside a visitor's budget.
 * Raised from 90,000 (the old per-step input cap, gone since 2026-10-29) when a
 * conversation's tool list became fixed: the schemas of tools loaded on later
 * turns ride the conversation as notes and stay in it, where they were in the
 * tool list for one turn only. The worst bound of this walk, which plays every
 * scenario in ONE conversation, measured 96,600 with them (the fifth turn).
 */
const STEP_SIZE_TARGET = 100_000
const EVERYTHING_EUR_CAP = 0.1

/** One scripted model answer: a tool call (by a matcher over the offered tools) or text. */
type ScriptStep =
  | { tool: RegExp; args: (offered: string[]) => Record<string, unknown> }
  | { text: string }

interface ScenarioTurn {
  scenario: string
  prompt: string
  script: ScriptStep[]
}

const ANSWER = (topic: string) =>
  `Here is what I found about ${topic}. ${"A sourced point with its reference. ".repeat(30)}`

/** Seeded ids the scripts read with (set once the world is seeded). */
const ids = { ticket: "", contact: "", doc: "" }

const TURNS: ScenarioTurn[] = [
  {
    scenario: "chat",
    prompt:
      "Tobias asks which EU rules on battery passports apply to us from 2027 and what we need to change. Can you research this, with sources?",
    script: [
      { tool: /^kernel__web_search$/, args: () => ({ query: "EU battery passport 2027 rules" }) },
      {
        tool: /^kernel__web_search$/,
        args: () => ({ query: "EU battery regulation 2023/1542 passport" }),
      },
      {
        tool: /^kernel__web_search$/,
        args: () => ({ query: "battery passport QR code data fields" }),
      },
      { text: ANSWER("the EU battery passport") },
    ],
  },
  {
    scenario: "chat",
    prompt: "turn this into a task for Tobias",
    script: [
      { tool: /^kernel__tool_search$/, args: () => ({ query: "create a project task" }) },
      // The live run's over-eager follow-up: a project, then task after task.
      ...Array.from({ length: 10 }, (_, n) => ({
        tool: /^projects__create$/,
        args: () => ({ title: `EU battery passport: step ${n + 1}` }),
      })),
      { text: "I created the tasks for Tobias." },
    ],
  },
  {
    scenario: "projects",
    prompt: "break this into subtasks for next week and let Tobias know",
    script: [
      { tool: /^kernel__tool_search$/, args: () => ({ query: "project tasks subtasks" }) },
      ...Array.from({ length: 6 }, (_, n) => ({
        tool: /^projects__create$/,
        args: () => ({ title: `Subtask ${n + 1}` }),
      })),
      { text: "I broke it into subtasks and told Tobias." },
    ],
  },
  {
    scenario: "support",
    prompt: "what else did this customer report before?",
    script: [
      {
        tool: /^kernel__tool_search$/,
        args: () => ({ query: "select:tickets__listForContact,tickets__get" }),
      },
      { tool: /^tickets__listForContact$/, args: () => ({ contactId: ids.contact }) },
      { tool: /^tickets__get$/, args: () => ({ ticketId: ids.ticket }) },
      { text: ANSWER("this customer's earlier tickets") },
    ],
  },
  {
    scenario: "commerce",
    prompt: "where does order #1097 stand, and can you prepare its shipment?",
    script: [
      { tool: /^kernel__tool_search$/, args: () => ({ query: "shopify order shipment" }) },
      {
        tool: /^shopify__(orders_get|get_order|order_get|orders_search|search_orders)$/,
        args: () => ({ query: "1097" }),
      },
      { text: ANSWER("order #1097") },
    ],
  },
]

interface Measured {
  cachedTokens: number
  scenario: string
  turn: number
  step: number
  estimatedTokens: number
  messagesTokens: number
  toolsTokens: number
  toolCount: number
  topTools: string[]
}

describe("a demo visitor's agent steps fit the step cap and the Everything budget", () => {
  let world: SeedDemoWorldResult
  let stub: ReturnType<typeof Bun.serve>
  const measured: Measured[] = []
  const finishes: string[] = []
  let current: { scenario: string; turn: number; script: ScriptStep[]; step: number } | null = null
  const saved: Record<string, string | undefined> = {}
  let savedSteps = env.LIAISON_DEMO_STEPS_PER_TURN
  let webSearches = 0
  let previousBody = ""
  const savedAlert = env.LIAISON_DEMO_ALERT_EMAIL
  const savedCapture = env.LIAISON_DEMO_MAIL_CAPTURE
  let webSearchFixture: unknown
  let appsTmp: string | null = null
  let catalogDir: string | null = null
  const savedCatalogDir = process.env.LIAISON_APP_CATALOG_DIR
  const BUDGET_KEYS = [
    "LIAISON_DEMO_BUDGET_PER_EMAIL_EUR",
    "LIAISON_DEMO_BUDGET_PER_NETWORK_EUR",
    "LIAISON_DEMO_BOX_DAILY_EUR",
    "LIAISON_DEMO_BOX_HOURLY_EUR",
  ] as const
  const savedBudgets: Partial<Record<(typeof BUDGET_KEYS)[number], number>> = {}

  function sse(chunks: unknown[]): Response {
    const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
  }

  function answer(body: {
    messages: unknown[]
    tools?: Array<{ function?: { name?: string } }>
    tool_choice?: unknown
  }): Response {
    const offered = (body.tools ?? []).map((t) => t.function?.name ?? "")
    const promptTokens = estimateVisitorTokens(JSON.stringify(body.messages))
    const toolTokens = estimateVisitorTokens(JSON.stringify(body.tools ?? []))
    const top = (body.tools ?? [])
      .map((t) => ({ n: t.function?.name ?? "", s: JSON.stringify(t).length }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((t) => `${t.n}:${Math.ceil(t.s / 3)}`)
    const cur = current
    const whole = JSON.stringify(body.tools ?? []) + JSON.stringify(body.messages)
    let common = 0
    const limit = Math.min(whole.length, previousBody.length)
    while (common < limit && whole.charCodeAt(common) === previousBody.charCodeAt(common)) common++
    previousBody = whole
    if (process.env.TURN_SIZE_DUMP) {
      require("node:fs").appendFileSync(process.env.TURN_SIZE_DUMP, `${JSON.stringify(body)}\n`)
    }
    if (cur) {
      measured.push({
        cachedTokens: estimateVisitorTokens(whole.slice(0, common)),
        scenario: cur.scenario,
        turn: cur.turn,
        step: cur.step,
        estimatedTokens: promptTokens + toolTokens,
        messagesTokens: promptTokens,
        toolsTokens: toolTokens,
        toolCount: offered.length,
        topTools: top,
      })
    }
    const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" }
    const usage = {
      prompt_tokens: promptTokens + toolTokens,
      completion_tokens: 60,
      total_tokens: promptTokens + toolTokens + 60,
    }
    // The tools loaded outside the thread's fixed list: their notes describe
    // them, and they are called through kernel__call_tool, as a model does.
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
    // Next scripted step whose tool is offered (a missing tool is skipped).
    // A step that must answer in words (its note says so, or tool calls are
    // switched off) is answered in words, as a model does.
    const lastText = JSON.stringify(body.messages.at(-1) ?? "")
    const answerOnly =
      body.tool_choice === "none" ||
      lastText.includes(JSON.stringify(TURN_BUDGET_CHECK_IN_NOTE).slice(1, 50)) ||
      lastText.includes(JSON.stringify(ROUTINE_RUN_PAUSE_NOTE).slice(1, 80))
    let step: ScriptStep | undefined
    while (!answerOnly && cur && cur.step < cur.script.length) {
      const s = cur.script[cur.step]
      cur.step += 1
      if (!s) break
      if ("text" in s || callable.some((n) => s.tool.test(n))) {
        step = s
        break
      }
    }
    if (!step || "text" in step) {
      const text = step && "text" in step ? step.text : "Done."
      return sse([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ])
    }
    const target = callable.find((n) => step.tool.test(n)) ?? ""
    const direct = offered.includes(target)
    const name = direct ? target : "kernel__call_tool"
    const args = step.args(offered)
    const input = direct ? args : { name: target, arguments: args }
    return sse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${cur?.scenario}_${cur?.step}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(input) },
                },
              ],
            },
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
    ])
  }

  beforeAll(async () => {
    if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
    if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
      throw new Error("refusing to seed a shared database: use a namespace database")
    }
    DemoModeTestAccess.set(true)
    if (!process.env.LIAISON_APPS_DIR) {
      appsTmp = mkdtempSync(path.join(tmpdir(), "visitor-turn-size-"))
      process.env.LIAISON_APPS_DIR = path.join(appsTmp, "apps")
    }
    // The catalog apps (invoicing, shopify, boxtal...): without them the
    // commerce layer and the sales routine are not seeded.
    catalogDir = stageDemoCatalog("visitor-turn-size")
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    webSearchFixture = (
      await import("../../../modules/agent/tools/__fixtures__/openrouter-web-search.json")
    ).default
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        // The host ranking reads a model's endpoints; none means the default routing.
        if (req.method === "GET") return Response.json({ data: { endpoints: [] } })
        const body = (await req.json()) as {
          model: string
          messages: unknown[]
          tools?: Array<{ function?: { name?: string } }>
          tool_choice?: unknown
        }
        if (body.model === OPENROUTER_WEB_SEARCH_MODEL) {
          webSearches += 1
          return Response.json(webSearchFixture)
        }
        return answer(body)
      },
    })
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) saved[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = "sk-or-visitor-turn-size-box-key"
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
    // Measure every step, however big: the cap is asserted below, not enforced here.
    savedSteps = env.LIAISON_DEMO_STEPS_PER_TURN
    // TURN_SIZE_STEPS replays the old cap (12) for a before/after comparison.
    if (process.env.TURN_SIZE_STEPS)
      env.LIAISON_DEMO_STEPS_PER_TURN = Number(process.env.TURN_SIZE_STEPS)
    for (const k of BUDGET_KEYS) {
      savedBudgets[k] = env[k]
      env[k] = 10_000
    }
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    env.LIAISON_DEMO_MAIL_CAPTURE = true
    registerDemoAlertMailer(async () => {})
    DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
      emailNormalized: `turn-size-${Date.now()}@example.com`,
      network: "192.0.2.0/24",
    }))

    const started = Date.now()
    world = await seedDemoWorld({
      orgSlug: `turn-size-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      // What Start sends for "Everything": every need, so the scenarios' routines are seeded.
      needs: ["support", "projects", "chat", "sales", "commerce", "dev", "knowledge"],
    })
    console.log(`seeded in ${Math.round((Date.now() - started) / 1000)} s`)
  }, 2_400_000)

  afterAll(async () => {
    if (appsTmp) {
      rmSync(appsTmp, { recursive: true, force: true })
      delete process.env.LIAISON_APPS_DIR
    }
    if (catalogDir) rmSync(catalogDir, { recursive: true, force: true })
    if (savedCatalogDir === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
    else process.env.LIAISON_APP_CATALOG_DIR = savedCatalogDir
    // The budget counters these turns wrote live under this run's Redis prefix.
    await clearRedisPatterns(["demo:*"])
    stub?.stop(true)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    env.LIAISON_DEMO_STEPS_PER_TURN = savedSteps
    for (const k of BUDGET_KEYS) env[k] = savedBudgets[k] as number
    env.LIAISON_DEMO_ALERT_EMAIL = savedAlert
    env.LIAISON_DEMO_MAIL_CAPTURE = savedCapture
    registerDemoAlertMailer(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    DemoModeTestAccess.set(null)
  })

  it("plays every scenario's agent turns and measures each step", async () => {
    if (world.failures.length > 0)
      console.log("SEED FAILURES", JSON.stringify(world.failures).slice(0, 4000))
    const orgId = world.orgId
    const ownerId = world.org.ownerUserId as string
    const actor = {
      actorType: "user" as const,
      userId: ownerId,
      orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const dm = await withPrivilegedDb(orgId, "turn-size-dm", async (tx) => {
      const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: ownerId })
      if (!agentId) throw new Error("the visitor has no personal agent")
      return createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId })
    })
    if (!dm) throw new Error("no DM")

    const rows = async <T>(q: ReturnType<typeof sql>) =>
      withPrivilegedDb(orgId, "turn-size-read", async (tx) => {
        const r = await tx.execute(q)
        return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[]
      })
    const [ticket] = await rows<{ id: string; contact: string | null }>(
      sql`SELECT t.id::text AS id, t.contact_id::text AS contact FROM app_tickets.tickets t
          WHERE t.org_id = ${orgId}::uuid AND t.contact_id IS NOT NULL
          ORDER BY (SELECT count(*) FROM app_tickets.tickets o WHERE o.contact_id = t.contact_id) DESC,
                   t.message_count DESC LIMIT 1`,
    )
    const [doc] = await rows<{ id: string }>(
      sql`SELECT id::text AS id FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid
          ORDER BY length(coalesce(body::text, '')) DESC LIMIT 1`,
    ).catch(() => [] as { id: string }[])
    ids.ticket = ticket?.id ?? ""
    ids.contact = ticket?.contact ?? ""
    ids.doc = doc?.id ?? ""

    for (const [i, t] of TURNS.entries()) {
      current = { scenario: t.scenario, turn: i, script: t.script, step: 0 }
      const messageId = crypto.randomUUID()
      await withPrivilegedDb(orgId, "turn-size-message", async (tx) => {
        await tx.execute(
          sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes)
              VALUES (${messageId}::uuid, ${orgId}::uuid, ${dm.id}::uuid, ${ownerId}::uuid, 'user', ${t.prompt}, '{}'::text[])`,
        )
      })
      const outcome = await invokeAgentForThread(dm.id, messageId, actor, orgId)
      finishes.push(`${t.scenario}#${i}: ${outcome.finishReason}`)
      current = null
    }

    // THE ROUTINE TURNS the support and sales scenarios set off: a new ticket
    // fires the support routine, the prospect's email the sales one.
    const routineRows = await rows<{ id: string; name: string }>(
      sql`SELECT id::text AS id, name FROM kernel.routines WHERE org_id = ${orgId}::uuid
          AND name IN (${SUPPORT_SCENARIO_ROUTINE}, ${PROSPECT_SCENARIO_ROUTINE})`,
    )
    await rows(
      sql`UPDATE kernel.routines SET enabled = true WHERE org_id = ${orgId}::uuid
          AND name IN (${SUPPORT_SCENARIO_ROUTINE}, ${PROSPECT_SCENARIO_ROUTINE}) RETURNING id`,
    )
    const ROUTINES: Array<{
      scenario: string
      name: string
      trigger: RoutineTriggerEvent
      script: ScriptStep[]
    }> = [
      {
        scenario: "support-routine",
        name: SUPPORT_SCENARIO_ROUTINE,
        trigger: {
          app: "tickets",
          entity: "ticket",
          action: "create",
          entityId: ticket?.id ?? null,
          data: { ticketId: ticket?.id },
        },
        script: [
          { tool: /^tickets__get$/, args: () => ({ ticketId: ids.ticket }) },
          { tool: /^tickets__listForContact$/, args: () => ({ contactId: ids.contact }) },
          { tool: /^knowledge__get$/, args: () => ({ id: ids.doc }) },
          {
            tool: /^tickets__addNote$/,
            args: () => ({
              ticketId: ids.ticket,
              text: "**Known issue.** Sources: the KB article.",
            }),
          },
          {
            tool: /^tickets__reply$/,
            args: () => ({ ticketId: ticket?.id, body: "Thanks for writing." }),
          },
          { text: "Noted and drafted." },
        ],
      },
      {
        scenario: "sales-routine",
        name: PROSPECT_SCENARIO_ROUTINE,
        trigger: { app: "mail", entity: "message", action: "create", entityId: null, data: {} },
        script: [
          { tool: /^kernel__web_fetch$/, args: () => ({ url: "https://example.com" }) },
          { tool: /^api-connector__/, args: () => ({}) },
          {
            tool: /^kernel__threads_reply$|^kernel__threads_post$/,
            args: () => ({ body: "Brief" }),
          },
          { tool: /^mail__(reply|send|draft)/, args: () => ({ body: "Hello" }) },
          { text: "Briefed and drafted." },
        ],
      },
    ]
    let turnNo = TURNS.length
    for (const r of ROUTINES) {
      const routineId = routineRows.find((x) => x.name === r.name)?.id
      if (!routineId) {
        finishes.push(`${r.scenario}: not seeded`)
        continue
      }
      current = { scenario: r.scenario, turn: turnNo, script: r.script, step: 0 }
      const tick = await runRoutineTick({
        orgId,
        routineId,
        scheduledAt: new Date().toISOString(),
        triggerEvent: r.trigger,
        // The production invoker's sizing path (kernel-jobs.ts): the event
        // preamble before the prompt, the tick's seeded tools, a background
        // turn under the routine's per-turn budget.
        agentInvoker: async ({ orgId: o, ownerUserId, threadId, prompt, scopes, triggerEvent }) => {
          const content = triggerEvent
            ? `${buildTriggerEventPreamble(triggerEvent)}\n\n${prompt}`
            : prompt
          const id = crypto.randomUUID()
          await withPrivilegedDb(o, "turn-size-tick-message", async (tx) => {
            await tx.execute(
              sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes)
                  VALUES (${id}::uuid, ${o}::uuid, ${threadId}::uuid, ${ownerUserId}::uuid, 'user', ${content}, '{}'::text[])`,
            )
          })
          const owner = {
            userId: ownerUserId,
            orgId: o,
            scopes,
            dimensionGrants: await resolveRoutineOwnerDimensionGrants(o, ownerUserId),
          }
          const out = await invokeAgentForThread(
            threadId,
            id,
            owner,
            o,
            true,
            { maxSteps: 400, timeoutMs: 480_000 },
            routineId,
            seedRoutineTickTools(o, { actorType: "user", ...owner }, scopes),
          )
          return { turnsAdded: out.turnsAdded ?? 1 }
        },
      })
      finishes.push(
        `${r.scenario}#${turnNo}: ${tick.status === "succeeded" ? "stop" : tick.status}`,
      )
      current = null
      turnNo += 1
    }

    console.log(finishes.join("\n"))
    for (const m of measured) {
      console.log(
        `STEP ${m.scenario}#${m.turn}.${m.step} est=${m.estimatedTokens} cached=${m.cachedTokens} messages=${m.messagesTokens} tools=${m.toolsTokens}/${m.toolCount} top=${m.topTools.slice(0, 3).join(",")}`,
      )
    }

    // EVERY STEP STAYS UNDER THE TARGET (the visitor estimate the step meter uses).
    for (const m of measured) expect(m.estimatedTokens).toBeLessThan(STEP_SIZE_TARGET)
    // And would with the biggest results a visitor turn can be handed: each
    // turn's first step plus one maximal result per later step (the tool
    // results here are smaller than a live world's: no search index).
    const maxResultTokens = Math.ceil((VISITOR_RESULT_LIMITS.maxTotal / 3) * 1.15)
    const firstSteps = new Map<number, number>()
    for (const m of measured) if (!firstSteps.has(m.turn)) firstSteps.set(m.turn, m.estimatedTokens)
    const routineTurns = new Set(
      measured.filter((m) => m.scenario.endsWith("-routine")).map((m) => m.turn),
    )
    for (const [turn, first] of firstSteps) {
      const steps = visitorStepsPerTurn({ routine: routineTurns.has(turn) })
      const bound = first + (steps - 1) * maxResultTokens
      console.log(`BOUND turn ${turn}: first=${first} worstLast=${bound}`)
      expect(bound).toBeLessThan(STEP_SIZE_TARGET)
    }
    // No turn runs past the visitor step budget, and each one ends with an answer.
    const perTurn = new Map<number, number>()
    for (const m of measured) perTurn.set(m.turn, (perTurn.get(m.turn) ?? 0) + 1)
    for (const [turn, n] of perTurn) {
      expect(n).toBeLessThanOrEqual(visitorStepsPerTurn({ routine: routineTurns.has(turn) }))
    }
    for (const f of finishes) expect(f).toMatch(/: stop$/)
    // The routine turns ran too (they are part of Everything's bill).
    expect(new Set(measured.map((m) => m.scenario))).toContain("support-routine")
    expect(new Set(measured.map((m) => m.scenario))).toContain("sales-routine")

    // THE COST OF EVERYTHING on the pinned model. Each step's input is billed
    // at the cached price up to the prefix it shares with the request before
    // it (DeepSeek caches prefixes automatically) and at the input price for
    // the rest, in the visitor estimate (chars / 3, which overcounts real
    // tokens); 400 output tokens a step; each web search at the 0.0069 USD a
    // live 5-result search cost, and at least the per-turn allowance of them
    // (the chat turn's second search lands as an approval here).
    const OUTPUT_PER_STEP = 400
    const WEB_SEARCH_USD = 0.0069
    const turnUsd = new Map<number, number>()
    for (const m of measured) {
      const uncached = m.estimatedTokens - m.cachedTokens
      const usd =
        (uncached * VISITOR_INPUT_USD_PER_M +
          m.cachedTokens * VISITOR_CACHED_INPUT_USD_PER_M +
          OUTPUT_PER_STEP * VISITOR_OUTPUT_USD_PER_M) /
        1_000_000
      turnUsd.set(m.turn, (turnUsd.get(m.turn) ?? 0) + usd)
    }
    const played = [...turnUsd.values()]
    const searches = Math.max(webSearches, env.LIAISON_DEMO_WEB_SEARCH_PER_TURN)
    const totalUsd = played.reduce((a, b) => a + b, 0) + searches * WEB_SEARCH_USD
    const totalEur = totalUsd / VISITOR_ECB_USD_PER_EUR
    const inputTokens = measured.reduce((a, m) => a + m.estimatedTokens, 0)
    console.log(
      `COST steps=${measured.length} inputTokens=${inputTokens} webSearches=${webSearches} perTurnUsd=${played.map((u) => u.toFixed(4)).join(",")} totalEur=${totalEur.toFixed(4)}`,
    )
    expect(totalEur).toBeLessThan(EVERYTHING_EUR_CAP)
  }, 600_000)
})
