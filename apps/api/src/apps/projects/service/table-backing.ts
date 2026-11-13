// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Projects' table backing provider (manifest `entities.task.tableBacking`, parent `project`):
// a dashboard table's rows are one project's tasks, read and written under the caller's RLS
// (modules/dashboards/tables/backing.ts, TableBackingProvider).
//
// - The columns a project offers: the built-ins title (text), status (a choice of the project's
//   status labels), assignee (person), due (date), priority (choice), then its own task fields
//   by key, typed as their definitions.
// - A write goes through createTask / updateTask as the writer, so the task's own history,
//   transitions and events record it; status is given by its label, null empties a value. A
//   refused value throws the dashboard CellError naming the column.
import { sql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import type { BackedRecord, TableBackingProvider } from "~/modules/dashboards/tables/backing"
import { CellError, type Column } from "~/modules/dashboards/tables/columns"
import { activeFields, parseStoredFields } from "./fields"
import { TASK_PRIORITIES } from "./resolve"
import type { UpdateTaskInput } from "./tasks"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BUILTINS = ["title", "status", "assignee", "due", "priority"] as const

interface ProjectShape {
  statuses: Array<{ id: string; label: string }>
  fields: Column[]
}

async function readProject(
  t: RlsClient,
  orgId: string,
  projectId: string,
): Promise<ProjectShape | null> {
  if (!UUID.test(projectId)) return null
  const [p] = extractRows<{ task_fields: unknown }>(
    await t.execute(sql`
      SELECT task_fields FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  if (!p) return null
  const statuses = extractRows<{ id: string; label: string }>(
    await t.execute(sql`
      SELECT id, label FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  return { statuses, fields: activeFields(parseStoredFields(p.task_fields)) }
}

function columnsOf(project: ProjectShape): Column[] {
  const builtins: Column[] = [
    { key: "title", label: "Title", type: "text", required: true },
    {
      key: "status",
      label: "Status",
      type: "choice",
      choices: [...new Set(project.statuses.map((s) => s.label))],
    },
    { key: "assignee", label: "Assignee", type: "person" },
    { key: "due", label: "Due", type: "date" },
    { key: "priority", label: "Priority", type: "choice", choices: [...TASK_PRIORITIES] },
  ]
  // A field whose key is a built-in's is shadowed by the built-in.
  return [
    ...builtins,
    ...project.fields.filter((f) => !(BUILTINS as readonly string[]).includes(f.key)),
  ]
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

async function rows(
  t: RlsClient,
  orgId: string,
  projectId: string,
  keys: readonly string[],
  opts: { id?: string; max: number },
): Promise<BackedRecord[]> {
  const project = await readProject(t, orgId, projectId)
  if (!project) return []
  if (opts.id !== undefined && !UUID.test(opts.id)) return []
  const one = opts.id ? sql`AND t.id = ${opts.id}::uuid` : sql``
  const found = extractRows<TaskRow>(
    await t.execute(sql`
      SELECT t.id, t.title, t.status_id, t.assignee_id, t.priority, t.due_date, t.fields,
             t.updated_at
        FROM ${projectsRel("tasks")} t
        LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.project_id = ${projectId}::uuid
         AND t.archived_at IS NULL ${one}
       ORDER BY s."order" ASC NULLS LAST, t.position ASC, t.created_at ASC
       LIMIT ${opts.max}
    `),
  )
  const statusLabel = new Map(project.statuses.map((s) => [s.id, s.label]))
  return found.map((r) => {
    const cells: Record<string, unknown> = {}
    for (const key of keys) {
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

async function write(
  t: RlsClient,
  viewer: UserContext,
  projectId: string,
  cells: Record<string, unknown>,
  taskId: string | null,
): Promise<string> {
  const project = await readProject(t, viewer.orgId, projectId)
  if (!project) throw new CellError("*", "the project is not one you can read")
  const input: UpdateTaskInput = {}
  const fields: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(cells)) {
    if (key === "title") {
      if (typeof v !== "string" || v.trim() === "") throw new CellError(key, "is text")
      input.title = v
    } else if (key === "status") {
      const s = project.statuses.find(
        (x) => typeof v === "string" && x.label.toLowerCase() === v.toLowerCase(),
      )
      if (!s) {
        throw new CellError(key, `is one of ${project.statuses.map((x) => x.label).join(", ")}`)
      }
      input.statusId = s.id
    } else if (key === "assignee") {
      if (v === null) input.assigneeId = null
      else if (typeof v === "string" && UUID.test(v)) input.assigneeId = v
      else throw new CellError(key, "is a member of this organisation (a user id)")
    } else if (key === "due") {
      if (v === null) input.dueDate = null
      else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) input.dueDate = v
      else throw new CellError(key, "is a date YYYY-MM-DD")
    } else if (key === "priority") {
      if (typeof v !== "string" || !(TASK_PRIORITIES as readonly string[]).includes(v)) {
        throw new CellError(key, `is one of ${TASK_PRIORITIES.join(", ")}`)
      }
      input.priority = v
    } else fields[key] = v
  }
  if (Object.keys(fields).length) input.fields = fields
  const { createTask, updateTask } = await import("./tasks")
  if (taskId === null) {
    const title = input.title
    if (title === undefined) throw new CellError("title", "a new task needs a title")
    const { statusLabel: _label, ...rest } = input
    const created = await createTask({
      tx: t,
      orgId: viewer.orgId,
      actor: viewer,
      input: { ...rest, title, projectId },
    })
    return created.id
  }
  if (Object.keys(input).length > 0) {
    await updateTask({ tx: t, orgId: viewer.orgId, actor: viewer, projectId, taskId, input })
  }
  return taskId
}

async function stamp(t: RlsClient, orgId: string, projectId: string): Promise<string> {
  if (!UUID.test(projectId)) return ""
  const [row] = extractRows<{ n: number; at: string | null }>(
    await t.execute(sql`
      SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS at FROM ${projectsRel("tasks")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid AND archived_at IS NULL
    `),
  )
  return `${row?.n ?? 0}:${row?.at ?? ""}`
}

export const taskTableBacking: TableBackingProvider = {
  writeScope: "projects:tasks:write",
  describe: async (t, orgId, projectId) => {
    const project = await readProject(t, orgId, projectId)
    return project ? { columns: columnsOf(project) } : null
  },
  rows,
  write,
  stamp,
}
