// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PREFIX AN OPENROUTER AGENT TURN SENDS STAYS BYTE-STABLE.
//
// OpenRouter's upstreams (DeepSeek, Qwen, GPT and the rest) cache the prompt
// by PREFIX: a request reads from cache exactly as far as its bytes match an
// earlier request served by the same upstream. Anything that moves, rewrites
// or reorders an earlier part of the request re-bills everything after it at
// the full input price. A turn re-sends the whole request every step, so a
// prefix that is not append-only costs the turn its cache on every step.
//
// This test runs two real agent turns (reasoning plus tool calls, then a text
// answer; then a follow-up turn) through invokeAgentForThread with the real
// OpenRouter provider, answers from canned SSE at the fetch layer, and asserts
// the request bodies:
//   - within a turn, every step's request is the previous step's request with
//     the previous step's output appended: same system, same tools (a
//     the same earlier messages byte for byte, and the replayed assistant
//     message keeps the order the model produced (reasoning, text, tool
//     calls);
//   - THE TOOL LIST IS THE SAME, BYTE FOR BYTE, ON EVERY STEP OF EVERY TURN
//     of the thread, though the thread loads tools mid-turn: a loaded tool
//     gets its description and parameters in a note after the step that
//     loaded it, and is called through kernel__call_tool, which runs the tool
//     itself (providers/fixed-tool-list.ts);
//   - across turns, the system prompt is unchanged, so the next turn reads the
//     same cached prefix;
//   - every request names the conversation (`session_id`), so OpenRouter keeps
//     the turn's steps, and the thread's turns, on the upstream that holds the
//     cache.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-00000000cd01"
const USER_ID = "00000000-0000-0000-0000-00000000cd02"
const THREAD_ID = "00000000-0000-0000-0000-00000000cd03"
const UPSTREAM = "test-vendor/prefix-stability"
const MODEL_ID = `openrouter/${UPSTREAM}`
// The first two tool steps each load one more deferred kernel tool; the
// third calls the first of them through the stable entry.
const TOOL_CALLS = [
  { name: "kernel__tool_search", input: { query: "select:kernel__list_skills" } },
  { name: "kernel__tool_search", input: { query: "select:kernel__audit_search" } },
  { name: "kernel__call_tool", input: { name: "kernel__list_skills", arguments: {} } },
]
const TOOL_STEPS = TOOL_CALLS.length

type ChatMessage = {
  role: string
  content?: unknown
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  reasoning?: string
  reasoning_details?: unknown
  tool_call_id?: string
}
type Body = {
  model: string
  messages: ChatMessage[]
  tools?: Array<{ function: { name: string } }>
  session_id?: string
}

let callCounter = 0

function sse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
  return {
    id: `gen-prefix-${callCounter}`,
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

/** A step: reasoning, then (tool steps) a short text and a tool call, or the answer. */
function openRouterStep(step: number): Response {
  callCounter++
  const reasoning = chunk({ role: "assistant", reasoning: `Thinking about step ${step}.` })
  if (step < TOOL_STEPS) {
    return sse([
      reasoning,
      chunk({ content: `Looking (${step}).` }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_prefix_${callCounter}`,
            type: "function",
            function: {
              name: TOOL_CALLS[step]?.name,
              arguments: JSON.stringify(TOOL_CALLS[step]?.input),
            },
          },
        ],
      }),
      chunk({}, "tool_calls", USAGE),
    ])
  }
  return sse([reasoning, chunk({ content: "Done." }), chunk({}, "stop", USAGE)])
}

const bodies: Body[][] = []
let turnBodies: Body[] = []
const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

/** The index of the first message where `b` stops repeating `a`, or a.length when `a` is a prefix of `b`. */
function firstDivergence(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i
  }
  return a.length
}

describe("the OpenRouter request an agent turn sends (prefix stability)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) savedEnv[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = "sk-or-test-prefix"
    process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1"
    // The model is one the org added from OpenRouter's catalogue, run on the box's key.
    const settings = {
      ai: {
        models: {
          added: [
            {
              key: MODEL_ID,
              provider: "openrouter",
              upstreamId: UPSTREAM,
              displayName: "Prefix stability test",
              contextWindow: 200000,
              inputCostPerM: "0.30",
              outputCostPerM: "1.20",
              tools: true,
              reasoningEfforts: ["low"],
              canDisableReasoning: false,
              enabled: true,
              addedAt: "2026-10-29T00:00:00.000Z",
            },
          ],
        },
      },
    }
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG_ID}, 'PrefixOrg', 'prefix-stability-org', ${JSON.stringify(settings)}::jsonb)`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'prefix@test.com', 'Prefix Person')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'prefix-stability', 'agent_chat', ${USER_ID}, ${MODEL_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
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

  it("sends an append-only request within a turn and a stable prefix across turns", async () => {
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    for (const [turn, text] of [
      "Which skills do I have? Look them up.",
      "Thanks. Anything else?",
      "And now?",
    ].entries()) {
      turnBodies = []
      const msgId = `00000000-0000-0000-0000-00000000cd1${turn}`
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

    if (process.env.PREFIX_DUMP) {
      await Bun.write(process.env.PREFIX_DUMP, JSON.stringify(bodies, null, 2))
    }

    for (const steps of bodies) {
      expect(steps).toHaveLength(TOOL_STEPS + 1)
      for (const body of steps) expect(body.session_id).toBe(THREAD_ID)
      for (let k = 1; k < steps.length; k++) {
        const prev = steps[k - 1] as Body
        const next = steps[k] as Body
        // The system message and every earlier message, byte for byte, up to
        // the turn's runtime context: it is never replayed (the next turn does
        // not repeat it), so it rides last, after the step's output, and the
        // conversation before it reads the same on the next turn.
        const tail = prev.messages[prev.messages.length - 1]
        expect(JSON.stringify(tail?.content)).toContain("<runtime-context")
        expect(firstDivergence(prev.messages, next.messages)).toBe(prev.messages.length - 1)
        expect(next.messages[next.messages.length - 1]).toEqual(tail as ChatMessage)
        // Then exactly the previous step's output: one assistant message in
        // the order produced (text before its tool calls) and its results.
        const appended = next.messages.slice(prev.messages.length - 1, -1)
        expect(appended[0]?.role).toBe("assistant")
        expect(appended[0]?.content).toBe(`Looking (${k - 1}).`)
        expect(appended[0]?.tool_calls?.map((c) => c.function.name)).toEqual([
          TOOL_CALLS[k - 1]?.name,
        ])
        // Its results, then at most the one-step note of a guide the load brought.
        const rest = appended.slice(1)
        const notes = rest.filter((m) => m.role !== "tool")
        expect(rest.slice(0, rest.length - notes.length).every((m) => m.role === "tool")).toBe(true)
        for (const m of notes) {
          expect(m.role).toBe("user")
          expect(JSON.stringify(m.content)).toContain("runtime-context")
        }
      }
    }
    const names = (b: Body) => (b.tools ?? []).map((t) => t.function.name)
    const [turn0, turn1, turn2] = bodies as [Body[], Body[], Body[]]
    // THE TOOL LIST NEVER CHANGES: every step of every turn sends the list
    // the thread's first step sent, byte for byte. The loaded tools are not
    // in it; the stable entry is.
    const firstTools = JSON.stringify((turn0[0] as Body).tools)
    for (const body of [...turn0, ...turn1, ...turn2]) {
      expect(JSON.stringify(body.tools)).toBe(firstTools)
    }
    expect(names(turn0[0] as Body)).toContain("kernel__call_tool")
    expect(names(turn0[0] as Body)).not.toContain("kernel__list_skills")
    expect(names(turn0[0] as Body)).not.toContain("kernel__audit_search")
    // The call through the entry ran the tool itself: the reply records
    // kernel__list_skills, and its result is the tool's, not the entry's.
    const [reply0] = await sql<Array<{ metadata: { toolCalls?: Array<{ toolName: string }> } }>>`
      SELECT metadata FROM kernel.messages WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
      ORDER BY created_at ASC LIMIT 1`
    expect(reply0?.metadata.toolCalls?.map((c) => c.toolName)).toEqual([
      "kernel__tool_search",
      "kernel__tool_search",
      "kernel__list_skills",
    ])
    // The last step: its output, then the runtime context.
    const callResult = (turn0.at(-1) as Body).messages.at(-2) as ChatMessage
    expect(callResult.role).toBe("tool")
    expect(JSON.stringify(callResult.content)).not.toContain("did not run")
    // The history writes that call as the model made it: through the entry.
    const callStep = (turn0.at(-1) as Body).messages.at(-3) as ChatMessage
    expect(callStep.tool_calls?.[0]?.function.name).toBe("kernel__call_tool")
    expect(JSON.parse(callStep.tool_calls?.[0]?.function.arguments ?? "null")).toEqual(
      TOOL_CALLS[2]?.input,
    )
    // Across turns that load nothing new (the steady state): the system
    // messages and the tool list are byte-identical, and so is the history up
    // to the previous turn's own request, so the next turn's first step reads
    // all of it from cache.
    const prev = turn1.at(-1) as Body
    const next = turn2[0] as Body
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(prev.tools))
    const systemCount = prev.messages.findIndex((m) => m.role !== "system")
    expect(systemCount).toBeGreaterThan(0)
    expect(JSON.stringify(next.messages.slice(0, systemCount))).toBe(
      JSON.stringify(prev.messages.slice(0, systemCount)),
    )
    const lastUserText = prev.messages.findLastIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Thanks. Anything else?"),
    )
    expect(firstDivergence(prev.messages, next.messages)).toBeGreaterThanOrEqual(lastUserText)
    // The earlier turn replays in the order it was produced: each step's words
    // and call, then its result, and the answer last (never every step's words
    // run together ahead of every call).
    const asked = next.messages.findIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Thanks. Anything else?"),
    )
    const replayed = next.messages.slice(asked + 1, asked + 8)
    expect(replayed.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ])
    expect(replayed.map((m) => (m.role === "assistant" ? m.content : null))).toEqual([
      "Looking (0).",
      null,
      "Looking (1).",
      null,
      "Looking (2).",
      null,
      "Done.",
    ])
    expect(replayed[0]?.tool_calls).toHaveLength(1)
    expect(replayed[2]?.tool_calls).toHaveLength(1)
    expect(replayed[4]?.tool_calls?.[0]?.function.name).toBe("kernel__call_tool")

    // THE SYSTEM PROMPT IS THE SAME ON EVERY TURN. What a load brings (the
    // loaded tool's description and parameters, and audit_search's guide,
    // which the system prompt does not carry) arrives as a note right after
    // the step that loaded it, and the next turns replay each note at the same
    // place instead of growing the system prompt or the tool list
    // (guide-notes.ts).
    const systemOf = (b: Body) => JSON.stringify(b.messages.filter((m) => m.role === "system"))
    expect(systemOf(turn1[0] as Body)).toBe(systemOf(turn0.at(-1) as Body))
    expect(systemOf(turn2[0] as Body)).toBe(systemOf(turn1.at(-1) as Body))
    const isGuideNote = (m: ChatMessage) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.startsWith('<runtime-context note="app guides')
    const liveTurn0 = turn0.at(-1) as Body
    const liveNotes = liveTurn0.messages.filter(isGuideNote).map((m) => m.content as string)
    expect(liveNotes).toHaveLength(2)
    // Each note describes the tool its step loaded, to be called through the entry.
    expect(liveNotes[0]).toContain('"name":"kernel__list_skills"')
    expect(liveNotes[0]).toContain("kernel__call_tool")
    expect(liveNotes[1]).toContain('"name":"kernel__audit_search"')
    // Turn 0 as the last turn replays it: each note right after the step that loaded its tool.
    const firstAsk = next.messages.findIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Which skills do I have?"),
    )
    const turn0Replay = next.messages.slice(firstAsk + 1, firstAsk + 10)
    expect(turn0Replay.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
    expect(turn0Replay[2]?.content).toBe(liveNotes[0])
    // A TOOL'S RESULT RULE IS SENT ONCE PER CONVERSATION (kernel-result-hints.ts):
    // the thread's first tool_search result carries it, every later one
    // (this turn's second, the later turns' own) does not, and every turn
    // replays the results exactly as they were sent.
    const searchRule = "A match flagged locked:true"
    const searchResults = (b: Body) =>
      b.messages.filter((m) => m.role === "tool" && JSON.stringify(m.content).includes("matches"))
    const liveSearchResults = searchResults(liveTurn0)
    expect(liveSearchResults).toHaveLength(2)
    expect(JSON.stringify(liveSearchResults[0]?.content)).toContain(searchRule)
    expect(JSON.stringify(liveSearchResults[1]?.content)).not.toContain(searchRule)
    for (const body of [turn1.at(-1) as Body, turn2.at(-1) as Body]) {
      const all = searchResults(body)
      expect(all).toHaveLength(liveSearchResults.length + (body === turn1.at(-1) ? 2 : 4))
      expect(all.filter((m) => JSON.stringify(m.content).includes(searchRule))).toHaveLength(1)
      expect(JSON.stringify(all.slice(0, 2))).toBe(JSON.stringify(liveSearchResults))
    }
    const turn1Ask = (turn1[0] as Body).messages.findIndex(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Which skills do I have?"),
    )
    expect(JSON.stringify((turn1[0] as Body).messages.slice(turn1Ask, turn1Ask + 10))).toBe(
      JSON.stringify(next.messages.slice(firstAsk, firstAsk + 10)),
    )
    expect(turn0Replay[5]?.content).toBe(liveNotes[1])
    expect(turn0Replay[8]?.content).toBe("Done.")
    // Delivered once: later turns carry those notes and send no other.
    for (const body of [...turn1, ...turn2]) {
      expect(body.messages.filter(isGuideNote).map((m) => m.content)).toEqual(liveNotes)
    }

    // THE TURN AN APPROVAL HANDS BACK (approval-result-turn.ts): a background
    // turn started off the result row, no view, nobody at the keyboard. It
    // repeats the last turn's tools and system prompt byte for byte, so it
    // reads the whole conversation from the cache.
    turnBodies = []
    const resultRowId = "00000000-0000-0000-0000-00000000cd19"
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes, metadata)
      VALUES (${resultRowId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'system', 'audit export ran; its result was passed to the agent.', '{}',
        ${JSON.stringify({ type: "approval-result", requestHandle: "audit export", toolName: "kernel__audit_search", result: "3 rows" })}::jsonb)`
    const resumed = await invokeAgentForThread(
      THREAD_ID,
      resultRowId,
      { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
      ORG_ID,
      true,
    )
    expect(resumed.finishReason).not.toBe("error")
    const resume = turnBodies[0] as Body
    const before = turn2.at(-1) as Body
    expect(JSON.stringify(resume.tools)).toBe(JSON.stringify(before.tools))
    expect(systemOf(resume)).toBe(systemOf(before))
  }, 60_000)
})
