// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A months column against the real database: a write merges the months it names (null clears
// one) and is recorded as any cell, an undo writes the whole cell back, a read gives the
// column's window in the org's timezone, an agent writes and reads the cell through its tools,
// and a dashboard table source reads the month map.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { dayIn } from "~/modules/dashboards/relative-dates"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { monthWindow } from "~/modules/dashboards/tables/columns"
import {
  createTable,
  getTable,
  listChanges,
  listRows,
  type Row,
  undoChange,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let ownerId = ""

async function asOwner(): Promise<UserContext> {
  const perms = await withSystemDb("months-perms", (tx) =>
    loadEffectivePermissions(tx as never, ownerId, orgId),
  )
  return {
    actorType: "user",
    userId: ownerId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

const COLUMNS = [
  { key: "item", label: "Item", type: "text", required: true },
  { key: "stock", label: "Stock", type: "number", emphasis: "negative" },
  { key: "expected", label: "Expected", type: "months", horizon: 4, emphasis: "nonzero" },
]

let n = 0
async function table(): Promise<string> {
  n += 1
  return (await createTable(await asOwner(), { name: `Parts ${n}`, columns: COLUMNS })).id
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Months Tables Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Planner" })).id
  registerDashboardTools(orgId)
})

afterAll(releaseTestLock)

describe("months cells", () => {
  it("a write changes only the months it names; null clears one; undo restores the cell", async () => {
    const id = await table()
    const owner = await asOwner()
    const [added] = (await writeRows(owner, id, [
      { op: "add", cells: { item: "Display panel", expected: { "2026-11": 40, "2026-12": 0 } } },
    ])) as Row[]
    expect(added!.cells.expected).toEqual({ "2026-11": 40, "2026-12": 0 })
    const [updated] = (await writeRows(owner, id, [
      {
        op: "update",
        id: added!.id,
        ifVersion: added!.version,
        cells: { expected: { "2026-11": null, "2027-01": 25 } },
      },
    ])) as Row[]
    expect(updated!.cells.expected).toEqual({ "2026-12": 0, "2027-01": 25 })

    const { changes } = await listChanges(owner, id, { rowId: added!.id })
    const latest = changes[0]!
    expect(latest.before).toEqual({ expected: { "2026-11": 40, "2026-12": 0 } })
    expect(latest.after).toEqual({ expected: { "2026-12": 0, "2027-01": 25 } })
    await undoChange(owner, id, latest.id)
    const [row] = (await listRows(owner, id)).rows
    expect(row!.cells.expected).toEqual({ "2026-11": 40, "2026-12": 0 })
  })

  it("refuses a malformed month and a sort or filter on a months column", async () => {
    const id = await table()
    const owner = await asOwner()
    await expect(
      writeRows(owner, id, [{ op: "add", cells: { item: "X", expected: { "2026-13": 1 } } }]),
    ).rejects.toMatchObject({ code: "invalid_cell" })
    await expect(listRows(owner, id, { sort: "expected" })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("a read gives the column's window from the org's month; setOptions changes it", async () => {
    const id = await table()
    const owner = await asOwner()
    const now = dayIn("UTC", new Date()).slice(0, 7)
    const info = await getTable(owner, id)
    const col = info.columns.find((c) => c.key === "expected")
    expect(col?.months).toEqual(monthWindow({ horizon: 4 }, now))
    const next = await updateTable(owner, id, {
      ifVersion: info.version,
      columns: { setOptions: [{ key: "expected", horizon: 2, fromOffset: 1 }] },
    })
    const after = next.columns.find((c) => c.key === "expected")
    expect(after?.months).toEqual(monthWindow({ horizon: 2, fromOffset: 1 }, now))
    expect(after?.emphasis).toBe("nonzero")
  })
})

describe("agent tools and dashboard sources", () => {
  it("an agent writes one month and reads the month map back", async () => {
    const id = await table()
    const owner = await asOwner()
    const [added] = (await writeRows(owner, id, [
      { op: "add", cells: { item: "Widget", expected: { "2026-11": 5 } } },
    ])) as Row[]
    const threadId = await minimal.thread(orgId, ownerId, { title: "months" })
    const write = await executeTool({
      toolName: "kernel:tables_rows_write",
      orgId,
      actor: owner,
      threadId,
      origin: "in-app-agent",
      params: {
        tableId: id,
        ops: [
          {
            op: "update",
            id: added!.id,
            ifVersion: added!.version,
            cells: { expected: { "2026-12": 12 } },
          },
        ],
      },
    })
    expect(write.blocked).toBeUndefined()
    const read = await executeTool<{ rows: Array<{ cells: Record<string, unknown> }> }>({
      toolName: "kernel:tables_query",
      orgId,
      actor: owner,
      threadId,
      origin: "in-app-agent",
      params: { tableId: id },
    })
    expect(read.data.rows[0]?.cells.expected).toEqual({ "2026-11": 5, "2026-12": 12 })
    const got = await executeTool<{ columns: Array<{ key: string; months?: string[] }> }>({
      toolName: "kernel:tables_get",
      orgId,
      actor: owner,
      threadId,
      origin: "in-app-agent",
      params: { tableId: id },
    })
    expect(got.data.columns.find((c) => c.key === "expected")?.months).toHaveLength(4)
  })

  it("a dashboard table source reads the month map, a month mapped as <key>.<YYYY-MM>", async () => {
    const id = await table()
    const owner = await asOwner()
    await writeRows(owner, id, [
      { op: "add", cells: { item: "A", expected: { "2026-12": 7 } } },
      { op: "add", cells: { item: "B", expected: { "2026-12": 8 } } },
    ])
    const dash = await createDashboard(owner, {
      title: "Plan",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "dec",
            type: "metric",
            title: "December",
            source: { kind: "table", table: id },
            map: { value: "expected.2026-12", agg: "sum" },
          },
        ],
      },
    })
    const data = JSON.stringify(await getBlockData(owner, dash.id, "dec"))
    // Ids are random and may hold "15": only the figure counts.
    expect(data.replaceAll(id, "").replaceAll(dash.id, "")).toMatch(/[^0-9.]15[^0-9.]/)
  })
})
