// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX24 item A -- the rest of the FX22 class: an approval-lifecycle audit row
// says POSITIVELY who acted, instead of inheriting whatever turn happens to be
// live around it.
//
// FX21 made `queueEvent` (and `sendMessage`) stamp the acting agent CENTRALLY
// from the live ALS frame unless the emitter passes an explicit value. That is
// right for a write an agent genuinely makes and wrong for every other one: a
// transition a PERSON drives, and a transition a WORKER drives, must record a
// positive null, or "what did this agent do" answers with someone else's click
// or with a cron tick.
//
// The classification is by WHO PERFORMS the transition, not by which frame is
// live:
//
//   human-decided  -> explicit null   (the edit HTTP route)
//   agent-action   -> that agent      (the two kernel approval tools, restage)
//   system/worker  -> explicit null   (the approving reaper)
//
// The two agent cases below are REGRESSION PINS, not new behaviour: both
// `approval_update_payload` and `approval_withdraw` are registered kernel tools
// (kernel-tools.ts), so an agent genuinely edits and withdraws through them and
// must stay named. Nulling those sites would have destroyed real attribution,
// which is why the human path is closed with an explicit argument from the HTTP
// route rather than with a blanket null inside the module.

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
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  handleApprovalUpdatePayload,
  handleApprovalWithdraw,
} from "~/modules/agent/tools/approval-tools"
import { runApprovingReaper } from "~/modules/approvals/approving-reaper"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalEditableFieldsRegistry } from "~/modules/apps/app-registries"
import type { AppContext } from "~/modules/apps/context"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f24001"
const USER = "00000000-0000-4000-8000-000000f24002"
const THREAD = "00000000-0000-4000-8000-000000f24003"
/** An agent that proposed nothing here and decides nothing: its turn is merely
 *  live while a person (or the reaper) acts. It must never be named. */
const BYSTANDER = "00000000-0000-4000-8000-000000f24004"
/** The agent that genuinely drives the two kernel approval tools. */
const OWN_AGENT = "00000000-0000-4000-8000-000000f24005"

const APP = "fx24_test"
const WRITE = `${APP}:write`
const APPROVE = `${APP}:approve`
const TOOL = `${APP}:ship`

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE, APPROVE],
  dimensionGrants: {},
}

const agentCtx = { orgId: ORG, userId: USER } as unknown as AppContext

function turnFrame(agentId: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f240ff"
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

/** Every audit row this org produced for one action, newest first. */
async function auditRows(
  action: string,
): Promise<{ agent_id: string | null; actor_id: string | null }[]> {
  const rows = await withSystemDb("fx24-audit-read", (db) =>
    db.execute(
      drizzleSql`SELECT agent_id, actor_id FROM kernel.audit_log
        WHERE org_id = ${ORG} AND action = ${action}
        ORDER BY "timestamp" DESC`,
    ),
  )
  return extractRows<{ agent_id: string | null; actor_id: string | null }>(rows)
}

/** A pending approval the USER raised, editable and withdrawable. */
async function seedPending(id: string, handle: string): Promise<void> {
  await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${id}, ${ORG}, ${handle}, ${THREAD}, ${THREAD}, ${TOOL}, '{"note":"old"}'::jsonb,
      '{"note":"old"}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER},
      'pending', 'gated', '{"kind":"edit","title":"FX24 Ship","lines":[]}'::jsonb
    )`
}

/** A wedged `approving` row past the reaper's stale threshold. */
async function seedApproving(id: string, handle: string, execStatus: string): Promise<void> {
  await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary,
      decided_by, decided_at, approving_started_at
    ) VALUES (
      ${id}, ${ORG}, ${handle}, ${THREAD}, ${THREAD}, ${TOOL}, '{"note":"x"}'::jsonb,
      '{"note":"x"}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER},
      'approving', 'gated', '{"kind":"edit","title":"FX24 Wedged","lines":[]}'::jsonb,
      ${USER}, now(), now() - interval '11 minutes'
    )`
  const error = execStatus === "failed_no_effect" ? JSON.stringify({ code: execStatus }) : null
  await sql`INSERT INTO kernel.approved_handler_executions (
      org_id, approval_request_id, tool_name, status, actor_id, attempts, error, finished_at
    ) VALUES (
      ${ORG}, ${id}, ${TOOL}, ${execStatus}, ${USER}, 1, ${error}::jsonb, now()
    )`
}

describe("FX24: an approval lifecycle row names who actually acted", () => {
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
      VALUES (${ORG}, 'FX24 Org', 'fx24-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx24@test.com', 'Operator', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx24-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    for (const scope of [WRITE, APPROVE]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    for (const [id, handleName] of [
      [BYSTANDER, "@fx24bystander"],
      [OWN_AGENT, "@fx24own"],
    ] as const) {
      await withPrivilegedDb(ORG, "fx24-seed-agent", (tx) =>
        tx
          .insert(agents)
          .values({
            id,
            orgId: ORG,
            kind: "personal",
            handle: handleName,
            displayName: handleName,
            ownerUserId: USER,
            scopeCeiling: [WRITE],
          })
          .onConflictDoNothing(),
      )
    }

    // Only the editable-field declaration is needed: with no tool registered the
    // edit path skips JSON-schema validation, which is not what is under test.
    approvalEditableFieldsRegistry.set(
      [ORG, APP, "ship"],
      [{ field: "note", label: "Note", widget: "text" }],
    )
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants
      WHERE org_id = ${ORG} AND thread_id <> ${THREAD}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG} AND id <> ${THREAD}`
  })

  afterAll(async () => {
    approvalEditableFieldsRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    resetEventBus()
    await releaseTestLock()
  })

  // ---- human-decided: the edit HTTP route ------------------------------------

  it("a human edit through the route argument shape names no agent", async () => {
    const id = "00000000-0000-4000-8000-000000f24103"
    await seedPending(id, "fx24-edit-human")

    // Exactly what `POST /api/approvals/:id/payload` passes: a person edited
    // this, so the acting agent is positively none whatever frame is live.
    await runContextStore.run(turnFrame(BYSTANDER), () =>
      updatePayload({
        orgId: ORG,
        requestId: id,
        fields: { note: "edited" },
        actor,
        actingAgentId: null,
      }),
    )
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    for (const row of updates) {
      expect(row.agent_id).toBeNull()
      expect(row.actor_id).toBe(USER)
    }
    const posts = await auditRows("message.create")
    expect(posts.length).toBeGreaterThan(0)
    for (const row of posts) expect(row.agent_id).toBeNull()
  })

  it("the payload route passes the positive null", async () => {
    // The fix lives at the CALLER, so pin the caller: a route that stops passing
    // it silently falls back to the ambient frame and the test above still passes.
    const source = await Bun.file(new URL("./routes.ts", import.meta.url).pathname).text()
    const call = source.slice(source.indexOf("const result = await updatePayload("))
    expect(call.slice(0, 200)).toContain("actingAgentId: null")
  })

  // ---- agent-action: the two kernel approval tools (REGRESSION PINS) ---------

  it("an agent editing through its kernel tool is still named", async () => {
    const id = "00000000-0000-4000-8000-000000f24104"
    await seedPending(id, "fx24-edit-agent")

    await runContextStore.run(turnFrame(OWN_AGENT), () =>
      handleApprovalUpdatePayload({ requestId: id, fields: { note: "by the agent" } }, agentCtx),
    )
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    // The agent genuinely made this edit. The human stays the actor.
    for (const row of updates) {
      expect(row.agent_id).toBe(OWN_AGENT)
      expect(row.actor_id).toBe(USER)
    }
  })

  it("an agent withdrawing its own request is still named", async () => {
    const id = "00000000-0000-4000-8000-000000f24105"
    await seedPending(id, "fx24-withdraw-agent")

    await runContextStore.run(turnFrame(OWN_AGENT), () =>
      handleApprovalWithdraw({ requestId: id, reason: "stale" }, agentCtx),
    )
    await drainOutbox()

    const updates = await auditRows("approval_request.update")
    expect(updates.length).toBeGreaterThan(0)
    for (const row of updates) expect(row.agent_id).toBe(OWN_AGENT)
    const posts = await auditRows("message.create")
    expect(posts.length).toBeGreaterThan(0)
    for (const row of posts) expect(row.agent_id).toBe(OWN_AGENT)
  })

  // ---- system/worker: the approving reaper -----------------------------------

  it("the reaper terminalizing a wedged row names no agent", async () => {
    const id = "00000000-0000-4000-8000-000000f24106"
    await seedApproving(id, "fx24-reap-ok", "succeeded")

    await runContextStore.run(turnFrame(BYSTANDER), () => runApprovingReaper())
    await drainOutbox()

    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("approved")
    for (const r of await auditRows("approval_request.update")) expect(r.agent_id).toBeNull()
    for (const r of await auditRows("message.create")) expect(r.agent_id).toBeNull()
  })

  it("the reaper reverting a failed row names no agent", async () => {
    const id = "00000000-0000-4000-8000-000000f24107"
    await seedApproving(id, "fx24-reap-fail", "failed_no_effect")

    await runContextStore.run(turnFrame(BYSTANDER), () => runApprovingReaper())
    await drainOutbox()

    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("pending")
    for (const r of await auditRows("approval_request.update")) expect(r.agent_id).toBeNull()
    for (const r of await auditRows("message.create")) expect(r.agent_id).toBeNull()
  })

  // ---- the control ------------------------------------------------------------

  it("outside every frame all of these still name no agent", async () => {
    const id = "00000000-0000-4000-8000-000000f24108"
    await seedPending(id, "fx24-noframe")

    await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { note: "edited" },
      actor,
      actingAgentId: null,
    })
    await drainOutbox()

    for (const r of await auditRows("approval_request.update")) expect(r.agent_id).toBeNull()
    for (const r of await auditRows("message.create")) expect(r.agent_id).toBeNull()
  })
})
