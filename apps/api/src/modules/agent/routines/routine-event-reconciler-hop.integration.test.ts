// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The routine chain guard holds through the event reconciler (0303). Two flow routines ping-pong
// a task's status (A moves it to Review, B moves it back to Open). The subscriber drops an event
// at hop 5 without a run row, and the task then sits in that event's status, so the reconciler
// sees an event with no run that is still current:
//   - a lost event at hop 4 is replayed with its hop: the replayed run's own write carries hop 5;
//   - that hop 5 event is never replayed (the loop stops), although the task still sits in its status.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { RoutineFlow } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  type ReconcileOptions,
  RoutineEventReconcilerTestAccess,
  reconcileEventRoutines,
} from "~/modules/agent/routines/routine-event-reconciler"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import { seedAuditEntry } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"

type Enq = Parameters<NonNullable<ReconcileOptions["enqueue"]>>[0]

let ORG = ""
let OWNER = ""
const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]
const ctx = (): UserContext => ({
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})
let projectId = ""
let open = ""
let review = ""
let A = ""
let B = ""

const moveTo = (statusId: string): RoutineFlow => ({
  version: 1,
  steps: [{ id: "move", type: "action", action: "set_status", args: { statusId } }],
})

async function flowRoutine(name: string, flow: RoutineFlow) {
  return seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name,
      description: name,
      kind: "event",
      event: "projects:task:status_changed",
      ownerUserId: OWNER,
      scopes: SCOPES,
      prompt: name,
      flow,
    },
  })
}

/** The audit row the outbox writes for a status change a routine's run made. */
async function audit(taskId: string, to: string, metadata: Record<string, unknown>) {
  const eventId = randomUUID()
  await seedAuditEntry({
    orgId: ORG,
    actorType: "system",
    app: "projects",
    entityType: "task",
    entityId: taskId,
    action: "task.status_changed",
    changes: { id: taskId, projectId, toStatusId: to },
    metadata,
    eventId,
    timestamp: new Date(Date.now() - 3600_000),
  })
  return eventId
}

async function reconcile(routineId: string) {
  const enqueued: Enq[] = []
  await RoutineEventReconcilerTestAccess.clearInFlight(routineId)
  const report = await reconcileEventRoutines({
    routineId,
    enqueue: async (p) => {
      enqueued.push(p)
    },
  })
  return { enqueued, report }
}

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Routine Chain Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  await minimal.grantScope(OWNER, "*")
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(ctx(), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(), input: { name: "Ping pong" } }),
  )
  projectId = p.id
  const statuses = p.statuses.filter((s) => !s.terminal)
  open = statuses[0]!.id
  review = statuses[1]!.id
  A = await flowRoutine("A to review", moveTo(review))
  B = await flowRoutine("B to open", moveTo(open))
  // Both predate the events the cases seed: the reconciler skips events older than the routine.
  await sql`UPDATE kernel.routines SET created_at = now() - interval '1 day' WHERE id IN (${A}::uuid, ${B}::uuid)`
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("the routine chain guard through the reconciler", () => {
  it("replays a lost hop 4 event with its hop, and never the hop 5 one its run caused", async () => {
    const t = await withRlsContext(ctx(), (tx) =>
      createTask({
        tx,
        orgId: ORG,
        actor: ctx(),
        input: { projectId, statusId: open, title: "P" },
      }),
    )
    // B moved the task back to Open at hop 4; A's tick for it was lost.
    const lost = await audit(t.id, open, { firedByRoutineId: B, hop: 4 })
    const first = await reconcile(A)
    const replay = first.enqueued.find((e) => e.triggerEvent.eventId === lost)
    expect(replay?.triggerEvent.hop).toBe(4)

    // The replayed tick runs A for real: its write is the chain's hop 5.
    const res = await runRoutineTick({
      ...replay!,
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
    })
    expect(res.status).toBe("succeeded")
    const [pending] = await sql<{ metadata: { hop?: number; firedByRoutineId?: string } }[]>`
      SELECT payload->'metadata' AS metadata FROM kernel.pending_events
       WHERE org_id = ${ORG}::uuid AND payload->>'action' = 'status_changed'
         AND payload->'metadata'->>'firedByRoutineId' = ${A}
       ORDER BY id DESC LIMIT 1`
    expect(pending?.metadata.hop).toBe(5)

    // The subscriber dropped that hop 5 event for B (no run row), and the task sits in Review.
    const dropped = await audit(t.id, review, pending!.metadata)
    const second = await reconcile(B)
    expect(second.enqueued.map((e) => e.triggerEvent.eventId)).not.toContain(dropped)
    expect(second.report.events.map((e) => e.eventId)).not.toContain(dropped)
  }, 60_000)

  it("still replays a lost event below the limit", async () => {
    const t = await withRlsContext(ctx(), (tx) =>
      createTask({
        tx,
        orgId: ORG,
        actor: ctx(),
        input: { projectId, statusId: open, title: "Q" },
      }),
    )
    await withRlsContext(ctx(), (tx) =>
      updateTask({ tx, orgId: ORG, actor: ctx(), taskId: t.id, input: { statusId: review } }),
    )
    const lost = await audit(t.id, review, { firedByRoutineId: A, hop: 2 })
    const { enqueued } = await reconcile(B)
    expect(enqueued.find((e) => e.triggerEvent.eventId === lost)?.triggerEvent.hop).toBe(2)
  }, 60_000)

  it("never replays an event from before the routine existed", async () => {
    const t = await withRlsContext(ctx(), (tx) =>
      createTask({
        tx,
        orgId: ORG,
        actor: ctx(),
        input: { projectId, statusId: open, title: "R" },
      }),
    )
    await withRlsContext(ctx(), (tx) =>
      updateTask({ tx, orgId: ORG, actor: ctx(), taskId: t.id, input: { statusId: review } }),
    )
    // An hour old event no run of A ever served: A predates it, so it is replayed for A.
    const old = await audit(t.id, review, {})
    // C is created after that event: the event was never C's to handle.
    const C = await flowRoutine("C created later", moveTo(open))
    const late = await reconcile(C)
    expect(late.enqueued.map((e) => e.triggerEvent.eventId)).not.toContain(old)
    expect(late.report.events.map((e) => e.eventId)).not.toContain(old)
    const earlier = await reconcile(A)
    expect(earlier.enqueued.map((e) => e.triggerEvent.eventId)).toContain(old)
  }, 60_000)
})
