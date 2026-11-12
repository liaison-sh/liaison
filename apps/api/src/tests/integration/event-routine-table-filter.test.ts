// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine on a dashboard table's row events (0298): its filter {tableId, column, to} fires it
// once on the column's transition to the value, not on other edits of the row, not on another
// table, not on its own write (firedByRoutineId), and never for a table its owner cannot read
// (the owner gate probes the table). The values are read from the change row as the owner: the
// event itself carries ids and changed keys only.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { tableRowFilterMatches } from "~/infra/jobs/event-routine-gate"
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
const { createTable, setTableSharing, writeRows, listChanges } = await import(
  "~/modules/dashboards/tables/service"
)

const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

let ORG = ""
let OWNER = ""
let OTHER = ""
let ROUTINE = ""
const EVENT = "kernel:dashboard_table_row:updated"

const ctx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
  roles: [],
})

let tableId = ""
let otherTableId = ""
let hiddenTableId = ""

const COLUMNS = [
  { key: "batch", label: "Batch", type: "text" },
  { key: "qty", label: "Quantity", type: "number" },
  { key: "status", label: "Status", type: "choice", choices: ["ordered", "in_transit", "arrived"] },
]

/** A row, then an update of it; returns the update's event as the outbox queued it. */
async function update(
  table: string,
  as: string,
  start: Record<string, unknown>,
  cells: Record<string, unknown>,
) {
  const [row] = (await writeRows(ctx(as), table, [{ op: "add", cells: start }])) as Array<{
    id: string
  }>
  await writeRows(ctx(as), table, [{ op: "update", id: row!.id, ifVersion: 1, cells }])
  const change = (await listChanges(ctx(as), table, { rowId: row!.id })).changes[0]!
  return {
    app: "kernel",
    entity: "dashboard_table_row",
    action: "updated",
    entityId: row!.id,
    data: {
      tableId: table,
      rowId: row!.id,
      changeId: change.id,
      changed: Object.keys(cells).sort(),
      audience: { orgWide: true, userIds: [] },
    },
  }
}

async function fire(evt: {
  app: string
  entity: string
  action: string
  entityId: string
  data: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  await _publishEventInternal({ ...evt, orgId: ORG })
  await flushEventHandlers()
  await new Promise((r) => setTimeout(r, COALESCE_MS + 150))
}

const FILTER = () => ({ tableId, column: "status", to: "arrived" })

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Table Routine Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  OTHER = (await minimal.person(ORG, { name: "Other" })).id
  for (const id of [OWNER, OTHER]) await minimal.grantScope(id, "*")
  initEventBus()
  tableId = (await createTable(ctx(OWNER), { name: "Inbound batches", columns: COLUMNS })).id
  otherTableId = (await createTable(ctx(OWNER), { name: "Repairs", columns: COLUMNS })).id
  // Restricted to OTHER: the routine's owner cannot read it.
  hiddenTableId = (await createTable(ctx(OTHER), { name: "Private list", columns: COLUMNS })).id
  await setTableSharing(ctx(OWNER), tableId, { orgAccess: "editor" })
  ROUTINE = await seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name: "Inbound follow-up",
      description: "follow-up",
      kind: "event",
      event: EVENT,
      eventFilter: { tableId, column: "status", to: "arrived" },
      ownerUserId: OWNER,
      scopes: ["kernel:dashboards:read"],
      prompt: "react",
    },
  })
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.app_documents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_document_usage WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.dashboard_table_changes WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.resource_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.dashboard_tables WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

beforeEach(async () => {
  enqueued.length = 0
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
  await registerEventRoutineSubscription({
    routineId: ROUTINE,
    orgId: ORG,
    event: EVENT,
    filter: FILTER(),
  })
})

describe("table row filter", () => {
  test("pure: `to` matches the transition only", () => {
    const evt = {
      app: "kernel",
      entity: "dashboard_table_row",
      action: "updated",
      orgId: ORG,
      data: { tableId: "t1", changed: ["status"] },
    }
    const f = { tableId: "t1", column: "status", to: "arrived" }
    expect(
      tableRowFilterMatches(f, evt, {
        before: { status: "ordered" },
        after: { status: "arrived" },
      }),
    ).toBe(true)
    expect(
      tableRowFilterMatches(f, evt, {
        before: { status: "arrived" },
        after: { status: "arrived" },
      }),
    ).toBe(false)
    expect(tableRowFilterMatches(f, evt, { before: null, after: { status: "arrived" } })).toBe(true)
    expect(
      tableRowFilterMatches(f, evt, {
        before: { status: "ordered" },
        after: { status: "in_transit" },
      }),
    ).toBe(false)
    expect(tableRowFilterMatches({ tableId: "t2" }, evt, null)).toBe(false)
    expect(tableRowFilterMatches({ tableId: "t1", column: "qty" }, evt, null)).toBe(false)
  })

  test("fires once on the transition to the value", async () => {
    await fire(
      await update(tableId, OWNER, { batch: "A", status: "in_transit" }, { status: "arrived" }),
    )
    expect(ticks().length).toBe(1)
    const payload = ticks()[0]![2] as { triggerEvent: { data: Record<string, unknown> } }
    expect(payload.triggerEvent.data.tableId).toBe(tableId)
  })

  test("does not fire on another column, another value or another table", async () => {
    await fire(await update(tableId, OWNER, { batch: "B", status: "ordered" }, { qty: 4 }))
    await fire(
      await update(tableId, OWNER, { batch: "C", status: "ordered" }, { status: "in_transit" }),
    )
    await fire(
      await update(otherTableId, OWNER, { batch: "D", status: "ordered" }, { status: "arrived" }),
    )
    expect(ticks().length).toBe(0)
  })

  test("does not fire on the routine's own write", async () => {
    const evt = await update(
      tableId,
      OTHER,
      { batch: "E", status: "ordered" },
      { status: "arrived" },
    )
    await fire({ ...evt, metadata: { firedByRoutineId: ROUTINE } })
    expect(ticks().length).toBe(0)
    await fire({ ...evt, metadata: { firedByRoutineId: randomUUID() } })
    expect(ticks().length).toBe(1)
  })

  test("never fires for a table its owner cannot read", async () => {
    await registerEventRoutineSubscription({
      routineId: ROUTINE,
      orgId: ORG,
      event: EVENT,
      filter: { tableId: hiddenTableId, column: "status", to: "arrived" },
    })
    await fire(
      await update(hiddenTableId, OTHER, { batch: "F", status: "ordered" }, { status: "arrived" }),
    )
    expect(ticks().length).toBe(0)
  })
})
