// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person mentions agent A in a channel, A asks agent B with
// kernel__agents_ask, and B's reply lands in the thread.
//
// The whole chain is the production one: the person's post through
// `dispatchForPostedMessage` (the thread route's dispatch), A's turn through
// invokeAgentForThread and the AI SDK loop, A's tool call through executeTool
// into `agents_ask`, B's turn through the same mention dispatch, all against
// the real Anthropic provider answered from canned SSE at the fetch layer.
//
// The second case is the one seen live: B's turn was refused before it ran (a
// spending gate), so B never wrote anything, and A, told the answer was
// "pending", told the person one second later that no answer had come back
// "yet". The asked agent now always answers in the thread, in its own name,
// and the asker is told the colleague's turn is over, with the reason.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { HTTPException } from "hono/http-exception"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { AgentServiceTestAccess, runAgentChat } from "~/modules/agent/runtime/agent-service"
import { NO_ANSWER_INSTRUCTION, RELAY_INSTRUCTION } from "~/modules/agent/tools/coordination-tools"
import { sendMessage } from "~/modules/threads/message"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = randomUUID()
const PERSON = randomUUID()
const SUPPORT = randomUUID()
const FINANCE = randomUUID()
const tag = ORG.slice(0, 8)
const FINANCE_HANDLE = `@finance-${tag}`
const MODEL_ID = "claude-agent-ask-reply"
const ANSWER = "Q3 gross margin was 41.2% on revenue of EUR 1.84M."
const REFUSAL = "This workspace is out of agent usage."
let THREAD = ""

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
    [
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
    ],
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

/** The agents_ask results Support's model was handed, newest last. */
const supportToolResults: Array<Record<string, unknown>> = []
let financeTurns = 0
const realFetch = globalThis.fetch
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

/** The tool results of the request's LAST message: this step's, not an earlier turn's. */
function toolResultsOf(body: { messages?: Array<{ content?: unknown }> }): string[] {
  const out: string[] = []
  for (const m of (body.messages ?? []).slice(-1)) {
    if (!Array.isArray(m.content)) continue
    for (const c of m.content as Array<{ type?: string; content?: unknown }>) {
      if (c.type === "tool_result") out.push(JSON.stringify(c.content))
    }
  }
  return out
}

function parseResult(raw: string): Record<string, unknown> {
  let parsed: unknown = JSON.parse(raw)
  // The tool_result content is a text part list, or the JSON text itself.
  while (typeof parsed === "string") parsed = JSON.parse(parsed)
  if (Array.isArray(parsed)) {
    const text = (parsed as Array<{ text?: string }>).find((p) => typeof p.text === "string")?.text
    return parseResult(JSON.stringify(text ?? "{}"))
  }
  return parsed as Record<string, unknown>
}

const actor: UserContext = {
  actorType: "user",
  userId: PERSON,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** A fresh channel per case, so no case reads another's history. */
async function openChannel(): Promise<void> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, title, agent_model_id, created_by)
    VALUES (${ORG}, ${`ask-reply-${randomUUID().slice(0, 8)}`}, 'thread', 'Support', ${MODEL_ID}, ${PERSON})
    RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${PERSON}, ${ORG})`
}

/** The person's post, then the one dispatch the thread route runs for it. */
async function personAsks(question: string): Promise<string> {
  await openChannel()
  const message = await withRlsContext(actor, (tx) =>
    sendMessage(tx, {
      orgId: ORG,
      userId: PERSON,
      threadId: THREAD,
      content: `@[Support](agent:${SUPPORT}) ${question}`,
      requiredScopes: [],
    }),
  )
  if (!message) throw new Error("the person could not post")
  const { dispatchedAgentIds } = await dispatchForPostedMessage((fn) => withRlsContext(actor, fn), {
    orgId: ORG,
    threadId: THREAD,
    message,
    actor: { userId: PERSON, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
  })
  expect(dispatchedAgentIds).toEqual([SUPPORT])
  return message.id
}

interface Row {
  id: string
  content: string
  author_type: string
  author_agent_id: string | null
  parent_message_id: string | null
  created_at: Date | string
  metadata: Record<string, unknown> | null
}

async function rowsAfter(triggerId: string): Promise<Row[]> {
  return sql<Row[]>`
    SELECT id, content, author_type, author_agent_id, parent_message_id, created_at, metadata
      FROM kernel.messages
     WHERE thread_id = ${THREAD}
       AND created_at >= (SELECT created_at FROM kernel.messages WHERE id = ${triggerId})
     ORDER BY created_at, id`
}

/** Support's own reply to the person (the turn's last post, not its question). */
function supportReply(rows: Row[], questionId: string | undefined): Row | undefined {
  return rows.find(
    (r) => r.author_agent_id === SUPPORT && r.author_type === "agent" && r.id !== questionId,
  )
}

/** Waits, bounded, for Support's reply to the person to land. */
async function settle(triggerId: string): Promise<Row[]> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const rows = await rowsAfter(triggerId)
    const question = rows.find((r) => r.author_agent_id === SUPPORT && r.content.includes(FINANCE))
    if (supportReply(rows, question?.id) || Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Ask Reply Org', ${`ask-reply-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${PERSON}, ${ORG}, ${`ask-reply-${tag}@t.com`}, 'Lucas', 'active', 'hash')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${PERSON}, ${ORG}, '*')`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '0', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Ask reply test', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  for (const [id, handle, name] of [
    [SUPPORT, `@support-${tag}`, "Support"],
    [FINANCE, FINANCE_HANDLE, "Finance"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }

  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-ask-reply-stub"
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    const system = JSON.stringify(body.system ?? "")
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return step({ type: "text", text: "side call" })
    }
    if (system.includes("You are Finance (")) {
      financeTurns++
      return step({ type: "text", text: ANSWER })
    }
    if (!system.includes("You are Support (")) return step({ type: "text", text: "side call" })
    const results = toolResultsOf(body)
    if (results.length === 0) {
      return step({
        type: "tool",
        name: "kernel__agents_ask",
        input: { agentHandle: FINANCE_HANDLE, question: "What was our gross margin in Q3?" },
      })
    }
    const result = parseResult(results[results.length - 1] as string)
    supportToolResults.push(result)
    return step({
      type: "text",
      text: result.answer ? `Finance says: ${String(result.answer)}` : "Finance could not answer.",
    })
  }) as typeof fetch
}, 120_000)

afterAll(async () => {
  AgentServiceTestAccess.setAgentRun()
  globalThis.fetch = realFetch
  if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  for (const t of [
    "kernel.messages",
    "kernel.thread_participants",
    "kernel.user_thread_state",
    "kernel.credit_transactions",
    "kernel.pending_events",
    "kernel.audit_log",
    "kernel.agent_runs",
  ]) {
    await sql.unsafe(`DELETE FROM ${t} WHERE org_id = '${ORG}'`).catch(() => undefined)
  }
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  await releaseTestLock()
})

describe("a person mentions agent A, A asks agent B, B answers in the thread", () => {
  test("B's reply lands under A's question and A relays it", async () => {
    const trigger = await personAsks("what was our gross margin in Q3?")
    const rows = await settle(trigger)

    const question = rows.find(
      (r) => r.author_agent_id === SUPPORT && r.content.includes(`(agent:${FINANCE})`),
    )
    expect(question).toBeDefined()
    const answer = rows.find((r) => r.author_agent_id === FINANCE && r.author_type === "agent")
    expect(answer?.content).toBe(ANSWER)
    expect(answer?.parent_message_id).toBe(question?.id ?? "")
    expect(financeTurns).toBe(1)

    // Support waited for the answer and was handed it.
    const result = supportToolResults.at(-1)
    expect(result?.asked).toBe(true)
    expect(result?.answer).toBe(ANSWER)
    expect(result?.instruction).toBe(RELAY_INSTRUCTION)
    const reply = supportReply(rows, question?.id)
    expect(reply?.content).toContain(ANSWER)
    expect(new Date(reply!.created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(answer!.created_at).getTime(),
    )
  }, 60_000)

  test("B's turn refused before it ran still answers in the thread, and A is told it is over", async () => {
    // B's turn is refused the way a spending gate refuses one: before a model
    // call, with a message written for a person. A's turn runs as usual.
    AgentServiceTestAccess.setAgentRun(async (params: { actingAgentId?: string | null }) => {
      if (params.actingAgentId === FINANCE) {
        throw new HTTPException(402, { message: REFUSAL })
      }
      return runAgentChat(params as never)
    })
    const turnsBefore = financeTurns
    try {
      const trigger = await personAsks("and the gross margin in Q2?")
      const rows = await settle(trigger)

      const question = rows.find(
        (r) => r.author_agent_id === SUPPORT && r.content.includes(`(agent:${FINANCE})`),
      )
      expect(question).toBeDefined()
      expect(financeTurns).toBe(turnsBefore)

      // The asked agent answers, in its own name, under the question: never
      // as the person, never as a system line nobody attributes.
      const fromFinance = rows.filter((r) => r.author_agent_id === FINANCE)
      expect(fromFinance.length).toBe(1)
      expect(fromFinance[0]?.author_type).toBe("agent")
      expect(fromFinance[0]?.parent_message_id).toBe(question?.id ?? "")
      expect(fromFinance[0]?.content).toContain("could not answer")
      expect(fromFinance[0]?.content).toContain(REFUSAL)

      // The asker is told the colleague's turn is OVER, and why, never that
      // the answer is still on its way.
      const result = supportToolResults.at(-1)
      expect(result?.asked).toBe(true)
      expect(result?.answer).toBeNull()
      expect(result?.status).toBeUndefined()
      expect(result?.reason).toBe("callee_turn_failed")
      expect(String(result?.note)).not.toContain("pending")
      expect(String(result?.note)).toContain(REFUSAL)
      expect(result?.instruction).toBe(NO_ANSWER_INSTRUCTION)
      const reply = supportReply(rows, question?.id)
      expect(reply).toBeDefined()
      expect(new Date(reply!.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(fromFinance[0]!.created_at).getTime(),
      )
    } finally {
      AgentServiceTestAccess.setAgentRun()
    }
  }, 60_000)
})
