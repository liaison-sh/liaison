// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A backed dashboard table (kernel.dashboard_tables.backing, migration 0304): its rows are a
// project's tasks, read under the reader's RLS, so a task the reader cannot read is no row.
//
// - `backing` = {kind: "project_tasks", projectId, fields}: `fields` names the task values the
//   table shows, read through: the built-ins title, status, assignee, due, priority, and the
//   project's own task fields by key. Each is a column typed from the project (status: a choice
//   of the project's status labels; a field: its definition as is), keyed by its name.
// - The table's own columns are an overlay stored per task id exactly as a plain table's rows
//   (row id = task id), with the same history, undo and events; an overlay row is made by its
//   first write. An overlay column key never equals a read-through one.
// - A read-through write goes through the Projects write path as the writer (createTask /
//   updateTask, the task's own history and transitions are its record), refused when the writer
//   lacks projects:tasks:write. Adding a row creates a task; deleting one is refused.
import { sql } from "drizzle-orm"
import { z } from "zod"
import type { UpdateTaskInput } from "~/apps/projects/service/tasks"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { COLUMN_KEY_RE, type Column } from "~/modules/dashboards/tables/columns"
import type { StoreDocument, Where } from "~/modules/data-store/service"

export const PROJECT_TASKS = "project_tasks"
export const BACKING_BUILTINS = ["title", "status", "assignee", "due", "priority"] as const
export type BackingBuiltin = (typeof BACKING_BUILTINS)[number]
/** The tasks a backed table reads at most (a block source's own cap is lower). */
export const MAX_BACKED_ROWS = 2000
export const TASK_WRITE_SCOPE = "projects:tasks:write"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIORITIES = ["low", "normal", "high", "urgent"]

export const backingSchema = z
  .object({
    kind: z.literal(PROJECT_TASKS),
    projectId: z.string().regex(UUID, "a project id"),
    fields: z
      .array(z.string().regex(COLUMN_KEY_RE, "a task field key or a built-in"))
      .min(1)
      .max(40)
      .refine((f) => new Set(f).size === f.length, "each field once"),
  })
  .strict()

export type TableBacking = z.infer<typeof backingSchema>

/** The stored backing (tolerant: anything malformed reads as a plain table). */
export function parseBacking(raw: unknown): TableBacking | null {
  const parsed = backingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const P = (name: string) => sql.raw(`${quoteIdent(schemaRef("app_projects"))}.${name}`)

interface ProjectShape {
  statuses: Array<{ id: string; label: string; terminal: boolean }>
  fields: Column[]
}

/** The project as the reader sees it (null when they cannot read it). */
export async function readProject(
  t: RlsClient,
  orgId: string,
  projectId: string,
): Promise<ProjectShape | null> {
  const [p] = extractRows<{ task_fields: unknown }>(
    await t.execute(sql`
      SELECT task_fields FROM ${P("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  if (!p) return null
  const { activeFields, parseStoredFields } = await import("~/apps/projects/service/fields")
  const statuses = extractRows<{ id: string; label: string; terminal: boolean }>(
    await t.execute(sql`
      SELECT id, label, terminal FROM ${P("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  return { statuses, fields: activeFields(parseStoredFields(p.task_fields)) }
}

function builtinColumn(key: BackingBuiltin, project: ProjectShape): Column {
  switch (key) {
    case "title":
      return { key, label: "Title", type: "text", required: true }
    case "status":
      return {
        key,
        label: "Status",
        type: "choice",
        choices: [...new Set(project.statuses.map((s) => s.label))],
      }
    case "assignee":
      return { key, label: "Assignee", type: "person" }
    case "due":
      return { key, label: "Due", type: "date" }
    case "priority":
      return { key, label: "Priority", type: "choice", choices: [...PRIORITIES] }
  }
}

const isBuiltin = (k: string): k is BackingBuiltin =>
  (BACKING_BUILTINS as readonly string[]).includes(k)

/** The read-through columns, in `fields` order; a field the project no longer has is left out. */
export function readThroughColumns(backing: TableBacking, project: ProjectShape | null): Column[] {
  if (!project) return []
  const out: Column[] = []
  for (const key of backing.fields) {
    if (isBuiltin(key)) out.push(builtinColumn(key, project))
    else {
      const f = project.fields.find((c) => c.key === key)
      if (f) out.push(f)
    }
  }
  return out
}

/** Why a backing cannot be saved (null = fine): an unreadable project, a field it has not, a key
 *  an overlay column uses too. */
export function backingProblem(
  backing: TableBacking,
  project: ProjectShape | null,
  overlay: Column[],
): string | null {
  if (!project) return "no project you can read with that id"
  for (const key of backing.fields) {
    if (!isBuiltin(key) && !project.fields.some((c) => c.key === key)) {
      return `'${key}' is not a field of the project (built-ins: ${BACKING_BUILTINS.join(", ")})`
    }
    if (overlay.some((c) => c.key === key)) {
      return `the column '${key}' is read from the project: give the table's own column another key`
    }
  }
  return null
}

interface TaskRow {
  id: string
  title: string
  status_id: string | null
  assignee_id: string | null
  priority: string | null
  due_date: string | Date | null
  fields: Record<string, unknown> | null
  updated_at: string | Date
}

const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : String(d))
const day = (d: string | Date | null) =>
  d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)

/** The project's tasks the reader can read (non-archived), as read-through cells. */
export async function readTaskCells(
  t: RlsClient,
  orgId: string,
  backing: TableBacking,
  project: ProjectShape | null,
  opts: { taskId?: string } = {},
): Promise<Array<{ id: string; cells: Record<string, unknown>; updatedAt: string }>> {
  if (!project) return []
  const one = opts.taskId ? sql`AND t.id = ${opts.taskId}::uuid` : sql``
  const rows = extractRows<TaskRow>(
    await t.execute(sql`
      SELECT t.id, t.title, t.status_id, t.assignee_id, t.priority, t.due_date, t.fields,
             t.updated_at
        FROM ${P("tasks")} t
        LEFT JOIN ${P("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.project_id = ${backing.projectId}::uuid
         AND t.archived_at IS NULL ${one}
       ORDER BY s."order" ASC NULLS LAST, t.position ASC, t.created_at ASC
       LIMIT ${MAX_BACKED_ROWS}
    `),
  )
  const statusLabel = new Map(project.statuses.map((s) => [s.id, s.label]))
  return rows.map((r) => {
    const cells: Record<string, unknown> = {}
    for (const key of backing.fields) {
      let v: unknown
      if (key === "title") v = r.title
      else if (key === "status") v = r.status_id ? (statusLabel.get(r.status_id) ?? null) : null
      else if (key === "assignee") v = r.assignee_id
      else if (key === "due") v = day(r.due_date)
      else if (key === "priority") v = r.priority
      else v = r.fields?.[key]
      if (v !== undefined && v !== null) cells[key] = v
    }
    return { id: r.id, cells, updatedAt: iso(r.updated_at) }
  })
}

/** The task rows merged with their overlay documents (row id = task id). */
export function mergeOverlay(
  tasks: Array<{ id: string; cells: Record<string, unknown>; updatedAt: string }>,
  overlay: StoreDocument[],
  overlayColumns: Column[],
): StoreDocument[] {
  const byId = new Map(overlay.map((d) => [d.id, d]))
  const own = new Set(overlayColumns.map((c) => c.key))
  return tasks.map((task) => {
    const doc = byId.get(task.id)
    const data: Record<string, unknown> = { ...task.cells }
    if (doc) for (const [k, v] of Object.entries(doc.data)) if (own.has(k)) data[k] = v
    const updatedAt = doc && doc.updatedAt > task.updatedAt ? doc.updatedAt : task.updatedAt
    return { id: task.id, data, version: doc?.version ?? 0, updatedAt }
  })
}

function compare(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b))
}

/** The data store's where, applied to merged rows (equal, in, range; a list cell holds it). */
export function matchesWhere(data: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true
  for (const [key, f] of Object.entries(where)) {
    const v = data[key]
    const eq = (x: unknown) => (Array.isArray(v) ? v.includes(x) : (v ?? null) === x)
    if (f === null || typeof f !== "object") {
      if (!eq(f)) return false
    } else if ("in" in f) {
      if (!f.in.some(eq)) return false
    } else {
      if (v === undefined || v === null) return false
      if (f.gt !== undefined && !(compare(v, f.gt) > 0)) return false
      if (f.gte !== undefined && !(compare(v, f.gte) >= 0)) return false
      if (f.lt !== undefined && !(compare(v, f.lt) < 0)) return false
      if (f.lte !== undefined && !(compare(v, f.lte) <= 0)) return false
    }
  }
  return true
}

export function sortDocs(docs: StoreDocument[], field: string | undefined, dir: "asc" | "desc") {
  if (!field) return docs
  const sign = dir === "desc" ? -1 : 1
  const at = (d: StoreDocument) =>
    field === "updated_at" ? d.updatedAt : field === "doc_id" ? d.id : d.data[field]
  return [...docs].sort((a, b) => sign * compare(at(a), at(b)) || a.id.localeCompare(b.id))
}

/** A text search over the cells a reader sees (a link by its label). */
export function matchesText(data: Record<string, unknown>, text: string): boolean {
  const q = text.trim().toLowerCase()
  if (!q) return true
  return Object.values(data).some((v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return String((v as { label?: unknown }).label ?? "")
        .toLowerCase()
        .includes(q)
    }
    return String(Array.isArray(v) ? v.join(" ") : v)
      .toLowerCase()
      .includes(q)
  })
}

/** What a backed table's cached block read keys on beside its own generation: the reader's
 *  view of the project's tasks (how many, the latest change). */
export async function taskStamp(
  t: RlsClient,
  orgId: string,
  backing: TableBacking,
): Promise<string> {
  const [row] = extractRows<{ n: number; at: string | null }>(
    await t.execute(sql`
      SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS at FROM ${P("tasks")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${backing.projectId}::uuid
         AND archived_at IS NULL
    `),
  )
  return `${row?.n ?? 0}:${row?.at ?? ""}`
}

/**
 * The Projects write of a row's read-through cells, as the writer: a create (title required) or
 * an update. Status is given by its label; null empties a value.
 */
export async function writeTask(
  t: RlsClient,
  viewer: UserContext,
  backing: TableBacking,
  project: ProjectShape,
  cells: Record<string, unknown>,
  taskId: string | null,
): Promise<string> {
  const input: UpdateTaskInput = {}
  const fields: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(cells)) {
    if (key === "title") {
      if (typeof v !== "string" || v.trim() === "") throw new BackedCellError(key, "is text")
      input.title = v
    } else if (key === "status") {
      if (v === null || v === undefined) {
        throw new BackedCellError(key, "a task always has a status")
      }
      const s = project.statuses.find(
        (x) => typeof v === "string" && x.label.toLowerCase() === v.toLowerCase(),
      )
      if (!s) {
        throw new BackedCellError(
          key,
          `is one of ${project.statuses.map((x) => x.label).join(", ")}`,
        )
      }
      input.statusId = s.id
    } else if (key === "assignee") {
      if (v === null) input.assigneeId = null
      else if (typeof v === "string" && UUID.test(v)) input.assigneeId = v
      else throw new BackedCellError(key, "is a member of this organisation (a user id)")
    } else if (key === "due") {
      if (v === null) input.dueDate = null
      else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) input.dueDate = v
      else throw new BackedCellError(key, "is a date YYYY-MM-DD")
    } else if (key === "priority") {
      if (v === null || !PRIORITIES.includes(String(v))) {
        throw new BackedCellError(key, `is one of ${PRIORITIES.join(", ")}`)
      }
      input.priority = String(v)
    } else fields[key] = v
  }
  if (Object.keys(fields).length) input.fields = fields
  const { createTask, updateTask } = await import("~/apps/projects/service/tasks")
  if (taskId === null) {
    const title = input.title
    if (title === undefined) throw new BackedCellError("title", "a new task needs a title")
    const { statusLabel: _label, ...rest } = input
    const created = await createTask({
      tx: t,
      orgId: viewer.orgId,
      actor: viewer,
      input: { ...rest, title, projectId: backing.projectId },
    })
    return created.id
  }
  if (Object.keys(input).length > 0) {
    await updateTask({
      tx: t,
      orgId: viewer.orgId,
      actor: viewer,
      projectId: backing.projectId,
      taskId,
      input,
    })
  }
  return taskId
}

/** A refused read-through value: the column and why (the table's invalid_cell). */
export class BackedCellError extends Error {
  constructor(
    readonly column: string,
    readonly reason: string,
  ) {
    super(`column '${column}': ${reason}`)
  }
}

/** Is `id` a task of the backing project the reader can read? */
export async function taskReadable(
  t: RlsClient,
  orgId: string,
  backing: TableBacking,
  id: string,
): Promise<boolean> {
  if (!UUID.test(id)) return false
  const [row] = extractRows<{ id: string }>(
    await t.execute(sql`
      SELECT id FROM ${P("tasks")}
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
         AND project_id = ${backing.projectId}::uuid AND archived_at IS NULL
       LIMIT 1
    `),
  )
  return !!row
}
