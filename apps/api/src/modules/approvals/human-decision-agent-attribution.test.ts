// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX22 item 3 -- a HUMAN-DECIDED approval transition names no agent, even when
// some other agent's turn happens to be live in the deciding request.
//
// FX21 made `queueEvent` stamp the acting agent CENTRALLY: an explicit value
// wins, otherwise the live run frame does. The approval lifecycle transitions a
// person drives (deny, revert, expiry, the terminalize after an approved
// execution) pass no explicit value, so under that stamp a decide made while an
// agent frame was live would file the APPROVER's agent onto a decision that
// agent did not make. "What did this agent do" would then answer with a human's
// click.
//
// The frames used here are exactly what makes it reachable: the approval is
// proposed by nobody (no agent), and the DECIDE runs inside agent Q's frame.
// Q must not appear anywhere on the resulting rows.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as jobsModule from "~/infra/jobs/jobs"

// The approved path enqueues the output poll and the expiry job; kernel job
// workers only register in index.ts, so enqueueAppJob throws "No handler
// registered" under bun:test. Stub it with a restored spy (never mock.module,
// which would leak into every later file in the same process).
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import { recordAwaitingOutput, recordStarted } from "~/modules/approvals/handler-protocol"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f23001"
const USER = "00000000-0000-4000-8000-000000f23002"
const THREAD = "00000000-0000-4000-8000-000000f23003"
/** The agent whose turn is live while the HUMAN decides. It proposed nothing. */
const OTHER_AGENT = "00000000-0000-4000-8000-000000f23004"

const APP = "fx22c_test"
const WRITE = `${APP}:write`
const APPROVE = `${APP}:approve`

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE, APPROVE],
  dimensionGrants: {},
}

function turnFrame(agentId: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f230ff"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: [WRITE, APPROVE],
    turnScopeAccumulator,
    agentId,
  }
}

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Every audit row for one action in this org, newest first. */
async function auditRows(
  action: string,
): Promise<{ agent_id: string | null; actor_id: string | null }[]> {
  const rows = await withSystemDb("fx22c-audit-read", (db) =>
    db.execute(
      drizzleSql`SELECT agent_id, actor_id FROM kernel.audit_log
        WHERE org_id = ${ORG} AND action = ${action}
        ORDER BY "timestamp" DESC`,
    ),
  )
  return extractRows<{ agent_id: string | null; actor_id: string | null }>(rows)
}

/** Stage a gated call with NO agent frame: a human asked for it. */
async function stageAsHuman(tool: string): Promise<string> {
  const r = await executeTool({
    toolName: `${APP}:${tool}`,
    orgId: ORG,
    actor,
    params: { note: "gate me" },
    threadId: THREAD,
    // Force the gated path even though the requester also holds :approve. The
    // direct-human bypass only triggers when `origin` is unset (decide.test's
    // convention), and what is under test is the DECIDE, not the staging.
    origin: "in-app-agent",
  })
  if (!r.blocked?.approvalRequestId) {
    throw new Error(`expected the call to be gated, got ${JSON.stringify(r)}`)
  }
  return r.blocked.approvalRequestId
}

/** The awaiting-output handler resolves its OWN approval row and parks it, which
 *  is what drives the cascade's no-message terminalize branch. */
async function parkOwnApproval(toolName: string): Promise<void> {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = {
    orgId: ORG,
    approvalRequestId: row.id,
    approvalDeciderId: row.decided_by,
    toolName,
  }
  await withPrivilegedDb(ORG, "fx22c-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "fx22c-rec", (tx) => recordAwaitingOutput(tx, ctx, toolName, {}))
}

describe("FX22: a human-decided approval transition claims no agent", () => {
  beforeAll(async () => {
    await acquireTestLock()

    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX22 Human Decision Org', 'fx22-human-decision-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx22-decider@test.com', 'Decider', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx22-decision-thread', 'agent_chat', ${USER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    // The decider needs the approve scope as a REAL grant: the notified
    // audience is computed from who holds it at staging time, and decide-time
    // eligibility reloads it from the database rather than trusting the
    // passed-in context.
    for (const scope of [WRITE, APPROVE]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await withPrivilegedDb(ORG, "fx22c-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: OTHER_AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx22c",
          displayName: "Bystander",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )

    // `ship` completes inline; `park` reports awaiting_output, which is what
    // takes the cascade's message-less terminalize branch.
    toolRegistry.set([ORG, APP, "ship"], {
      appName: APP,
      name: "ship",
      description: "A gated shipment",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => ({ ok: true }),
    } as never)
    toolRegistry.set([ORG, APP, "park"], {
      appName: APP,
      name: "park",
      description: "A gated shipment whose output arrives later",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => {
        await parkOwnApproval(`${APP}:park`)
        return { queued: true }
      },
    } as never)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    resetEventBus()
    enqueueAppJobSpy.mockRestore()
    await releaseTestLock()
  })

  it("denying inside another agent's live frame records no agent on the update", async () => {
    const approvalId = await stageAsHuman("ship")
    await runContextStore.run(turnFrame(OTHER_AGENT), () =>
      decideApproval({ orgId: ORG, requestId: approvalId, actor, decision: "deny", reason: "no" }),
    )
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    // The human decided it. The bystanding agent must not be named.
    for (const row of updates) {
      expect(row.agent_id).toBeNull()
      expect(row.actor_id).toBe(USER)
    }
  })

  it("the system messages announcing a human decision name no agent either", async () => {
    const approvalId = await stageAsHuman("ship")
    await runContextStore.run(turnFrame(OTHER_AGENT), () =>
      decideApproval({ orgId: ORG, requestId: approvalId, actor, decision: "deny", reason: "no" }),
    )
    await drainOutbox()

    const posts = await auditRows("message.create")
    expect(posts.length).toBeGreaterThan(0)
    for (const row of posts) expect(row.agent_id).toBeNull()
  })

  it("terminalizing an approved call that awaits output records no agent", async () => {
    const approvalId = await stageAsHuman("park")
    await runContextStore.run(turnFrame(OTHER_AGENT), () =>
      decideApproval({ orgId: ORG, requestId: approvalId, actor, decision: "approve" }),
    )
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    for (const row of updates) {
      expect(row.agent_id).toBeNull()
      expect(row.actor_id).toBe(USER)
    }
  })

  it("deciding outside every frame still records no agent", async () => {
    // The control: nothing about the fix depends on a frame being present.
    const approvalId = await stageAsHuman("ship")
    await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor,
      decision: "deny",
      reason: "no",
    })
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    for (const row of updates) expect(row.agent_id).toBeNull()
  })
})
