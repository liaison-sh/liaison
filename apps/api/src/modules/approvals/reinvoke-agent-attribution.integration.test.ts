// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX19 item 1 -- a RE-INVOKED turn names the agent whose turn failed
// (`kernel.audit_log.agent_id`). Spec A11.
//
// When an approval bundle fails, `failBundle` enqueues a BullMQ
// `agent-reinvoke` job that posts a failure-context message and re-runs the
// agent. That job executes long after the proposing turn ended and OUTSIDE its
// ALS frame, so `captureActingAgentId()` there answers "no agent" for an action
// an agent plainly caused, and every audit row the re-invocation produced was
// unattributed.
//
// The identity RIDES THE MESSAGE, exactly as T32 established for the event
// envelope and FX4 did for the proposing turn's scopes: the agent recorded on
// the approval row when the gated call was proposed is read at the enqueue site
// and travels on the job payload. It is deliberately NOT re-resolved inside the
// job: re-resolving asks "who would act now", which can name a DIFFERENT agent
// than the one whose turn actually failed.
//
// FAIL CLOSED ON IDENTITY, NOT ON THE WRITE: a bundle with no recorded agent
// carries a positive null, never the requester's own id and never a guess, and
// the audit row still lands either way. A job enqueued BEFORE this field
// existed has no such key at all and must behave the same.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import * as jobsModule from "~/infra/jobs/jobs"
import { runAgentReinvoke } from "~/modules/agent/runtime/reinvoke"

// enqueueAppJob throws "No handler registered" under bun:test (kernel job
// workers only register in index.ts). Record the enqueues as no-ops and drain
// them after failBundle's transaction commits, exactly as BullMQ would. spyOn,
// never mock.module, which leaks process-wide into every later test file.
const enqueuedJobs: Array<{ appName: string; jobName: string; payload: any }> = []
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
  appName: string,
  jobName: string,
  payload: any,
) => {
  enqueuedJobs.push({ appName, jobName, payload })
  return `${jobName}:stub`
}) as typeof jobsModule.enqueueAppJob)

import { and, eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import * as agentService from "~/modules/agent/runtime/agent-service"
import { failBundle } from "~/modules/approvals/cascade-fail"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Replace ONLY invokeAgentForThread: the re-invocation must not run a model.
const reinvokeSpy = spyOn(agentService, "invokeAgentForThread").mockResolvedValue({
  finishReason: "stop",
  turnsAdded: 1,
})

const ORG = "00000000-0000-4000-8000-000000f19001"
const USER = "00000000-0000-4000-8000-000000f19002"
const THREAD = "00000000-0000-4000-8000-000000f19003"

/** The agent whose turn proposed the bundle that failed. */
let AGENT = ""

/** Drain the transactional outbox so the durable audit consumer has run. */
async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Run every recorded agent-reinvoke job, mirroring the BullMQ worker. */
async function drainReinvokeJobs(): Promise<void> {
  for (const job of enqueuedJobs.filter((j) => j.jobName === "agent-reinvoke")) {
    await runAgentReinvoke(job.payload)
  }
}

/** The audit row for one entity, read outside RLS. */
async function auditRowFor(
  entityId: string,
): Promise<{ actorType: string; actorId: string | null; agentId: string | null } | undefined> {
  const rows = await withSystemDb("fx19-audit-read", (db) =>
    db
      .select({
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        agentId: auditLog.agentId,
      })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, ORG), eq(auditLog.entityId, entityId))),
  )
  return rows[0]
}

/** The id of the failure-context message the re-invocation posted. */
async function reinvokeMessageId(): Promise<string | undefined> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM kernel.messages
    WHERE thread_id = ${THREAD} AND metadata ->> 'type' = 'bundle-reinvoke'`
  return rows[0]?.id
}

/**
 * One single-step bundle whose head is `deferred`, with the acting agent the
 * proposing turn recorded on it (null when no agent proposed it).
 */
async function seedBundleHead(agentId: string | null): Promise<string> {
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO kernel.approval_requests
      (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
       current_payload, expires_at, requested_by, status, bundle_id, bundle_position, agent_id)
    VALUES (${id}, ${ORG}, ${`req-${id.slice(0, 8)}`}, ${THREAD}, ${THREAD},
       'fx19_test:step', '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour',
       ${USER}, 'deferred', ${id}, 0, ${agentId})`
  return id
}

/** The single recorded agent-reinvoke enqueue. */
function reinvokeJobPayload(): any {
  const jobs = enqueuedJobs.filter((j) => j.jobName === "agent-reinvoke")
  expect(jobs.length).toBe(1)
  return jobs[0].payload
}

beforeAll(async () => {
  await acquireTestLock()

  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  // Real audit + timeline consumers; WS fan-out stubbed (no manager here).
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'FX19 Reinvoke Org', 'fx19-reinvoke-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'fx19-reinvoke@test.com', 'Requester', 'active', 'hash')
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'fx19-reinvoke-thread', 'agent_chat', ${USER})
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${USER}, ${ORG}, 'fx19_test:write') ON CONFLICT DO NOTHING`

  AGENT = await withPrivilegedDb(ORG, "fx19-seed-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId: ORG,
        kind: "role",
        handle: `@fx19-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Logistics",
        scopeCeiling: ["fx19_test:write"],
      })
      .returning({ id: agents.id })
    return a.id
  })
})

afterEach(async () => {
  reinvokeSpy.mockClear()
  enqueuedJobs.length = 0
  // kernel.audit_log is append-only (0000 revokes DELETE from the app role), so
  // nothing is cleaned there; every assertion keys on its own message id.
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})

afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  reinvokeSpy.mockRestore()
  resetEventBus()
  await releaseTestLock()
})

describe("FX19: a re-invoked turn names the agent whose turn failed", () => {
  it("the re-invocation job payload carries the proposing turn's agent", async () => {
    const head = await seedBundleHead(AGENT)

    await failBundle(ORG, head, "downstream boom")

    // Read off the approval row at the enqueue site, never re-resolved inside
    // the job, so the identity is the one that actually proposed the bundle.
    expect(reinvokeJobPayload().agentId).toBe(AGENT)
  })

  it("the failure-context message audits with that agent, independently of the human", async () => {
    const head = await seedBundleHead(AGENT)

    await failBundle(ORG, head, "downstream boom")
    await drainReinvokeJobs()
    await drainOutbox()

    const messageId = await reinvokeMessageId()
    expect(messageId).toBeDefined()
    const row = await auditRowFor(messageId!)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(AGENT)
    // The human requester stays the actor. The agent id is INDEPENDENT of it,
    // never a substitute, so the human's id never lands in the agent slot.
    expect(row?.actorId).toBe(USER)
    expect(row?.agentId).not.toBe(USER)
    expect(reinvokeSpy).toHaveBeenCalled()
  })

  it("a bundle proposed by no agent enqueues a positive null, never the requester's id", async () => {
    const head = await seedBundleHead(null)

    await failBundle(ORG, head, "downstream boom")

    const payload = reinvokeJobPayload()
    // Null, not absent: the field was resolved and the answer is "no agent".
    expect(payload.agentId).toBeNull()
    expect(payload.agentId).not.toBe(USER)

    await drainReinvokeJobs()
    await drainOutbox()
    const messageId = await reinvokeMessageId()
    expect(messageId).toBeDefined()
    const row = await auditRowFor(messageId!)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("an old job enqueued before this field existed records no agent and still lands the row", async () => {
    // Exactly the payload shape already sitting on the queue: no agentId key at
    // all. It must not crash, and it must record null rather than guessing.
    await runAgentReinvoke({
      orgId: ORG,
      threadId: THREAD,
      bundleId: crypto.randomUUID(),
      requesterId: USER,
      context: "An approval sequence could not complete automatically: downstream boom.",
    })
    await drainOutbox()

    const messageId = await reinvokeMessageId()
    expect(messageId).toBeDefined()
    const row = await auditRowFor(messageId!)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
    expect(row?.actorId).toBe(USER)
  })

  it("the sequence-failed notice names the agent whose turn proposed the bundle", async () => {
    // FX20 item 3. The notice is posted from a privileged path outside the
    // proposing turn's frame, two lines above the enqueue that already carries
    // the identity, so it audited with no agent while the re-invocation it
    // announces audited with one.
    const head = await seedBundleHead(AGENT)

    await failBundle(ORG, head, "downstream boom")
    await drainOutbox()

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND metadata ->> 'type' = 'sequence-failed'`
    expect(rows.length).toBeGreaterThan(0)
    const row = await auditRowFor(rows[0].id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(AGENT)
    // The human requester stays the actor; the agent id never replaces it.
    expect(row?.actorId).toBe(USER)
    expect(row?.agentId).not.toBe(USER)
  })

  it("a sequence-failed notice for a bundle no agent proposed records no agent", async () => {
    const head = await seedBundleHead(null)

    await failBundle(ORG, head, "downstream boom")
    await drainOutbox()

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND metadata ->> 'type' = 'sequence-failed'`
    expect(rows.length).toBeGreaterThan(0)
    const row = await auditRowFor(rows[0].id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("an unusable agent id on the payload still lands the row, recording no agent", async () => {
    // Fail closed on IDENTITY, not on the write: a value that is not a real
    // agent id must never take the audit row down with it.
    await runAgentReinvoke({
      orgId: ORG,
      threadId: THREAD,
      bundleId: crypto.randomUUID(),
      requesterId: USER,
      context: "An approval sequence could not complete automatically: downstream boom.",
      agentId: "not-a-uuid",
    })
    await drainOutbox()

    const messageId = await reinvokeMessageId()
    expect(messageId).toBeDefined()
    const row = await auditRowFor(messageId!)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })
})
