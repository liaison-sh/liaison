// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX20 item 2 -- the approved RE-ENTRY names the agent whose turn proposed the
// gated call, end to end. Spec A11.
//
// A gated call does not write when the agent makes it: it parks as an
// approval_request and writes later, when a human approves. That execution runs
// in another request, minutes or days later, with the proposing turn's
// AsyncLocalStorage frame long gone, and `run-approved-handler` built its
// re-entry frame deliberately without an agent. So every write the re-entry
// made (the messages it posts, the events it queues, and the audit rows behind
// them) was unattributed, and "what did the logistics agent do" missed exactly
// the actions important enough that a human stopped to approve them.
//
// The identity is PERSISTED at request time on `approval_requests.agent_id`
// (FX20 item 1) and read back here, seeded into the re-entry frame the way FX4
// seeds `proposing_turn_scopes` into the same frame. It is deliberately NOT
// re-resolved at re-entry: asking "who would act now" can name a DIFFERENT
// agent than the one that actually proposed the call, and the test below
// approves from inside another agent's frame to prove it does not.
//
// An approval created before the column was written carries null, and the
// re-entry must record null and NOT crash.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f21001"
const USER = "00000000-0000-4000-8000-000000f21002"
const THREAD = "00000000-0000-4000-8000-000000f21003"
const AGENT = "00000000-0000-4000-8000-000000f21004"
/** A DIFFERENT agent, acting when the human approves. It must never be recorded
 *  as the author of a call the first agent proposed. */
const OTHER_AGENT = "00000000-0000-4000-8000-000000f21005"

const APP = "fx21_test"
const WRITE = `${APP}:write`
const APPROVE = `${APP}:approve`
const SCOPES = [WRITE, APPROVE, "kernel:threads:write"]

function requester(): ActorContext & UserContext {
  return {
    actorType: "user",
    userId: USER,
    orgId: ORG,
    scopes: SCOPES,
    dimensionGrants: {},
  }
}

function turnFrame(agentId?: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f210ff"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: SCOPES,
    turnScopeAccumulator,
    ...(agentId ? { agentId } : {}),
  }
}

function posterManifest(): Record<string, unknown> {
  return {
    name: APP,
    trusted: true,
    capabilities: ["messages.post"],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The audit row for one entity and action, read outside RLS. */
async function auditAgentOf(
  entityId: string,
  action: string,
): Promise<{ found: boolean; agentId: string | null; actorId: string | null }> {
  const rows = await withSystemDb("fx21-audit-read", (db) =>
    db.execute(
      drizzleSql`SELECT agent_id, actor_id FROM kernel.audit_log
        WHERE org_id = ${ORG} AND entity_id = ${entityId} AND action = ${action}
        ORDER BY "timestamp" DESC LIMIT 1`,
    ),
  )
  const row = extractRows<{ agent_id: string | null; actor_id: string | null }>(rows)[0]
  return {
    found: row !== undefined,
    agentId: row?.agent_id ?? null,
    actorId: row?.actor_id ?? null,
  }
}

/** The message the approved re-entry posted, by its body. */
async function messageIdOf(body: string): Promise<string | undefined> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages WHERE org_id = ${ORG} AND content = ${body}`
  return rows[0]?.id
}

async function rowAgentOf(approvalId: string): Promise<string | null> {
  const rows = await withSystemDb("fx21-row-read", (db) =>
    db.execute(drizzleSql`SELECT agent_id FROM kernel.approval_requests WHERE id = ${approvalId}`),
  )
  return extractRows<{ agent_id: string | null }>(rows)[0]?.agent_id ?? null
}

/** Propose the gated post inside an agent turn. Returns the approval id. */
async function proposeInTurn(frame: RunContext | undefined, body: string): Promise<string> {
  const call = () =>
    executeTool({
      toolName: `${APP}:postScoped`,
      orgId: ORG,
      actor: requester(),
      params: { body },
      threadId: THREAD,
      // Forces the gated path even though the requester may self-approve.
      origin: "in-app-agent",
    })
  const r = frame ? await runContextStore.run(frame, call) : await call()
  if (!r.blocked?.approvalRequestId) {
    throw new Error(`expected the call to be gated, got ${JSON.stringify(r)}`)
  }
  return r.blocked.approvalRequestId
}

async function approve(approvalId: string) {
  return decideApproval({
    orgId: ORG,
    requestId: approvalId,
    actor: requester(),
    decision: "approve",
  })
}

describe("FX20: the approved re-entry names the proposing turn's agent", () => {
  beforeAll(async () => {
    await acquireTestLock()

    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    // The real audit and timeline consumers; WS fan-out stubbed (no manager).
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX20 Reentry Org', 'fx20-reentry-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx20-reentry@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx20-reentry-thread', 'agent_chat', ${USER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await withPrivilegedDb(ORG, "fx21-seed-agents", async (tx) => {
      for (const [id, handle, name] of [
        [AGENT, "@fx21-proposer", "Logistics"],
        [OTHER_AGENT, "@fx21-other", "Finance"],
      ] as const) {
        await tx
          .insert(agents)
          .values({
            id,
            orgId: ORG,
            kind: "personal",
            handle,
            displayName: name,
            ownerUserId: USER,
            scopeCeiling: [WRITE],
          })
          .onConflictDoNothing()
      }
    })

    // A gated tool that POSTS A MESSAGE through the production sandbox bridge,
    // built inside whatever frame the execution runs in: on the approved
    // re-entry that is the frame `runApprovedToolHandler` seeds, so the message
    // is attributed only if the identity survived on the row.
    toolRegistry.set([ORG, APP, "postScoped"], {
      appName: APP,
      name: "postScoped",
      description: "Posts a message when approved",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async (params: { body: string }) =>
        withRlsContext(requester(), async (tx) => {
          const bridge = createRpcBridge(
            APP,
            USER,
            ORG,
            tx as never,
            posterManifest() as never,
            SCOPES,
            "user",
            undefined,
            { actor: requester() as never, threadId: THREAD },
          ) as Record<string, (p: string) => Promise<string>>
          return JSON.parse(
            await bridge.messages_post!(JSON.stringify({ thread_id: THREAD, body: params.body })),
          )
        }),
    } as never)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    resetEventBus()
    await releaseTestLock()
  })

  it("a gated call proposed by an agent, approved and re-entered, audits under that one agent", async () => {
    // A11's actual question, end to end: propose inside the agent's turn, have
    // a human approve, let the re-entry run, and ask the audit trail who did it.
    const body = "the shipment was booked by the approved re-entry"
    const approvalId = await proposeInTurn(turnFrame(AGENT), body)

    // The identity is persisted at REQUEST time: the proposing turn's frame is
    // gone by the time anybody decides.
    expect(await rowAgentOf(approvalId)).toBe(AGENT)

    const decided = await approve(approvalId)
    expect(decided.status).toBe("approved")
    await drainOutbox()

    const messageId = await messageIdOf(body)
    expect(messageId).toBeDefined()

    // Every row of the story names the SAME agent: the one whose turn proposed
    // the call. The human stays the actor throughout, never the agent.
    const proposal = await auditAgentOf(approvalId, "approval_request.create")
    const reentryWrite = await auditAgentOf(messageId!, "message.create")
    expect({ proposal, reentryWrite }).toEqual({
      proposal: { found: true, agentId: AGENT, actorId: USER },
      reentryWrite: { found: true, agentId: AGENT, actorId: USER },
    })
    expect(reentryWrite.agentId).toBe(proposal.agentId)
    expect(reentryWrite.agentId).not.toBe(USER)
  })

  it("a human proposed gated call re-enters with no agent, never the human's id", async () => {
    const body = "a human asked for this one"
    const approvalId = await proposeInTurn(undefined, body)
    expect(await rowAgentOf(approvalId)).toBeNull()

    await approve(approvalId)
    await drainOutbox()

    const messageId = await messageIdOf(body)
    expect(messageId).toBeDefined()
    const reentryWrite = await auditAgentOf(messageId!, "message.create")
    expect(reentryWrite).toEqual({ found: true, agentId: null, actorId: USER })
  })

  it("an approval created before the column was written re-enters recording null, and does not crash", async () => {
    // Exactly the rows already sitting in production: proposed by an agent turn
    // before anything wrote `agent_id`. The write must still happen.
    const body = "an approval from before the column was written"
    const approvalId = await proposeInTurn(turnFrame(AGENT), body)
    await sql`UPDATE kernel.approval_requests SET agent_id = NULL WHERE id = ${approvalId}`
    expect(await rowAgentOf(approvalId)).toBeNull()

    const decided = await approve(approvalId)
    expect(decided.status).toBe("approved")
    await drainOutbox()

    const messageId = await messageIdOf(body)
    expect(messageId).toBeDefined()
    expect(await auditAgentOf(messageId!, "message.create")).toEqual({
      found: true,
      agentId: null,
      actorId: USER,
    })
  })

  it("the re-entry reads the persisted agent and never re-resolves a live one", async () => {
    // The reason the identity is read off the row rather than resolved again:
    // when the human clicks Approve, some OTHER agent's turn may be live. That
    // agent did not propose this call and must not be named by it.
    const body = "approved while a different agent was running"
    const approvalId = await proposeInTurn(turnFrame(AGENT), body)
    await sql`UPDATE kernel.approval_requests SET agent_id = NULL WHERE id = ${approvalId}`

    await runContextStore.run(turnFrame(OTHER_AGENT), () => approve(approvalId))
    await drainOutbox()

    const messageId = await messageIdOf(body)
    expect(messageId).toBeDefined()
    const reentryWrite = await auditAgentOf(messageId!, "message.create")
    // Null, because the ROW recorded none. Never the agent that happened to be
    // running at decision time.
    expect(reentryWrite.agentId).toBeNull()
    expect(reentryWrite.agentId).not.toBe(OTHER_AGENT)
  })

  it("an approval proposed by one agent is never re-attributed to the agent that approved it", async () => {
    const body = "proposed by logistics, approved while finance was running"
    const approvalId = await proposeInTurn(turnFrame(AGENT), body)

    await runContextStore.run(turnFrame(OTHER_AGENT), () => approve(approvalId))
    await drainOutbox()

    const messageId = await messageIdOf(body)
    expect(messageId).toBeDefined()
    const reentryWrite = await auditAgentOf(messageId!, "message.create")
    expect(reentryWrite.agentId).toBe(AGENT)
    expect(reentryWrite.agentId).not.toBe(OTHER_AGENT)
  })
})
