// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A11 -- a routine tick IS an agent turn, so every durable row the tick writes
// must name the routine's OWNER AGENT.
//
// Before this file, a finished tick's `routine.run_completed` audit row and the
// run-now requester's `agent_notification.create` row both landed with
// `agent_id` NULL, so "what did the logistics agent do" missed every scheduled
// action that agent ever took -- exactly the rows a routine exists to produce.
// Both emit sites already hold the FULL routine row (the `select()` in
// `runRoutineTick` loads it, and the same lines read `routine.name` /
// `routine.kind`), so the agent is a plain property access, not a lookup.
//
// FAIL CLOSED ON IDENTITY: the value is `routine.ownerAgentId ?? null`, passed
// EXPLICITLY so it wins over whatever frame happens to be live around the tick.
// A routine with no owner agent records a positive null -- never a guess, and
// never the enabling human's id, which stays where it belongs in `actor_id`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, auditLog, routines as routinesTbl, users } from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let ownerAgentId: string
let strangerAgentId: string

/** A live turn frame carrying some OTHER agent than the routine's owner. */
function strangerFrame(agentId: string): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, agentId }
}

async function seedAgent(handle: string): Promise<string> {
  return await withPrivilegedDb(orgId, "fx23-seed-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "role",
        handle: `@${handle}-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Logistics",
        scopeCeiling: ["kernel:threads:read"],
      })
      .returning({ id: agents.id })
    return a!.id
  })
}

async function makeRoutine(opts: {
  agentId: string | null
}): Promise<{ id: string; name: string }> {
  const name = `fx23-${crypto.randomUUID().slice(0, 8)}`
  return await withPrivilegedDb(orgId, "fx23-seed-routine", async (tx) => {
    const [row] = await tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId: opts.agentId,
        name,
        description: "Attribution test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "say hi",
        scopes: [],
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id, name: routinesTbl.name })
    return row!
  })
}

type AuditRow = {
  action: string
  actorId: string | null
  agentId: string | null
  changes: unknown
}

async function auditRows(action: string): Promise<AuditRow[]> {
  return await withSystemDb("fx23-audit-read", (db) =>
    db
      .select({
        action: auditLog.action,
        actorId: auditLog.actorId,
        agentId: auditLog.agentId,
        changes: auditLog.changes,
      })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))),
  )
}

/** The one `routine.run_completed` row for this routine. */
async function runCompletedRowFor(routineId: string): Promise<AuditRow | undefined> {
  const rows = await withSystemDb("fx23-audit-run-completed", (db) =>
    db
      .select({
        action: auditLog.action,
        actorId: auditLog.actorId,
        agentId: auditLog.agentId,
        changes: auditLog.changes,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.action, "routine.run_completed"),
          eq(auditLog.entityId, routineId),
        ),
      ),
  )
  return rows[0]
}

/** The run-now notification row naming this routine, matched on its summary. */
async function notificationRowFor(routineName: string): Promise<AuditRow | undefined> {
  const rows = await auditRows("agent_notification.create")
  return rows.find((r) => {
    const summary = (r.changes as { summary?: string } | null)?.summary
    return typeof summary === "string" && summary.includes(routineName)
  })
}

async function tick(
  routineId: string,
  extra: { requestedByUserId?: string } = {},
): Promise<string> {
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async () => ({ turnsAdded: 1 }),
    ...extra,
  })
  return result.status
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

  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await seedAgent("fx23-owner")
  strangerAgentId = await seedAgent("fx23-stranger")
})

afterAll(async () => {
  await clearRedisPatterns(["routine-lock:*"])
  resetEventBus()
  await releaseTestLock()
})

describe("a routine tick names the routine's owner agent", () => {
  it("a finished tick's run_completed audit row carries the owner agent", async () => {
    const routine = await makeRoutine({ agentId: ownerAgentId })
    expect(await tick(routine.id)).toBe("succeeded")
    await drainOutbox()

    const row = await runCompletedRowFor(routine.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(ownerAgentId)
    // The owning human stays the actor; the agent id is independent of it.
    expect(row?.actorId).toBe(userId)
  })

  it("a routine with no owner agent records no agent, never the owning human", async () => {
    const routine = await makeRoutine({ agentId: null })
    expect(await tick(routine.id)).toBe("succeeded")
    await drainOutbox()

    const row = await runCompletedRowFor(routine.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
    expect(row?.actorId).toBe(userId)
  })

  it("the run-now requester notification carries the owner agent", async () => {
    const routine = await makeRoutine({ agentId: ownerAgentId })
    const requester = await withSystemDb("fx23-requester", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `fx23-req-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Run-now Requester",
          status: "active",
        })
        .returning({ id: users.id })
      return u!.id
    })
    expect(await tick(routine.id, { requestedByUserId: requester })).toBe("succeeded")
    await drainOutbox()

    const row = await notificationRowFor(routine.name)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(ownerAgentId)
  })

  it("the run-now notification of an agentless routine records no agent", async () => {
    const routine = await makeRoutine({ agentId: null })
    const requester = await withSystemDb("fx23-requester-2", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `fx23-req-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Run-now Requester Two",
          status: "active",
        })
        .returning({ id: users.id })
      return u!.id
    })
    expect(await tick(routine.id, { requestedByUserId: requester })).toBe("succeeded")
    await drainOutbox()

    const row = await notificationRowFor(routine.name)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("an unrelated live frame cannot lend its agent to an agentless routine", async () => {
    // The identity is the ROUTINE's, passed explicitly, so whatever turn happens
    // to be executing around the tick can never be recorded as the actor of the
    // routine's own rows. Falsifies any implementation that leans on the frame.
    const routine = await makeRoutine({ agentId: null })
    const status = await runContextStore.run(strangerFrame(strangerAgentId), () => tick(routine.id))
    expect(status).toBe("succeeded")
    await drainOutbox()

    const row = await runCompletedRowFor(routine.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBeNull()
  })

  it("an unrelated live frame cannot displace the routine's own owner agent", async () => {
    const routine = await makeRoutine({ agentId: ownerAgentId })
    const status = await runContextStore.run(strangerFrame(strangerAgentId), () => tick(routine.id))
    expect(status).toBe("succeeded")
    await drainOutbox()

    const row = await runCompletedRowFor(routine.id)
    expect(row).toBeDefined()
    expect(row?.agentId).toBe(ownerAgentId)
  })
})
