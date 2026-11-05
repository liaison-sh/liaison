// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX20 item 3 -- the restage-in-place path names the acting agent. Spec A11.
//
// A dedupe-keyed gated tool surfaces at most one pending approval per keyed
// action: a second staging call with different params updates the stored
// approval in place and queues an `approval_request:update` so the live cards
// refresh. That is the same class as FX18's four sites and it was missed: the
// event carried no agent, so an agent restaging a keyed action left an
// unattributed audit row, and the system message announcing the restage was
// unattributed with it.
//
// The identity is the one `executeToolCore` already resolved once for the whole
// dispatch (in frame, or forwarded across the sandbox hop), passed into the
// restage rather than re-read from a frame that may be gone.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
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
import { approvalDedupeKeyRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f22001"
const USER = "00000000-0000-4000-8000-000000f22002"
const THREAD = "00000000-0000-4000-8000-000000f22003"
const AGENT = "00000000-0000-4000-8000-000000f22004"

const APP = "fx22_test"
const WRITE = `${APP}:write`

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE],
  dimensionGrants: {},
}

function turnFrame(agentId?: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f220ff"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: [WRITE],
    turnScopeAccumulator,
    ...(agentId ? { agentId } : {}),
  }
}

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function auditAgentOf(
  entityId: string,
  action: string,
): Promise<{ found: boolean; agentId: string | null; actorId: string | null }> {
  const rows = await withSystemDb("fx22-audit-read", (db) =>
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

/** Stage the dedupe-keyed gated call. The SECOND call with a different carrier
 *  restages the same approval in place instead of stacking a new one. */
async function stage(frame: RunContext | undefined, carrier: string): Promise<string> {
  const call = () =>
    executeTool({
      toolName: `${APP}:ship`,
      orgId: ORG,
      actor,
      params: { draft_id: "draft-1", carrier },
      threadId: THREAD,
      origin: "in-app-agent",
    })
  const r = frame ? await runContextStore.run(frame, call) : await call()
  if (!r.blocked?.approvalRequestId) {
    throw new Error(`expected the call to be gated, got ${JSON.stringify(r)}`)
  }
  return r.blocked.approvalRequestId
}

describe("FX20: a restaged approval names the acting agent", () => {
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
      VALUES (${ORG}, 'FX20 Restage Org', 'fx20-restage-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx20-restage@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx20-restage-thread', 'agent_chat', ${USER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "fx22-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx22",
          displayName: "Logistics",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )

    toolRegistry.set([ORG, APP, "ship"], {
      appName: APP,
      name: "ship",
      description: "A dedupe-keyed gated shipment",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => ({ ok: true }),
    } as never)
    approvalDedupeKeyRegistry.set([ORG, APP, "ship"], "draft_id")
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    approvalDedupeKeyRegistry.deleteByPrefix([ORG])
    resetEventBus()
    await releaseTestLock()
  })

  it("an agent restaging a keyed action names itself on the update row", async () => {
    const first = await stage(turnFrame(AGENT), "carrier-a")
    const second = await stage(turnFrame(AGENT), "carrier-b")
    // The dedupe hit re-surfaces the SAME approval, updated in place.
    expect(second).toBe(first)
    await drainOutbox()

    // The human stays the actor; the agent that restaged rides alongside.
    expect(await auditAgentOf(first, "approval_request.update")).toEqual({
      found: true,
      agentId: AGENT,
      actorId: USER,
    })
  })

  it("a human restaging the same action records no agent", async () => {
    const first = await stage(undefined, "carrier-a")
    const second = await stage(undefined, "carrier-b")
    expect(second).toBe(first)
    await drainOutbox()

    const row = await auditAgentOf(first, "approval_request.update")
    expect(row).toEqual({ found: true, agentId: null, actorId: USER })
    expect(row.agentId).not.toBe(USER)
  })
})
