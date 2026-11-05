// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S27, A34, F6: a routine's agent hands work to another named agent and gets
// the answer back in the same run.
//
// The tick is the production one: the `kernel:routine-tick` worker that
// registerKernelJobs wires (runRoutineTick + the real agent invoker, the
// routine supervisor, invokeAgentForThread, the AI SDK loop), against the real
// Anthropic provider answered from canned SSE at the fetch layer. The routine
// agent calls kernel__agents_ask on a named role agent; the callee answers in
// one step; the routine agent's next step is handed a NON-NULL answer
// (synchronous: the callee runs in the cloud, so no "queued" receipt), and the
// routine's output holds it. The callee is admitted to the owner's routine
// thread to answer there.
//
// Sub-run tokens counting toward the routine's hard limit is proven in
// agent-service.hard-token-limit.test.ts and not repeated here.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Worker = (payload: unknown) => Promise<unknown>
const workers = new Map<string, Worker>()
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  registerJobWorker: (app: string, name: string, fn: Worker) => {
    workers.set(`${app}:${name}`, fn)
  },
  registerScheduledJob: async () => undefined,
  upsertJobScheduler: async () => undefined,
  removeScheduledJob: async () => undefined,
  removeAppJob: async () => undefined,
  enqueueAppJob: async () => "job-id",
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { registerKernelJobs } = await import("~/infra/jobs/kernel-jobs")
const { handleCreateRoutine } = await import("~/modules/agent/tools/skills-routines-tools")

const ORG = randomUUID()
const OWNER = randomUUID()
const CALLEE = randomUUID()
const tag = ORG.slice(0, 8)
const CALLEE_HANDLE = `@p5t2-logistics-${tag}`
const MODEL_ID = "claude-p5t2-routine-ask"
const ANSWER = "The pallet left the warehouse on Tuesday at 14:00."
const QUESTION = "When did pallet 42 leave the warehouse?"

function sse(events: Array<[string, unknown]>): Response {
  return new Response(
    events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

let n = 0
function step(
  block: { type: "text"; text: string } | { type: "tool"; name: string; input: unknown },
) {
  const id = ++n
  const start: [string, unknown] = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
  ]
  const body: Array<[string, unknown]> =
    block.type === "tool"
      ? [
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: `toolu_${id}`, name: block.name, input: {} },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            },
          ],
        ]
      : [
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: block.text },
            },
          ],
        ]
  return sse([
    start,
    ...body,
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: block.type === "tool" ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ])
}

/** The tool results the routine agent's model was handed, in order. */
const routineToolResults: string[] = []
let calleeTurns = 0
let routineSteps = 0
const realFetch = globalThis.fetch
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function toolResultsOf(body: { messages?: Array<{ content?: unknown }> }): string[] {
  const out: string[] = []
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const c of m.content as Array<{ type?: string; content?: unknown }>) {
      if (c.type === "tool_result") out.push(JSON.stringify(c.content))
    }
  }
  return out
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Routine Ask Org', ${`p5t2-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${OWNER}, ${ORG}, ${`p5t2-${tag}@t.com`}, 'Elodie', 'active', 'hash')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${OWNER}, ${ORG}, '*')`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '0', 'EUR')`
  // Auto-eligible: the tick's credit gate resolves the org's auto model.
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Routine ask test', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLEE}, ${ORG}, 'role', ${CALLEE_HANDLE}, 'Logistics', '["*"]'::jsonb)`

  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-p5t2-stub"
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    const system = JSON.stringify(body.system ?? "")
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return step({ type: "text", text: "side call" })
    }
    // Who the step is for, read from the agent's own identity line.
    if (system.includes("You are Logistics (")) {
      calleeTurns++
      return step({ type: "text", text: ANSWER })
    }
    // The routine runs as the owner's personal agent, whose identity line
    // names it for its owner ("Elodie's agent").
    if (
      !system.includes("You are Personal agent (") &&
      !system.includes("You are Elodie's agent")
    ) {
      return step({ type: "text", text: "side call" })
    }
    routineSteps++
    const results = toolResultsOf(body)

    if (results.length === 0) {
      return step({
        type: "tool",
        name: "kernel__agents_ask",
        input: { agentHandle: CALLEE_HANDLE, question: QUESTION },
      })
    }
    routineToolResults.push(...results)
    return step({ type: "text", text: `Logistics says: ${ANSWER}` })
  }) as typeof fetch

  await registerKernelJobs()
}, 120_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  for (const t of [
    "kernel.routine_runs",
    "kernel.approval_requests",
    "kernel.messages",
    "kernel.thread_participants",
    "kernel.user_thread_state",
    "kernel.credit_transactions",
    "kernel.pending_events",
    "kernel.audit_log",
  ]) {
    await sql.unsafe(`DELETE FROM ${t} WHERE org_id = '${ORG}'`).catch(() => undefined)
  }
  await sql`UPDATE kernel.routines SET output_thread_id = NULL WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  await releaseTestLock()
})

describe("agents_ask from a routine tick (S27)", () => {
  test("the routine agent gets a non-null answer from the named agent in the same run", async () => {
    const created = (await handleCreateRoutine(
      {
        name: `pallet-check-${tag}`,
        description: "Ask logistics about the pallet",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "Europe/Paris",
        prompt: `Ask ${CALLEE_HANDLE} when pallet 42 left, then report it.`,
        // D20: the hand-off's thread scopes are set by the creator, never guessed from the prompt.
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        agentModelId: MODEL_ID,
      },
      {
        orgId: ORG,
        userId: OWNER,
        actorType: "user",
        scopes: ["*"],
        approverUserId: OWNER,
      } as never,
    )) as { routine?: { id: string }; error?: unknown }
    expect(created.error).toBeUndefined()
    const routineId = created.routine!.id
    // The scopes set at create are what lets the routine ask and read the answer.
    const [stored] = await sql<{ scopes: string[] }[]>`
      SELECT scopes FROM kernel.routines WHERE id = ${routineId}`
    expect(stored.scopes).toEqual(["kernel:threads:read", "kernel:threads:write"])

    const tick = workers.get("kernel:routine-tick")
    expect(tick).toBeDefined()
    await tick!({ routineId, orgId: ORG, scheduledAt: new Date().toISOString() })

    const [run] = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM kernel.routine_runs WHERE routine_id = ${routineId}
      ORDER BY ran_at DESC LIMIT 1`
    expect(run?.status).toBe("succeeded")

    // The callee ran (in the cloud) and the routine agent was handed its answer.
    expect(calleeTurns).toBe(1)
    expect(routineSteps).toBe(2)
    expect(routineToolResults.length).toBe(1)
    let parsed: unknown = JSON.parse(routineToolResults[0])
    while (typeof parsed === "string") parsed = JSON.parse(parsed)
    const result = parsed as Record<string, unknown>
    expect(result.asked).toBe(true)
    expect(result.answer).toBe(ANSWER)
    expect(result.status).toBeUndefined() // synchronous: no "queued" receipt

    // The callee was admitted to the owner's routine thread, and the routine's
    // output there holds the answer.
    const [r] = await sql<{ output_thread_id: string }[]>`
      SELECT output_thread_id FROM kernel.routines WHERE id = ${routineId}`
    const seats = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.thread_participants WHERE thread_id = ${r.output_thread_id}`
    expect(seats.some((s) => s.agent_id === CALLEE)).toBe(true)
    const [last] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
       WHERE thread_id = ${r.output_thread_id} AND author_type = 'agent'
         AND (author_agent_id IS NULL OR author_agent_id <> ${CALLEE})
       ORDER BY created_at DESC LIMIT 1`
    expect(last?.content).toContain(ANSWER)
  }, 120_000)
})

describe("a hand-off prompt brings no scope by itself (D20)", () => {
  test("a routine whose prompt names an agent but sets no scope holds none", async () => {
    const created = (await handleCreateRoutine(
      {
        name: `handoff-noscope-${tag}`,
        description: "Ask without scopes",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "Europe/Paris",
        prompt: `Ask ${CALLEE_HANDLE} when pallet 42 left. Use kernel__agents_ask.`,
        scopes: [],
        enabled: false,
      },
      {
        orgId: ORG,
        userId: OWNER,
        actorType: "user",
        scopes: ["*"],
        approverUserId: OWNER,
      } as never,
    )) as { routine?: { id: string; scopes: string[] }; error?: unknown }
    expect(created.error).toBeUndefined()
    expect(created.routine!.scopes).toEqual([])
  })
})
