// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY SURFACE THAT RUNS A TURN SENDS ONE TOOL LIST AND ONE SYSTEM PROMPT.
//
// The chat turn's request is covered by agent-service.openrouter-prefix-
// stability.test.ts. The other surfaces reach the same loop through
// invokeAgentForThread with their own arguments, and each could build its tool
// list or system prompt differently from step to step or from turn to turn:
//   - a routine tick (background, `routineId`, the tick's seeded tools), two
//     ticks of one routine, then the run resumed after an approval (the same
//     call routine-run-resume.ts makes);
//   - @-mention turns in a shared thread where two agents take turns (A, B,
//     A): each agent keeps ITS OWN tool list, so A's second turn repeats its
//     first even though B answered in between with a different list;
//   - the background turn an approval result hands back to the agent that
//     asked (approval-result-turn.ts).
// Each turn loads a tool mid-turn (tool_search) and calls it through
// kernel__call_tool, the case that used to change the tool list. Real
// OpenRouter provider, canned SSE at the fetch layer (no paid call).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { seedRoutineTickTools } from "~/modules/agent/routines/routine-tool-seed"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The org (registered, with its admin) and the person, made in beforeAll.
let ORG_ID = ""
let USER_ID = ""
const ROUTINE_THREAD_ID = "00000000-0000-0000-0000-00000000ce03"
const SHARED_THREAD_ID = "00000000-0000-0000-0000-00000000ce04"
const ROUTINE_ID = "00000000-0000-0000-0000-00000000ce05"
const AGENT_A = "00000000-0000-0000-0000-00000000ce06"
const AGENT_B = "00000000-0000-0000-0000-00000000ce07"
const UPSTREAM = "test-vendor/surfaces-prefix"
const MODEL_ID = `openrouter/${UPSTREAM}`
const SCOPES = ["kernel:threads:read", "kernel:skills:read", "kernel:audit:read"]
const ROUTINE_SEED_SCOPES = ["example:items:read"]
let ACTOR = { userId: USER_ID, orgId: ORG_ID, scopes: SCOPES, dimensionGrants: {} }

type ToolCall = { name: string; input: unknown }
type ChatMessage = { role: string; content?: unknown }
type Body = { messages: ChatMessage[]; tools?: Array<{ function: { name: string } }> }

/** A turn that loads `tool`, calls it through the stable entry, then answers. */
function loadAndCall(tool: string): ToolCall[] {
  return [
    { name: "kernel__tool_search", input: { query: `select:${tool}` } },
    { name: "kernel__call_tool", input: { name: tool, arguments: {} } },
  ]
}

let script: ToolCall[] = []
let turnBodies: Body[] = []
let callCounter = 0
const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

function sse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
  return {
    id: `gen-surfaces-${callCounter}`,
    object: "chat.completion.chunk",
    created: 1,
    model: UPSTREAM,
    provider: "TestUpstream",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 20,
  total_tokens: 1020,
  prompt_tokens_details: { cached_tokens: 800 },
  cost: 0.0001,
}

function step(index: number): Response {
  callCounter++
  const call = script[index]
  if (call) {
    return sse([
      chunk({ role: "assistant", content: `Step ${index}.` }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_surfaces_${callCounter}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      }),
      chunk({}, "tool_calls", USAGE),
    ])
  }
  return sse([chunk({ role: "assistant", content: "Done." }), chunk({}, "stop", USAGE)])
}

const toolsOf = (b: Body) => JSON.stringify(b.tools)
const systemOf = (b: Body) => JSON.stringify(b.messages.filter((m) => m.role === "system"))
const names = (b: Body) => (b.tools ?? []).map((t) => t.function.name)

/** Every step of a turn sent the same tools and the same system prompt; returns its first step. */
function assertStableTurn(steps: Body[], calls: ToolCall[]): Body {
  expect(steps).toHaveLength(calls.length + 1)
  const first = steps[0] as Body
  for (const body of steps) {
    expect(toolsOf(body)).toBe(toolsOf(first))
    expect(systemOf(body)).toBe(systemOf(first))
  }
  // The tool loaded mid-turn is not in the list; the stable entry is.
  expect(names(first)).toContain("kernel__call_tool")
  for (const call of calls) {
    if (call.name === "kernel__call_tool") {
      expect(names(first)).not.toContain((call.input as { name: string }).name)
    }
  }
  // The call through the entry ran the tool itself.
  const lastSteps = steps.at(-1) as Body
  const results = lastSteps.messages.filter((m) => m.role === "tool")
  expect(JSON.stringify(results.at(-1)?.content)).not.toContain("did not run")
  return first
}

async function postUser(id: string, threadId: string, text: string): Promise<void> {
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${id}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${text}, '{}')`
}

describe("the request every turn surface sends (fixed tool list, stable system prompt)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) savedEnv[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = "sk-or-test-surfaces"
    process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1"
    const settings = {
      ai: {
        models: {
          added: [
            {
              key: MODEL_ID,
              provider: "openrouter",
              upstreamId: UPSTREAM,
              displayName: "Surfaces prefix test",
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
    ORG_ID = (await createTestOrg()).id
    await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${ORG_ID}`
    USER_ID = (await minimal.person(ORG_ID, { name: "Surfaces Person" })).id
    ACTOR = { userId: USER_ID, orgId: ORG_ID, scopes: SCOPES, dimensionGrants: {} }
    // The room's floor is its members' scopes: the person holds what the agents use.
    for (const scope of SCOPES) await minimal.grantScope(USER_ID, scope)
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    for (const [id, handle, type] of [
      [ROUTINE_THREAD_ID, "surfaces-routine", "agent_chat"],
      [SHARED_THREAD_ID, "surfaces-shared", "thread"],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
        VALUES (${id}, ${ORG_ID}, ${handle}, ${type}, ${USER_ID}, ${MODEL_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${id}, ${USER_ID}, ${ORG_ID})`
    }
    for (const [id, handle, name] of [
      [AGENT_A, "@surfaces-a", "Agent A"],
      [AGENT_B, "@surfaces-b", "Agent B"],
    ] as const) {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
        VALUES (${id}, ${ORG_ID}, 'role', ${handle}, ${name}, ${JSON.stringify(SCOPES)}::jsonb, ${`You are ${name}.`})`
    }
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, output_thread_id, created_by_actor_type, cron, timezone)
      VALUES (${ROUTINE_ID}, ${ORG_ID}, ${USER_ID}, ${AGENT_A}, 'Surfaces routine', 'test', 'Check the skills.', ${SCOPES}, ${ROUTINE_THREAD_ID}, 'user', '0 9 * * *', 'UTC')`
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith("https://openrouter.test/")) return realFetch(input as never, init)
      const index = turnBodies.length
      turnBodies.push(JSON.parse(String(init?.body)) as Body)
      return step(index)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("routine ticks and the resumed run send one tool list and one system prompt", async () => {
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const ticks: Body[] = []
    for (const [n, text] of [
      "Tick 1: check the skills.",
      "Tick 2: check the skills.",
      "The approval was decided: continue the run.",
    ].entries()) {
      turnBodies = []
      script = loadAndCall("kernel__list_skills")
      const msgId = `00000000-0000-0000-0000-00000000ce1${n}`
      await postUser(msgId, ROUTINE_THREAD_ID, text)
      // The tick's seeded tools, as the routine supervisor and the resume
      // compute them, for a routine whose domain is another app: the kernel
      // tool the tick needs is loaded mid-run (a kernel-scoped routine would
      // seed every kernel tool and load nothing).
      const seed = seedRoutineTickTools(
        ORG_ID,
        { actorType: "user", ...ACTOR },
        ROUTINE_SEED_SCOPES,
      )
      const result = await invokeAgentForThread(
        ROUTINE_THREAD_ID,
        msgId,
        ACTOR,
        ORG_ID,
        true,
        undefined,
        ROUTINE_ID,
        seed,
      )
      expect(result.finishReason).not.toBe("error")
      ticks.push(assertStableTurn(turnBodies, script))
    }
    // Across ticks (and the resume): the same tools and system prompt, byte for byte.
    for (const tick of ticks) {
      expect(toolsOf(tick)).toBe(toolsOf(ticks[0] as Body))
      expect(systemOf(tick)).toBe(systemOf(ticks[0] as Body))
    }
  }, 90_000)

  it("two agents taking turns in a shared thread each keep their own tool list", async () => {
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const turns: Array<{ agent: string; first: Body }> = []
    for (const [n, [agent, tool]] of (
      [
        [AGENT_A, "kernel__list_skills"],
        [AGENT_B, "kernel__audit_search"],
        [AGENT_A, "kernel__audit_search"],
      ] as const
    ).entries()) {
      turnBodies = []
      script = loadAndCall(tool)
      const msgId = `00000000-0000-0000-0000-00000000ce2${n}`
      await postUser(msgId, SHARED_THREAD_ID, `@agent please look at ${tool}`)
      const result = await invokeAgentForThread(
        SHARED_THREAD_ID,
        msgId,
        ACTOR,
        ORG_ID,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        agent,
      )
      expect(result.finishReason).not.toBe("error")
      turns.push({ agent, first: assertStableTurn(turnBodies, script) })
    }
    const [a1, b1, a2] = turns as [
      { agent: string; first: Body },
      { agent: string; first: Body },
      { agent: string; first: Body },
    ]
    // B started after A had loaded a tool, so its list is not A's...
    expect(toolsOf(b1.first)).not.toBe(toolsOf(a1.first))
    // ...and A's next turn repeats A's own list and system prompt, not B's.
    expect(toolsOf(a2.first)).toBe(toolsOf(a1.first))
    expect(systemOf(a2.first)).toBe(systemOf(a1.first))
    // The replies record who wrote them, which is what each agent's order is read from.
    const replies = await sql<Array<{ author_agent_id: string | null }>>`
      SELECT author_agent_id FROM kernel.messages
      WHERE thread_id = ${SHARED_THREAD_ID} AND author_type = 'agent' ORDER BY created_at, id`
    expect(replies.map((r) => r.author_agent_id)).toEqual([AGENT_A, AGENT_B, AGENT_A])

    // THE TURN AN APPROVAL HANDS BACK to agent A (approval-result-turn.ts): a
    // background turn off the result row. Every step repeats A's tools and
    // system prompt.
    turnBodies = []
    script = loadAndCall("kernel__list_skills")
    const resultRowId = "00000000-0000-0000-0000-00000000ce29"
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes, metadata)
      VALUES (${resultRowId}, ${SHARED_THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'system', 'audit export ran; its result was passed to the agent.', '{}',
        ${JSON.stringify({ type: "approval-result", requestHandle: "audit export", toolName: "kernel__audit_search", result: "3 rows" })}::jsonb)`
    const resumed = await invokeAgentForThread(
      SHARED_THREAD_ID,
      resultRowId,
      ACTOR,
      ORG_ID,
      true,
      undefined,
      undefined,
      undefined,
      false,
      AGENT_A,
    )
    expect(resumed.finishReason).not.toBe("error")
    const approvalTurn = assertStableTurn(turnBodies, script)
    expect(toolsOf(approvalTurn)).toBe(toolsOf(a1.first))
    expect(systemOf(approvalTurn)).toBe(systemOf(a1.first))
  }, 90_000)
})
