// SPDX-License-Identifier: FSL-1.1-ALv2
// A resumed turn's next provider request is the request the uninterrupted turn
// sends at that step (S10, C2), on the providers' real wire shapes: an
// Anthropic stream with thinking blocks and their signatures, and an
// OpenRouter stream with reasoning details. The provider HTTP calls are
// captured at `fetch` and answered with canned streams, so everything between
// the turn loop and the socket is the production code: the SDK's message
// building, the journal's redaction and parse, the resume's prompt rebuild.
//
// Two turns ask the same question with the same canned answers: A runs
// through; B is handed off after step 1 and resumed. B's resumed request must
// equal A's step-2 request byte for byte, once the ids that differ by
// construction (thread, messages, turn, timestamps) are named.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import * as eventBusModule from "~/infra/events/event-bus"
import { runAgentChat } from "~/modules/agent/runtime/agent-service"
import { handOffRunningTurns, TurnHandoffTestAccess } from "~/modules/agent/runtime/turn-handoff"
import { resumeTurn } from "~/modules/agent/runtime/turn-resume"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ENV_KEYS = ["LIAISON_ANTHROPIC_API_KEY", "LIAISON_MODEL_PROVIDER", "OPENROUTER_API_KEY"]
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))

const OR_MODEL = "openrouter/test/wire-model"
const SEARCH = "kernel__tool_search"

let owner: minimal.Session
let agentId: string
let ownerScopes: string[] = []

// ── Canned provider streams ────────────────────────────────────────────────

type Step =
  | { kind: "tool"; thinking: string; signature: string; callId: string; query: string }
  | { kind: "text"; thinking: string; signature: string; text: string }

const STEPS: Step[] = [
  {
    kind: "tool",
    thinking: "I should look up the contacts tools first.",
    signature: "EqQBCkYIBxgCKkDsig-step-one+/==",
    callId: "toolu_01WireStepOne",
    query: "contacts",
  },
  {
    kind: "tool",
    thinking: "Now the orders tools.",
    signature: "EqQBCkYIBxgCKkDsig-step-two+/==",
    callId: "toolu_02WireStepTwo",
    query: "orders",
  },
  {
    kind: "text",
    thinking: "I have what I need.",
    signature: "EqQBCkYIBxgCKkDsig-step-three+/==",
    text: "Both looked up.",
  },
]

const sse = (events: Array<[string | null, unknown]>) =>
  events
    .map(([event, data]) =>
      event
        ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        : `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("")

function anthropicStream(step: Step, n: number): string {
  const blocks: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_wire_${n}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: step.thinking },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: step.signature },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ]
  if (step.kind === "tool") {
    blocks.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: step.callId, name: SEARCH, input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: step.query }) },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
    )
  } else {
    blocks.push(
      [
        "content_block_start",
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: step.text } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
    )
  }
  blocks.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: step.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  )
  return sse(blocks)
}

function openRouterStream(step: Step, n: number): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown) => ({
    id: `gen-wire-${n}`,
    object: "chat.completion.chunk",
    created: 1_790_000_000 + n,
    model: "test/wire-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })
  const events: Array<[null, unknown]> = [
    [
      null,
      chunk(
        {
          role: "assistant",
          content: "",
          reasoning: step.thinking,
          reasoning_details: [
            {
              type: "reasoning.text",
              text: step.thinking,
              signature: step.signature,
              format: "anthropic-claude-v1",
              index: 0,
            },
          ],
        },
        null,
      ),
    ],
  ]
  if (step.kind === "tool") {
    events.push([
      null,
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: step.callId,
              type: "function",
              function: { name: SEARCH, arguments: JSON.stringify({ query: step.query }) },
            },
          ],
        },
        null,
      ),
    ])
  } else {
    events.push([null, chunk({ content: step.text }, null)])
  }
  events.push([
    null,
    chunk({}, step.kind === "tool" ? "tool_calls" : "stop", {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0001,
    }),
  ])
  events.push([null, "[DONE]"])
  return sse(events)
}

// ── The fetch seam ─────────────────────────────────────────────────────────

interface Captured {
  url: string
  body: string
}

const PROVIDER_HOSTS = /api\.anthropic\.com|openrouter\.ai/
let captured: Captured[] = []
/** The answer to the next provider request, by request count; `hold` delays it. */
let answer: ((n: number) => string) | null = null
let hold: ((n: number) => Promise<void>) | null = null

const realFetch = globalThis.fetch
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!PROVIDER_HOSTS.test(url) || !answer) return realFetch(input, init)
  const body = typeof init?.body === "string" ? init.body : ""
  captured.push({ url, body })
  const n = captured.length
  if (hold) await hold(n)
  return new Response(answer(n), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}) as typeof fetch)

// ── Turns ──────────────────────────────────────────────────────────────────

async function freshThread(): Promise<string> {
  const threadId = await minimal.thread(owner.orgId, owner.userId)
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
  return threadId
}

const turnInput = (threadId: string, modelId: string | null) => ({
  threadId,
  content: "Look up the contacts and the orders tools.",
  actor: {
    actorType: "user" as const,
    userId: owner.userId,
    orgId: owner.orgId,
    scopes: ownerScopes,
    dimensionGrants: {},
  },
  orgId: owner.orgId,
  actingAgentId: agentId,
  ...(modelId ? { modelId } : {}),
})

async function drain(r: Awaited<ReturnType<typeof runAgentChat>>): Promise<string> {
  let text = ""
  for await (const part of r.fullStream) if (part.type === "text-delta") text += part.text
  await r.finalize({
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "stop",
    text,
    steps: [],
  })
  return text
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await Bun.sleep(50)
  }
}

const turnState = async (turnId: string) => {
  const [row] = await sql<{ state: string; step_count: number }[]>`
    SELECT state, step_count FROM kernel.agent_turns WHERE id = ${turnId}`
  return row
}

/**
 * The ids that differ between two turns by construction, named: each value
 * maps to a placeholder, so what is left to compare is everything else.
 */
async function idsOf(threadId: string, turnId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>([
    [threadId, "<thread>"],
    [turnId, "<turn>"],
  ])
  const [thread] = await sql<
    { handle: string }[]
  >`SELECT handle FROM kernel.threads WHERE id = ${threadId}`
  if (thread) ids.set(thread.handle, "<thread-handle>")
  const msgs = await sql<{ id: string; created_at: Date }[]>`
    SELECT id, created_at FROM kernel.messages WHERE thread_id = ${threadId} ORDER BY created_at`
  for (const [i, m] of msgs.entries()) ids.set(m.id, `<message-${i}>`)
  return ids
}

function normalize(body: string, ids: Map<string, string>): string {
  let out = body
  for (const [value, name] of ids) out = out.split(value).join(name)
  // Clock readings in the runtime context (the turn's own "now").
  return out
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<clock>")
}

/** Where two strings first differ, with context, for a readable failure. */
function firstDiff(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return i >= a.length && i >= b.length
    ? "equal"
    : `at ${i}:\n  A: …${a.slice(Math.max(0, i - 120), i + 120)}\n  B: …${b.slice(Math.max(0, i - 120), i + 120)}`
}

async function compareResumedRequest(
  modelId: string | null,
  stream: (step: Step, n: number) => string,
): Promise<void> {
  // A: the uninterrupted turn, three provider requests.
  const threadA = await freshThread()
  captured = []
  answer = (n) => stream(STEPS[n - 1] as Step, n)
  const a = await runAgentChat(turnInput(threadA, modelId))
  expect(await drain(a)).toBe("Both looked up.")
  expect((await turnState(a.turnId)).state).toBe("done")
  const requestsA = captured
  expect(requestsA).toHaveLength(3)

  // B: the same turn, handed off while step 1's answer is on the wire.
  const threadB = await freshThread()
  captured = []
  let release: () => void = () => {}
  const released = new Promise<void>((r) => {
    release = r
  })
  hold = async (n) => {
    if (n === 1) await released
  }
  const b = await runAgentChat(turnInput(threadB, modelId))
  const draining = drain(b)
  await until(
    async () => captured.length,
    (n) => n === 1,
  )
  const handed = handOffRunningTurns(10_000, 2_000)
  release()
  await draining
  expect((await handed).unsettled).toEqual([])
  hold = null
  expect(await turnState(b.turnId)).toEqual({ state: "handoff", step_count: 1 })
  expect(captured).toHaveLength(1)

  // The resume continues from step 1: its first request is step 2's.
  expect(await resumeTurn(owner.orgId, b.turnId)).toBe("resumed")
  await until(
    () => turnState(b.turnId),
    (row) => row.state === "done",
  )
  expect((await turnState(b.turnId)).state).toBe("done")
  const requestsB = captured
  expect(requestsB).toHaveLength(3)

  const idsA = await idsOf(threadA, a.turnId)
  const idsB = await idsOf(threadB, b.turnId)
  const first = [
    normalize(requestsA[0]?.body ?? "", idsA),
    normalize(requestsB[0]?.body ?? "", idsB),
  ]
  // The two turns are the same turn: their first requests already agree.
  expect(firstDiff(first[0] as string, first[1] as string)).toBe("equal")
  for (const i of [1, 2]) {
    const ra = normalize(requestsA[i]?.body ?? "", idsA)
    const rb = normalize(requestsB[i]?.body ?? "", idsB)
    expect(firstDiff(ra, rb)).toBe("equal")
  }
  // The step-1 reasoning and its signature went back to the provider on the resume.
  expect(requestsB[1]?.body).toContain(JSON.stringify(STEPS[0]?.signature).slice(1, -1))
  expect(requestsB[1]?.body).toContain((STEPS[0] as Step).thinking)
  expect(requestsB[1]?.body).toContain((STEPS[0] as Extract<Step, { kind: "tool" }>).callId)
}

describe("a resumed turn's provider request (C2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    process.env.OPENROUTER_API_KEY = "sk-or-test-key"
    delete process.env.LIAISON_MODEL_PROVIDER
    owner = await minimal.adminSession((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@wire-${crypto.randomUUID().slice(0, 8)}`}, 'Sam',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${owner.orgId}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    // An OpenRouter model the org added (Settings > AI), served by the box key.
    const added = {
      key: OR_MODEL,
      provider: "openrouter",
      upstreamId: OR_MODEL.slice("openrouter/".length),
      displayName: "Wire model",
      contextWindow: 200000,
      inputCostPerM: "0.26000000",
      outputCostPerM: "1.04000000",
      tools: true,
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: true,
      enabled: true,
      addedAt: "2026-10-22T00:00:00.000Z",
    }
    await sql`UPDATE kernel.organizations
      SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}',
        coalesce(settings->'ai', '{}'::jsonb) || ${JSON.stringify({ models: { added: [added] } })}::jsonb)
      WHERE id = ${owner.orgId}`
    const perms = await withPrivilegedDb(owner.orgId, "test:turn-wire-owner", (tx) =>
      loadEffectivePermissions(tx, owner.userId, owner.orgId),
    )
    ownerScopes = perms.scopes
  })

  // A drain hands off every turn registered in this process: start from none,
  // whatever an earlier file in the same run left behind.
  beforeEach(() => {
    TurnHandoffTestAccess.clear()
  })

  afterEach(() => {
    answer = null
    hold = null
    captured = []
    TurnHandoffTestAccess.clear()
  })

  afterAll(async () => {
    fetchSpy.mockRestore()
    broadcastSpy.mockRestore()
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await releaseTestLock()
  })

  it("Anthropic with thinking: the resumed step-2 request equals the uninterrupted one", async () => {
    await compareResumedRequest(null, anthropicStream)
  }, 90_000)

  it("OpenRouter with reasoning details: the resumed step-2 request equals the uninterrupted one", async () => {
    await compareResumedRequest(OR_MODEL, openRouterStream)
  }, 90_000)
})
