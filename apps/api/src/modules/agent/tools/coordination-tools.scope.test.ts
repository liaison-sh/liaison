// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T10: what an ask carries across the hand off.
//
// A4: the callee's turn runs at its own ceiling intersected with the grants of
// the PERSON the request originates from (what that person would get
// addressing the callee directly), then floored by the room; never at the
// callee's ceiling alone and never above the person. A routine tick, which has
// no person, keeps the calling turn's effective scope as the bound. D2: what
// the intersection removed comes back to the caller as CATEGORIES, read off
// the turn's own result, never recomputed here (A14).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { capabilityCategories } from "~/modules/agent/context/context"
import {
  AgentServiceTestAccess,
  type TurnCoordination,
} from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { handleAgentsAsk } from "~/modules/agent/tools/coordination-tools"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""
/** A channel with a second human who holds only B: the room floor case. */
let ROOM = ""
const OTHER = crypto.randomUUID()
const ROLE_ALL = crypto.randomUUID()
const ROLE_B = crypto.randomUUID()

// A and B are the caller's; B and C are the callee's ceiling. The intersection
// is exactly B: A is the caller's alone, C the callee's alone.
const A = "kernel:threads:read"
const B = "kernel:contacts:read"
const C = "kernel:files:read"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

let captured: { coordination?: TurnCoordination } | null = null
let stubWithheld: string[] = []
/** The accumulator the last `ask()` ran with: the CALLER's turn scope set. */
let callerAccumulator: ReturnType<typeof createTurnScopeAccumulator> | null = null

function stubRun() {
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
        withheldCapabilities: stubWithheld,
      }),
      actingAgentId: params.actingAgentId ?? null,
      stepCtx: { stepBundleId: null },
      discoveredTools: new Set<string>(),
      turnAccumulatedScopes: () => [],
    }
  })
}

/**
 * A callee turn that PERSISTS an answer of its own, tagged with `scopes`, the
 * way a real callee turn tags what its tools touched. The stub is what makes
 * the scope deterministic: the point of the test is the tag travelling back to
 * the caller, not how the callee earned it.
 */
function stubRunAnsweringWith(scopes: string[]) {
  AgentServiceTestAccess.setAgentRun(async (params: any) => {
    await sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content,
         required_scopes, parent_message_id)
      VALUES (${THREAD}, ${ORG}, ${USER}, 'agent', ${CALLEE}, 'the invoice total is 1240 euros',
              ${scopes}::text[], ${params.userMessageId})`
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
}

function realStream() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "the delegated answer" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

async function seed(content: string, thread: string = THREAD): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${thread}, ${ORG}, ${USER}, 'user', ${content}, '{}'::text[]) RETURNING id`
  return row.id
}

async function ask(
  question: string,
  opts: {
    turnMessageId: string
    effectiveScope?: string[]
    taint?: string[]
    /** The requester's grants the tool ctx carries. Default: everything. */
    requesterScopes?: string[]
    routineId?: string
    thread?: string
  },
) {
  const runId = crypto.randomUUID()
  const accumulator = createTurnScopeAccumulator()
  callerAccumulator = accumulator
  if (opts.taint?.length) accumulator.recordInjected(opts.taint)
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: CALLER,
    agentCeiling: [A, B],
    effectiveScope: opts.effectiveScope ?? [A, B],
    turnScopeAccumulator: accumulator,
    turnMessageId: opts.turnMessageId,
    ...(opts.routineId ? { routineId: opts.routineId } : {}),
  }
  return withRlsContext(actor, (tx) =>
    runContextStore.run(frame, () =>
      handleAgentsAsk(
        { agentHandle: `@callee-${tag}`, question },
        {
          userId: USER,
          orgId: ORG,
          db: tx,
          agentExecutionThreadId: opts.thread ?? THREAD,
          scopes: opts.requesterScopes ?? ["*"],
          actingAgentId: CALLER,
        },
      ),
    ),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Scope Org', ${`p3b-t10-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t10-${tag}@t.com`}, 'Scope User')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLER}, ${ORG}, 'role', ${`@caller-${tag}`}, 'Caller', ${JSON.stringify([A, B])}::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLEE}, ${ORG}, 'role', ${`@callee-${tag}`}, 'Callee', ${JSON.stringify([B, C])}::jsonb)`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`p3b-t10-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLER}, ${ORG}, 'agent')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER}, ${ORG}, ${`p3b-t10-o-${tag}@t.com`}, 'Other')`
  await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ALL}, ${ORG}, ${`all-${tag}`}, 'all')`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ALL}, '*')`
  await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_B}, ${ORG}, ${`b-${tag}`}, 'b')`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_B}, ${B})`
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER}, ${ROLE_ALL}, ${ORG})`
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${OTHER}, ${ROLE_B}, ${ORG})`
  const [room] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`p3b-t10-room-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  ROOM = room.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${ROOM}, ${OTHER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${ROOM}, ${CALLER}, ${ORG}, 'agent')`
})

afterAll(async () => {
  AgentServiceTestAccess.setAgentRun()
  AgentServiceTestAccess.setStreamText()
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ROLE_ALL}, ${ROLE_B})`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("what an ask delegates", () => {
  it("the delegated turn runs at the callee ceiling intersected with the requester's grants", async () => {
    stubRun()
    stubWithheld = []
    const trigger = await seed("what does the contact record say")
    await ask("what does the contact record say", { turnMessageId: trigger })
    expect([...(captured?.coordination?.delegatedScope ?? [])].sort()).toEqual([B, C].sort())
  })

  it("an entry agent whose own ceiling lacks the scope still gets the callee's reach", async () => {
    // Live QA: @base (no KPI scope) asked @data, @data ran at @base's reach,
    // and nobody could answer a data question put to the entry point.
    stubRun()
    const trigger = await seed("a question the caller cannot answer itself")
    await ask("a question the caller cannot answer itself", {
      turnMessageId: trigger,
      effectiveScope: [A],
    })
    expect(captured?.coordination?.delegatedScope).toContain(C)
    expect(captured?.coordination?.delegatedScope).toContain(B)
  })

  it("a delegated turn never exceeds the requester's own grants", async () => {
    stubRun()
    const trigger = await seed("a question the requester is not cleared for")
    await ask("a question the requester is not cleared for", {
      turnMessageId: trigger,
      requesterScopes: [A, B],
    })
    expect(captured?.coordination?.delegatedScope).toEqual([B])
  })

  it("a routine tick, which has no person behind it, keeps the calling turn's scope as the bound", async () => {
    stubRun()
    const trigger = await seed("a routine asking a colleague")
    await ask("a routine asking a colleague", {
      turnMessageId: trigger,
      routineId: crypto.randomUUID(),
    })
    expect(captured?.coordination?.delegatedScope).toEqual([B])
  })

  it("the asked agent's turn acts for the asking person, not for anyone else", async () => {
    // Tool calls of the delegated turn (a database read among them) run as
    // `actor.userId`: per-person checks such as the database connector's report
    // access judge the person who asked, so an asked agent never reaches what
    // that person may not.
    stubRun()
    const trigger = await seed("what was revenue last month")
    await ask("what was revenue last month", { turnMessageId: trigger })
    const run = captured as unknown as { actor?: { userId?: string; orgId?: string } } | null
    expect(run?.actor?.userId).toBe(USER)
    expect(run?.actor?.orgId).toBe(ORG)
  })

  it("a delegated turn never exceeds the callee ceiling", async () => {
    stubRun()
    const trigger = await seed("a question about something else entirely")
    await ask("a question about something else entirely", { turnMessageId: trigger })
    expect(captured?.coordination?.delegatedScope).not.toContain(A)
  })

  it("an ask outside the caller scope returns withheld capability categories and no data", async () => {
    stubRun()
    stubWithheld = ["a capability"]
    const trigger = await seed("a question whose answer needs a closed capability")
    const res = await ask("a question whose answer needs a closed capability", {
      turnMessageId: trigger,
      // The caller holds nothing the callee's ceiling covers.
      effectiveScope: [A],
    })
    expect(res.withheldCapabilities?.length).toBeGreaterThan(0)
    for (const label of res.withheldCapabilities ?? []) {
      expect(label).not.toContain(":")
      expect(label).not.toContain("agents_ask")
      expect(label).not.toContain("contacts")
    }
  })

  it("a callee that ran without a capability and gave no answer says so explicitly, not null", async () => {
    stubRun()
    stubWithheld = ["KPI figures"]
    const trigger = await seed("how many members joined in August")
    const res = await ask("how many members joined in August", { turnMessageId: trigger })
    expect(res.answer).toBeNull()
    expect(res.reason).toBe("insufficient_scope")
    expect(res.missingAccess).toContain("KPI figures")
    expect(res.missingAccess).toContain(`@callee-${tag}`)
    // Private to the requester: never relayed by name into a shared room.
    expect(res.missingAccess).toContain("only to the person who asked")
    expect(res.note).not.toContain("pending")
  })

  it("the withheld categories come from the turn result, not a second computation", async () => {
    stubRun()
    stubWithheld = ["finance data"]
    const first = await seed("one question")
    const res1 = await ask("one question", { turnMessageId: first })
    expect(res1.withheldCapabilities).toEqual(capabilityCategories(["finance data"]))
    stubWithheld = ["shipping data"]
    const second = await seed("another question")
    const res2 = await ask("another question", { turnMessageId: second })
    expect(res2.withheldCapabilities).toEqual(capabilityCategories(["shipping data"]))
    expect(res2.withheldCapabilities).not.toEqual(res1.withheldCapabilities)
  })

  it("the answer scopes join the caller turn, so the caller reply is not under tagged", async () => {
    // A2: a turn's requiredScopes are its own tools' scopes PLUS the scopes of
    // everything injected into it, and another agent's answer quoted into the
    // reply is such an injection. Without this the caller's reply carried only
    // `kernel:threads:write` while its body held the callee's scoped data.
    stubRunAnsweringWith([B])
    const trigger = await seed("what is the invoice total for order 91")
    const res = await ask("what is the invoice total for order 91", { turnMessageId: trigger })
    expect(res.answer).toContain("1240")
    expect(callerAccumulator?.snapshot()).toContain(B)
    // An agent asks in its own room: the thread id is not handed back, since
    // an agent once wrote it into a mention as the colleague's id.
    expect(res.threadId).toBeUndefined()
  })

  it("the delegated turn is still floored by the room it runs in", async () => {
    // A person mentioning the callee in this room would get the callee's
    // ceiling floored by every human member; a delegation gets no more. The
    // other member holds B only, so C is withheld from the callee's turn.
    AgentServiceTestAccess.setAgentRun()
    AgentServiceTestAccess.setStreamText(realStream as never)
    // The stream is faked; the key only has to exist for the credit check.
    const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const trigger = await seed("what do the files say", ROOM)
      const res = await ask("what do the files say", { turnMessageId: trigger, thread: ROOM })
      expect(res.answer).toContain("the delegated answer")
      expect(res.withheldCapabilities ?? []).not.toHaveLength(0)
      expect(res.reason).toBe("insufficient_scope")
    } finally {
      if (origKey === undefined) delete process.env.LIAISON_ANTHROPIC_API_KEY
      else process.env.LIAISON_ANTHROPIC_API_KEY = origKey
    }
  }, 30_000)

  it("the caller taint is visible to the callee turn", async () => {
    // The REAL turn this time: the taint has to reach the row the callee wrote.
    AgentServiceTestAccess.setAgentRun()
    AgentServiceTestAccess.setStreamText(realStream as never)
    const trigger = await seed("what did the earlier read say")
    await ask("what did the earlier read say", { turnMessageId: trigger, taint: [B] })
    const [reply] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${THREAD} AND author_agent_id = ${CALLEE}
      ORDER BY created_at DESC LIMIT 1`
    expect(reply.required_scopes).toContain(B)
  })
})
