// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Row links and rollup columns against the real database: a "Supplier lots" table links the rows
// of a "Parts" table, and Parts adds up the lots linking to each part. Saving checks the other
// table and its columns; a read computes the rollup under the reader's RLS (a reader who cannot
// read the lots gets the column empty with a note, and the links' labels hidden); a deleted row
// reads as an unresolved link; the picker searches the linked table as the person; writes,
// filters and sorts naming a rollup are refused; tables_query and a table block source read it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import type { RestToolCall } from "~/modules/apps/rest-tool-call"
import { dayIn } from "~/modules/dashboards/relative-dates"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { monthWindow } from "~/modules/dashboards/tables/columns"
import { searchLinkTargets } from "~/modules/dashboards/tables/link-search"
import {
  createTable,
  getTable,
  listRows,
  type Row,
  setTableSharing,
  TableError,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let ownerId = ""
let readerId = ""

async function as(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("rollup-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

const call: RestToolCall = { origin: "human-ui" }

let n = 0
/** Parts (shared with the whole org as viewers) and Supplier lots (the owner's only), linked. */
async function world() {
  n += 1
  const owner = await as(ownerId)
  const parts = await createTable(owner, {
    name: `Parts ${n}`,
    columns: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "stock", label: "Stock", type: "number" },
    ],
  })
  await setTableSharing(owner, parts.id, { orgAccess: "viewer" })
  const lots = await createTable(owner, {
    name: `Supplier lots ${n}`,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      {
        key: "part",
        label: "Part",
        type: "link",
        linkTo: { app: "kernel", entityType: "table_row", table: parts.id },
      },
      { key: "qty", label: "Quantity", type: "number" },
      { key: "eta", label: "Expected", type: "date" },
      { key: "status", label: "Status", type: "choice", choices: ["ordered", "arrived"] },
    ],
  })
  const [panel, motor] = (await writeRows(owner, parts.id, [
    { op: "add", cells: { name: "Display panel", stock: 3 } },
    { op: "add", cells: { name: "Vibration motor", stock: 8 } },
  ])) as Row[]
  const ref = (r: Row, label: string) => ({
    app: "kernel",
    entityType: "table_row",
    id: r.id,
    label,
  })
  const month = dayIn("UTC", new Date()).slice(0, 7)
  const [m0, m1] = monthWindow({ horizon: 2 }, month) as [string, string]
  await writeRows(owner, lots.id, [
    {
      op: "add",
      cells: {
        lot: "L1",
        part: ref(panel!, "Display panel"),
        qty: 40,
        eta: `${m0}-10`,
        status: "ordered",
      },
    },
    {
      op: "add",
      cells: {
        lot: "L2",
        part: ref(panel!, "Display panel"),
        qty: 15,
        eta: `${m1}-03`,
        status: "ordered",
      },
    },
    {
      op: "add",
      cells: {
        lot: "L3",
        part: ref(panel!, "Display panel"),
        qty: 100,
        eta: `${m0}-01`,
        status: "arrived",
      },
    },
    { op: "add", cells: { lot: "L4", part: ref(motor!, "Old motor name"), qty: 6 } },
  ])
  return { parts: parts.id, lots: lots.id, panel: panel!, motor: motor!, m0, m1 }
}

async function addRollups(w: Awaited<ReturnType<typeof world>>) {
  const owner = await as(ownerId)
  const t = await getTable(owner, w.parts)
  await updateTable(owner, w.parts, {
    ifVersion: t.version,
    columns: {
      add: [
        {
          key: "ordered",
          label: "Ordered",
          type: "rollup",
          emphasis: "nonzero",
          rollup: {
            table: w.lots,
            link: "part",
            value: "qty",
            agg: "sum",
            where: { status: "ordered" },
          },
        },
        {
          key: "lots",
          label: "Lots",
          type: "rollup",
          rollup: { table: w.lots, link: "part", value: null, agg: "count" },
        },
        {
          key: "by_month",
          label: "Expected by month",
          type: "rollup",
          horizon: 2,
          rollup: {
            table: w.lots,
            link: "part",
            value: "qty",
            agg: "sum",
            where: { status: "ordered" },
            byMonth: "eta",
          },
        },
      ],
    },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Rollup Tables Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Planner" })).id
  readerId = (await minimal.person(orgId, { name: "Reader" })).id
  registerDashboardTools(orgId)
})

afterAll(releaseTestLock)

describe("rollup columns", () => {
  it("a sum with where, a count and a sum by month, computed on read", async () => {
    const w = await world()
    await addRollups(w)
    const owner = await as(ownerId)
    const page = await listRows(owner, w.parts, { sort: "id" })
    const panel = page.rows.find((r) => r.id === w.panel.id)!
    const motor = page.rows.find((r) => r.id === w.motor.id)!
    expect(panel.cells.ordered).toBe(55)
    expect(panel.cells.lots).toBe(3)
    expect(panel.cells.by_month).toEqual({ [w.m0]: 40, [w.m1]: 15 })
    expect(motor.cells.ordered).toBe(0)
    expect(motor.cells.lots).toBe(1)
    expect(page.columnNotes).toBeUndefined()
    const info = await getTable(owner, w.parts)
    expect(info.columns.find((c) => c.key === "by_month")?.months).toEqual([w.m0, w.m1])
  })

  it("a reader who cannot read the other table gets the column empty with a note", async () => {
    const w = await world()
    await addRollups(w)
    const reader = await as(readerId)
    const page = await listRows(reader, w.parts)
    expect(page.rows).toHaveLength(2)
    for (const r of page.rows) {
      expect(r.cells.ordered).toBeUndefined()
      expect(r.cells.by_month).toBeUndefined()
    }
    expect(page.columnNotes?.ordered).toMatch(/cannot read the table/)
    expect(page.columnNotes?.lots).toMatch(/cannot read the table/)
  })

  it("refuses at save what does not hold, and writes, filters and sorts naming it", async () => {
    const w = await world()
    const owner = await as(ownerId)
    const add = async (rollup: Record<string, unknown>) => {
      const t = await getTable(owner, w.parts)
      return updateTable(owner, w.parts, {
        ifVersion: t.version,
        columns: { add: [{ key: "r", label: "R", type: "rollup", rollup }] },
      })
    }
    const base = { table: w.lots, link: "part", value: "qty", agg: "sum" }
    await expect(add({ ...base, link: "lot" })).rejects.toThrow(/not a link column/)
    await expect(add({ ...base, value: "lot" })).rejects.toThrow(/number or amount/)
    await expect(add({ ...base, byMonth: "qty" })).rejects.toThrow(/date column/)
    await expect(add({ ...base, where: { nope: 1 } })).rejects.toThrow(/rollup.where/)
    // Another table that does not link here.
    await expect(add({ ...base, table: w.parts, link: "name" })).rejects.toThrow(TableError)
    // A table the saver cannot read: the reader saving a rollup on their own table.
    const reader = await as(readerId)
    const mine = await createTable(reader, {
      name: `Reader table ${n}`,
      columns: [{ key: "x", label: "X", type: "text" }],
    })
    await expect(
      updateTable(reader, mine.id, {
        ifVersion: mine.version,
        columns: { add: [{ key: "r", label: "R", type: "rollup", rollup: base }] },
      }),
    ).rejects.toThrow(/cannot read the table/)
    // A rollup on create: no table links to one that does not exist yet.
    await expect(
      createTable(owner, {
        name: `New ${n}`,
        columns: [{ key: "r", label: "R", type: "rollup", rollup: base }],
      }),
    ).rejects.toThrow(/with alter/)

    await addRollups(w)
    await expect(
      writeRows(owner, w.parts, [
        { op: "update", id: w.panel.id, ifVersion: w.panel.version, cells: { ordered: 1 } },
      ]),
    ).rejects.toThrow(/rollup column/)
    await expect(listRows(owner, w.parts, { where: { ordered: 1 } })).rejects.toThrow(
      /rollup column/,
    )
    await expect(listRows(owner, w.parts, { sort: "ordered" })).rejects.toThrow(/rollup column/)
  })

  it("tables_query and a table block source read the rollup", async () => {
    const w = await world()
    await addRollups(w)
    const owner = await as(ownerId)
    const threadId = await minimal.thread(orgId, ownerId, { title: "rollups" })
    const read = await executeTool<{ rows: Array<{ id: string; cells: Record<string, unknown> }> }>(
      {
        toolName: "kernel:tables_query",
        orgId,
        actor: owner,
        threadId,
        origin: "in-app-agent",
        params: { tableId: w.parts },
      },
    )
    const panel = read.data.rows.find((r) => r.id === w.panel.id)
    expect(panel?.cells.ordered).toBe(55)
    expect(panel?.cells.by_month).toEqual({ [w.m0]: 40, [w.m1]: 15 })

    const dash = await createDashboard(owner, {
      title: "Parts",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "ordered",
            type: "metric",
            title: "Ordered",
            source: { kind: "table", table: w.parts },
            map: { value: "ordered", agg: "sum" },
          },
        ],
      },
    })
    const data = JSON.stringify(await getBlockData(owner, dash.id, "ordered"))
    expect(data.replaceAll(w.parts, "").replaceAll(dash.id, "")).toMatch(/[^0-9.]55[^0-9.]/)
  })
})

describe("links to another table's rows", () => {
  it("read with the row's label now; a deleted row reads missing; hidden to a non-reader", async () => {
    const w = await world()
    const owner = await as(ownerId)
    const lots = await listRows(owner, w.lots, { sort: "lot" })
    const l4 = lots.rows.find((r) => r.cells.lot === "L4")!
    expect((l4.cells.part as { label: string }).label).toBe("Vibration motor")

    await writeRows(owner, w.parts, [{ op: "delete", id: w.motor.id, ifVersion: w.motor.version }])
    const after = await listRows(owner, w.lots, { sort: "lot" })
    const gone = after.rows.find((r) => r.cells.lot === "L4")!.cells.part as {
      id: string
      missing?: boolean
    }
    expect(gone.id).toBe(w.motor.id)
    expect(gone.missing).toBe(true)

    // The reader may read the lots but not the parts: the labels are hidden.
    const t = await getTable(owner, w.parts)
    await setTableSharing(owner, w.parts, { orgAccess: "none" })
    await setTableSharing(owner, w.lots, { orgAccess: "viewer" })
    expect(t.id).toBe(w.parts)
    const seen = await listRows(await as(readerId), w.lots, { sort: "lot" })
    const l1 = seen.rows.find((r) => r.cells.lot === "L1")!.cells.part as { label: string }
    expect(l1.label).toBe("Linked record")
  })

  it("the picker searches the linked table as the person; a table they cannot read is refused", async () => {
    const w = await world()
    const owner = await as(ownerId)
    const found = await searchLinkTargets(
      owner,
      { app: "kernel", entityType: "table_row", table: w.parts, q: "display" },
      call,
    )
    expect(found).toEqual([
      { id: w.panel.id, label: "Display panel", app: "kernel", entityType: "table_row" },
    ])
    const reader = await as(readerId)
    await expect(
      searchLinkTargets(
        reader,
        { app: "kernel", entityType: "table_row", table: w.lots, q: "" },
        call,
      ),
    ).rejects.toThrow(TableError)
  })

  it("a link column to a table the saver cannot read is refused at save", async () => {
    const w = await world()
    const reader = await as(readerId)
    await expect(
      createTable(reader, {
        name: `Reader links ${n}`,
        columns: [
          {
            key: "lot",
            label: "Lot",
            type: "link",
            linkTo: { app: "kernel", entityType: "table_row", table: w.lots },
          },
        ],
      }),
    ).rejects.toThrow(/no table .* you can read/)
  })
})
