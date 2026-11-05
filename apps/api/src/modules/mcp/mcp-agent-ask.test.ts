// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What an ask made OVER MCP carries (P3b-FX1 / D2).
//
// An agent bound MCP connection is an agent taking a turn, so the run frame the
// gateway builds has to say the two things a coordination tool reads off it:
// how far the CALLER reaches (A4, or the callee runs at its own ceiling) and
// which turn the question hangs under (or every ask is a fresh root the per
// root cap never reaches).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  AgentServiceTestAccess,
  type TurnCoordination,
} from "~/modules/agent/runtime/agent-service"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { userContextFor } from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import { isMessageVisible } from "~/services/security/visibility"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const CONNECTION = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

// The connection's token reaches A and B; the callee's ceiling covers B and C.
// The intersection is B alone: C is the callee's own, and the caller's token
// does not hold it.
const A = "kernel:threads:read"
const B = "kernel:contacts:read"
const C = "kernel:files:read"
/** What calling `agents_ask` itself costs; held by the token and the caller. */
const POST = "kernel:threads:write"

let captured: { coordination?: TurnCoordination } | null = null

/** A stubbed callee turn: it records what it was handed and answers nothing. */
function stubTurn(withheld: string[] = []) {
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
        withheldCapabilities: withheld,
      }),
      actingAgentId: params.actingAgentId ?? null,
      stepCtx: { stepBundleId: null },
      discoveredTools: new Set<string>(),
      turnAccumulatedScopes: () => [],
    }
  })
}

function ctxFor(scopes: string[]): ToolCallCtx {
  return {
    orgId: ORG,
    actor: userContextFor(ORG, USER, scopes),
    connectionId: CONNECTION,
    ownerUserId: USER,
    agentId: CALLER,
    connectionThreadId: THREAD,
    discovered: new Set(),
  }
}

/** The same connection with NO agent binding: a person at a Claude Code prompt. */
function humanCtxFor(scopes: string[]): ToolCallCtx {
  return {
    orgId: ORG,
    actor: userContextFor(ORG, USER, scopes),
    connectionId: CONNECTION,
    ownerUserId: USER,
    connectionThreadId: THREAD,
    discovered: new Set(),
  }
}

async function seedMessage(opts: {
  content: string
  parentId?: string | null
  agentId?: string | null
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
       parent_message_id)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${opts.agentId ? "agent" : "user"}, ${opts.agentId ?? null},
            ${opts.content}, '{}'::text[], ${opts.parentId ?? null})
    RETURNING id`
  return row.id
}

async function ask(question: string, scopes: string[] = [A, B, POST]) {
  return handleToolCall(ctxFor(scopes), "kernel__agents_ask", {
    agentHandle: `@mcp-callee-${tag}`,
    question,
  })
}

beforeAll(async () => {
  await acquireTestLock()
  stubTurn()
  AgentServiceTestAccess.setStreamText()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'MCP Ask Org', ${`fx1-d2-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, ${`fx1-d2-${tag}@t.com`}, 'MCP Owner', 'active', 'hash')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLER}, ${ORG}, 'role', ${`@mcp-caller-${tag}`}, 'Caller', ${JSON.stringify([A, B, POST])}::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${CALLEE}, ${ORG}, 'role', ${`@mcp-callee-${tag}`}, 'Callee', ${JSON.stringify([B, C])}::jsonb)`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, title, created_by)
    VALUES (${ORG}, ${`fx1-d2-${tag}`}, 'approval', 'MCP connection', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLER}, ${ORG}, 'agent')`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLEE}, ${ORG}, 'agent')`
  await registerKernelAgentTools(ORG)
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
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("an ask made over MCP", () => {
  it("narrows the callee to the intersection of the connection scope and the callee ceiling", async () => {
    captured = null
    stubTurn(["files"])
    const res = await ask("what does the contact record say about this customer")
    expect(res.isError).toBeFalsy()
    // A4: the delegated turn runs at B alone. C is the callee's own ceiling and
    // the connection's token does not hold it, so it is withheld and reported.
    const seen = captured as { coordination?: TurnCoordination } | null
    expect(seen?.coordination?.delegatedScope).toEqual([B])
    expect(seen?.coordination?.delegatedScope).not.toContain(C)
    const payload = res.structuredContent as { withheldCapabilities?: string[] }
    expect((payload.withheldCapabilities ?? []).length).toBeGreaterThan(0)
  }, 30_000)

  it("consecutive asks on one connection thread accumulate toward the per root cap", async () => {
    stubTurn()
    // The turn the room is on, plus the four agent turns already under it. The
    // next ask posts the fifth and is allowed; the one after that meets the cap
    // of six, and it is the ANCHOR that makes them one exchange: with no turn
    // message on the frame every ask would be the root of its own chain and no
    // cap would ever be reached.
    const anchor = await seedMessage({ content: "the turn this connection is working on" })
    for (let i = 0; i < 4; i++) {
      await seedMessage({
        content: `an earlier agent turn ${i}`,
        parentId: anchor,
        agentId: CALLER,
      })
    }
    const first = await ask("is this ask under the cap for this root")
    expect((first.structuredContent as { asked?: boolean }).asked).toBe(true)
    const second = await ask("is the next ask under this root refused")
    const payload = second.structuredContent as { asked?: boolean; reason?: string }
    expect(payload.asked).toBe(false)
    expect(payload.reason).toBe("root_turn_cap")
  }, 30_000)
})

// A HUMAN using this server from Claude Code. There is no agent binding, so
// there is no turn to ask "here" in: the question belongs in the person's own
// direct message with the agent they are addressing, exactly where the web app
// puts it, authored by THEM.
describe("an ask made by a human connection", () => {
  async function dmWith(agentId: string): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
      SELECT t.id FROM kernel.threads t
      JOIN kernel.thread_participants me ON me.thread_id = t.id AND me.user_id = ${USER}
      JOIN kernel.thread_participants seat ON seat.thread_id = t.id AND seat.agent_id = ${agentId}
      WHERE t.org_id = ${ORG} AND t.type = 'agent_chat'`
    return rows[0]?.id ?? null
  }

  it("offers agents_ask in the catalog of a connection bound to no agent", async () => {
    const names = (
      await listMcpTools({ orgId: ORG, actor: userContextFor(ORG, USER, [A, B, POST]) })
    ).map((t) => t.name)
    expect(names).toContain("kernel__agents_ask")
    expect(names).not.toContain("kernel__agents_invite")
  }, 30_000)

  it("posts the question into the person's own DM with the callee, as their agent, never as the person", async () => {
    captured = null
    stubTurn()
    const res = await handleToolCall(humanCtxFor([A, B, POST]), "kernel__agents_ask", {
      agentHandle: `@mcp-callee-${tag}`,
      question: "can you check the shipping status of order 1042 for me",
    })
    expect(res.isError).toBeFalsy()
    const payload = res.structuredContent as { asked?: boolean; threadId?: string }
    expect(payload.asked).toBe(true)
    const dm = await dmWith(CALLEE)
    expect(dm).toBeTruthy()
    expect(payload.threadId).toBe(dm as string)
    // An external client is a model writing for the person: the row is their
    // agent's ("{User}'s agent"), marked as an external request, never theirs.
    const rows = await sql<
      {
        author_type: string
        author_agent_id: string | null
        metadata: { agentAuthorLabel?: string; externalClientPost?: boolean } | null
      }[]
    >`
      SELECT author_type, author_agent_id, metadata FROM kernel.messages
      WHERE thread_id = ${dm} AND content LIKE '%order 1042%'`
    expect(rows.length).toBe(1)
    expect(rows[0].author_type).toBe("agent")
    expect(rows[0].author_agent_id).not.toBeNull()
    expect(rows[0].metadata?.agentAuthorLabel).toMatch(/'s agent$/)
    expect(rows[0].metadata?.externalClientPost).toBe(true)
  }, 30_000)

  // THE CALLEE HAS TO BE ABLE TO READ THE QUESTION IT WAS ASKED. The question
  // row is stamped on the way in, and the callee's turn renders only the rows
  // its own effective scope covers. Stamped with the CONNECTION's scope list,
  // the row is wider than the delegated scope by construction (the delegation
  // is that list intersected with the callee's ceiling), so the callee's
  // context dropped the question and the turn answered whatever sat above it.
  it("stamps the person's question so the callee's delegated turn can read it", async () => {
    captured = null
    stubTurn()
    const question = "name the three things you do for this organization"
    const res = await handleToolCall(humanCtxFor([A, B, POST]), "kernel__agents_ask", {
      agentHandle: `@mcp-callee-${tag}`,
      question,
    })
    expect(res.isError).toBeFalsy()
    const dm = await dmWith(CALLEE)
    const rows = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${dm} AND content LIKE ${`%${question}%`}`
    expect(rows.length).toBe(1)
    const seen = captured as { coordination?: TurnCoordination } | null
    const delegated = seen?.coordination?.delegatedScope ?? []
    expect(
      isMessageVisible(
        { requiredScopes: rows[0].required_scopes ?? [], disclosureList: null },
        { userId: USER, grants: delegated },
      ),
    ).toBe(true)
    // And nothing the person merely holds is carried into the callee's turn as
    // read taint: the answer would be stamped with it and hidden from the room.
    expect(seen?.coordination?.callerTaintScopes ?? []).toEqual([])
  }, 30_000)

  // THE PRODUCTION DM. A person asked their own agent from an external client:
  // the question landed in the DM under an "@Agent" chip nobody else could be
  // addressed by, and the callee was told "A colleague" asked it, so it said
  // the question came "from another agent" and tried to ask that agent back.
  it("posts the person's question in the DM without a mention chip of the only agent there", async () => {
    captured = null
    stubTurn()
    const question = "what are my current notification settings"
    const res = await handleToolCall(humanCtxFor([A, B, POST]), "kernel__agents_ask", {
      agentHandle: `@mcp-callee-${tag}`,
      question,
    })
    expect(res.isError).toBeFalsy()
    const dm = await dmWith(CALLEE)
    const rows = await sql<{ content: string; mentions: unknown }[]>`
      SELECT content, mentions FROM kernel.messages
      WHERE thread_id = ${dm} AND content LIKE ${`%${question}%`}`
    expect(rows.length).toBe(1)
    expect(rows[0].content).toBe(question)
    expect(rows[0].content).not.toContain("(agent:")
  }, 30_000)

  it("tells the callee the person asked, not a colleague", async () => {
    captured = null
    stubTurn()
    const res = await handleToolCall(humanCtxFor([A, B, POST]), "kernel__agents_ask", {
      agentHandle: `@mcp-callee-${tag}`,
      question: "which hubs did I look at last week",
    })
    expect(res.isError).toBeFalsy()
    const seen = captured as { coordination?: TurnCoordination } | null
    const askedBy = seen?.coordination?.askedQuestion?.askedBy ?? ""
    expect(askedBy).toContain("MCP Owner")
    expect(askedBy).toContain("external app")
    expect(askedBy).not.toBe("A colleague")
    expect(seen?.coordination?.callerAgentId).toBeNull()
  }, 30_000)

  it("runs the callee at the connection's effective scope, never at its own ceiling", async () => {
    captured = null
    stubTurn(["files"])
    const res = await handleToolCall(humanCtxFor([A, B, POST]), "kernel__agents_ask", {
      agentHandle: `@mcp-callee-${tag}`,
      question: "which carrier did this parcel leave with on friday",
    })
    expect(res.isError).toBeFalsy()
    const seen = captured as { coordination?: TurnCoordination } | null
    expect(seen?.coordination?.delegatedScope).toEqual([B])
    expect(seen?.coordination?.delegatedScope).not.toContain(C)
  }, 30_000)
})
