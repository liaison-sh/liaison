// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tasks_aggregate: a project's (or several projects') tasks grouped and measured, the read a
// manager's dashboard charts (status counts, load per handler, aging, SLA state, sums of an
// amount field). It reads under the caller's RLS like every task read, so a viewer counts only
// the tasks they can read; a project they cannot read contributes nothing.
//
// Groups: status, assignee, priority, due (the shared due buckets), age_in_status (days since the
// task entered its status, in `ageBuckets`), sla (met / missed / open_ok / open_late: did the task
// reach one of `sla.toStatusIds` within `sla.withinWorkingDays` working days of its creation, in
// the org's working calendar, lib/working-time.ts) and field:<key> (a choice, choices, person,
// checkbox or date field; a date groups by month). An optional `series` splits each group again.
// Measures: count, sum:<key> or avg:<key> of a number or amount field. Amounts in different
// currencies (the field's `currency` per project) are never added together: each row then
// carries its `currency`, a group holding several currencies is one row per currency, and the
// result's `currency` is set only when every project read uses the same one.
//
// Each row carries `taskIds` when it holds at most 50 tasks, and `filter`, the tasks_byProject
// params that list exactly its tasks, when the group can be expressed as one (status, assignee,
// priority, due, a choice / choices / person / checkbox field, on one project).
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { addWorkingTime, resolveWorkingCalendar, type WorkingCalendar } from "~/lib/working-time"
import type { Column } from "~/modules/dashboards/tables/columns"
import { dueBucketSql } from "./due-status"
import { activeFields, fieldFilterConditions, parseStoredFields } from "./fields"
import { releaseFilterSql } from "./release-filter"
import { TASK_PRIORITIES } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { labelFilterCondition } from "./task-labels"

export const MAX_AGGREGATE_PROJECTS = 50
/** Tasks read per call; past it the result says `truncated`. */
export const MAX_AGGREGATE_TASKS = 5000
/** A row lists its task ids up to this many (for a drill). */
export const MAX_ROW_TASK_IDS = 50
export const DEFAULT_AGE_BUCKETS = [1, 3, 7, 14, 30] as const

const BUILTIN_GROUPS = ["status", "assignee", "priority", "due", "age_in_status", "sla"] as const
type BuiltinGroup = (typeof BUILTIN_GROUPS)[number]
const FIELD_GROUP_TYPES = ["choice", "choices", "person", "checkbox", "date"] as const

export interface AggregateWhere {
  statusId?: string
  terminal?: boolean
  due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
  labels?: unknown
  fields?: Record<string, unknown> | null
  release?: string
  assigneeId?: string | null
  priority?: string
}

export interface TasksAggregateArgs {
  tx: RlsClient
  orgId: string
  projectId?: string
  projectIds?: string[]
  groupBy?: string
  series?: string
  measure?: string
  where?: AggregateWhere
  includeTerminal?: boolean
  ageBuckets?: number[]
  sla?: { toStatusIds?: string[]; withinWorkingDays?: number }
  /** For tests: the instant ages and SLA deadlines are measured against. */
  now?: Date
}

export interface AggregateRow {
  group: string | null
  groupLabel: string
  series?: string | null
  seriesLabel?: string
  value: number | null
  count: number
  /** An amount measure: the currency of this row's value. */
  currency?: string
  taskIds?: string[]
  filter?: Record<string, unknown>
}

export interface TasksAggregateResult {
  rows: AggregateRow[]
  groupBy: string
  series: string | null
  measure: string
  totalTasks: number
  truncated: boolean
  currency?: string
}

interface TaskRow {
  id: string
  project_id: string
  status_id: string | null
  assignee_id: string | null
  priority: string | null
  created_at: string | Date
  status_entered_at: string | Date | null
  fields: Record<string, unknown> | null
  status_label: string | null
  status_order: number | null
  status_terminal: boolean | null
  assignee_name: string | null
  due_bucket: string
}

interface ProjectRow {
  id: string
  task_fields: unknown
}

interface StatusRow {
  id: string
  project_id: string
  label: string
  order: number
  terminal: boolean
}

function bad(code: string, message: string, details?: unknown): ProjectsServiceError {
  return new ProjectsServiceError(422, code, message, details)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function projectIdsOf(args: TasksAggregateArgs): string[] {
  const ids =
    args.projectIds !== undefined && args.projectIds !== null
      ? args.projectIds
      : args.projectId
        ? [args.projectId]
        : []
  if (!Array.isArray(ids) || ids.length === 0) {
    throw bad("invalid_params", "projectId or projectIds (1 to 50 project ids) is required")
  }
  if (ids.length > MAX_AGGREGATE_PROJECTS) {
    throw bad("invalid_params", `projectIds holds at most ${MAX_AGGREGATE_PROJECTS} projects`)
  }
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw bad("invalid_params", `a project id is a uuid (got ${JSON.stringify(id)})`)
    }
  }
  return [...new Set(ids)]
}

type Grouping = { kind: BuiltinGroup } | { kind: "field"; key: string; column: Column }

/** The field of every readable project under `key`, or a refusal. */
function fieldOf(projects: ProjectRow[], key: string, allowed: readonly string[]): Column {
  let col: Column | null = null
  for (const p of projects) {
    const found = activeFields(parseStoredFields(p.task_fields)).find((c) => c.key === key)
    if (!found) {
      throw bad("unknown_field", `field '${key}' is not a field of every project read`, {
        field: key,
      })
    }
    if (col && col.type !== found.type) {
      throw bad("invalid_group", `field '${key}' has a different type in the projects read`, {
        field: key,
      })
    }
    col = col ?? found
  }
  if (!col)
    throw bad("unknown_field", `field '${key}' is not a field of the project`, { field: key })
  if (!allowed.includes(col.type)) {
    throw bad(
      "invalid_group",
      `field '${key}' is a ${col.type} field; use one of ${allowed.join(", ")}`,
      {
        field: key,
      },
    )
  }
  return col
}

function parseGrouping(raw: string, projects: ProjectRow[], param: string): Grouping {
  if ((BUILTIN_GROUPS as readonly string[]).includes(raw)) return { kind: raw as BuiltinGroup }
  if (raw.startsWith("field:")) {
    const key = raw.slice("field:".length)
    return { kind: "field", key, column: fieldOf(projects, key, FIELD_GROUP_TYPES) }
  }
  throw bad(
    "invalid_group",
    `${param} is one of ${BUILTIN_GROUPS.join(", ")} or field:<key> (got ${JSON.stringify(raw)})`,
  )
}

type Measure = { kind: "count" } | { kind: "sum" | "avg"; key: string; column: Column }

function parseMeasure(raw: string, projects: ProjectRow[]): Measure {
  if (raw === "count") return { kind: "count" }
  const m = /^(sum|avg):(.+)$/.exec(raw)
  if (!m)
    throw bad(
      "invalid_measure",
      `measure is count, sum:<field> or avg:<field> (got ${JSON.stringify(raw)})`,
    )
  const key = m[2]!
  const column = fieldOf(projects, key, ["number", "amount"])
  return { kind: m[1] as "sum" | "avg", key, column }
}

function ageBucketsOf(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [...DEFAULT_AGE_BUCKETS]
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 12 ||
    !raw.every((d) => typeof d === "number" && Number.isFinite(d) && d > 0)
  ) {
    throw bad("invalid_params", "ageBuckets is 1 to 12 positive day counts, ascending")
  }
  const sorted = [...raw].sort((a, b) => a - b)
  if (new Set(sorted).size !== sorted.length) {
    throw bad("invalid_params", "ageBuckets holds each day count once")
  }
  return sorted
}

/** A day count as shown: 1 -> "1 day", 0.5 -> "0.5 days". */
function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`
}

/** The age buckets' keys and labels, in order: "<1d", "1-3d", ..., "30d+". */
function ageBucketDefs(bounds: number[]): Array<{ key: string; label: string; max: number }> {
  const out: Array<{ key: string; label: string; max: number }> = []
  let lo = 0
  for (const b of bounds) {
    out.push({
      key: lo === 0 ? `<${b}d` : `${lo}-${b}d`,
      label: lo === 0 ? `Less than ${days(b)}` : `${lo} to ${days(b)}`,
      max: b,
    })
    lo = b
  }
  out.push({ key: `${lo}d+`, label: `${days(lo)} or more`, max: Number.POSITIVE_INFINITY })
  return out
}

const DUE_ORDER = ["overdue", "due_soon", "later", "none", "done"] as const
const DUE_LABELS: Record<string, string> = {
  overdue: "Overdue",
  due_soon: "Due within 7 days",
  later: "Due later",
  none: "No due date",
  done: "Done",
}
const SLA_ORDER = ["met", "missed", "open_ok", "open_late"] as const
const SLA_LABELS: Record<string, string> = {
  met: "Met",
  missed: "Missed",
  open_ok: "Open, on time",
  open_late: "Open, late",
}
const PRIORITY_ORDER = [...TASK_PRIORITIES].reverse()

function toDate(v: string | Date | null): Date | null {
  if (v === null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

interface Context {
  single: boolean
  statuses: Map<string, StatusRow>
  people: Map<string, string>
  ageDefs: Array<{ key: string; label: string; max: number }>
  sla: Map<string, (typeof SLA_ORDER)[number]>
  now: Date
}

/** The keys a task falls into for one grouping (a choices field: one per value it holds). */
function keysOf(g: Grouping, t: TaskRow, ctx: Context): Array<string | null> {
  switch (g.kind) {
    case "status":
      if (!t.status_id) return [null]
      return [ctx.single ? t.status_id : (t.status_label ?? t.status_id)]
    case "assignee":
      return [t.assignee_id]
    case "priority":
      return [t.priority]
    case "due":
      return [t.due_bucket]
    case "age_in_status": {
      const since = toDate(t.status_entered_at) ?? toDate(t.created_at)
      const age = since ? (ctx.now.getTime() - since.getTime()) / 86_400_000 : 0
      return [(ctx.ageDefs.find((d) => age < d.max) ?? ctx.ageDefs[ctx.ageDefs.length - 1]!).key]
    }
    case "sla":
      return [ctx.sla.get(t.id) ?? "open_ok"]
    case "field": {
      const v = t.fields?.[g.key]
      if (v === undefined || v === null || v === "") return [null]
      if (g.column.type === "choices") {
        return Array.isArray(v) && v.length > 0 ? v.map(String) : [null]
      }
      if (g.column.type === "checkbox") return [v === true ? "true" : "false"]
      if (g.column.type === "date") return [typeof v === "string" ? v.slice(0, 7) : null]
      return [String(v)]
    }
  }
}

function labelOf(g: Grouping, key: string | null, ctx: Context): string {
  if (key === null) {
    if (g.kind === "assignee") return "Unassigned"
    if (g.kind === "status") return "No status"
    if (g.kind === "priority") return "No priority"
    return "No value"
  }
  switch (g.kind) {
    case "status":
      return ctx.single ? (ctx.statuses.get(key)?.label ?? key) : key
    case "assignee":
      return ctx.people.get(key) ?? "Former member"
    case "priority":
      return key.charAt(0).toUpperCase() + key.slice(1)
    case "due":
      return DUE_LABELS[key] ?? key
    case "age_in_status":
      return ctx.ageDefs.find((d) => d.key === key)?.label ?? key
    case "sla":
      return SLA_LABELS[key] ?? key
    case "field":
      if (g.column.type === "person") return ctx.people.get(key) ?? "Former member"
      if (g.column.type === "checkbox") return key === "true" ? "Yes" : "No"
      return key
  }
}

/** The group's sort position: the grouping's own order, then the label. */
function rankOf(g: Grouping, key: string | null, ctx: Context): number {
  if (key === null) return Number.MAX_SAFE_INTEGER
  switch (g.kind) {
    case "status":
      return ctx.single ? (ctx.statuses.get(key)?.order ?? 1e9) : 0
    case "priority":
      return PRIORITY_ORDER.indexOf(key as (typeof PRIORITY_ORDER)[number])
    case "due":
      return DUE_ORDER.indexOf(key as (typeof DUE_ORDER)[number])
    case "age_in_status":
      return ctx.ageDefs.findIndex((d) => d.key === key)
    case "sla":
      return SLA_ORDER.indexOf(key as (typeof SLA_ORDER)[number])
    case "field":
      if (g.column.type === "choice" || g.column.type === "choices") {
        const i = (g.column.choices ?? []).indexOf(key)
        return i < 0 ? 1e9 : i
      }
      if (g.column.type === "checkbox") return key === "true" ? 0 : 1
      return 0
    default:
      return 0
  }
}

/** Every group a grouping always shows, even empty (so a chart keeps its columns). */
function fixedKeys(g: Grouping, ctx: Context, includeTerminal: boolean): string[] {
  switch (g.kind) {
    case "status":
      return ctx.single
        ? [...ctx.statuses.values()].filter((s) => includeTerminal || !s.terminal).map((s) => s.id)
        : []
    case "priority":
      return [...PRIORITY_ORDER]
    case "due":
      return DUE_ORDER.filter((d) => includeTerminal || d !== "done")
    case "age_in_status":
      return ctx.ageDefs.map((d) => d.key)
    case "sla":
      return [...SLA_ORDER]
    case "field":
      if (g.column.type === "choice" || g.column.type === "choices")
        return [...(g.column.choices ?? [])]
      if (g.column.type === "checkbox") return ["true", "false"]
      return []
    default:
      return []
  }
}

/** The tasks_byProject params that list exactly this group's tasks, when one exists. */
function filterOf(g: Grouping, key: string | null, ctx: Context): Record<string, unknown> | null {
  if (!ctx.single) return null
  switch (g.kind) {
    case "status":
      return key === null ? null : { statusId: key }
    case "assignee":
      return { assigneeId: key }
    case "priority":
      return key === null ? null : { priority: key }
    case "due":
      return key === null || key === "done" ? null : { due: key }
    case "field":
      if (g.column.type === "date") return null
      if (key === null) return { fields: { [g.key]: null } }
      return {
        fields: { [g.key]: g.column.type === "checkbox" ? key === "true" : key },
      }
    default:
      return null
  }
}

function mergeFilters(
  base: Record<string, unknown>,
  ...parts: Array<Record<string, unknown> | null>
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...base }
  for (const p of parts) {
    if (p === null) return null
    for (const [k, v] of Object.entries(p)) {
      if (k === "fields" && v && typeof v === "object") {
        const prev = (out.fields ?? {}) as Record<string, unknown>
        for (const fk of Object.keys(v as Record<string, unknown>)) {
          // The group's own value would contradict a where on the same field: no single filter.
          if (fk in prev) return null
        }
        out.fields = { ...prev, ...(v as Record<string, unknown>) }
      } else {
        if (k in out && out[k] !== v) return null
        out[k] = v
      }
    }
  }
  return out
}

async function slaStates(
  tx: RlsClient,
  orgId: string,
  tasks: TaskRow[],
  sla: { toStatusIds: string[]; withinWorkingDays: number },
  cal: WorkingCalendar,
  now: Date,
): Promise<Map<string, (typeof SLA_ORDER)[number]>> {
  const out = new Map<string, (typeof SLA_ORDER)[number]>()
  if (tasks.length === 0) return out
  const reached = new Map<string, Date>()
  const idList = drizzleSql.join(
    tasks.map((t) => drizzleSql`${t.id}::uuid`),
    drizzleSql`, `,
  )
  const toList = drizzleSql.join(
    sla.toStatusIds.map((s) => drizzleSql`${s}::uuid`),
    drizzleSql`, `,
  )
  const rows = extractRows<{ task_id: string; first_at: string | Date }>(
    await tx.execute(drizzleSql`
      SELECT task_id, MIN("at") AS first_at
      FROM ${projectsRel("task_transitions")}
      WHERE org_id = ${orgId}::uuid AND task_id IN (${idList}) AND to_status_id IN (${toList})
      GROUP BY task_id
    `),
  )
  for (const r of rows) {
    const d = toDate(r.first_at)
    if (d) reached.set(r.task_id, d)
  }
  for (const t of tasks) {
    const start = toDate(t.created_at) ?? now
    const deadline = addWorkingTime(start, sla.withinWorkingDays, "working_days", cal)
    const at = reached.get(t.id)
    if (at) out.set(t.id, at.getTime() <= deadline.getTime() ? "met" : "missed")
    else out.set(t.id, now.getTime() <= deadline.getTime() ? "open_ok" : "open_late")
  }
  return out
}

async function orgCalendar(tx: RlsClient, orgId: string): Promise<WorkingCalendar> {
  const [org] = extractRows<{ timezone: string | null; business_hours: unknown }>(
    await tx.execute(drizzleSql`
      SELECT timezone, business_hours FROM ${kernelRel("organizations")}
      WHERE id = ${orgId}::uuid LIMIT 1
    `),
  )
  return resolveWorkingCalendar(
    org ? { timezone: org.timezone, businessHours: org.business_hours } : null,
  )
}

export async function tasksAggregate(args: TasksAggregateArgs): Promise<TasksAggregateResult> {
  const ids = projectIdsOf(args)
  const now = args.now ?? new Date()
  const includeTerminal = args.includeTerminal === true
  const where = args.where ?? {}
  if (typeof where !== "object" || Array.isArray(where)) {
    throw bad("invalid_params", "where is an object of tasks_byProject filters")
  }
  const idList = drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  // The projects the caller can read (RLS): the rest contribute nothing.
  const projects = extractRows<ProjectRow>(
    await args.tx.execute(drizzleSql`
      SELECT id, task_fields FROM ${projectsRel("projects")}
      WHERE org_id = ${args.orgId}::uuid AND id IN (${idList})
    `),
  )
  const groupByRaw = args.groupBy ?? "status"
  const measureRaw = args.measure ?? "count"
  if (typeof groupByRaw !== "string" || typeof measureRaw !== "string") {
    throw bad("invalid_params", "groupBy and measure are strings")
  }
  if (args.series !== undefined && args.series !== null && typeof args.series !== "string") {
    throw bad("invalid_params", "series is a string")
  }
  const group = parseGrouping(groupByRaw, projects, "groupBy")
  const series = args.series ? parseGrouping(args.series, projects, "series") : null
  const measure = parseMeasure(measureRaw, projects)
  const usesSla = group.kind === "sla" || series?.kind === "sla"
  let sla: { toStatusIds: string[]; withinWorkingDays: number } | null = null
  if (usesSla) {
    const toStatusIds = args.sla?.toStatusIds
    const within = args.sla?.withinWorkingDays
    if (
      !Array.isArray(toStatusIds) ||
      toStatusIds.length === 0 ||
      toStatusIds.length > 20 ||
      !toStatusIds.every((s) => typeof s === "string" && UUID_RE.test(s)) ||
      typeof within !== "number" ||
      !Number.isFinite(within) ||
      within < 0 ||
      within > 365
    ) {
      throw bad(
        "invalid_params",
        "an sla group needs sla: {toStatusIds: [status ids], withinWorkingDays: 0 to 365}",
      )
    }
    sla = { toStatusIds, withinWorkingDays: within }
  }

  // The same filters as tasks_byProject.
  const conds: SQL[] = [
    drizzleSql`t.org_id = ${args.orgId}::uuid`,
    drizzleSql`t.project_id IN (${idList})`,
    drizzleSql`t.archived_at IS NULL`,
  ]
  if (!includeTerminal && where.terminal === undefined)
    conds.push(drizzleSql`s.terminal IS NOT TRUE`)
  if (where.terminal === true) conds.push(drizzleSql`s.terminal IS TRUE`)
  else if (where.terminal === false) conds.push(drizzleSql`s.terminal IS NOT TRUE`)
  if (where.statusId !== undefined) {
    if (typeof where.statusId !== "string" || !UUID_RE.test(where.statusId)) {
      throw bad("invalid_params", "where.statusId is a status id")
    }
    conds.push(drizzleSql`t.status_id = ${where.statusId}::uuid`)
  }
  if (where.due !== undefined) {
    const bucket = where.due === "this_week" ? "due_soon" : where.due
    conds.push(drizzleSql`${dueBucketSql("t", "s")} = ${bucket}`)
  }
  if (where.assigneeId !== undefined) {
    if (where.assigneeId === null) conds.push(drizzleSql`t.assignee_id IS NULL`)
    else if (typeof where.assigneeId === "string" && UUID_RE.test(where.assigneeId)) {
      conds.push(drizzleSql`t.assignee_id = ${where.assigneeId}::uuid`)
    } else throw bad("invalid_params", "where.assigneeId is a user id or null")
  }
  if (where.priority !== undefined) {
    if (!(TASK_PRIORITIES as readonly string[]).includes(String(where.priority))) {
      throw bad("invalid_params", `where.priority is one of ${TASK_PRIORITIES.join(", ")}`)
    }
    conds.push(drizzleSql`t.priority = ${where.priority}`)
  }
  const releaseCond = releaseFilterSql("t", args.orgId, where.release)
  if (releaseCond) conds.push(releaseCond)
  const labelCond = await labelFilterCondition(args.tx, args.orgId, "t", where.labels)
  if (labelCond) conds.push(labelCond)
  if (where.fields !== undefined && where.fields !== null) {
    for (const p of projects) {
      conds.push(
        ...fieldFilterConditions(parseStoredFields(p.task_fields), where.fields, "t").map(
          (c) => drizzleSql`(t.project_id <> ${p.id}::uuid OR ${c})`,
        ),
      )
    }
  }
  const whereSql = drizzleSql.join(conds, drizzleSql` AND `)

  const fetched = extractRows<TaskRow>(
    await args.tx.execute(drizzleSql`
      SELECT
        t.id, t.project_id, t.status_id, t.assignee_id, t.priority, t.created_at,
        t.status_entered_at, t.fields,
        s.label AS status_label, s."order" AS status_order, s.terminal AS status_terminal,
        u.name AS assignee_name,
        ${dueBucketSql("t", "s")} AS due_bucket
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      LEFT JOIN ${kernelRel("users")} u ON u.id = t.assignee_id AND u.org_id = t.org_id
      WHERE ${whereSql}
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT ${MAX_AGGREGATE_TASKS + 1}
    `),
  )
  const truncated = fetched.length > MAX_AGGREGATE_TASKS
  const tasks = truncated ? fetched.slice(0, MAX_AGGREGATE_TASKS) : fetched

  const statuses = new Map<string, StatusRow>()
  if (projects.length > 0) {
    const readable = drizzleSql.join(
      projects.map((p) => drizzleSql`${p.id}::uuid`),
      drizzleSql`, `,
    )
    for (const s of extractRows<StatusRow>(
      await args.tx.execute(drizzleSql`
        SELECT id, project_id, label, "order", terminal FROM ${projectsRel("project_statuses")}
        WHERE org_id = ${args.orgId}::uuid AND project_id IN (${readable})
        ORDER BY "order" ASC
      `),
    )) {
      statuses.set(s.id, s)
    }
  }

  // Display names of the people a group names (assignees and person fields).
  const people = new Map<string, string>()
  for (const t of tasks)
    if (t.assignee_id && t.assignee_name) people.set(t.assignee_id, t.assignee_name)
  const personKeys = [group, series].flatMap((g) =>
    g && g.kind === "field" && g.column.type === "person" ? [g.key] : [],
  )
  const personIds = new Set<string>()
  for (const t of tasks) {
    for (const k of personKeys) {
      const v = t.fields?.[k]
      if (typeof v === "string" && UUID_RE.test(v) && !people.has(v)) personIds.add(v)
    }
  }
  if (personIds.size > 0) {
    const list = drizzleSql.join(
      [...personIds].map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    for (const u of extractRows<{ id: string; name: string | null }>(
      await args.tx.execute(drizzleSql`
        SELECT id, name FROM ${kernelRel("users")}
        WHERE org_id = ${args.orgId}::uuid AND id IN (${list})
      `),
    )) {
      if (u.name) people.set(u.id, u.name)
    }
  }

  const ctx: Context = {
    single: ids.length === 1,
    statuses,
    people,
    ageDefs: ageBucketDefs(ageBucketsOf(args.ageBuckets)),
    sla: sla
      ? await slaStates(
          args.tx,
          args.orgId,
          tasks,
          sla,
          await orgCalendar(args.tx, args.orgId),
          now,
        )
      : new Map(),
    now,
  }

  // An amount measure's currency per project (its own field definition's).
  const currencyOf = new Map<string, string | null>()
  if (measure.kind !== "count" && measure.column.type === "amount") {
    for (const p of projects) {
      const f = activeFields(parseStoredFields(p.task_fields)).find((c) => c.key === measure.key)
      currencyOf.set(p.id, f?.currency ?? null)
    }
  }
  const currencies = [...new Set(currencyOf.values())]
  const byCurrency = currencyOf.size > 0

  interface Acc {
    group: string | null
    series: string | null
    currency: string | null
    count: number
    sum: number
    valued: number
    taskIds: string[]
  }
  const accs = new Map<string, Acc>()
  const accFor = (g: string | null, s: string | null, c: string | null): Acc => {
    const k = JSON.stringify([g, s, c])
    let a = accs.get(k)
    if (!a) {
      a = { group: g, series: s, currency: c, count: 0, sum: 0, valued: 0, taskIds: [] }
      accs.set(k, a)
    }
    return a
  }
  if (!series) {
    for (const k of fixedKeys(group, ctx, includeTerminal)) {
      for (const c of byCurrency ? currencies : [null]) accFor(k, null, c)
    }
  }
  for (const t of tasks) {
    const gKeys = keysOf(group, t, ctx)
    const sKeys = series ? keysOf(series, t, ctx) : [null]
    const raw = measure.kind === "count" ? null : t.fields?.[measure.key]
    const num = typeof raw === "number" && Number.isFinite(raw) ? raw : null
    const cur = byCurrency ? (currencyOf.get(t.project_id) ?? null) : null
    for (const g of gKeys) {
      for (const s of sKeys) {
        const a = accFor(g, s, cur)
        a.count++
        if (num !== null) {
          a.sum += num
          a.valued++
        }
        if (a.taskIds.length <= MAX_ROW_TASK_IDS) a.taskIds.push(t.id)
      }
    }
  }

  const base: Record<string, unknown> = {}
  if (ctx.single) {
    base.projectId = ids[0]
    for (const [k, v] of Object.entries(where)) if (v !== undefined) base[k] = v
    if (!includeTerminal && where.terminal === undefined) base.terminal = false
  }
  const rows: AggregateRow[] = [...accs.values()]
    .sort(
      (a, b) =>
        rankOf(group, a.group, ctx) - rankOf(group, b.group, ctx) ||
        labelOf(group, a.group, ctx).localeCompare(labelOf(group, b.group, ctx)) ||
        (series
          ? rankOf(series, a.series, ctx) - rankOf(series, b.series, ctx) ||
            labelOf(series, a.series, ctx).localeCompare(labelOf(series, b.series, ctx))
          : 0) ||
        String(a.currency ?? "").localeCompare(String(b.currency ?? "")),
    )
    .map((a) => {
      const value =
        measure.kind === "count"
          ? a.count
          : measure.kind === "sum"
            ? a.sum
            : a.valued > 0
              ? a.sum / a.valued
              : null
      const row: AggregateRow = {
        group: a.group,
        groupLabel: labelOf(group, a.group, ctx),
        ...(series ? { series: a.series, seriesLabel: labelOf(series, a.series, ctx) } : {}),
        value,
        count: a.count,
        ...(a.currency ? { currency: a.currency } : {}),
      }
      if (a.taskIds.length <= MAX_ROW_TASK_IDS) row.taskIds = a.taskIds
      const filter = ctx.single
        ? mergeFilters(
            base,
            filterOf(group, a.group, ctx),
            series ? filterOf(series, a.series, ctx) : {},
          )
        : null
      if (filter) row.filter = filter
      return row
    })

  return {
    rows,
    groupBy: groupByRaw,
    series: args.series ?? null,
    measure: measureRaw,
    totalTasks: tasks.length,
    truncated,
    // One currency across every project read: the result's; several: each row says its own.
    ...(byCurrency
      ? currencies.length === 1 && currencies[0]
        ? { currency: currencies[0] }
        : {}
      : measure.kind !== "count" && measure.column.currency
        ? { currency: measure.column.currency }
        : {}),
  }
}
