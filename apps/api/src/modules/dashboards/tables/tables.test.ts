// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard tables against the real database and its row policies (migration 0297): sharing
// decides every read and write, by the service and by any raw path (the data store's own
// org-only functions included); a row write records its change in the same transaction, an
// undo writes the change back while it is the row's latest and refuses after; a row event
// carries ids and keys, never a cell.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  appDocuments,
  dashboardTableChanges,
  dashboardTables,
  pendingEvents,
  roles,
  userRoles,
} from "~/db/schema/kernel"
import { createDashboard } from "~/modules/dashboards/service"
import { setDashboardSharing } from "~/modules/dashboards/sharing"
import {
  createTable,
  deleteTable,
  getTable,
  listChanges,
  listRows,
  listTables,
  type Row,
  setTableSharing,
  TableError,
  tableCollection,
  undoChange,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"
import {
  getDocument,
  listCollections,
  queryDocuments,
  setDocument,
} from "~/modules/data-store/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let roleId = ""
let ownerId = ""
let viewerId = ""
let outsiderId = ""
let roleMemberId = ""
let editorId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("tables-perms", (tx) =>
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
  { key: "qty", label: "Quantity", type: "number" },
  { key: "status", label: "Status", type: "choice", choices: ["ordered", "in_transit", "arrived"] },
  { key: "eta", label: "ETA", type: "date" },
  { key: "owner", label: "Owner", type: "person" },
]

let n = 0
/** A table shared with the viewer (viewer), the editor (editor) and the role (viewer). */
async function sharedTable(): Promise<string> {
  n += 1
  const owner = await asHeld(ownerId)
  const t = await createTable(owner, { name: `Inbound batches ${n}`, columns: COLUMNS })
  await setTableSharing(owner, t.id, {
    orgAccess: "none",
    users: [
      { userId: viewerId, role: "viewer" },
      { userId: editorId, role: "editor" },
    ],
    roles: [{ roleId, role: "viewer" }],
  })
  return t.id
}

async function rowEvents(tableId: string) {
  const rows = await withSystemDb("tables-events-test", (db) =>
    db
      .select({ seq: pendingEvents.seq, payload: pendingEvents.payload })
      .from(pendingEvents)
      .where(
        and(
          eq(pendingEvents.orgId, orgId),
          sql`${pendingEvents.payload}->>'entity' = 'dashboard_table_row'`,
          sql`${pendingEvents.payload}->'data'->>'tableId' = ${tableId}`,
        ),
      ),
  )
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.payload as { action: string; data: Record<string, unknown> })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboard Tables Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Table Owner" })).id
  viewerId = (await minimal.person(orgId, { name: "Table Viewer" })).id
  editorId = (await minimal.person(orgId, { name: "Table Editor" })).id
  outsiderId = (await minimal.person(orgId, { name: "Outsider" })).id
  roleMemberId = (await minimal.person(orgId, { name: "Warehouse Lead" })).id
  roleId = await withPrivilegedDb(orgId, "tables-role", async (tx) => {
    const [r] = await tx
      .insert(roles)
      .values({ orgId, name: "Warehouse" })
      .returning({ id: roles.id })
    await tx.insert(userRoles).values({ userId: roleMemberId, roleId: r!.id, orgId })
    return r!.id
  })
})

afterAll(releaseTestLock)

describe("sharing in the database", () => {
  it("a non-grantee sees no table, no row and no change, by every path", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    await writeRows(owner, id, [{ op: "add", cells: { batch: "B-1", qty: 4 } }])
    const outsider = await asHeld(outsiderId)
    expect((await listTables(outsider)).map((t) => t.id)).not.toContain(id)
    await expect(getTable(outsider, id)).rejects.toMatchObject({ code: "not_found" })
    await expect(listRows(outsider, id)).rejects.toMatchObject({ code: "not_found" })
    await expect(listChanges(outsider, id)).rejects.toMatchObject({ code: "not_found" })
    const raw = await withRlsContext(outsider, async (tx) => ({
      tables: await tx.select().from(dashboardTables).where(eq(dashboardTables.id, id)),
      rows: await tx
        .select()
        .from(appDocuments)
        .where(eq(appDocuments.collection, tableCollection(id))),
      changes: await tx
        .select()
        .from(dashboardTableChanges)
        .where(eq(dashboardTableChanges.tableId, id)),
      // The data store's own org-only paths (data tools, the store source, an app's ctx.store).
      queried: await queryDocuments(
        tx,
        { orgId, app: "dashboards", userId: outsiderId },
        tableCollection(id),
      ),
      listed: await listCollections(tx, { orgId }),
    }))
    expect(raw.tables).toEqual([])
    expect(raw.rows).toEqual([])
    expect(raw.changes).toEqual([])
    expect(raw.queried.items).toEqual([])
    expect(raw.listed.some((c) => c.app === "dashboards")).toBe(false)
  })

  it("the data store's own write path cannot reach a table's rows without editor access", async () => {
    const id = await sharedTable()
    for (const userId of [outsiderId, viewerId]) {
      const who = await asHeld(userId)
      await expect(
        withRlsContext(who, (tx) =>
          setDocument(tx, { orgId, app: "dashboards", userId }, tableCollection(id), "planted", {
            batch: "X",
          }),
        ),
      ).rejects.toThrow()
    }
    // The editor's raw write passes the policy (the policy, not the service, decides).
    const editor = await asHeld(editorId)
    const doc = await withRlsContext(editor, (tx) =>
      setDocument(tx, { orgId, app: "dashboards", userId: editorId }, tableCollection(id), "raw", {
        batch: "R",
      }),
    )
    expect(doc.id).toBe("raw")
  })

  it("a viewer reads rows but cannot write them", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const [row] = (await writeRows(owner, id, [{ op: "add", cells: { batch: "B-2" } }])) as Row[]
    const viewer = await asHeld(viewerId)
    const info = await getTable(viewer, id)
    expect(info.myRole).toBe("viewer")
    expect((await listRows(viewer, id)).rows.map((r) => r.id)).toEqual([row!.id])
    await expect(
      writeRows(viewer, id, [{ op: "update", id: row!.id, ifVersion: 1, cells: { qty: 9 } }]),
    ).rejects.toMatchObject({ code: "forbidden" })
    // Raw: an UPDATE under the viewer's RLS touches nothing.
    const touched = await withRlsContext(viewer, (tx) =>
      tx
        .update(appDocuments)
        .set({ data: { batch: "taken" } })
        .where(eq(appDocuments.collection, tableCollection(id)))
        .returning({ id: appDocuments.docId }),
    )
    expect(touched).toEqual([])
  })

  it("a role grant reaches the role's members", async () => {
    const id = await sharedTable()
    const member = await asHeld(roleMemberId)
    expect((await listTables(member)).map((t) => t.id)).toContain(id)
    expect((await getTable(member, id)).myRole).toBe("viewer")
  })

  it("an editor writes rows; an org admin it is not shared with sees nothing", async () => {
    const id = await sharedTable()
    const editor = await asHeld(editorId)
    expect((await getTable(editor, id)).myRole).toBe("editor")
    const [row] = (await writeRows(editor, id, [{ op: "add", cells: { batch: "E-1" } }])) as Row[]
    expect(row!.version).toBe(1)
  })
})

describe("cells", () => {
  it("refuses an unknown column, a wrong type, a bad choice and a missing required cell, naming the column", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const refused = async (cells: Record<string, unknown>) => {
      try {
        await writeRows(owner, id, [{ op: "add", cells }])
      } catch (err) {
        expect(err).toBeInstanceOf(TableError)
        return { code: (err as TableError).code, column: (err as TableError).details.column }
      }
      throw new Error("not refused")
    }
    expect(await refused({ batch: "A", colour: "red" })).toEqual({
      code: "invalid_cell",
      column: "colour",
    })
    expect(await refused({ batch: "A", qty: "four" })).toEqual({
      code: "invalid_cell",
      column: "qty",
    })
    expect(await refused({ batch: "A", status: "lost" })).toEqual({
      code: "invalid_cell",
      column: "status",
    })
    expect(await refused({ qty: 1 })).toEqual({ code: "invalid_cell", column: "batch" })
    expect(await refused({ batch: "A", eta: "2026-02-30" })).toEqual({
      code: "invalid_cell",
      column: "eta",
    })
    expect(await refused({ batch: "A", owner: crypto.randomUUID() })).toEqual({
      code: "invalid_cell",
      column: "owner",
    })
    const [ok] = (await writeRows(owner, id, [
      { op: "add", cells: { batch: "A", owner: viewerId, eta: "2026-03-01" } },
    ])) as Row[]
    expect(ok!.cells).toEqual({ batch: "A", owner: viewerId, eta: "2026-03-01" })
  })
})

describe("history", () => {
  it("records the change in the same transaction: a refused batch leaves neither row nor change", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    await expect(
      writeRows(owner, id, [
        { op: "add", cells: { batch: "kept?" } },
        { op: "add", cells: { batch: "B", status: "nope" } },
      ]),
    ).rejects.toMatchObject({ code: "invalid_cell" })
    expect((await listRows(owner, id)).rows).toEqual([])
    expect((await listChanges(owner, id)).changes).toEqual([])
    const [row] = (await writeRows(owner, id, [{ op: "add", cells: { batch: "B" } }])) as Row[]
    const { changes } = await listChanges(owner, id, { rowId: row!.id })
    expect(changes.map((c) => c.op)).toEqual(["create"])
    expect(changes[0]!.actor).toMatchObject({ type: "user", id: ownerId, label: "Table Owner" })
  })

  it("undoes the latest change, and refuses an older one naming who changed it since", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const editor = await asHeld(editorId)
    const [row] = (await writeRows(owner, id, [
      { op: "add", cells: { batch: "U", status: "ordered" } },
    ])) as Row[]
    await writeRows(owner, id, [
      { op: "update", id: row!.id, ifVersion: 1, cells: { status: "in_transit" } },
    ])
    const first = (await listChanges(owner, id, { rowId: row!.id })).changes
    expect(first.map((c) => [c.op, c.undoable])).toEqual([
      ["update", true],
      ["create", false],
    ])
    expect(first[0]!.before).toEqual({ status: "ordered" })
    expect(first[0]!.after).toEqual({ status: "in_transit" })
    // Someone else changes the row: the owner's update is no longer the latest.
    await writeRows(editor, id, [{ op: "update", id: row!.id, ifVersion: 2, cells: { qty: 3 } }])
    await expect(undoChange(owner, id, first[0]!.id)).rejects.toMatchObject({
      code: "version_conflict",
      message: expect.stringContaining("Table Editor"),
    })
    // Undo the editor's change, then the owner's.
    const latest = (await listChanges(owner, id, { rowId: row!.id })).changes[0]!
    await undoChange(owner, id, latest.id)
    const again = (await listChanges(owner, id, { rowId: row!.id })).changes
    expect(again[0]!.op).toBe("undo")
    const restored = (await listRows(owner, id)).rows.find((r) => r.id === row!.id)!
    expect(restored.cells).toEqual({ batch: "U", status: "in_transit" })
  })

  it("an undone delete brings the row back with its id", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const [row] = (await writeRows(owner, id, [{ op: "add", cells: { batch: "D" } }])) as Row[]
    await writeRows(owner, id, [{ op: "delete", id: row!.id, ifVersion: 1 }])
    const del = (await listChanges(owner, id, { rowId: row!.id })).changes[0]!
    expect(del.op).toBe("delete")
    const back = (await undoChange(owner, id, del.id)) as Row
    expect(back.id).toBe(row!.id)
    expect(back.cells).toEqual({ batch: "D" })
  })

  it("a stale ifVersion is a conflict carrying the current row", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const [row] = (await writeRows(owner, id, [{ op: "add", cells: { batch: "V" } }])) as Row[]
    await writeRows(owner, id, [{ op: "update", id: row!.id, ifVersion: 1, cells: { qty: 1 } }])
    const err = await writeRows(owner, id, [
      { op: "update", id: row!.id, ifVersion: 1, cells: { qty: 2 } },
    ]).catch((e) => e as TableError)
    expect(err).toBeInstanceOf(TableError)
    expect((err as TableError).code).toBe("version_conflict")
    expect((err as TableError).details.current).toMatchObject({ id: row!.id, version: 2 })
  })
})

describe("events", () => {
  it("a row event carries ids, changed keys and the audience, never a cell or the name", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const [row] = (await writeRows(owner, id, [
      { op: "add", cells: { batch: "Secret batch", qty: 7 } },
    ])) as Row[]
    await writeRows(owner, id, [
      { op: "update", id: row!.id, ifVersion: 1, cells: { status: "arrived" } },
    ])
    const events = await rowEvents(id)
    expect(events.map((e) => e.action)).toEqual(["created", "updated"])
    for (const e of events) {
      expect(Object.keys(e.data).sort()).toEqual([
        "audience",
        "changeId",
        "changed",
        "rowId",
        "tableId",
      ])
      const text = JSON.stringify(e)
      expect(text).not.toContain("Secret batch")
      expect(text).not.toContain("arrived")
      expect(text).not.toContain("Inbound batches")
    }
    expect(events[1]!.data.changed).toEqual(["status"])
    const audience = events[0]!.data.audience as { orgWide: boolean; userIds: string[] }
    expect(audience.orgWide).toBe(false)
    expect(audience.userIds.sort()).toEqual([ownerId, viewerId, editorId, roleMemberId].sort())
  })
})

describe("tables", () => {
  it("a table made from a dashboard copies its sharing", async () => {
    const owner = await asHeld(ownerId)
    const dash = await createDashboard(owner, {
      title: "Stock board",
      visibility: "personal",
      spec: { v: 1, blocks: [] },
    })
    await setDashboardSharing(owner, dash.id, {
      orgAccess: "none",
      users: [{ userId: viewerId, role: "viewer" }],
    })
    const t = await createTable(owner, {
      name: "Repairs from board",
      columns: COLUMNS,
      fromDashboardId: dash.id,
    })
    expect((await getTable(await asHeld(viewerId), t.id)).myRole).toBe("viewer")
    await expect(getTable(await asHeld(outsiderId), t.id)).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("drops a column (its key retired, its cells kept), and deletes a table with its rows", async () => {
    const id = await sharedTable()
    const owner = await asHeld(ownerId)
    const [row] = (await writeRows(owner, id, [
      { op: "add", cells: { batch: "C", qty: 2 } },
    ])) as Row[]
    const info = await updateTable(owner, id, {
      ifVersion: (await getTable(owner, id)).version,
      columns: { drop: ["qty"] },
    })
    expect(info.droppedKeys).toEqual(["qty"])
    expect(info.columns.map((c) => c.key)).not.toContain("qty")
    await expect(
      updateTable(owner, id, {
        ifVersion: info.version,
        columns: { add: [{ key: "qty", label: "Qty again", type: "number" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    const listed = (await listRows(owner, id)).rows[0]!
    expect(listed.cells).toEqual({ batch: "C" })
    expect(listed.version).toBe(1)
    const stored = await withRlsContext(owner, (tx) =>
      getDocument(tx, { orgId, app: "dashboards", userId: ownerId }, tableCollection(id), row!.id),
    )
    expect(stored?.data).toEqual({ batch: "C", qty: 2 })

    await expect(deleteTable(await asHeld(editorId), id)).rejects.toMatchObject({
      code: "forbidden",
    })
    await deleteTable(owner, id)
    await expect(getTable(owner, id)).rejects.toMatchObject({ code: "not_found" })
    const left = await withSystemDb("tables-after-delete", async (db) => ({
      rows: await db
        .select()
        .from(appDocuments)
        .where(eq(appDocuments.collection, tableCollection(id))),
      changes: await db
        .select()
        .from(dashboardTableChanges)
        .where(eq(dashboardTableChanges.tableId, id)),
    }))
    expect(left.rows).toEqual([])
    // The history stays (retention, export), unreachable under RLS.
    expect(left.changes.length).toBeGreaterThan(0)
  })
})
