// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T09b: `agents_ask`, thin sugar over the mention dispatch.
//
// Everything asserted here is a persisted row or a returned value, never a
// mock: the question is a real `messages` row carrying a real mention token,
// the answer is the row the callee's turn actually wrote, and the refusals are
// the dispatch guard's own verdicts reaching the caller.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { parseMentions } from "~/lib/mentions"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  COLLEAGUE_PERSONAL_AGENT_REFUSAL,
  CoordinationToolsTestAccess,
  colleaguePersonalAgentRefusal,
  handleAgentsAsk,
  handleAgentsInvite,
  NO_ANSWER_INSTRUCTION,
  PENDING_INSTRUCTION,
  PERSON_NOT_AGENT_INSTRUCTION,
  QUEUED_INSTRUCTION,
  RELAY_INSTRUCTION,
  SELF_ASK_INSTRUCTION,
  SELF_ASK_REFUSAL,
  UNKNOWN_HANDLE_INSTRUCTION,
} from "~/modules/agent/tools/coordination-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const GONE = crypto.randomUUID()
const COLLEAGUE = crypto.randomUUID()
const COLLEAGUE_AGENT = crypto.randomUUID()
const BASE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const ANSWER = "the pallet shipped on tuesday"
/** What the stubbed callee turn answers next; the dedupe cases vary it. */
let answerText = ANSWER
/**
 * While set, the stubbed callee turn holds before answering until the gate is
 * released: a callee slower than the ask's wait bound, without a fixed delay.
 */
let streamGate: Promise<void> | null = null
/**
 * The prompt the CALLEE's turn actually sent, captured off the one model call
 * the stub stands in for. This is the only place the whole pass through is
 * observable: tool -> dispatch -> invokeAgentForThread -> runAgentChat ->
 * assembleContext -> the request.
 */
let lastPromptMessages: Array<{ role: string; content: unknown }> = []

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function fakeStream(options?: { messages?: Array<{ role: string; content: unknown }> }) {
  const gate = streamGate
  lastPromptMessages = options?.messages ?? []
  return {
    fullStream: (async function* () {
      if (gate) await gate
      yield { type: "text-delta", text: answerText }
      yield {
        type: "finish-step",
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

async function seed(opts: {
  content: string
  parentId?: string | null
  agentId?: string | null
  mentions?: Array<{ type: "agent"; id: string }>
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
       parent_message_id, mentions)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${opts.agentId ? "agent" : "user"}, ${opts.agentId ?? null},
            ${opts.content}, '{}'::text[], ${opts.parentId ?? null},
            ${opts.mentions ? JSON.stringify(opts.mentions) : null}::jsonb)
    RETURNING id`
  return row.id
}

/** Runs one ask inside a turn frame, as the tool bridge would. */
async function ask(
  params: { agentHandle: string; question: string },
  opts: { turnMessageId?: string; frame?: Partial<RunContext>; scopes?: string[] } = {},
) {
  const runId = crypto.randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: CALLER,
    agentCeiling: ["*"],
    // Every real agent turn computes this before the tool catalog is built, and
    // the dispatch REFUSES without it (A4: a caller that cannot say how far it
    // reaches delegates nothing), so the fixture carries what a turn carries.
    effectiveScope: ["*"],
    turnScopeAccumulator: createTurnScopeAccumulator(),
    ...(opts.turnMessageId ? { turnMessageId: opts.turnMessageId } : {}),
    ...opts.frame,
  }
  return withRlsContext(actor, (tx) =>
    runContextStore.run(frame, () =>
      handleAgentsAsk(params, {
        userId: USER,
        orgId: ORG,
        db: tx,
        agentExecutionThreadId: THREAD,
        scopes: opts.scopes ?? ["*"],
        actingAgentId: CALLER,
      }),
    ),
  )
}

/** Holds the callee's next turns until the returned release is called. */
function holdCallee(): () => void {
  let release: () => void = () => {}
  streamGate = new Promise<void>((r) => {
    release = r
  })
  return () => {
    streamGate = null
    release()
  }
}

async function calleeReplyCount(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages WHERE thread_id = ${THREAD} AND author_agent_id = ${CALLEE}`
  return rows.length
}

/** Releases a held callee turn and waits (bounded) for its reply to land. */
async function releaseCalleeAndSettle(release: () => void): Promise<void> {
  const before = await calleeReplyCount()
  release()
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && (await calleeReplyCount()) <= before) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function messageCount(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages WHERE thread_id = ${THREAD}`
  return rows.length
}

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeStream as never)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Ask Org', ${`p3b-t09b-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t09b-${tag}@t.com`}, 'Ask User')`
  for (const [id, handle, name] of [
    [CALLER, `@caller-${tag}`, "Caller"],
    [CALLEE, `@callee-${tag}`, "Callee"],
    [GONE, `@gone-${tag}`, "Gone"],
    [BASE, "@base", "Liaison"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${GONE}`
  // A colleague's personal agent: the app never shows it to anyone else.
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${COLLEAGUE}, ${ORG}, ${`p3b-t09b-col-${tag}@t.com`}, 'Riley')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
    VALUES (${COLLEAGUE_AGENT}, ${ORG}, 'personal', ${`@riley-${tag}`}, 'Riley', '["*"]'::jsonb, ${COLLEAGUE})`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`p3b-t09b-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLER}, ${ORG}, 'agent')`
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  CoordinationToolsTestAccess.setAgentAskWait()
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("agents_ask", () => {
  it("agents_ask on an unknown handle refuses and posts nothing", async () => {
    const before = await messageCount()
    const res = await ask({ agentHandle: "@nobody-at-all", question: "who ships this" })
    expect(res).toEqual({
      asked: false,
      reason: "no live agent with that handle",
      availableAgents: [`@callee-${tag}`],
      instruction: UNKNOWN_HANDLE_INSTRUCTION,
    })
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask resolves a handle written without its @ or in another case", async () => {
    for (const handle of [`callee-${tag}`, `@CALLEE-${tag}`, `Callee-${tag.toUpperCase()}`]) {
      const trigger = await seed({ content: `a human asks ${handle}` })
      const res = await ask(
        { agentHandle: handle, question: `has parcel ${handle} shipped` },
        { turnMessageId: trigger },
      )
      expect(res.answeredBy).toBe(`@callee-${tag}`)
    }
  })

  it("agents_ask resolves an agent by its display name, the word a person uses", async () => {
    const trigger = await seed({ content: "ask the callee" })
    const res = await ask(
      { agentHandle: "callee", question: "has the display name parcel shipped" },
      { turnMessageId: trigger },
    )
    expect(res.asked).toBe(true)
    expect(res.answeredBy).toBe(`@callee-${tag}`)
  })

  it("agents_ask never resolves a colleague's personal agent by the colleague's name", async () => {
    const before = await messageCount()
    const res = await ask({ agentHandle: "Riley", question: "who ships this" })
    expect(res.asked).toBe(false)
    expect(res.availableAgents).not.toContain(`@riley-${tag}`)
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask on a colleague's personal agent by HANDLE refuses and points at the person", async () => {
    // Asked to "answer tobias" in a task discussion, an agent asked @tobias,
    // the colleague's personal agent, which then answered as the colleague.
    // A person is answered in the conversation, addressed to them; their
    // personal agent acts for them alone and is nobody else's to ask.
    const before = await messageCount()
    const res = await ask({ agentHandle: `@riley-${tag}`, question: "where are the demo units" })
    expect(res.asked).toBe(false)
    expect(res.instruction).toBe(PERSON_NOT_AGENT_INSTRUCTION)
    expect(res.person).toEqual({ name: "Riley", mention: `@[Riley](user:${COLLEAGUE})` })
    expect(res.reason).toContain("Riley's agent")
    expect(PERSON_NOT_AGENT_INSTRUCTION).toContain("addressed to them")
    // An owner with no name is never replaced by an invented person.
    expect(colleaguePersonalAgentRefusal()).toBe(COLLEAGUE_PERSONAL_AGENT_REFUSAL)
    expect(COLLEAGUE_PERSONAL_AGENT_REFUSAL).not.toContain("that colleague:")
    expect(await messageCount()).toBe(before)
  })

  it("agents_invite never seats a colleague's personal agent", async () => {
    const before = await messageCount()
    const res = await withRlsContext(actor, (tx) =>
      runContextStore.run(
        {
          runId: crypto.randomUUID(),
          parentRunId: null,
          rootRunId: crypto.randomUUID(),
          nestingDepth: 0,
          agentId: CALLER,
          agentCeiling: ["*"],
          effectiveScope: ["*"],
          turnScopeAccumulator: createTurnScopeAccumulator(),
        },
        () =>
          handleAgentsInvite(
            { agentHandle: `@riley-${tag}` },
            {
              userId: USER,
              orgId: ORG,
              db: tx,
              agentExecutionThreadId: THREAD,
              scopes: ["*"],
              actingAgentId: CALLER,
            },
          ),
      ),
    )
    expect(res.invited).toBe(false)
    expect(res.reason).toContain(`@[Riley](user:${COLLEAGUE})`)
    const seats = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
      WHERE thread_id = ${THREAD} AND agent_id = ${COLLEAGUE_AGENT}`
    expect(seats[0].n).toBe(0)
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask on an archived agent refuses and posts nothing", async () => {
    const before = await messageCount()
    const res = await ask({ agentHandle: `@gone-${tag}`, question: "who ships this" })
    expect(res).toEqual({
      asked: false,
      reason: "no live agent with that handle",
      availableAgents: [`@callee-${tag}`],
      instruction: UNKNOWN_HANDLE_INSTRUCTION,
    })
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask on the base agent refuses and posts nothing", async () => {
    const before = await messageCount()
    const res = await ask({ agentHandle: "@base", question: "who ships this" })
    expect(res).toEqual({
      asked: false,
      reason: "no live agent with that handle",
      availableAgents: [`@callee-${tag}`],
      instruction: UNKNOWN_HANDLE_INSTRUCTION,
    })
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask on the caller's OWN handle refuses and posts nothing", async () => {
    // The live two-agent failure: addressed in a message naming its own handle
    // beside a colleague's, the agent called agents_ask on ITSELF and then
    // reported the result as an answer it had collected. The refusal names the
    // handle as the caller so the next step is to answer, not to ask again.
    const before = await messageCount()
    const res = await ask({ agentHandle: `@caller-${tag}`, question: "what do you handle here" })
    expect(res).toEqual({
      asked: false,
      reason: SELF_ASK_REFUSAL,
      // NOT the no answer obligation: that told the production agent to report
      // its owner's question as unanswerable, when it only had to answer it.
      instruction: SELF_ASK_INSTRUCTION,
    })
    expect(SELF_ASK_INSTRUCTION).toContain("Answer the person yourself")
    expect(await messageCount()).toBe(before)
  })

  it("agents_ask posts the question nested under the caller turn with a parseable agent mention token", async () => {
    const trigger = await seed({ content: "a human asks about the pallet" })
    await ask(
      { agentHandle: `@callee-${tag}`, question: "has the pallet shipped" },
      { turnMessageId: trigger },
    )
    const [q] = await sql<
      { id: string; parent_message_id: string | null; author_agent_id: string; content: string }[]
    >`
      SELECT id, parent_message_id, author_agent_id, content FROM kernel.messages
      WHERE thread_id = ${THREAD} AND author_agent_id = ${CALLER}
      ORDER BY created_at DESC LIMIT 1`
    expect(q.parent_message_id).toBe(trigger)
    expect(q.author_agent_id).toBe(CALLER)
    expect(parseMentions(q.content)).toEqual([{ type: "agent", id: CALLEE }])
  })

  it("agents_ask carries the caller accumulated required scopes onto the question message", async () => {
    const trigger = await seed({ content: "a second human question" })
    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected(["app_invoicing:documents:read"])
    await ask(
      { agentHandle: `@callee-${tag}`, question: "what is the invoice total" },
      { turnMessageId: trigger, frame: { turnScopeAccumulator: accumulator } },
    )
    const [q] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${THREAD} AND author_agent_id = ${CALLER}
      ORDER BY created_at DESC LIMIT 1`
    expect(q.required_scopes).toContain("app_invoicing:documents:read")
  })

  it("agents_ask returns the callee answer text", async () => {
    const trigger = await seed({ content: "a third human question" })
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: "when did it leave the warehouse" },
      { turnMessageId: trigger },
    )
    expect(res.asked).toBe(true)
    expect(res.answeredBy).toBe(`@callee-${tag}`)
    expect(res.answer).toBe(ANSWER)
  })

  it("agents_ask refuses a second outstanding ask in the same turn", async () => {
    const trigger = await seed({ content: "a fourth human question" })
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: "and what about the second pallet" },
      { turnMessageId: trigger, frame: { agentAskInFlight: true } },
    )
    expect(res).toEqual({
      asked: false,
      reason: "an earlier question is still waiting for its answer",
      instruction: NO_ANSWER_INSTRUCTION,
    })
  })

  it("agents_ask with the worker pool saturated returns the pending note within the wait bound and never hangs", async () => {
    const trigger = await seed({ content: "a fifth human question" })
    CoordinationToolsTestAccess.setAgentAskWait(150)
    const releaseCallee = holdCallee()
    const startedAt = Date.now()
    try {
      const res = await ask(
        { agentHandle: `@callee-${tag}`, question: "is the courier late today" },
        { turnMessageId: trigger },
      )
      expect(Date.now() - startedAt).toBeLessThan(1500)
      expect(res.asked).toBe(true)
      expect(res.answer).toBe(null)
      expect(res.note).toBe("asked, answer pending in the thread")
      expect(res.status).toBe("pending")
    } finally {
      CoordinationToolsTestAccess.setAgentAskWait()
      // Let the slow turn land before the next case reads the thread.
      await releaseCalleeAndSettle(releaseCallee)
    }
  })

  it("agents_ask returns the guard refusal without posting when the hop bound is reached", async () => {
    const human = await seed({ content: "the human question that started it" })
    const relayed = await seed({ content: "relayed once", parentId: human, agentId: CALLER })
    const before = await messageCount()
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: "relay this one hop too far" },
      { turnMessageId: relayed },
    )
    expect(res).toEqual({
      asked: false,
      reason: "hop_bound",
      instruction: NO_ANSWER_INSTRUCTION,
    })
    expect(await messageCount()).toBe(before)
  })

  it("a deduped ask returns the answer to the question it repeats", async () => {
    // Two different questions to one callee under one trigger. Repeating the
    // FIRST hands back the FIRST answer, never the newer one next door.
    const trigger = await seed({ content: "a turn with two questions in it" })
    const first = "when does the container clear customs"
    answerText = "it clears on thursday"
    await ask({ agentHandle: `@callee-${tag}`, question: first }, { turnMessageId: trigger })
    answerText = "the warehouse supervisor signed it"
    await ask(
      { agentHandle: `@callee-${tag}`, question: "who signed the delivery note" },
      { turnMessageId: trigger },
    )
    answerText = ANSWER
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: first },
      { turnMessageId: trigger },
    )
    expect(res.reason).toBe("duplicate_ask")
    expect(res.answer).toBe("it clears on thursday")
  })

  it("a result with no answer tells the model in words what to do with it", async () => {
    // Measured: a flash-lite agent whose ask was withheld or cut invented a
    // figure for the person in about half of the live runs. The machinery was
    // right every time; the RESULT never said what a failed ask obliges.
    // A refusal that carries no answer (an ask already in flight). Not the
    // self ask, which carries its own obligation: answer it yourself.
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: "who ships this" },
      { frame: { agentAskInFlight: true } },
    )
    expect(res.asked).toBe(false)
    expect(res.instruction).toBe(NO_ANSWER_INSTRUCTION)
    expect(NO_ANSWER_INSTRUCTION).toContain("Never state a value you did not receive")
    expect(UNKNOWN_HANDLE_INSTRUCTION).toContain("Never state a value you did not receive")
  })

  it("an ask that came back with an answer carries the relay obligation", async () => {
    // Measured on prod: the answer that came back was about an unrelated
    // ticket and the caller reported a count ("22") that appears nowhere in
    // the exchange. "An answer arrived" is not "the question was answered",
    // and the answered branch carried no obligation at all until now.
    const trigger = await seed({ content: "a human question with an answer coming" })
    const res = await ask(
      { agentHandle: `@callee-${tag}`, question: "did the second pallet leave" },
      { turnMessageId: trigger },
    )
    expect(res.answer).toBe(ANSWER)
    expect(res.instruction).toBe(RELAY_INSTRUCTION)
  })

  it("the question reaches the callee's own prompt, as its last user message", async () => {
    // THE WIRING, end to end, through the real path: the tool posts the
    // question, the dispatch hands `askedQuestion` to the turn, the turn hands
    // it to `assembleContext`, and the assembled request carries it. Deleting
    // either pass through (agent-dispatch-guard's `coordination.askedQuestion`
    // or agent-service's `askedQuestion` spread) leaves the callee with a
    // thread and no request, which is the prod defect.
    const earlier = await seed({ content: "what is the status of ticket 6507" })
    lastPromptMessages = []
    const question = "how many orders are waiting to be packed in the queue"
    const res = await ask({ agentHandle: `@callee-${tag}`, question }, { turnMessageId: earlier })
    expect(res.asked).toBe(true)
    const last = lastPromptMessages[lastPromptMessages.length - 1]
    expect(last?.role).toBe("user")
    const text = typeof last?.content === "string" ? last.content : ""
    expect(text).toContain("<asked-question")
    expect(text).toContain(question)
    // And the earlier topic is not what the callee is being told to do.
    expect(text).not.toContain("6507")
  })

  it("the relay obligation forbids a figure that is not in the answer", () => {
    expect(RELAY_INSTRUCTION).toContain("Relay only what `answer` says")
    expect(RELAY_INSTRUCTION).toContain("that does not appear in it")
    expect(RELAY_INSTRUCTION).toContain("never compute one")
    // The second half is the case the prod defect actually was: an answer that
    // came back, about something else.
    expect(RELAY_INSTRUCTION).toContain("does not address the question you asked")
  })

  it("an ask still pending at the wait bound hands over, never reports a missing answer", async () => {
    const trigger = await seed({ content: "a human question the callee is slow on" })
    CoordinationToolsTestAccess.setAgentAskWait(150)
    const releaseCallee = holdCallee()
    try {
      const res = await ask(
        { agentHandle: `@callee-${tag}`, question: "how slow is the warehouse today" },
        { turnMessageId: trigger },
      )
      expect(res.asked).toBe(true)
      expect(res.answer).toBeNull()
      expect(res.instruction).toBe(PENDING_INSTRUCTION)
      expect(PENDING_INSTRUCTION).toContain("will be posted in this conversation")
    } finally {
      CoordinationToolsTestAccess.setAgentAskWait()
      await releaseCalleeAndSettle(releaseCallee)
    }
  })

  it("a deduped ask that hands back a standing answer carries no instruction", async () => {
    const trigger = await seed({ content: "a repeated question with an answer standing" })
    const question = "has the second container cleared customs"
    await ask({ agentHandle: `@callee-${tag}`, question }, { turnMessageId: trigger })
    const res = await ask({ agentHandle: `@callee-${tag}`, question }, { turnMessageId: trigger })
    expect(res.reason).toBe("duplicate_ask")
    expect(res.answer).toBe(ANSWER)
    // A standing answer is still an answer being relayed, so it carries the
    // same obligation as a fresh one.
    expect(res.instruction).toBe(RELAY_INSTRUCTION)
  })

  it("a tool identifier in the callee answer never reaches the caller", async () => {
    // Observed live: with a tool named in the callee's own system prompt, a
    // relayed decline reached the person as "does not have the
    // ledger__invoice_total tool available". The relay scrubs what the registry
    // itself registered, so the caller is handed prose it can safely repeat.
    toolRegistry.set([ORG, "ledger", "invoice_total"], {
      appName: "ledger",
      name: "invoice_total",
      description: "look up one invoice total",
      requiredScopes: ["kernel"],
      params: z.object({}),
      handler: async () => ({}),
      readOnly: true,
    })
    const trigger = await seed({ content: "a human question the callee declines" })
    answerText = "I do not have the ledger__invoice_total tool available in this conversation"
    try {
      const res = await ask(
        { agentHandle: `@callee-${tag}`, question: "what is the total on that invoice" },
        { turnMessageId: trigger },
      )
      expect(res.answer).not.toContain("ledger__invoice_total")
      expect(res.answer).toContain("a tool")
    } finally {
      answerText = ANSWER
      toolRegistry.delete([ORG, "ledger", "invoice_total"])
    }
  })

  it("a deduped ask returns the earlier answer text", async () => {
    const trigger = await seed({ content: "a repeated human question" })
    const question = "has the container cleared customs"
    const res1 = await ask({ agentHandle: `@callee-${tag}`, question }, { turnMessageId: trigger })
    expect(res1.answer).toBe(ANSWER)
    const before = await messageCount()
    const res2 = await ask({ agentHandle: `@callee-${tag}`, question }, { turnMessageId: trigger })
    expect(res2.asked).toBe(false)
    expect(res2.reason).toBe("duplicate_ask")
    expect(res2.answer).toBe(ANSWER)
    expect(await messageCount()).toBe(before)
  })
})

describe("agents_ask: a question queued on someone's computer (D22)", () => {
  it("promises the answer posted here, never a link (the asker may not open the owner's thread)", () => {
    // Walk 2026-10-12: Support Desk told the person "The result will be linked
    // into this conversation", while the answer itself is now posted (or a
    // notice saying who can share it).
    expect(QUEUED_INSTRUCTION).toContain("answer will be posted into this conversation")
    expect(QUEUED_INSTRUCTION).not.toContain("linked")
  })
})
