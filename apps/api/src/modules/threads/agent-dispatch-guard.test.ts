// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T06: the dispatch guard, read off the message parent chain.
//
// Every boundary here is an off by one worth pinning: the last allowed hop and
// the first refused one, the sixth agent turn under a root and the seventh, a
// duplicate inside the window and the same question outside it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { flushEventHandlers, onEvent } from "~/infra/events/event-bus"
import {
  AgentServiceTestAccess,
  type TurnCoordination,
} from "~/modules/agent/runtime/agent-service"
import {
  AGENT_ASK_DEDUPE_WINDOW_MS,
  AGENT_TURN_FAILED,
  type DispatchVerdict,
  dispatchAgentMention,
  evaluateAgentDispatch,
  withTurnFailureReported,
} from "~/modules/threads/agent-dispatch-guard"
import { listMessages, postAgentAutoAddSystemMessage } from "~/modules/threads/message"
import { addAgentParticipant } from "~/modules/threads/participant"
import { createOrGetAgentDm } from "~/modules/threads/thread"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
/** A callee with a ceiling of its OWN, so an intersection is observable. */
const NARROW = crypto.randomUUID()
const tag = ORG.slice(0, 8)

// The human's connection reaches A and B; NARROW's ceiling covers B and C. The
// intersection is B alone.
const SCOPE_A = "kernel:threads:read"
const SCOPE_B = "kernel:contacts:read"
const SCOPE_C = "kernel:files:read"
let THREAD = ""

const ctx: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

/** A message row, with the parent and author the case under test needs. */
async function seedMessage(opts: {
  content?: string
  parentId?: string | null
  agentId?: string | null
  mentions?: Array<{ type: "agent"; id: string }>
  createdAt?: Date
  requiredScopes?: string[]
}): Promise<string> {
  const authorType = opts.agentId ? "agent" : "user"
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
       parent_message_id, mentions, created_at)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${authorType}, ${opts.agentId ?? null},
            ${opts.content ?? "a message"}, ${opts.requiredScopes ?? []}::text[], ${opts.parentId ?? null},
            ${opts.mentions ? JSON.stringify(opts.mentions) : null}::jsonb,
            ${(opts.createdAt ?? new Date()).toISOString()}::timestamptz)
    RETURNING id`
  return row.id
}

async function evaluate(params: {
  parentMessageId: string | null
  callerAgentId: string | null
  calleeAgentId?: string
  questionText?: string
  triggerMessageId?: string
  now?: Date
}): Promise<DispatchVerdict> {
  return withRlsContext(ctx, (tx) =>
    evaluateAgentDispatch(tx, {
      orgId: ORG,
      threadId: THREAD,
      parentMessageId: params.parentMessageId,
      callerAgentId: params.callerAgentId,
      calleeAgentId: params.calleeAgentId ?? CALLEE,
      questionText: params.questionText ?? "what is the shipping status of order 1042",
      triggerMessageId: params.triggerMessageId,
      now: params.now,
    }),
  )
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Guard Org', ${`p3b-t06-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, ${`p3b-t06-${tag}@test.com`}, 'Guard User', 'active', 'hash')`
  for (const [id, handle, name] of [
    [CALLER, `@guard-caller-${tag}`, "Caller"],
    [CALLEE, `@guard-callee-${tag}`, "Callee"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${NARROW}, ${ORG}, 'role', ${`@guard-narrow-${tag}`}, 'Narrow',
            ${JSON.stringify([SCOPE_B, SCOPE_C])}::jsonb)`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p3b-t06-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
})

afterAll(async () => {
  AgentServiceTestAccess.setAgentRun()
  AgentServiceTestAccess.setStreamText()
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("evaluateAgentDispatch", () => {
  it("a human mention with no parent is allowed at hop zero", async () => {
    const trigger = await seedMessage({ content: "hello @callee" })
    const verdict = await evaluate({
      parentMessageId: null,
      callerAgentId: null,
      triggerMessageId: trigger,
    })
    expect(verdict).toEqual({ allowed: true, hopDepth: 0, rootMessageId: trigger })
  })

  it("an agent asking itself is refused with self ask", async () => {
    const verdict = await evaluate({
      parentMessageId: null,
      callerAgentId: CALLEE,
      triggerMessageId: await seedMessage({}),
    })
    expect(verdict).toEqual({ allowed: false, reason: "self_ask" })
  })

  it("the last allowed dispatch is at hop depth one", async () => {
    const human = await seedMessage({ content: "the question a human asked" })
    const firstAgent = await seedMessage({ parentId: human, agentId: CALLER })
    const verdict = await evaluate({ parentMessageId: firstAgent, callerAgentId: CALLER })
    expect(verdict).toEqual({ allowed: true, hopDepth: 1, rootMessageId: human })
  })

  it("the verdict names the chain root, so the per root cap counts from the human turn", async () => {
    const human = await seedMessage({ content: "the root of this exchange" })
    const nested = await seedMessage({ parentId: human, agentId: CALLER })
    const verdict = await evaluate({ parentMessageId: nested, callerAgentId: CALLER })
    expect(verdict.allowed).toBe(true)
    expect(verdict.allowed && verdict.rootMessageId).toBe(human)
  })

  it("the first refused dispatch is at hop depth two", async () => {
    const human = await seedMessage({ content: "the question a human asked twice over" })
    const first = await seedMessage({ parentId: human, agentId: CALLER })
    const second = await seedMessage({ parentId: first, agentId: CALLEE })
    const verdict = await evaluate({ parentMessageId: second, callerAgentId: CALLER })
    expect(verdict).toEqual({ allowed: false, reason: "hop_bound" })
  })

  it("a cycle in the parent chain terminates and refuses", async () => {
    const a = await seedMessage({ content: "a", agentId: CALLER })
    const b = await seedMessage({ content: "b", parentId: a, agentId: CALLEE })
    await sql`UPDATE kernel.messages SET parent_message_id = ${b} WHERE id = ${a}`
    const verdict = await evaluate({ parentMessageId: b, callerAgentId: CALLER })
    expect(verdict).toEqual({ allowed: false, reason: "chain_too_deep" })
    await sql`UPDATE kernel.messages SET parent_message_id = NULL WHERE id = ${a}`
  })

  it("a chain of human replies is at hop zero however deep it is", async () => {
    // Nesting is not delegation: five levels of people replying to each other
    // put NO agent link in the chain, so the mention under them is the first
    // dispatch and it is allowed.
    let parent = await seedMessage({ content: "the human root" })
    for (let i = 0; i < 4; i++) {
      parent = await seedMessage({ content: `a human reply ${i}`, parentId: parent })
    }
    const verdict = await evaluate({
      parentMessageId: parent,
      callerAgentId: null,
      questionText: "a question deep in a human conversation",
    })
    expect(verdict.allowed).toBe(true)
    expect(verdict.allowed && verdict.hopDepth).toBe(0)
  })

  it("an identical question to the same callee inside the dedupe window is refused as duplicate ask and carries the earlier answer text", async () => {
    const now = new Date()
    const human = await seedMessage({ content: "root for the dedupe", createdAt: now })
    const question = "can you confirm the carrier picked up order 1042"
    const earlier = await seedMessage({
      content: question,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 1000),
    })
    // The callee's answer hangs under the QUESTION, which is what the dispatch
    // writes (an agent triggered turn parents every message to its trigger).
    await seedMessage({
      content: "yes, the carrier collected it this morning",
      parentId: earlier,
      agentId: CALLEE,
      createdAt: new Date(now.getTime() - 500),
    })
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: `${question}?`,
      now,
    })
    expect(verdict).toEqual({
      allowed: false,
      reason: "duplicate_ask",
      earlierAnswer: "yes, the carrier collected it this morning",
      earlierAnswerScopes: [],
      earlierQuestionId: earlier,
    })
  })

  it("a duplicate ask carries the standing answer's own scope tag", async () => {
    // The caller is handed that answer as its tool result and quotes it, so its
    // own reply has to be taggable with what the answer carries (A2).
    const now = new Date()
    const human = await seedMessage({ content: "root for the tagged dedupe", createdAt: now })
    const question = "what is the invoice total for order 91"
    const earlier = await seedMessage({
      content: question,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 1000),
    })
    await seedMessage({
      content: "it is 1240 euros",
      parentId: earlier,
      agentId: CALLEE,
      createdAt: new Date(now.getTime() - 500),
      requiredScopes: ["invoicing:documents:read"],
    })
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: question,
      now,
    })
    expect(verdict).toEqual({
      allowed: false,
      reason: "duplicate_ask",
      earlierAnswer: "it is 1240 euros",
      earlierAnswerScopes: ["invoicing:documents:read"],
      earlierQuestionId: earlier,
    })
  })

  it("a duplicate ask whose earlier ask has not answered yet carries a null earlier answer", async () => {
    const now = new Date()
    const human = await seedMessage({ content: "root for the unanswered dedupe", createdAt: now })
    const question = "who owns the return for order 77"
    const unanswered = await seedMessage({
      content: question,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 1000),
    })
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: question,
      now,
    })
    expect(verdict).toEqual({
      allowed: false,
      reason: "duplicate_ask",
      earlierAnswer: null,
      earlierAnswerScopes: [],
      earlierQuestionId: unanswered,
    })
  })

  it("the dispatch pass dedupes a bare question against the mention prefixed sibling", async () => {
    // What the two passes are handed differs by the mention token alone: the
    // pre-check compares the posted CONTENT, the dispatch compares the bare
    // question. Both must reach the same verdict, or the dispatch pass is dead.
    const now = new Date()
    const human = await seedMessage({
      content: "root for the bare question dedupe",
      createdAt: now,
    })
    const question = "did the pallet leave the warehouse"
    await seedMessage({
      content: `@[Callee](agent:${CALLEE}) ${question}`,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 1000),
    })
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: question,
      now,
    })
    expect(verdict.allowed).toBe(false)
    expect(!verdict.allowed && verdict.reason).toBe("duplicate_ask")
  })

  it("the duplicate answer is the one under the repeated question, not the newest", async () => {
    // Two different questions to one callee under one parent. Repeating the
    // FIRST must hand back the FIRST answer, however new the second one is.
    const now = new Date()
    const human = await seedMessage({ content: "root with two questions", createdAt: now })
    const first = "when does the container clear customs"
    const q1 = await seedMessage({
      content: first,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 4000),
    })
    await seedMessage({
      content: "it clears on thursday",
      parentId: q1,
      agentId: CALLEE,
      createdAt: new Date(now.getTime() - 3000),
    })
    const q2 = await seedMessage({
      content: "who signed the delivery note",
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 2000),
    })
    await seedMessage({
      content: "the warehouse supervisor signed it",
      parentId: q2,
      agentId: CALLEE,
      createdAt: new Date(now.getTime() - 1000),
    })
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: first,
      now,
    })
    expect(verdict).toEqual({
      allowed: false,
      reason: "duplicate_ask",
      earlierAnswer: "it clears on thursday",
      earlierAnswerScopes: [],
      earlierQuestionId: q1,
    })
  })

  it("the same question outside the window is allowed", async () => {
    const now = new Date()
    const human = await seedMessage({ content: "root for the stale dedupe", createdAt: now })
    const question = "has the invoice for order 88 been issued"
    await seedMessage({
      content: question,
      parentId: human,
      agentId: CALLER,
      mentions: [{ type: "agent", id: CALLEE }],
      createdAt: new Date(now.getTime() - 1000),
    })
    // The pinned clock moves, never the wall clock.
    const later = new Date(now.getTime() + AGENT_ASK_DEDUPE_WINDOW_MS + 1000)
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: question,
      now: later,
    })
    expect(verdict.allowed).toBe(true)
  })

  it("a sixth agent turn under one root is allowed", async () => {
    const human = await seedMessage({ content: "root with five agent turns" })
    for (let i = 0; i < 5; i++) {
      await seedMessage({ content: `turn ${i}`, parentId: human, agentId: CALLER })
    }
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: "a question nobody asked yet under this root",
    })
    expect(verdict.allowed).toBe(true)
  })

  it("a seventh agent turn under one root is refused with root turn cap", async () => {
    const human = await seedMessage({ content: "root with six agent turns" })
    for (let i = 0; i < 6; i++) {
      await seedMessage({ content: `turn ${i}`, parentId: human, agentId: CALLER })
    }
    const verdict = await evaluate({
      parentMessageId: human,
      callerAgentId: CALLER,
      questionText: "a question nobody asked yet under this other root",
    })
    expect(verdict).toEqual({ allowed: false, reason: "root_turn_cap" })
  })
})

// Surface 8: a turn that cannot START (no API key for the provider, a model
// that is gone, a runtime that throws before the first frame) used to be
// logged and nothing else: the room showed no state, no activity row and no
// line, so the question simply sat there unanswered.
describe("reportAgentTurnFailure", () => {
  it("records the failed turn and tells the thread, and the wrapper still rethrows", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = ${AGENT_TURN_FAILED}`

    const broken = Promise.reject(
      new Error("No API key available for provider anthropic"),
    ) as Promise<never>
    await expect(
      withTurnFailureReported(broken, {
        orgId: ORG,
        threadId: THREAD,
        actorUserId: USER,
        agentId: CALLEE,
      }),
    ).rejects.toThrow("No API key available for provider anthropic")

    const rows = await sql<{ entity_id: string; agent_id: string | null; metadata: any }[]>`
      SELECT entity_id, agent_id, metadata FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = ${AGENT_TURN_FAILED}
      ORDER BY timestamp DESC`
    expect(rows.length).toBe(before[0].n + 1)
    expect(rows[0].entity_id).toBe(THREAD)
    expect(rows[0].agent_id).toBe(CALLEE)
    // The reason is recorded, not just the fact: "it failed" is not an answer.
    expect(rows[0].metadata.error).toBe("No API key available for provider anthropic")
  })
})

// A4 for a caller that is NOT an agent: a human MCP connection states how far
// it reaches, and the agent it addresses must not answer at a wider ceiling
// than that connection holds. The in-app HTTP route states no ceiling and is
// unchanged: the agent there runs at its own.
describe("dispatchAgentMention: a human caller that states a ceiling", () => {
  /** Records what the callee's turn was handed, and answers nothing. */
  function stubTurn(): {
    seen: () => { coordination?: TurnCoordination; agentDispatched?: boolean } | null
  } {
    let captured: { coordination?: TurnCoordination; agentDispatched?: boolean } | null = null
    AgentServiceTestAccess.setAgentRun(async (params: any) => {
      captured = params
      return {
        userMessageId: params.userMessageId,
        fullStream: (async function* () {
          yield {
            type: "finish-step",
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
        finalize: async () => ({
          messageId: null,
          creditCost: 0,
          finishReason: "stop",
          withheldCapabilities: [],
        }),
        actingAgentId: params.actingAgentId ?? null,
        stepCtx: { stepBundleId: null },
        discoveredTools: new Set<string>(),
        turnAccumulatedScopes: () => [],
      }
    })
    return { seen: () => captured }
  }

  async function dispatch(opts: {
    callerEffectiveScope?: string[]
    question: string
    asked?: boolean
  }) {
    const parent = await seedMessage({ content: `a human turn: ${opts.question}` })
    const trigger = await seedMessage({
      content: `@[Narrow](agent:${NARROW}) ${opts.question}`,
      parentId: parent,
      mentions: [{ type: "agent", id: NARROW }],
    })
    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId: THREAD,
      calleeAgentId: NARROW,
      callerAgentId: null,
      parentMessageId: trigger,
      triggerMessageId: trigger,
      questionText: opts.question,
      actor: { userId: USER, orgId: ORG, scopes: [SCOPE_A, SCOPE_B], dimensionGrants: {} },
      adderName: "Guard User",
      ...(opts.callerEffectiveScope ? { callerEffectiveScope: opts.callerEffectiveScope } : {}),
      ...(opts.asked ? { askedQuestion: { askedBy: "Guard User", question: opts.question } } : {}),
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)
    return outcome
  }

  it("narrows the callee to the stated ceiling intersected with its own", async () => {
    const stub = stubTurn()
    await dispatch({
      callerEffectiveScope: [SCOPE_A, SCOPE_B],
      question: "what does the contact record say about this customer",
    })
    expect(stub.seen()?.coordination?.delegatedScope).toEqual([SCOPE_B])
    expect(stub.seen()?.coordination?.delegatedScope).not.toContain(SCOPE_C)
  }, 30_000)

  it("a human caller that states no ceiling delegates nothing, as the in app route does", async () => {
    const stub = stubTurn()
    await dispatch({ question: "which carrier is this order going out with today" })
    expect(stub.seen()?.coordination).toBeUndefined()
  }, 30_000)

  // Review finding 2: the person's input budget asks "should I continue?". An
  // asked agent's turn answers its CALLER, so it must not carry that budget.
  it("an agents_ask callee's turn is marked agent-dispatched, so it carries no input budget", async () => {
    const stub = stubTurn()
    await dispatch({
      callerEffectiveScope: [SCOPE_A, SCOPE_B],
      question: "how many kpi runs does the monthly report need",
      asked: true,
    })
    expect(stub.seen()?.agentDispatched).toBe(true)
  }, 30_000)

  it("a person's own mention is not agent-dispatched: their turn keeps the budget", async () => {
    const stub = stubTurn()
    await dispatch({ question: "which hub had the most signups last month" })
    expect(stub.seen()?.agentDispatched).toBeUndefined()
  }, 30_000)
})

// The DM that turned into a group thread. An agent asking a colleague through
// `agents_ask` inside a user's 1:1 with their own agent seated that colleague
// PERMANENTLY and told the room about it: the DM was retitled, its private
// history became a group thread, and `createOrGetAgentDm` (which wants exactly
// one agent seat) stopped matching it, so the next "Message" click opened a
// fresh empty DM. The colleague answers as a GUEST instead.
describe("dispatchAgentMention: an agent asking a colleague", () => {
  let lastAnsweringParams: { agentDispatched?: boolean } | null = null
  /** A turn that WRITES the callee's answer, as a real turn would. */
  function stubAnsweringTurn(threadId: string, parentId: string, content: string) {
    AgentServiceTestAccess.setAgentRun(async (params: any) => {
      lastAnsweringParams = params
      return {
        userMessageId: params.userMessageId,
        fullStream: (async function* () {
          yield {
            type: "finish-step",
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
        finalize: async () => {
          const [row] = await sql<{ id: string }[]>`
          INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, author_agent_id, content,
             required_scopes, parent_message_id)
          VALUES (${threadId}, ${ORG}, ${USER}, 'agent', ${CALLEE}, ${content},
                  '{}'::text[], ${parentId})
          RETURNING id`
          return {
            messageId: row.id,
            creditCost: 0,
            finishReason: "stop",
            withheldCapabilities: [],
          }
        },
        actingAgentId: params.actingAgentId ?? null,
        stepCtx: { stepBundleId: null },
        discoveredTools: new Set<string>(),
        turnAccumulatedScopes: () => [],
      }
    })
  }

  /** A thread with the seats the case under test needs. */
  async function seedThread(opts: {
    type: "agent_chat" | "thread"
    humans: string[]
    agentSeat?: string
  }): Promise<string> {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, ${`guest-seat-${crypto.randomUUID().slice(0, 8)}`}, ${opts.type}, ${USER})
      RETURNING id`
    for (const human of opts.humans) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${t.id}, ${human}, ${ORG})`
    }
    if (opts.agentSeat) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
        VALUES (${t.id}, ${opts.agentSeat}, ${ORG}, 'agent')`
    }
    return t.id
  }

  async function seedIn(
    threadId: string,
    opts: { content: string; parentId?: string | null; agentId?: string | null },
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
         parent_message_id, mentions)
      VALUES (${threadId}, ${ORG}, ${USER}, ${opts.agentId ? "agent" : "user"},
              ${opts.agentId ?? null}, ${opts.content}, '{}'::text[], ${opts.parentId ?? null},
              ${JSON.stringify([{ type: "agent", id: CALLEE }])}::jsonb)
      RETURNING id`
    return row.id
  }

  async function agentSeats(threadId: string): Promise<string[]> {
    const rows = await sql<{ agent_id: string }[]>`
      SELECT agent_id FROM kernel.thread_participants
      WHERE thread_id = ${threadId} AND org_id = ${ORG} AND participant_type = 'agent'`
    return rows.map((r) => r.agent_id)
  }

  async function autoAddLines(threadId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${threadId} AND org_id = ${ORG}
        AND metadata->>'type' = 'participant-added'`
    return row.n
  }

  async function askIn(threadId: string, question: string) {
    const human = await seedIn(threadId, { content: `a person asks: ${question}` })
    const questionMsg = await seedIn(threadId, {
      content: `@[Callee](agent:${CALLEE}) ${question}`,
      parentId: human,
      agentId: CALLER,
    })
    stubAnsweringTurn(threadId, questionMsg, `the answer to: ${question}`)
    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId,
      calleeAgentId: CALLEE,
      callerAgentId: CALLER,
      parentMessageId: questionMsg,
      triggerMessageId: questionMsg,
      questionText: question,
      actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      adderName: "Caller",
      callerEffectiveScope: ["*"],
      askedQuestion: { askedBy: "Caller", question },
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)
    return { questionMsg }
  }

  it("seats the colleague as a guest in a 1:1 agent DM and unseats it when the turn settles", async () => {
    const dm = await seedThread({ type: "agent_chat", humans: [USER], agentSeat: CALLER })
    const question = "what did the carrier say about order 2001"
    await askIn(dm, question)

    // One agent seat, and it is the DM's own agent.
    expect(await agentSeats(dm)).toEqual([CALLER])
    // The room was never told about a membership that did not outlive the turn.
    expect(await autoAddLines(dm)).toBe(0)
    // The answer stays, and stays readable through the thread read path.
    const page = await withRlsContext(ctx, (tx) =>
      listMessages(tx, { orgId: ORG, userId: USER, threadId: dm, limit: 50 }),
    )
    expect(
      page?.messages.some(
        (m: { content: string | null; authorAgentId: string | null }) =>
          m.authorAgentId === CALLEE && m.content === `the answer to: ${question}`,
      ),
    ).toBe(true)
    // And the DM is still THE DM: the same thread the Message button opens.
    const dmAgain = await withRlsContext(ctx, (tx) =>
      createOrGetAgentDm(tx, { orgId: ORG, userId: USER, agentId: CALLER }),
    )
    expect(dmAgain?.id).toBe(dm)
    expect(dmAgain?.created).toBe(false)
  }, 30_000)

  it("gives the guest seat back when the turn cannot even be delegated", async () => {
    // `agents_ask` ALWAYS states a ceiling, so the delegation refusal is the
    // everyday failure, not an exotic one: it throws between the seat and the
    // turn, past the unseat chained onto a turn that never starts.
    const dm = await seedThread({ type: "agent_chat", humans: [USER], agentSeat: CALLER })
    const question = "what is the status of the replacement unit"
    const human = await seedIn(dm, { content: `a person asks: ${question}` })
    const questionMsg = await seedIn(dm, {
      content: `@[Callee](agent:${CALLEE}) ${question}`,
      parentId: human,
      agentId: CALLER,
    })
    // The callee stops being a live agent AFTER it has been seated: the guard
    // reads, the seat is taken, and the delegation then refuses. The seat step
    // is the second RLS transaction this dispatch opens (the verdict is the
    // first), so archiving as it commits puts the failure exactly there.
    let rlsCalls = 0
    const runRls = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
      const result = await withRlsContext(ctx, fn)
      rlsCalls += 1
      if (rlsCalls === 2) {
        await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${CALLEE}`
      }
      return result
    }
    try {
      await expect(
        dispatchAgentMention(runRls, {
          orgId: ORG,
          threadId: dm,
          calleeAgentId: CALLEE,
          callerAgentId: CALLER,
          parentMessageId: questionMsg,
          triggerMessageId: questionMsg,
          questionText: question,
          actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
          adderName: "Caller",
          callerEffectiveScope: ["*"],
          askedQuestion: { askedBy: "Caller", question },
        }),
      ).rejects.toThrow(/no longer available/)
    } finally {
      await sql`UPDATE kernel.agents SET archived_at = NULL WHERE id = ${CALLEE}`
    }
    expect(await agentSeats(dm)).toEqual([CALLER])
  }, 30_000)

  it("a person's mention during a guest turn promotes the seat and the guest unseat leaves it alone", async () => {
    // `addAgentParticipant` is ON CONFLICT DO NOTHING, so a human mention of the
    // same agent mid turn used to find the guest row, seat nobody, post no line,
    // and then watch the guest unseat delete the seat the person asked for.
    const dm = await seedThread({ type: "agent_chat", humans: [USER], agentSeat: CALLER })
    const question = "did the replacement ship yet"
    const human = await seedIn(dm, { content: `a person asks: ${question}` })
    const questionMsg = await seedIn(dm, {
      content: `@[Callee](agent:${CALLEE}) ${question}`,
      parentId: human,
      agentId: CALLER,
    })
    // The person mentions the same agent WHILE the guest turn is running.
    let midTurn: (() => Promise<void>) | null = null
    AgentServiceTestAccess.setAgentRun(async (params: any) => ({
      userMessageId: params.userMessageId,
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
      finalize: async () => {
        await midTurn?.()
        return { messageId: null, creditCost: 0, finishReason: "stop", withheldCapabilities: [] }
      },
      actingAgentId: params.actingAgentId ?? null,
      stepCtx: { stepBundleId: null },
      discoveredTools: new Set<string>(),
      turnAccumulatedScopes: () => [],
    }))
    midTurn = async () => {
      await withRlsContext(ctx, async (tx) => {
        const seated = await addAgentParticipant(tx, {
          orgId: ORG,
          threadId: dm,
          agentId: CALLEE,
          actorUserId: USER,
        })
        expect(seated).not.toBeNull()
        if (seated) {
          await postAgentAutoAddSystemMessage(tx, {
            orgId: ORG,
            threadId: dm,
            actorUserId: USER,
            adderName: "Guard User",
            agentName: seated.agentName,
          })
        }
      })
    }

    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId: dm,
      calleeAgentId: CALLEE,
      callerAgentId: CALLER,
      parentMessageId: questionMsg,
      triggerMessageId: questionMsg,
      questionText: question,
      actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      adderName: "Caller",
      callerEffectiveScope: ["*"],
      askedQuestion: { askedBy: "Caller", question },
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)

    expect((await agentSeats(dm)).sort()).toEqual([CALLER, CALLEE].sort())
    expect(await autoAddLines(dm)).toBe(1)
  }, 30_000)

  it("an agent authored mention in a 1:1 DM is a guest seat too, not only an ask", async () => {
    // The residual half of the same bug: an agent that @mentions a colleague in
    // its own reply reaches the seat through posted-message-dispatch, with no
    // `askedQuestion` at all.
    const dm = await seedThread({ type: "agent_chat", humans: [USER], agentSeat: CALLER })
    const question = "can you confirm the customs paperwork"
    const trigger = await seedIn(dm, {
      content: `@[Callee](agent:${CALLEE}) ${question}`,
      agentId: CALLER,
    })
    stubAnsweringTurn(dm, trigger, "the answer to an agent authored mention")
    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId: dm,
      calleeAgentId: CALLEE,
      callerAgentId: CALLER,
      parentMessageId: null,
      triggerMessageId: trigger,
      questionText: question,
      actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      adderName: "Caller",
      callerEffectiveScope: ["*"],
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)

    expect(await agentSeats(dm)).toEqual([CALLER])
    expect(await autoAddLines(dm)).toBe(0)
    // It answers the agent that mentioned it: no person's input budget.
    expect(lastAnsweringParams?.agentDispatched).toBe(true)
  }, 30_000)

  it("a room with two people: an agent's ask seats the colleague as a guest and adds nobody", async () => {
    const other = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${other}, ${ORG}, ${`guest-seat-${other.slice(0, 8)}@test.com`}, 'Other', 'active', 'hash')`
    const room = await seedThread({
      type: "agent_chat",
      humans: [USER, other],
      agentSeat: CALLER,
    })
    await askIn(room, "who signed for the pallet on monday")

    // An agent never adds a participant on its own: no seat outlives the
    // answer and the room reads no "added" line.
    expect(await agentSeats(room)).toEqual([CALLER])
    expect(await autoAddLines(room)).toBe(0)
  }, 30_000)

  it("a channel: an agent's ask seats the colleague as a guest and adds nobody", async () => {
    const room = await seedThread({ type: "thread", humans: [USER], agentSeat: CALLER })
    await askIn(room, "is invoice 4411 paid")

    expect(await agentSeats(room)).toEqual([CALLER])
    expect(await autoAddLines(room)).toBe(0)
  }, 30_000)

  it("a person's own mention in a DM still seats the agent for good", async () => {
    const dm = await seedThread({ type: "agent_chat", humans: [USER], agentSeat: CALLER })
    const question = "can you check the return window on order 2002"
    const trigger = await seedIn(dm, { content: `@[Callee](agent:${CALLEE}) ${question}` })
    stubAnsweringTurn(dm, trigger, "the answer a person asked for")
    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId: dm,
      calleeAgentId: CALLEE,
      callerAgentId: null,
      parentMessageId: null,
      triggerMessageId: trigger,
      questionText: question,
      actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      adderName: "Guard User",
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)

    expect((await agentSeats(dm)).sort()).toEqual([CALLER, CALLEE].sort())
    expect(await autoAddLines(dm)).toBe(1)

    // D23a: the seat records that a mention made it, so the people's DM stays
    // their DM; adding the agent ON PURPOSE afterwards re-records it, keeping
    // its join point.
    const origin = async () =>
      (
        await sql<{ seat_origin: string | null; created_at: string | Date }[]>`
          SELECT seat_origin, created_at FROM kernel.thread_participants
          WHERE thread_id = ${dm} AND agent_id = ${CALLEE}`
      )[0]
    const mentioned = await origin()
    expect(mentioned?.seat_origin).toBe("mention")
    await withRlsContext(ctx, (tx) =>
      addAgentParticipant(tx, { orgId: ORG, threadId: dm, agentId: CALLEE, actorUserId: USER }),
    )
    const added = await origin()
    expect(added?.seat_origin).toBeNull()
    expect(new Date(added?.created_at ?? 0).getTime()).toBe(
      new Date(mentioned?.created_at ?? 1).getTime(),
    )
  }, 30_000)
})

// THR-10: an agent mentioned inside a reply the channel does not show. Every
// line the dispatch writes for that turn belongs to the reply thread (A7): the
// "added" seat line, and the Failed frame of a turn that could not start. Both
// used to land in the channel.
describe("dispatchAgentMention from a hidden reply", () => {
  /** A room of its own, so a seat from an earlier case does not suppress the line. */
  async function seedRoom(): Promise<string> {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, ${`hidden-reply-${crypto.randomUUID().slice(0, 8)}`}, 'thread', ${USER})
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${t.id}, ${USER}, ${ORG})`
    return t.id
  }

  async function seedRootAndReply(room: string, question: string) {
    const [root] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${room}, ${ORG}, ${USER}, 'user', 'the root', '{}'::text[]) RETURNING id`
    const [reply] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id, mentions)
      VALUES (${room}, ${ORG}, ${USER}, 'user', ${`@[Callee](agent:${CALLEE}) ${question}`},
              '{}'::text[], ${root.id}, ${JSON.stringify([{ type: "agent", id: CALLEE }])}::jsonb)
      RETURNING id`
    return { root: root.id, reply: reply.id }
  }

  async function dispatchFrom(room: string, ids: { root: string; reply: string }, q: string) {
    const outcome = await dispatchAgentMention((fn) => withRlsContext(ctx, fn), {
      orgId: ORG,
      threadId: room,
      calleeAgentId: CALLEE,
      callerAgentId: null,
      parentMessageId: null,
      triggerMessageId: ids.reply,
      replyRootId: ids.root,
      questionText: q,
      actor: { userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      adderName: "Guard User",
    })
    expect(outcome.allowed).toBe(true)
    if (outcome.allowed) await outcome.turn?.catch(() => null)
  }

  it("posts the seat line in the reply thread, not in the channel", async () => {
    AgentServiceTestAccess.setAgentRun(async () => {
      throw new Error("No API key available for provider google")
    })
    const room = await seedRoom()
    const ids = await seedRootAndReply(room, "which pallet left on monday")
    await dispatchFrom(room, ids, "which pallet left on monday")
    const lines = await sql<{ reply_root_id: string | null }[]>`
      SELECT reply_root_id FROM kernel.messages
      WHERE thread_id = ${room} AND metadata->>'type' = 'participant-added'`
    expect(lines.length).toBe(1)
    expect(lines[0].reply_root_id).toBe(ids.root)
  }, 30_000)

  it("a turn that cannot start reports its failure in the reply thread", async () => {
    const frames: Array<Record<string, unknown>> = []
    onEvent(
      async (event) => {
        if (event.entity === "agent_stream" && event.action === "error") {
          frames.push((event.data ?? {}) as Record<string, unknown>)
        }
      },
      { delivery: "per-replica" },
    )
    AgentServiceTestAccess.setAgentRun(async () => {
      throw new Error("No API key available for provider google")
    })
    const room = await seedRoom()
    const ids = await seedRootAndReply(room, "where is the carrier invoice")
    await dispatchFrom(room, ids, "where is the carrier invoice")
    await flushEventHandlers()
    const mine = frames.filter((f) => f.threadId === room)
    expect(mine.length).toBeGreaterThan(0)
    for (const f of mine) expect(f.replyRootId).toBe(ids.root)
  }, 30_000)

  it("the wrapper carries the reply root onto the failure frame", async () => {
    const frames: Array<Record<string, unknown>> = []
    onEvent(
      async (event) => {
        if (event.entity === "agent_stream" && event.action === "error") {
          frames.push((event.data ?? {}) as Record<string, unknown>)
        }
      },
      { delivery: "per-replica" },
    )
    const room = await seedRoom()
    const ids = await seedRootAndReply(room, "unit")
    await expect(
      withTurnFailureReported(Promise.reject(new Error("no key")) as Promise<never>, {
        orgId: ORG,
        threadId: room,
        actorUserId: USER,
        agentId: CALLEE,
        replyRootId: ids.root,
      }),
    ).rejects.toThrow("no key")
    await flushEventHandlers()
    const mine = frames.filter((f) => f.threadId === room)
    expect(mine.length).toBe(1)
    expect(mine[0].replyRootId).toBe(ids.root)
  })

  // QA THR-10: a failed turn by @Base was headed "Personal agent", because
  // the failure frame named no agent and the client fell back. Every other
  // agent_stream frame names its agent; the failure frame does too, in the
  // reply thread and in the channel.
  it("the failure frame names the agent whose turn failed, in a reply and in the channel", async () => {
    const frames: Array<Record<string, unknown>> = []
    onEvent(
      async (event) => {
        if (event.entity === "agent_stream" && event.action === "error") {
          frames.push((event.data ?? {}) as Record<string, unknown>)
        }
      },
      { delivery: "per-replica" },
    )
    const room = await seedRoom()
    const ids = await seedRootAndReply(room, "unit-agent")
    for (const replyRootId of [ids.root, null]) {
      await expect(
        withTurnFailureReported(Promise.reject(new Error("no key")) as Promise<never>, {
          orgId: ORG,
          threadId: room,
          actorUserId: USER,
          agentId: CALLEE,
          replyRootId,
        }),
      ).rejects.toThrow("no key")
    }
    await flushEventHandlers()
    const mine = frames.filter((f) => f.threadId === room)
    expect(mine.length).toBe(2)
    for (const f of mine) expect(f.agentId).toBe(CALLEE)
    expect(mine.map((f) => f.replyRootId ?? null)).toEqual([ids.root, null])
  })
})
