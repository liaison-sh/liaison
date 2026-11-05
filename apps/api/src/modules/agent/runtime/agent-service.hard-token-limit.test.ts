// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S17 / A34: a routine's hard token limit stops the run.
//
// Real agent turns (invokeAgentForThread -> runAgentChat -> the AI SDK loop)
// against the real Anthropic provider, answered from canned SSE at the fetch
// layer, so the stop condition, onStepFinish and the usage the SDK reads are
// the production ones. Every model step costs 300 tokens: 100 plain input +
// 150 cache-read input + 50 output (cached input counts, A34).
//
//  - limit 500: the run stops after step 2 (300, 600) and its output says so;
//  - no account on the frame: the same script runs to its natural end;
//  - an agents_ask sub-run started inside the run adds its tokens to the
//    parent's account, so the parent then stops one step earlier.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { addSharedTokens, type RunTokenAccount } from "~/modules/agent/runtime/run-token-limit"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  CoordinationToolsTestAccess,
  handleAgentsAsk,
} from "~/modules/agent/tools/coordination-tools"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const MODEL_ID = "claude-hard-token-limit-test"
let CHAT = ""
let ROOM = ""

const STEP = { input: 100, cacheRead: 150, output: 50 } // 300 per step
const STOP_TEXT = "Stopped at the hard limit of 500 tokens."

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function sse(events: Array<[string, unknown]>): Response {
  return new Response(
    events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

let toolUseCounter = 0
function anthropicStep(kind: "tool" | "text", text = "Done."): Response {
  const start: [string, unknown] = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: `msg_${++toolUseCounter}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: STEP.input,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: STEP.cacheRead,
          output_tokens: 1,
        },
      },
    },
  ]
  const end = (reason: string): Array<[string, unknown]> => [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: STEP.output },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  const block: Array<[string, unknown]> =
    kind === "tool"
      ? [
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: `toolu_limit_${toolUseCounter}`,
                name: "kernel__tool_search",
                input: {},
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ query: "select:kernel__list_skills" }),
              },
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
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          ],
        ]
  return sse([
    start,
    ...block,
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end(kind === "tool" ? "tool_use" : "end_turn"),
  ])
}

/** What the next agent-loop requests answer, in order; past the end, a final text. */
let script: Array<"tool" | "text"> = []
let loopRequests = 0
const realFetch = globalThis.fetch
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

async function userMessage(threadId: string, text: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${threadId}, ${ORG}, ${USER}, 'user', ${text}, '{}') RETURNING id`
  return row.id
}

async function lastAgentMessage(threadId: string): Promise<string> {
  const [row] = await sql<{ content: string }[]>`
    SELECT content FROM kernel.messages
     WHERE thread_id = ${threadId} AND author_type = 'agent'
     ORDER BY created_at DESC LIMIT 1`
  return row?.content ?? ""
}

function tickFrame(tokenAccount?: RunTokenAccount): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    background: true,
    ...(tokenAccount ? { tokenAccount } : {}),
  }
}

async function runTurn(threadId: string, frame: RunContext) {
  const msgId = await userMessage(threadId, "Look the skills up, then answer.")
  return runContextStore.run(frame, () =>
    invokeAgentForThread(threadId, msgId, { ...actor }, ORG, true),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Token Limit Org', ${`s17-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`s17-${tag}@t.com`}, 'Limit User')`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '0', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Token limit test', '1.00', '5.00', 200000, false, 'starter') ON CONFLICT DO NOTHING`
  for (const [id, handle, name] of [
    [CALLER, `@s17-caller-${tag}`, "Caller"],
    [CALLEE, `@s17-callee-${tag}`, "Callee"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  const [chat] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by, agent_model_id)
    VALUES (${ORG}, ${`s17-chat-${tag}`}, 'agent_chat', ${USER}, ${MODEL_ID}) RETURNING id`
  CHAT = chat.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${CHAT}, ${USER}, ${ORG})`
  const [room] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`s17-room-${tag}`}, 'thread', ${MODEL_ID}, ${USER}) RETURNING id`
  ROOM = room.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${ROOM}, ${CALLER}, ${ORG}, 'agent')`
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-s17-stub"
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: unknown }
    // Only an agent-loop step carries the agent's identity prompt; any side
    // call (a title, a summary) is answered but not counted.
    if (!JSON.stringify(body.system ?? "").includes("## Identity")) {
      return anthropicStep("text", "side call")
    }
    loopRequests++
    return anthropicStep(script.shift() ?? "text")
  }) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = realFetch
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  CoordinationToolsTestAccess.setAgentAskWait()
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  await releaseTestLock()
})

describe("a routine's hard token limit (S17, A34)", () => {
  it("limit 500 at 300 tokens a step: the run stops after step 2 and says so", async () => {
    script = ["tool", "tool", "tool", "text"]
    loopRequests = 0
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    }
    const result = await runTurn(CHAT, tickFrame(account))
    expect(loopRequests).toBe(2)
    // Input counts its cached part: 2 x (100 + 150 + 50).
    expect(account.used).toBe(600)
    expect(result.finishReason).toBe("hard_token_limit")
    expect(await lastAgentMessage(CHAT)).toBe(STOP_TEXT)
  }, 60_000)

  it("absent fields change nothing: the same script runs to its natural end", async () => {
    script = ["tool", "tool", "tool", "text"]
    loopRequests = 0
    const result = await runTurn(CHAT, tickFrame())
    expect(loopRequests).toBe(4)
    expect(result.finishReason).toBe("stop")
    expect(await lastAgentMessage(CHAT)).toBe("Done.")
  }, 60_000)

  it("a limit the run never reaches changes nothing either", async () => {
    script = ["tool", "text"]
    loopRequests = 0
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: 4000,
      hardTokenLimit: 100_000,
      used: 0,
    }
    const result = await runTurn(CHAT, tickFrame(account))
    expect(loopRequests).toBe(2)
    expect(account.used).toBe(600)
    expect(result.finishReason).toBe("stop")
    expect(await lastAgentMessage(CHAT)).toBe("Done.")
  }, 60_000)

  it("a turn started after the limit is spent makes no model call and says so", async () => {
    script = ["tool", "tool", "text"]
    loopRequests = 0
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 600,
    }
    const result = await runTurn(CHAT, tickFrame(account))
    expect(loopRequests).toBe(0)
    expect(account.used).toBe(600)
    expect(result.finishReason).toBe("hard_token_limit")
    expect(await lastAgentMessage(CHAT)).toBe(STOP_TEXT)
  }, 60_000)

  it("a limit spent by a sub-run elsewhere (the shared counter) also stops the next turn before any call", async () => {
    script = ["tool", "text"]
    loopRequests = 0
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    }
    // A spawn_agent sub-run in another worker spent it: only the shared counter knows.
    await addSharedTokens(account.id, 550)
    const result = await runTurn(CHAT, tickFrame(account))
    expect(loopRequests).toBe(0)
    expect(account.used).toBe(550)
    expect(result.finishReason).toBe("hard_token_limit")
    expect(await lastAgentMessage(CHAT)).toBe(STOP_TEXT)
  }, 60_000)

  it("an agents_ask sub-run's tokens count toward the parent's limit", async () => {
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    }
    const frame: RunContext = {
      ...tickFrame(account),
      agentId: CALLER,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      turnMessageId: await userMessage(ROOM, "ask the callee"),
    }
    // The callee answers in one step: 300 tokens, spent inside the parent's run.
    script = ["text"]
    loopRequests = 0
    const res = await withRlsContext(actor, (tx) =>
      runContextStore.run(frame, () =>
        handleAgentsAsk(
          { agentHandle: `@s17-callee-${tag}`, question: "when did the pallet leave" },
          {
            userId: USER,
            orgId: ORG,
            db: tx,
            agentExecutionThreadId: ROOM,
            scopes: ["*"],
            actingAgentId: CALLER,
          },
        ),
      ),
    )
    expect(res.asked).toBe(true)
    expect(loopRequests).toBe(1)
    expect(account.used).toBe(300)

    // The parent goes on in the same run: its first step takes the account to
    // 600, past 500, so it stops after ONE step where alone it would take two.
    script = ["tool", "tool", "tool", "text"]
    loopRequests = 0
    const result = await runTurn(CHAT, tickFrame(account))
    expect(loopRequests).toBe(1)
    expect(account.used).toBe(600)
    expect(result.finishReason).toBe("hard_token_limit")
    expect(await lastAgentMessage(CHAT)).toBe(STOP_TEXT)
  }, 60_000)
})
