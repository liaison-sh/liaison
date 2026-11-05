// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A TOOL LOADED ON SPECULATION IS LISTED BY NAME, ITS SCHEMA COMES WHEN ASKED.
//
// On a thread with a fixed tool list (providers/fixed-tool-list.ts) a loaded
// tool's schema rides a guide note that stays in the history for good. The
// tools a turn loads on speculation (the other tools of the app the last turn
// worked, the view's app) were most of those notes and were mostly never
// called. This test runs three real agent turns through invokeAgentForThread
// with the real OpenRouter provider, answers from canned SSE at the fetch
// layer, and asserts the request bodies:
//   - turn 1 starts with the app's other tools listed by name and purpose,
//     without their parameters;
//   - a call to one of them with fitting arguments runs, and the note after
//     that step carries its schema;
//   - a call to another with arguments that do not fit does not run, its
//     answer carries the tool's parameters, and the note after it its schema;
//   - turn 2 replays all of it byte for byte and sends no note of its own.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-00000000ce01"
const USER_ID = "00000000-0000-0000-0000-00000000ce02"
const THREAD_ID = "00000000-0000-0000-0000-00000000ce03"
const UPSTREAM = "test-vendor/index-only"
const MODEL_ID = `openrouter/${UPSTREAM}`

type Call = { name: string; input: unknown }
/** Each turn's tool steps, then its answer. */
const SCRIPTS: Call[][] = [
  [
    { name: "kernel__tool_search", input: { query: "select:gizmos__lookup" } },
    { name: "kernel__call_tool", input: { name: "gizmos__lookup", arguments: { name: "a" } } },
  ],
  [
    {
      name: "kernel__call_tool",
      input: { name: "gizmos__count", arguments: { uniqueColourFilter: "red" } },
    },
    { name: "kernel__call_tool", input: { name: "gizmos__list", arguments: { wrong: 1 } } },
  ],
  [],
]

type ChatMessage = {
  role: string
  content?: unknown
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}
type Body = { messages: ChatMessage[]; tools?: Array<{ function: { name: string } }> }

let callCounter = 0
let turnIndex = 0
const runs = { lookup: 0, count: 0, list: 0 }

function sse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
  return {
    id: `gen-index-${callCounter}`,
    object: "chat.completion.chunk",
    created: 1,
    model: UPSTREAM,
    provider: "TestUpstream",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

const USAGE = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cost: 0.0001 }

function openRouterStep(step: number): Response {
  callCounter++
  const call = SCRIPTS[turnIndex]?.[step]
  if (!call) return sse([chunk({ role: "assistant", content: "Done." }), chunk({}, "stop", USAGE)])
  return sse([
    chunk({ role: "assistant", content: `Step ${step}.` }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: `call_index_${callCounter}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        },
      ],
    }),
    chunk({}, "tool_calls", USAGE),
  ])
}

const bodies: Body[][] = []
let turnBodies: Body[] = []
const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

const isGuideNote = (m: ChatMessage) =>
  m.role === "user" &&
  typeof m.content === "string" &&
  m.content.startsWith('<runtime-context note="app guides')

/** The index of the first message where `b` stops repeating `a`, or a.length. */
function firstDivergence(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i
  }
  return a.length
}

function registerGizmos() {
  const tool = (name: string, description: string, params: z.ZodTypeAny, run: () => unknown) =>
    toolRegistry.set([ORG_ID, "gizmos", name], {
      appName: "gizmos",
      name,
      description,
      requiredScopes: ["kernel:threads:read"],
      readOnly: true,
      params,
      handler: async () => run(),
    } as never)
  tool("lookup", "Look up a gizmo by name.", z.object({ name: z.string() }), () => {
    runs.lookup++
    return { name: "a", stock: 3 }
  })
  tool(
    "count",
    "Count the gizmos of a colour. Long usage notes that only the schema carries.",
    z.object({ uniqueColourFilter: z.string() }),
    () => {
      runs.count++
      return { count: 7 }
    },
  )
  tool(
    "list",
    "List the gizmos of a category.",
    z.object({ uniqueCategoryParam: z.string() }),
    () => {
      runs.list++
      return { items: [] }
    },
  )
}

describe("a tool loaded on speculation (index-only notes)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) savedEnv[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = "sk-or-test-index"
    process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1"
    const settings = {
      ai: {
        models: {
          added: [
            {
              key: MODEL_ID,
              provider: "openrouter",
              upstreamId: UPSTREAM,
              displayName: "Index-only test",
              contextWindow: 200000,
              inputCostPerM: "0.30",
              outputCostPerM: "1.20",
              tools: true,
              reasoningEfforts: ["low"],
              canDisableReasoning: false,
              enabled: true,
              addedAt: "2026-10-30T00:00:00.000Z",
            },
          ],
        },
      },
    }
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG_ID}, 'IndexOrg', 'index-only-org', ${JSON.stringify(settings)}::jsonb)`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'index@test.com', 'Index Person')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'index-only', 'agent_chat', ${USER_ID}, ${MODEL_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    registerGizmos()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith("https://openrouter.test/")) return realFetch(input as never, init)
      const step = turnBodies.length
      turnBodies.push(JSON.parse(String(init?.body)) as Body)
      return openRouterStep(step)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    for (const name of ["lookup", "count", "list"]) toolRegistry.delete([ORG_ID, "gizmos", name])
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("lists the speculative tools by name, and sends a schema on the first call", async () => {
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    for (const [turn, text] of [
      "Look up gizmo a.",
      "How many red ones, by category?",
      "Thanks.",
    ].entries()) {
      turnIndex = turn
      turnBodies = []
      const msgId = `00000000-0000-0000-0000-00000000ce1${turn}`
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${text}, '{}')`
      const result = await invokeAgentForThread(
        THREAD_ID,
        msgId,
        { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
        ORG_ID,
      )
      expect(result.finishReason).not.toBe("error")
      bodies.push(turnBodies)
    }
    const [turn0, turn1, turn2] = bodies as [Body[], Body[], Body[]]
    expect(turn0).toHaveLength(3)
    expect(turn1).toHaveLength(3)
    expect(turn2).toHaveLength(1)
    // The tool list never changes, and never names a gizmos tool.
    const firstTools = JSON.stringify((turn0[0] as Body).tools)
    for (const body of [...turn0, ...turn1, ...turn2]) {
      expect(JSON.stringify(body.tools)).toBe(firstTools)
    }
    expect(firstTools).not.toContain("gizmos__")
    expect(runs.lookup).toBe(1)

    // TURN 1 STARTS with the app's other tools, by name and purpose only.
    const notesOf = (b: Body) => b.messages.filter(isGuideNote).map((m) => m.content as string)
    const turn0Notes = notesOf(turn0.at(-1) as Body)
    const startNotes = notesOf(turn1[0] as Body).slice(turn0Notes.length)
    expect(startNotes).toHaveLength(1)
    const startNote = startNotes[0] as string
    expect(startNote).toContain("- gizmos__count: Count the gizmos of a colour.")
    expect(startNote).toContain("- gizmos__list: List the gizmos of a category.")
    expect(startNote).not.toContain("uniqueColourFilter")
    expect(startNote).not.toContain("uniqueCategoryParam")
    expect(startNote).not.toContain("Long usage notes")

    // A fitting call ran, and its schema followed in the note after it.
    expect(runs.count).toBe(1)
    const step1 = turn1[1] as Body
    const countResult = step1.messages.filter((m) => m.role === "tool").at(-1)
    expect(JSON.stringify(countResult?.content)).toContain("count")
    expect(JSON.stringify(countResult?.content)).not.toContain("did not run")
    const countNote = notesOf(step1).at(-1) as string
    expect(countNote).toContain('"name":"gizmos__count"')
    expect(countNote).toContain("uniqueColourFilter")
    expect(countNote).not.toContain("uniqueCategoryParam")

    // A call whose arguments do not fit did not run: its answer carries the
    // tool's parameters, and the note after it its schema.
    expect(runs.list).toBe(0)
    const step2 = turn1[2] as Body
    const listResult = step2.messages.filter((m) => m.role === "tool").at(-1)
    expect(JSON.stringify(listResult?.content)).toContain("Invalid arguments for gizmos__list")
    expect(JSON.stringify(listResult?.content)).toContain("uniqueCategoryParam")
    const listNote = notesOf(step2).at(-1) as string
    expect(listNote).toContain('"name":"gizmos__list"')

    // TURN 2 replays turn 1, notes included, byte for byte, and sends none.
    const lastOfTurn1 = turn1.at(-1) as Body
    const firstOfTurn2 = turn2[0] as Body
    const asked = lastOfTurn1.messages.findIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("How many red ones"),
    )
    expect(asked).toBeGreaterThan(0)
    // Everything before the person's message, and everything after it up to
    // the turn's runtime context (never replayed); the message itself differs
    // only by the live request's cache breakpoint.
    expect(firstDivergence(lastOfTurn1.messages, firstOfTurn2.messages)).toBe(asked)
    const liveAfter = lastOfTurn1.messages.slice(asked + 1, -1)
    expect(
      JSON.stringify(firstOfTurn2.messages.slice(asked + 1, asked + 1 + liveAfter.length)),
    ).toBe(JSON.stringify(liveAfter))
    expect(notesOf(firstOfTurn2)).toEqual(notesOf(lastOfTurn1))
    const replayedNotes = notesOf(firstOfTurn2)
    expect(replayedNotes).toContain(startNote)
    expect(replayedNotes).toContain(countNote)
    expect(replayedNotes).toContain(listNote)
  }, 60_000)
})
