// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's table tools and a table on a dashboard: a row write applies at once unless the
// table's switch asks for approval (then one card, routed to the owner of a restricted table);
// a schema change always waits; a block reading a table shows its rows to readers only, and a
// row write is seen at once (the cached read keys on the table's generation).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import {
  createTable,
  listRows,
  setTableSharing,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let ownerId = ""
let editorId = ""
let outsiderId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("table-tools-perms", (tx) =>
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

const COLUMNS = [
  { key: "batch", label: "Batch", type: "text", required: true },
  { key: "status", label: "Status", type: "choice", choices: ["ordered", "arrived"] },
  { key: "qty", label: "Quantity", type: "number" },
]

let n = 0
async function table(opts: { switchOn?: boolean } = {}) {
  n += 1
  const owner = await asHeld(ownerId)
  const t = await createTable(owner, {
    name: `Repairs ${n}`,
    columns: COLUMNS,
    agentWritesNeedApproval: opts.switchOn ?? false,
  })
  await setTableSharing(owner, t.id, { users: [{ userId: editorId, role: "editor" }] })
  return t.id
}

async function agentCall(userId: string, toolName: string, params: Record<string, unknown>) {
  return executeTool({
    toolName,
    orgId,
    actor: await asHeld(userId),
    params,
    threadId: await minimal.thread(orgId, userId, { title: `call ${toolName}` }),
    origin: "in-app-agent",
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Table Tools Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Owner" })).id
  editorId = (await minimal.person(orgId, { name: "Editor" })).id
  outsiderId = (await minimal.person(orgId, { name: "Outsider" })).id
  registerDashboardTools(orgId)
})

afterAll(releaseTestLock)

describe("tables_rows_write", () => {
  it("applies at once while the table's switch is off", async () => {
    const id = await table()
    const res = await agentCall(editorId, "kernel:tables_rows_write", {
      tableId: id,
      ops: [{ op: "add", cells: { batch: "R-1", status: "ordered" } }],
    })
    expect(res.blocked).toBeUndefined()
    const rows = (await listRows(await asHeld(ownerId), id)).rows
    expect(rows.map((r) => r.cells.batch)).toEqual(["R-1"])
  })

  it("waits for the restricted table's owner once the switch is on, and writes nothing", async () => {
    const id = await table({ switchOn: true })
    const res = await agentCall(editorId, "kernel:tables_rows_write", {
      tableId: id,
      ops: [
        { op: "add", cells: { batch: "R-2", status: "arrived" } },
        { op: "add", cells: { batch: "R-3" } },
      ],
    })
    expect(res.blocked?.summary?.title).toContain(`Change 2 rows of the table "Repairs`)
    expect(res.blocked?.summary?.lines.join("\n")).toContain("Batch = R-2, Status = arrived")
    const [request] = await sql`
      SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${String(res.blocked?.approvalRequestId)}`
    expect(request?.resource_owner_id).toBe(ownerId)
    expect((await listRows(await asHeld(ownerId), id)).rows).toEqual([])
    // A person's own write never waits.
    await writeRows(await asHeld(editorId), id, [{ op: "add", cells: { batch: "by hand" } }])
    expect((await listRows(await asHeld(ownerId), id)).rows.length).toBe(1)
  })

  it("an agent of someone the table is not shared with finds no table", async () => {
    const id = await table()
    await expect(
      agentCall(outsiderId, "kernel:tables_rows_write", {
        tableId: id,
        ops: [{ op: "add", cells: { batch: "planted" } }],
      }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect((await listRows(await asHeld(ownerId), id)).rows).toEqual([])
  })
})

describe("tables_edit", () => {
  it("always waits for a person, even on the requester's own table", async () => {
    const res = await agentCall(ownerId, "kernel:tables_edit", {
      action: "create",
      name: "Inbound by agent",
      columns: COLUMNS,
    })
    expect(res.blocked?.summary?.title).toBe('Create the table "Inbound by agent"')
    expect(res.blocked?.summary?.lines[0]).toContain('"Batch" (batch): text, required')
    const id = await table()
    const owner = await asHeld(ownerId)
    const alter = await agentCall(ownerId, "kernel:tables_edit", {
      action: "alter",
      tableId: id,
      ifVersion: (await updateTable(owner, id, { ifVersion: 2, description: "x" })).version,
      columns: { drop: ["qty"] },
    })
    expect(alter.blocked?.summary?.lines.join("\n")).toContain('Drop the column "Quantity"')
  })
})

describe("a table on a dashboard", () => {
  it("shows its rows to a reader, a new row at once, and nothing to a non-reader", async () => {
    const id = await table()
    const owner = await asHeld(ownerId)
    await writeRows(owner, id, [
      { op: "add", cells: { batch: "A", status: "arrived", qty: 2 } },
      { op: "add", cells: { batch: "B", status: "ordered", qty: 3 } },
    ])
    const dash = await createDashboard(owner, {
      title: "Workshop",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "total",
            type: "metric",
            title: "Units",
            source: { kind: "table", table: id },
            map: { value: "qty", agg: "sum" },
          },
          {
            id: "grid",
            type: "table",
            title: "Repairs",
            source: { kind: "table", table: id },
            map: { editable: true, staleAfterDays: 7 },
          },
        ],
      },
    })
    const first = await getBlockData(owner, dash.id, "total")
    expect(JSON.stringify(first)).toContain("5")
    await writeRows(owner, id, [{ op: "add", cells: { batch: "C", qty: 10 } }])
    const second = await getBlockData(owner, dash.id, "total")
    expect(JSON.stringify(second)).toContain("15")

    // The dashboard is shared with the outsider, the table is not: the block refuses.
    const { setDashboardSharing } = await import("~/modules/dashboards/sharing")
    await setDashboardSharing(owner, dash.id, { users: [{ userId: outsiderId, role: "viewer" }] })
    const theirs = await getBlockData(await asHeld(outsiderId), dash.id, "total")
    expect(JSON.stringify(theirs)).toContain("no_access")
    expect(JSON.stringify(theirs)).not.toContain("15")
  })
})
