// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/dashboards/tables (the contract the web builds on, plan.md): a person creates a table,
// writes rows, reads them back paged, sees the history, undoes, and a refusal carries its
// column, row or current row under error.details. Mounted before /api/dashboards/:id.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let owner = ""
let other = ""

async function req(userId: string, method: string, path: string, body?: unknown) {
  const token = await minimal.token(userId)
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Table Routes Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
})

afterAll(releaseTestLock)

describe("tables REST", () => {
  it("creates, writes, pages, lists the history and undoes", async () => {
    const created = await req(owner, "POST", "/api/dashboards/tables", {
      name: "Inbound batches",
      columns: [
        { key: "batch", label: "Batch", type: "text", required: true },
        { key: "status", label: "Status", type: "choice", choices: ["ordered", "arrived"] },
      ],
    })
    expect(created.status).toBe(201)
    const t = created.body.data
    expect(t).toMatchObject({
      name: "Inbound batches",
      myRole: "owner",
      rowCount: 0,
      droppedKeys: [],
    })

    const listed = await req(owner, "GET", "/api/dashboards/tables")
    expect(listed.body.data.tables.map((x: { id: string }) => x.id)).toContain(t.id)

    const wrote = await req(owner, "POST", `/api/dashboards/tables/${t.id}/rows`, {
      ops: [
        { op: "add", cells: { batch: "B-1", status: "ordered" } },
        { op: "add", cells: { batch: "B-2" } },
      ],
    })
    expect(wrote.status).toBe(200)
    const [row] = wrote.body.data.rows
    expect(row).toMatchObject({ cells: { batch: "B-1", status: "ordered" }, version: 1 })

    const page = await req(
      owner,
      "GET",
      `/api/dashboards/tables/${t.id}/rows?limit=1&sort=batch&dir=asc`,
    )
    expect(page.body.data.rows.map((r: { cells: { batch: string } }) => r.cells.batch)).toEqual([
      "B-1",
    ])
    expect(page.body.data.nextCursor).toBeTruthy()
    expect(page.body.data.rows[0].updatedBy.type).toBe("user")

    const upd = await req(owner, "POST", `/api/dashboards/tables/${t.id}/rows`, {
      ops: [{ op: "update", id: row.id, ifVersion: 1, cells: { status: "arrived" } }],
    })
    expect(upd.body.data.rows[0].version).toBe(2)

    const stale = await req(owner, "POST", `/api/dashboards/tables/${t.id}/rows`, {
      ops: [{ op: "update", id: row.id, ifVersion: 1, cells: { status: "ordered" } }],
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("version_conflict")
    expect(stale.body.error.details.current).toMatchObject({ id: row.id, version: 2 })

    const bad = await req(owner, "POST", `/api/dashboards/tables/${t.id}/rows`, {
      ops: [{ op: "add", cells: { batch: "B-3", status: "lost" } }],
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toMatchObject({ code: "invalid_cell", details: { column: "status" } })

    const history = await req(
      owner,
      "GET",
      `/api/dashboards/tables/${t.id}/changes?rowId=${row.id}`,
    )
    const [latest] = history.body.data.changes
    expect(latest).toMatchObject({ op: "update", undoable: true, after: { status: "arrived" } })
    const undone = await req(
      owner,
      "POST",
      `/api/dashboards/tables/${t.id}/changes/${latest.id}/undo`,
    )
    expect(undone.status).toBe(200)
    expect(undone.body.data.cells.status).toBe("ordered")

    const sharing = await req(owner, "GET", `/api/dashboards/tables/${t.id}/sharing`)
    expect(sharing.body.data).toMatchObject({ orgAccess: "none", canManage: true, dimensions: [] })
  })

  it("is invisible to someone it is not shared with", async () => {
    const created = await req(owner, "POST", "/api/dashboards/tables", {
      name: "Repairs",
      columns: [{ key: "item", label: "Item", type: "text" }],
    })
    const id = created.body.data.id
    expect((await req(other, "GET", `/api/dashboards/tables/${id}`)).status).toBe(404)
    expect((await req(other, "GET", `/api/dashboards/tables/${id}/rows`)).status).toBe(404)
    const write = await req(other, "POST", `/api/dashboards/tables/${id}/rows`, {
      ops: [{ op: "add", cells: { item: "x" } }],
    })
    expect(write.status).toBe(404)
    const mine = await req(other, "GET", "/api/dashboards/tables")
    expect(mine.body.data.tables.map((x: { id: string }) => x.id)).not.toContain(id)
  })

  // A link column without `linkTo` names no app: its picker searches every app (it was a 400).
  it("searches link targets without an app", async () => {
    const any = await req(owner, "GET", "/api/dashboards/tables/link-search?q=")
    expect(any.status).toBe(200)
    expect(any.body.data.items).toEqual([])
    const one = await req(owner, "GET", "/api/dashboards/tables/link-search?app=kernel&q=")
    expect(one.status).toBe(200)
    expect(Array.isArray(one.body.data.items)).toBe(true)
  })

  it("answers conflict for a name already taken", async () => {
    await req(owner, "POST", "/api/dashboards/tables", { name: "Twice", columns: [] })
    const again = await req(owner, "POST", "/api/dashboards/tables", { name: "Twice", columns: [] })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("conflict")
  })
})

describe("tables REST: a project backing", () => {
  it("takes a backing on create and refuses one naming no project the person can read", async () => {
    const res = await req(owner, "POST", "/api/dashboards/tables", {
      name: "Backed by nothing",
      columns: [],
      backing: {
        kind: "project_tasks",
        projectId: "00000000-0000-4000-8000-000000000000",
        fields: ["title"],
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: "invalid_request" })
    expect(res.body.error.message).toContain("backing: no project you can read")
  })
})
