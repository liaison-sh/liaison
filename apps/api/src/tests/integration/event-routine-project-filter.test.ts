// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine on projects task events (0303): its filter {projectId, fromStatusId, toStatusId,
// fields} fires it only for that project's tasks, that status change and those field values,
// read from the task as the owner. Status changes are never coalesced (each transition is its own
// run), a non-matching event starts no tick, and a routine chain stops at depth 5.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { projectTaskFilterMatches, taskCellMatches } from "~/infra/jobs/event-routine-gate"
import { redis } from "~/lib/redis"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"

const enqueued: unknown[][] = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (...a: unknown[]) => {
    enqueued.push(a)
    return "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const {
  registerEventRoutineSubscription,
  EventRoutineSubscriberTestAccess,
  __resetEventRoutineSubscriber,
} = await import("~/infra/jobs/event-routine-subscriber")

const COALESCE_MS = 400
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

interface TickPayload {
  triggerEvent: { entityId: string; hop?: number; data: Record<string, unknown> }
}
const ticks = () =>
  enqueued
    .filter(([app, job]) => app === "kernel" && job === "routine-tick")
    .map((a) => a[2] as TickPayload)

let ORG = ""
let OWNER = ""
let ROUTINE = ""
const EVENT = "projects:task:status_changed"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]
const ctx = (userId: string, scopes = SCOPES): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})

const FIELDS = [
  { key: "kind", label: "Kind", type: "choice", choices: ["Noise", "Power", "Other"] },
  { key: "parts", label: "Parts", type: "choices", choices: ["Fan", "Board"] },
]

interface Board {
  id: string
  open: string
  next: string
}
let board: Board
let otherBoard: Board

async function makeBoard(name: string): Promise<Board> {
  const p = await withRlsContext(ctx(OWNER), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(OWNER), input: { name, fields: FIELDS } }),
  )
  const open = p.statuses.filter((s) => !s.terminal)
  return { id: p.id, open: open[0]!.id, next: open[1]!.id }
}

async function task(b: Board, fields: Record<string, unknown>): Promise<string> {
  const t = await withRlsContext(ctx(OWNER), (tx) =>
    createTask({
      tx,
      orgId: ORG,
      actor: ctx(OWNER),
      input: { projectId: b.id, statusId: b.open, title: "A task", fields },
    }),
  )
  return t.id
}

/** A status change event as transitions.ts queues it. */
function statusChanged(
  taskId: string,
  b: Board,
  from: string | null,
  to: string,
  metadata?: Record<string, unknown>,
) {
  return {
    app: "projects",
    entity: "task",
    action: "status_changed",
    entityId: taskId,
    data: { id: taskId, projectId: b.id, fromStatusId: from, toStatusId: to },
    ...(metadata ? { metadata } : {}),
  }
}

async function fire(evt: ReturnType<typeof statusChanged>) {
  await _publishEventInternal({ ...evt, orgId: ORG })
  await flushEventHandlers()
  await new Promise((r) => setTimeout(r, 150))
}

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Project Routine Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  await minimal.grantScope(OWNER, "*")
  initEventBus()
  board = await makeBoard("Intake")
  otherBoard = await makeBoard("Elsewhere")
  ROUTINE = await seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name: "Assign on review",
      description: "assign",
      kind: "event",
      event: EVENT,
      eventFilter: { projectId: board.id, toStatusId: board.next, fields: { kind: ["Noise"] } },
      ownerUserId: OWNER,
      scopes: ["projects:tasks:write"],
      prompt: "assign",
    },
  })
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

async function subscribe(filter: Record<string, unknown>) {
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
  await registerEventRoutineSubscription({ routineId: ROUTINE, orgId: ORG, event: EVENT, filter })
}

beforeEach(async () => {
  enqueued.length = 0
  await subscribe({ projectId: board.id, toStatusId: board.next, fields: { kind: ["Noise"] } })
})

describe("projects task filter", () => {
  test("pure: project, from/to status and fields", () => {
    const evt = { action: "status_changed", data: { fromStatusId: "a", toStatusId: "b" } }
    const t = { projectId: "p", fields: { kind: "Noise", parts: ["Fan"] } }
    expect(projectTaskFilterMatches({ projectId: "p", toStatusId: "b" }, evt, t)).toBe(true)
    expect(projectTaskFilterMatches({ projectId: "q" }, evt, t)).toBe(false)
    expect(projectTaskFilterMatches({ toStatusId: "c" }, evt, t)).toBe(false)
    expect(projectTaskFilterMatches({ fromStatusId: "a" }, evt, t)).toBe(true)
    expect(projectTaskFilterMatches({ fromStatusId: null }, evt, t)).toBe(false)
    expect(
      projectTaskFilterMatches(
        { fromStatusId: null, toStatusId: "b" },
        { action: "status_changed", data: { fromStatusId: null, toStatusId: "b" } },
        t,
      ),
    ).toBe(true)
    expect(projectTaskFilterMatches({ fields: { kind: "noise" } }, evt, t)).toBe(true)
    expect(projectTaskFilterMatches({ fields: { kind: ["Power", "Other"] } }, evt, t)).toBe(false)
    expect(projectTaskFilterMatches({ fields: { parts: "Fan" } }, evt, t)).toBe(true)
    expect(projectTaskFilterMatches({ fields: { missing: null } }, evt, t)).toBe(true)
    // A status filter never matches an edit, and nothing matches a task the owner cannot read.
    expect(projectTaskFilterMatches({ toStatusId: "b" }, { action: "updated", data: {} }, t)).toBe(
      false,
    )
    expect(projectTaskFilterMatches({ projectId: "p" }, evt, null)).toBe(false)
    expect(taskCellMatches({ id: "r1", label: "R" }, "r1")).toBe(true)
  })

  test("fires for the matching transition, with the event", async () => {
    const id = await task(board, { kind: "Noise" })
    await fire(statusChanged(id, board, board.open, board.next))
    expect(ticks().map((t) => t.triggerEvent.entityId)).toEqual([id])
    expect(ticks()[0]!.triggerEvent.data.toStatusId).toBe(board.next)
  })

  test("starts no tick for another project, status or field value", async () => {
    const noisy = await task(board, { kind: "Noise" })
    const power = await task(board, { kind: "Power" })
    const elsewhere = await task(otherBoard, { kind: "Noise" })
    await fire(statusChanged(noisy, board, board.next, board.open))
    await fire(statusChanged(power, board, board.open, board.next))
    await fire(statusChanged(elsewhere, otherBoard, otherBoard.open, otherBoard.next))
    expect(ticks()).toEqual([])
  })

  test("fromStatusId null matches a task created in the status", async () => {
    await subscribe({ projectId: board.id, fromStatusId: null, toStatusId: board.open })
    const id = await task(board, {})
    await fire(statusChanged(id, board, board.open, board.next))
    expect(ticks()).toEqual([])
    await fire(statusChanged(id, board, null, board.open))
    expect(ticks().length).toBe(1)
  })

  test("each status change of one task fires: no coalesce window", async () => {
    await subscribe({ projectId: board.id })
    const id = await task(board, {})
    await fire(statusChanged(id, board, board.open, board.next))
    await fire(statusChanged(id, board, board.next, board.open))
    expect(ticks().length).toBe(2)
  })

  test("a task the owner cannot read starts no tick", async () => {
    const outsider = (await minimal.person(ORG, { name: "Outsider" })).id
    const theirs = await seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
      createdByUserId: outsider,
      ownerScopes: [],
      enabled: true,
      routine: {
        name: "Outsider routine",
        description: "watch",
        kind: "event",
        event: EVENT,
        eventFilter: { projectId: board.id },
        ownerUserId: outsider,
        scopes: [],
        prompt: "watch",
      },
    })
    __resetEventRoutineSubscriber()
    resetEventBus()
    initEventBus()
    await registerEventRoutineSubscription({
      routineId: theirs,
      orgId: ORG,
      event: EVENT,
      filter: { projectId: board.id },
    })
    const id = await task(board, { kind: "Noise" })
    await fire(statusChanged(id, board, board.open, board.next))
    expect(ticks()).toEqual([])
  })

  test("a routine chain stops at depth 5 and tells the owner once", async () => {
    await redis.del(`routine-chain-alert:${ROUTINE}`)
    const id = await task(board, { kind: "Noise" })
    await fire(statusChanged(id, board, board.open, board.next, { hop: 4 }))
    expect(ticks().map((t) => t.triggerEvent.hop)).toEqual([4])
    enqueued.length = 0
    await fire(statusChanged(id, board, board.next, board.open, { hop: 5 }))
    await fire(statusChanged(id, board, board.open, board.next, { hop: 6 }))
    expect(ticks()).toEqual([])
    const alerts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
        AND payload->'data'->>'summary' LIKE 'A routine stopped reacting%'`
    expect(alerts[0]!.n).toBe(1)
  })
})
