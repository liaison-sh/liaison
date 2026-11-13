// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard table backed by a project (tables/backing.ts), against the real database:
//   - its rows are the project's tasks the reader can read (an archived task, another project's
//     task and every task for a reader without the projects read scope are absent), its
//     read-through columns typed from the project, then its own;
//   - an own-column write is a plain row write (history, undo, a row event), made lazily;
//   - a read-through write changes the task through the Projects write path (its transition
//     and projects event), records no table change, and is refused without projects:tasks:write;
//   - adding a row creates a task; deleting one is refused;
//   - a backing that names a missing field, or an own column that shadows a read-through one, is
//     refused; a block on the table reads the merged rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, deleteTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboardTableChanges, pendingEvents } from "~/db/schema/kernel"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import {
  createTable,
  getTable,
  listChanges,
  listRows,
  type Row,
  TableError,
  undoChange,
  updateTable,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const DASH = ["kernel:dashboards:read", "kernel:dashboards:write", "kernel:dashboards:share"]
const PROJECTS = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId = ""
let owner: UserContext
let dashOnly: UserContext
let reader: UserContext

const FIELDS = [
  { key: "problem", label: "Problem type", type: "choice", choices: ["Noise", "Power"] },
  { key: "cost", label: "Cost", type: "amount", currency: "EUR" },
]

interface Board {
  id: string
  todo: string
  doing: string
  tasks: string[]
}

async function board(): Promise<Board> {
  return withRlsContext(owner, async (tx) => {
    const p = await createProject({
      tx,
      orgId,
      actor: owner,
      input: {
        name: `backed-${randomUUID().slice(0, 8)}`,
        statuses: [{ label: "Todo" }, { label: "Doing" }, { label: "Done", terminal: true }],
        fields: FIELDS,
      },
    })
    const by = (l: string) => p.statuses.find((s) => s.label === l)!.id
    const a = await createTask({
      tx,
      orgId,
      actor: owner,
      input: { projectId: p.id, title: "Amp hums", fields: { problem: "Noise", cost: 40 } },
    })
    const b = await createTask({
      tx,
      orgId,
      actor: owner,
      input: { projectId: p.id, title: "No power", statusId: by("Doing") },
    })
    return { id: p.id, todo: by("Todo"), doing: by("Doing"), tasks: [a.id, b.id] }
  })
}

let n = 0
async function backedTable(b: Board): Promise<string> {
  n += 1
  const t = await createTable(owner, {
    name: `Repairs ${n}-${randomUUID().slice(0, 4)}`,
    columns: [{ key: "note", label: "Note", type: "text" }],
    backing: {
      app: "projects",
      entity: "task",
      parentId: b.id,
      fields: ["title", "status", "problem"],
    },
    orgAccess: "editor",
  })
  return t.id
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]))

async function tableChanges(tableId: string): Promise<number> {
  const rows = await withSystemDb("backed-changes", (tx) =>
    tx
      .select({ id: dashboardTableChanges.id })
      .from(dashboardTableChanges)
      .where(eq(dashboardTableChanges.tableId, tableId)),
  )
  return rows.length
}

async function taskEvents(
  taskId: string,
): Promise<Array<{ action: string; data: Record<string, unknown> }>> {
  const rows = await withSystemDb("backed-events", (tx) =>
    tx
      .select({ seq: pendingEvents.seq, payload: pendingEvents.payload })
      .from(pendingEvents)
      .where(
        and(
          eq(pendingEvents.orgId, orgId),
          sql`${pendingEvents.payload}->>'entity' = 'task'`,
          sql`${pendingEvents.payload}->>'entityId' = ${taskId}`,
        ),
      ),
  )
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.payload as { action: string; data: Record<string, unknown> })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = await seedOrgRow({ name: "Backed Tables Org", slug: `backed-${randomUUID()}` })
  const mk = (name: string) =>
    seedUserRow({
      orgId,
      email: `${name}-${randomUUID()}@test.com`,
      name,
      status: "active",
      passwordHash: "hash",
      authVersion: 1,
      permissionVersion: 1,
    })
  const base = { actorType: "user" as const, orgId, dimensionGrants: { "*": ["*"] } }
  owner = { ...base, userId: await mk("Owner"), scopes: [...DASH, ...PROJECTS] }
  dashOnly = { ...base, userId: await mk("Dash Only"), scopes: [...DASH] }
  reader = {
    ...base,
    userId: await mk("Reader"),
    scopes: [...DASH, "projects:projects:read", "projects:tasks:read"],
  }
  await ensureAppsForOrg(orgId, {})
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("a backed table reads the project's tasks", () => {
  it("columns: read-through ones typed from the project, then its own", async () => {
    const b = await board()
    const id = await backedTable(b)
    const t = await getTable(owner, id)
    expect(t.columns.map((c) => [c.key, c.type])).toEqual([
      ["title", "text"],
      ["status", "choice"],
      ["problem", "choice"],
      ["note", "text"],
    ])
    expect(t.columns[1]!.choices).toEqual(["Todo", "Doing", "Done"])
    expect(t.backing).toMatchObject({
      app: "projects",
      entity: "task",
      parentId: b.id,
      readThrough: ["title", "status", "problem"],
      own: ["note"],
    })
  })

  it("rows mirror the tasks the reader can read: archived and unreadable ones are absent", async () => {
    const b = await board()
    const other = await board()
    const id = await backedTable(b)
    const gone = await withRlsContext(owner, (tx) =>
      createTask({ tx, orgId, actor: owner, input: { projectId: b.id, title: "Archived" } }),
    )
    await withRlsContext(owner, (tx) => deleteTask({ tx, orgId, actor: owner, taskId: gone.id }))
    const { rows } = await listRows(owner, id)
    expect(rows.map((r) => r.id).sort()).toEqual([...b.tasks].sort())
    expect(rows.some((r) => other.tasks.includes(r.id))).toBe(false)
    const amp = byId(rows).get(b.tasks[0]!)!
    expect(amp.cells).toEqual({ title: "Amp hums", status: "Todo", problem: "Noise" })
    expect(amp.version).toBe(0)
    // Shared with the org as editor, but without the projects read scope: no task, no row.
    expect((await listRows(dashOnly, id)).rows).toEqual([])
    expect((await listRows(reader, id)).rows).toHaveLength(2)
    // The row count is the reader's: the tasks they can read, not the table's own cells.
    expect((await getTable(owner, id)).rowCount).toBe(2)
    expect((await getTable(dashOnly, id)).rowCount).toBe(0)
    // Filters, sort and the text search apply to the merged rows.
    expect(
      (await listRows(owner, id, { where: { status: "Doing" } })).rows.map((r) => r.id),
    ).toEqual([b.tasks[1]])
    expect(
      (await listRows(owner, id, { sort: "title", dir: "asc" })).rows.map((r) => r.cells.title),
    ).toEqual(["Amp hums", "No power"])
    expect((await listRows(owner, id, { q: "power" })).rows.map((r) => r.id)).toEqual([b.tasks[1]])
    const page = await listRows(owner, id, { limit: 1, sort: "title" })
    expect(page.rows).toHaveLength(1)
    expect(
      (await listRows(owner, id, { limit: 1, sort: "title", cursor: page.nextCursor! })).rows[0]!
        .cells.title,
    ).toBe("No power")
  })
})

describe("writing a backed table", () => {
  it("an own-column write is a row write made lazily, undone like any other", async () => {
    const b = await board()
    const id = await backedTable(b)
    const [row] = (await writeRows(owner, id, [
      { op: "update", id: b.tasks[0]!, ifVersion: 0, cells: { note: "call back" } },
    ])) as Row[]
    expect(row!.cells).toEqual({
      title: "Amp hums",
      status: "Todo",
      problem: "Noise",
      note: "call back",
    })
    expect(row!.version).toBe(1)
    const { changes } = await listChanges(owner, id, { rowId: b.tasks[0]! })
    expect(changes).toHaveLength(1)
    // A stale version is refused.
    await expect(
      writeRows(owner, id, [{ op: "update", id: b.tasks[0]!, ifVersion: 0, cells: { note: "x" } }]),
    ).rejects.toMatchObject({ code: "version_conflict" })
    await undoChange(owner, id, changes[0]!.id)
    const after = byId((await listRows(owner, id)).rows).get(b.tasks[0]!)!
    expect(after.cells.note).toBeUndefined()
    expect(after.cells.title).toBe("Amp hums")
  })

  it("a read-through write changes the task through Projects, with its transition and event, and no table change", async () => {
    const b = await board()
    const id = await backedTable(b)
    const taskId = b.tasks[0]!
    const [row] = (await writeRows(owner, id, [
      { op: "update", id: taskId, ifVersion: 0, cells: { status: "Doing", problem: "Power" } },
    ])) as Row[]
    expect(row!.cells).toMatchObject({ status: "Doing", problem: "Power" })
    const [task] = extractRows<{ status_id: string; fields: Record<string, unknown> }>(
      await db.execute(
        sql`SELECT status_id, fields FROM app_projects.tasks WHERE id = ${taskId}::uuid`,
      ),
    )
    expect(task!.status_id).toBe(b.doing)
    expect(task!.fields.problem).toBe("Power")
    const [transitions] = extractRows<{ n: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM app_projects.task_transitions WHERE task_id = ${taskId}::uuid AND to_status_id = ${b.doing}::uuid`,
      ),
    )
    expect(transitions!.n).toBe(1)
    const updated = (await taskEvents(taskId)).filter((e) => e.action === "updated")
    expect(updated.at(-1)?.data.changedFields).toEqual(["statusId", "fields.problem"])
    expect(await tableChanges(id)).toBe(0)
    // An unknown status label or a bad field value names the column.
    await expect(
      writeRows(owner, id, [{ op: "update", id: taskId, ifVersion: 0, cells: { status: "Lost" } }]),
    ).rejects.toMatchObject({ code: "invalid_cell", details: { column: "status" } })
    await expect(
      writeRows(owner, id, [
        { op: "update", id: taskId, ifVersion: 0, cells: { problem: "Fire" } },
      ]),
    ).rejects.toMatchObject({ code: "invalid_cell", details: { column: "problem" } })
  })

  it("a writer without projects:tasks:write is refused a read-through write, and writes nothing", async () => {
    const b = await board()
    const id = await backedTable(b)
    const err = await writeRows(reader, id, [
      { op: "update", id: b.tasks[0]!, ifVersion: 0, cells: { status: "Doing", note: "n" } },
    ]).catch((e) => e)
    expect(err).toBeInstanceOf(TableError)
    expect(err.code).toBe("forbidden")
    const row = byId((await listRows(owner, id)).rows).get(b.tasks[0]!)!
    expect(row.cells).toEqual({ title: "Amp hums", status: "Todo", problem: "Noise" })
    // Its own columns stay writable by a table editor.
    await writeRows(reader, id, [
      { op: "update", id: b.tasks[0]!, ifVersion: 0, cells: { note: "n" } },
    ])
    expect(byId((await listRows(owner, id)).rows).get(b.tasks[0]!)!.cells.note).toBe("n")
  })

  it("adding a row creates a task in the project; deleting one is refused", async () => {
    const b = await board()
    const id = await backedTable(b)
    const [added] = (await writeRows(owner, id, [
      { op: "add", cells: { title: "Fan rattles", status: "Doing", note: "from the table" } },
    ])) as Row[]
    const [task] = extractRows<{ project_id: string; title: string; status_id: string }>(
      await db.execute(
        sql`SELECT project_id, title, status_id FROM app_projects.tasks WHERE id = ${added!.id}::uuid`,
      ),
    )
    expect(task).toEqual({ project_id: b.id, title: "Fan rattles", status_id: b.doing })
    expect(added!.cells).toMatchObject({ title: "Fan rattles", note: "from the table" })
    await expect(
      writeRows(owner, id, [{ op: "add", cells: { note: "no title" } }]),
    ).rejects.toMatchObject({
      code: "invalid_cell",
      details: { column: "title" },
    })
    await expect(
      writeRows(owner, id, [{ op: "delete", id: b.tasks[0]!, ifVersion: 1 }]),
    ).rejects.toMatchObject({ code: "invalid_request" })
    // A row id that is no task of the project is refused.
    await expect(
      writeRows(owner, id, [
        { op: "update", id: randomUUID(), ifVersion: 0, cells: { note: "x" } },
      ]),
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("saving a backing", () => {
  it("refuses a missing field, an own column shadowing a read-through one, and an unreadable project", async () => {
    const b = await board()
    const make = (fields: string[], columns: unknown[] = [], projectId = b.id) =>
      createTable(owner, {
        name: `Refused ${randomUUID().slice(0, 6)}`,
        columns,
        backing: { app: "projects", entity: "task", parentId: projectId, fields },
      })
    await expect(make(["title", "nope"])).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      make(["title", "status"], [{ key: "status", label: "Mine", type: "text" }]),
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(make(["title"], [], randomUUID())).rejects.toMatchObject({
      code: "invalid_request",
    })
    // Only an entity its app declares as a table backing.
    await expect(
      createTable(owner, {
        name: `Refused ${randomUUID().slice(0, 6)}`,
        columns: [],
        backing: { app: "projects", entity: "project", parentId: b.id, fields: ["title"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    // An added own column may not take a read-through key either.
    const id = await backedTable(b)
    const t = await getTable(owner, id)
    await expect(
      updateTable(owner, id, {
        ifVersion: t.version,
        columns: { add: [{ key: "problem", label: "Mine", type: "text" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("a block on a backed table", () => {
  it("reads the merged rows as the viewer", async () => {
    const b = await board()
    const id = await backedTable(b)
    await writeRows(owner, id, [
      { op: "update", id: b.tasks[1]!, ifVersion: 0, cells: { note: "urgent" } },
    ])
    const d = await createDashboard(owner, {
      title: `Backed ${randomUUID().slice(0, 6)}`,
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "t",
            type: "table",
            title: "Repairs",
            source: { kind: "table", table: id, where: {} },
            map: {
              columns: [
                { field: "title", label: "Title" },
                { field: "status", label: "Status" },
                { field: "note", label: "Note" },
              ],
            },
          },
        ],
      },
    })
    const out = (await getBlockData(owner, d.id, "t")) as { ok: boolean; data?: unknown }
    expect(out.ok).toBe(true)
    const text = JSON.stringify(out.data)
    expect(text).toContain("Amp hums")
    expect(text).toContain("urgent")
  })
})
