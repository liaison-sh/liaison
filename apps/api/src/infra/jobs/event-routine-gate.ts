// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The owner gate and the mail sender filter of event routines.
 *
 * A routine runs as its OWNER. An event that reaches it is data the owner's
 * agent will read, so an event about an entity the owner cannot see must never
 * fire it: another member's personal-mailbox mail, a personal calendar's event,
 * a private contact, a personal MCP connection, a personal knowledge document.
 * The bus delivers every event of the org to every subscriber, so the
 * subscriber re-reads the event's entity AS THE OWNER, under RLS, before it
 * enqueues anything, and drops the event when that read finds nothing.
 *
 * Families whose entity carries no per-owner visibility (tickets, social
 * findings, inventory, ...) have no resolver here and pass unchanged.
 *
 * The mail sender filter narrows a `mail:message:create` routine to mail FROM
 * given contacts or members of given contact groups. It is evaluated before any
 * tick is enqueued, so a non-matching mail spends no tokens, and it resolves the
 * sender under the owner's RLS too: a private contact of someone else, or a
 * group member the owner cannot see, never matches.
 */
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** The subset of an `AppEvent` the gate reads. */
export interface GateEvent {
  app: string
  entity: string
  action: string
  orgId: string
  entityId?: unknown
  data?: unknown
}

interface EntityProbe {
  /** Schema-qualified table, unquoted parts. */
  schema: string
  table: string
  /** The probed id is this `data` key, not the event's entity id (a table row: its table). */
  idDataKey?: string
  /** When the entity row is gone (a delete event), the parent whose
   *  visibility stands in for it, read from these `data` keys in order. */
  parents?: Array<{ dataKey: string; schema: string; table: string }>
}

const mailProbe = (table: string): EntityProbe => ({
  schema: "app_mail",
  table,
  parents: [{ dataKey: "accountId", schema: "app_mail", table: "accounts" }],
})
const calendarProbe = (table: string): EntityProbe => ({
  schema: "app_calendar",
  table,
  parents: [
    { dataKey: "calendarId", schema: "app_calendar", table: "calendars" },
    { dataKey: "accountId", schema: "app_calendar", table: "accounts" },
  ],
})

/**
 * One resolver per ownership-bearing event family, keyed `<app>:<entity>`.
 * A family missing from this map has no owner-scoped entity and passes.
 */
const OWNER_SCOPED_FAMILIES: Record<string, EntityProbe> = {
  "mail:message": mailProbe("messages"),
  "mail:conversation": mailProbe("conversations"),
  "mail:account": { schema: "app_mail", table: "accounts" },
  "calendar:event": calendarProbe("events"),
  "calendar:calendar": calendarProbe("calendars"),
  "calendar:account": { schema: "app_calendar", table: "accounts" },
  "kernel:contact": { schema: "kernel", table: "contacts" },
  "mcp-manager:connection": { schema: "app_mcp_manager", table: "mcp_connections" },
  "knowledge:document": { schema: "app_knowledge", table: "documents" },
  // A dashboard table's row (modules/dashboards/tables): the owner must read its table (0298).
  "kernel:dashboard_table_row": {
    schema: "kernel",
    table: "dashboard_tables",
    idDataKey: "tableId",
  },
  "kernel:dashboard_table": { schema: "kernel", table: "dashboard_tables", idDataKey: "tableId" },
  // A project task (its field values ride in the event): the owner must read the task.
  "projects:task": {
    schema: "app_projects",
    table: "tasks",
    parents: [{ dataKey: "projectId", schema: "app_projects", table: "projects" }],
  },
}

function asUuid(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null
}

function dataOf(evt: GateEvent): Record<string, unknown> {
  return evt.data && typeof evt.data === "object" && !Array.isArray(evt.data)
    ? (evt.data as Record<string, unknown>)
    : {}
}

/** Whether events of this family must pass the owner gate. */
export function isOwnerScopedEvent(evt: Pick<GateEvent, "app" | "entity">): boolean {
  return `${evt.app}:${evt.entity}` in OWNER_SCOPED_FAMILIES
}

/** The routine owner's effective RLS context, or null when the routine is gone. */
export async function loadRoutineOwnerContext(
  orgId: string,
  routineId: string,
): Promise<UserContext | null> {
  if (!asUuid(routineId)) return null
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  return withPrivilegedDb(orgId, "event-routine-owner-gate", async (tx) => {
    const [row] = extractRows<{ owner_user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT owner_user_id FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.routines
        WHERE id = ${routineId}::uuid AND org_id = ${orgId}::uuid
        LIMIT 1`),
    )
    if (!row) return null
    const perms = await loadEffectivePermissions(tx, row.owner_user_id, orgId)
    return {
      actorType: "user",
      userId: row.owner_user_id,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
  })
}

function tableSql(schema: string, table: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`)
}

async function rowExists(
  tx: { execute: RlsClient["execute"] },
  schema: string,
  table: string,
  id: string,
  orgId: string,
): Promise<boolean> {
  const rows = extractRows(
    await tx.execute(drizzleSql`
      SELECT 1 AS ok FROM ${tableSql(schema, table)}
      WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
  )
  return rows.length > 0
}

/**
 * Whether the routine owner can see the entity this event is about.
 *
 *  - Families with no owner-scoped entity: true.
 *  - The entity row is visible to the owner under RLS: true.
 *  - The row exists but the owner cannot see it: false.
 *  - The row is gone (a delete event): the first parent named in the event's
 *    data decides (the mailbox, the calendar); with no parent to read, false.
 *  - Anything unreadable (no entity id, an error): false. The gate fails closed.
 */
export async function ownerCanSeeEventEntity(owner: UserContext, evt: GateEvent): Promise<boolean> {
  const probe = OWNER_SCOPED_FAMILIES[`${evt.app}:${evt.entity}`]
  if (!probe) return true
  const id = probe.idDataKey
    ? asUuid(dataOf(evt)[probe.idDataKey])
    : (asUuid(evt.entityId) ?? asUuid(dataOf(evt).id))
  if (!id) return false
  const visible = await withRlsContext(
    owner,
    (tx) => rowExists(tx, probe.schema, probe.table, id, owner.orgId),
    { pool: "jobs" },
  )
  if (visible) return true
  const exists = await withPrivilegedDb(owner.orgId, "event-routine-owner-gate-exists", (tx) =>
    rowExists(tx, probe.schema, probe.table, id, owner.orgId),
  )
  if (exists) return false
  const data = dataOf(evt)
  for (const parent of probe.parents ?? []) {
    const parentId = asUuid(data[parent.dataKey])
    if (!parentId) continue
    return withRlsContext(
      owner,
      (tx) => rowExists(tx, parent.schema, parent.table, parentId, owner.orgId),
      { pool: "jobs" },
    )
  }
  return false
}

/** The label a reader sees on a link to an app they may not open (dashboard tables, projects). */
const HIDDEN_LINK_LABEL = "Linked record"

/**
 * The event data a routine is handed, as its owner may read it. A project task event carries the
 * task's field values as its WRITER may read them; a link value to an app the owner may not open
 * gets the hidden label here, as a read by the owner would show it. Other families pass as is.
 */
export function eventDataForOwner(owner: UserContext | null, evt: GateEvent): unknown {
  if (`${evt.app}:${evt.entity}` !== "projects:task" || !owner) return evt.data
  const data = dataOf(evt)
  const fields = data.fields
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return evt.data
  const sees = (app: string) =>
    app === "kernel" || owner.scopes.some((s) => s === "*" || s === app || s.startsWith(`${app}:`))
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    const app =
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as { app?: unknown }).app
        : undefined
    masked[k] =
      typeof app === "string" && !sees(app)
        ? { ...(v as Record<string, unknown>), label: HIDDEN_LINK_LABEL }
        : v
  }
  return { ...data, fields: masked }
}

// ── Mail sender filter (S26) ────────────────────────────────────────────────

export interface MailSenderFilter {
  fromContactIds?: string[]
  fromGroupIds?: string[]
}

/** What the database says about a sender, as the routine owner sees it. */
export interface SenderMembership {
  contactIds: string[]
  groupIds: string[]
}

/** Whether a filter narrows anything (an empty filter matches every mail). */
export function isMailSenderFilterActive(filter: MailSenderFilter | null | undefined): boolean {
  return Boolean(
    filter && ((filter.fromContactIds?.length ?? 0) > 0 || (filter.fromGroupIds?.length ?? 0) > 0),
  )
}

/** Whether the filter applies to events of this family (only new mail messages). */
export function isMailSenderFilterEvent(
  evt: Pick<GateEvent, "app" | "entity" | "action">,
): boolean {
  return evt.app === "mail" && evt.entity === "message" && evt.action === "create"
}

/**
 * The sender a filter is matched against: `data.from.email` of an INBOUND
 * `mail:message:create`, lowercased. Null for outbound mail and for events
 * without a usable sender address.
 */
export function inboundSenderEmail(evt: GateEvent): string | null {
  if (!isMailSenderFilterEvent(evt)) return null
  const data = dataOf(evt)
  if ((data.direction ?? "inbound") !== "inbound") return null
  const from = data.from
  const email =
    from && typeof from === "object" && !Array.isArray(from)
      ? (from as { email?: unknown }).email
      : null
  return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null
}

/**
 * Pure: does this mail event pass the filter, given the sender's membership?
 * An inactive filter passes everything. An active filter passes only an inbound
 * mail whose sender is one of the listed contacts or a member of a listed group.
 */
export function mailSenderFilterMatches(
  filter: MailSenderFilter | null | undefined,
  evt: GateEvent,
  membership: SenderMembership,
): boolean {
  if (!isMailSenderFilterActive(filter)) return true
  if (!inboundSenderEmail(evt)) return false
  // The From address is whatever the sender typed. A filter naming trusted
  // contacts or groups matches only a message the receiving provider
  // authenticated (SPF/DKIM/DMARC pass).
  if (dataOf(evt).senderAuth !== "pass") return false
  const contacts = new Set(filter?.fromContactIds ?? [])
  const groups = new Set(filter?.fromGroupIds ?? [])
  return (
    membership.contactIds.some((id) => contacts.has(id)) ||
    membership.groupIds.some((id) => groups.has(id))
  )
}

/** The contacts carrying `email` and the manual groups they belong to, as the
 *  caller's RLS context sees them. */
export async function loadSenderMembership(
  tx: RlsClient,
  orgId: string,
  email: string,
): Promise<SenderMembership> {
  const k = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
  const rows = extractRows<{ contact_id: string; segment_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT c.id::text AS contact_id, m.segment_id::text AS segment_id
      FROM ${k}.contacts c
      LEFT JOIN ${k}.contact_group_members m ON m.contact_id = c.id AND m.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid AND lower(c.email) = ${email}`),
  )
  return {
    contactIds: [...new Set(rows.map((r) => r.contact_id))],
    groupIds: [...new Set(rows.flatMap((r) => (r.segment_id ? [r.segment_id] : [])))],
  }
}

/** Evaluate the filter for one event as the routine owner. */
export async function ownerMailSenderFilterMatches(
  owner: UserContext,
  filter: MailSenderFilter | null | undefined,
  evt: GateEvent,
): Promise<boolean> {
  if (!isMailSenderFilterActive(filter)) return true
  const email = inboundSenderEmail(evt)
  if (!email) return false
  const membership = await withRlsContext(
    owner,
    (tx) => loadSenderMembership(tx, owner.orgId, email),
    { pool: "jobs" },
  )
  return mailSenderFilterMatches(filter, evt, membership)
}

/** The subset of an `AppEvent` the origin classifier reads. */
export interface OriginEvent extends GateEvent {
  actorType?: string
  actorId?: string | null
}

async function isActiveOrgMember(orgId: string, userId: string | null): Promise<boolean> {
  const id = asUuid(userId)
  if (!id) return false
  return withPrivilegedDb(orgId, "event-routine-origin-member", async (tx) => {
    const rows = extractRows<{ one: number }>(
      await tx.execute(
        drizzleSql`SELECT 1 AS one FROM ${K()}.users
          WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid AND status = 'active' LIMIT 1`,
      ),
    )
    return rows.length > 0
  })
}

/**
 * Where a routine's triggering event came from (`TriggerEventOrigin`, scopes/taint.ts). Only an
 * event that carries text written outside the organisation taints the tick it fires.
 *
 * - Families whose payload is outside text by nature are external whoever the emitting actor is
 *   (a mail sync job runs under the mailbox owner's identity): any inbound mail (its From is not
 *   authenticated, and a member's forward carries a customer's words), an inbound ticket message,
 *   any mail conversation event, any social event, and a thread message an AGENT posted (it can
 *   carry what its turn read outside; a member's own message stays internal).
 * - Every other event is internal when an active org member (directly, through their agent or an
 *   MCP client) produced it, and external otherwise: a system actor is a webhook, a sync or an
 *   ingestion, i.e. a third party's payload.
 * Fails closed: an event that cannot be judged is external.
 */
export async function triggerEventOrigin(evt: OriginEvent): Promise<"external" | "internal"> {
  try {
    const data = dataOf(evt)
    if (evt.app === "social") return "external"
    if (evt.app === "mail" && evt.entity === "conversation") return "external"
    // An inbound mail is outside text whoever its From names: the header is not authenticated
    // here, and a member forwarding or quoting a customer carries the customer's words.
    if (isMailSenderFilterEvent(evt) && (data.direction ?? "inbound") === "inbound") {
      return "external"
    }
    // An agent's post can carry what its turn read outside, and thread posts are not gated.
    if (
      evt.app === "kernel" &&
      evt.entity === "message" &&
      (evt.actorType === "agent" || data.authorType === "agent")
    ) {
      return "external"
    }
    if (
      evt.app === "tickets" &&
      evt.entity === "message" &&
      data.kind !== "outbound" &&
      data.kind !== "note"
    ) {
      return "external"
    }
    if (evt.actorType === "user" || evt.actorType === "agent" || evt.actorType === "mcp") {
      return (await isActiveOrgMember(evt.orgId, evt.actorId ?? null)) ? "internal" : "external"
    }
    return "external"
  } catch {
    return "external"
  }
}

// ── Dashboard table row filter (0298) ───────────────────────────────────────

/**
 * The filter of a `kernel:dashboard_table_row:*` routine: one table, optionally one column, and
 * optionally the value that column changes TO. `to` matches when the change's `after[column]`
 * equals it and, unless the row was created, `before[column]` did not.
 */
export interface TableRowFilter {
  tableId: string
  column?: string
  to?: string | number | boolean | null
}

/** A routine's stored filter: a mail sender filter or a table row filter. */
export type RoutineEventFilter =
  | (MailSenderFilter & Partial<TableRowFilter> & ProjectTaskFilter)
  | null

export const TABLE_ROW_EVENTS = [
  "kernel:dashboard_table_row:created",
  "kernel:dashboard_table_row:updated",
  "kernel:dashboard_table_row:deleted",
] as const

export function isTableRowEvent(evt: Pick<GateEvent, "app" | "entity">): boolean {
  return evt.app === "kernel" && evt.entity === "dashboard_table_row"
}

/** Whether the filter is a table row filter (it names a table). */
export function isTableRowFilter(filter: unknown): filter is TableRowFilter {
  return Boolean(
    filter &&
      typeof filter === "object" &&
      typeof (filter as { tableId?: unknown }).tableId === "string",
  )
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Pure: does this table row event pass the filter, given the change (its before and after
 * cells) as the owner reads it? A filter on another table, a column the change did not touch,
 * or a `to` the column did not move to, drops the event.
 */
export function tableRowFilterMatches(
  filter: TableRowFilter,
  evt: GateEvent,
  change: { before: Record<string, unknown> | null; after: Record<string, unknown> | null } | null,
): boolean {
  const data = dataOf(evt)
  if (data.tableId !== filter.tableId) return false
  if (!filter.column) return true
  const changed = Array.isArray(data.changed) ? data.changed : []
  if (!changed.includes(filter.column)) return false
  if (filter.to === undefined) return true
  if (!change?.after) return false
  const after = change.after[filter.column]
  if (!sameValue(after, filter.to)) return false
  if (!change.before) return true
  return !sameValue(change.before[filter.column], filter.to)
}

/**
 * Evaluates a table row filter as the routine owner: the change is read under the owner's RLS
 * (a table they cannot read yields nothing, so nothing matches). Fails closed.
 */
export async function ownerTableRowFilterMatches(
  owner: UserContext,
  filter: TableRowFilter,
  evt: GateEvent,
): Promise<boolean> {
  const data = dataOf(evt)
  if (data.tableId !== filter.tableId) return false
  if (filter.to === undefined) return tableRowFilterMatches(filter, evt, null)
  const changeId = asUuid(data.changeId)
  if (!changeId) return false
  const change = await withRlsContext(
    owner,
    async (tx) => {
      const rows = extractRows<{
        before: Record<string, unknown> | null
        after: Record<string, unknown> | null
      }>(
        await tx.execute(drizzleSql`
          SELECT before, after FROM ${K()}.dashboard_table_changes
           WHERE id = ${changeId}::uuid AND org_id = ${owner.orgId}::uuid LIMIT 1`),
      )
      return rows[0] ?? null
    },
    { pool: "jobs" },
  )
  if (!change) return false
  return tableRowFilterMatches(filter, evt, change)
}

// ── Projects task filter (0303) ─────────────────────────────────────────────

/**
 * The filter of a `projects:task:status_changed|updated|created` routine: one project, a status
 * change (from, to; `fromStatusId: null` = a task created directly in `toStatusId`), and field
 * values (a value, or a list of accepted values; null = the field is empty).
 */
export interface ProjectTaskFilter {
  projectId?: string
  fromStatusId?: string | null
  toStatusId?: string
  fields?: Record<string, unknown>
}

const PROJECT_TASK_FILTER_ACTIONS = new Set(["status_changed", "updated", "created"])

export function isProjectTaskFilterEvent(
  evt: Pick<GateEvent, "app" | "entity" | "action">,
): boolean {
  return (
    evt.app === "projects" && evt.entity === "task" && PROJECT_TASK_FILTER_ACTIONS.has(evt.action)
  )
}

/** Whether the filter names anything a projects task filter matches on. */
export function isProjectTaskFilter(filter: unknown): filter is ProjectTaskFilter {
  if (!filter || typeof filter !== "object") return false
  const f = filter as ProjectTaskFilter
  return (
    f.projectId !== undefined ||
    f.fromStatusId !== undefined ||
    f.toStatusId !== undefined ||
    f.fields !== undefined
  )
}

/**
 * Pure: does a task cell hold this filter value? Mirrors the projects field filter
 * (fields.ts `fieldFilterConditions`): null matches an empty cell, a choices cell holds the value,
 * a link cell's record id equals it, a person cell compares without case.
 */
export function taskCellMatches(cell: unknown, value: unknown): boolean {
  const empty =
    cell === undefined || cell === null || cell === "" || (Array.isArray(cell) && cell.length === 0)
  if (value === null) return empty
  if (empty) return false
  if (Array.isArray(cell)) return cell.some((c) => sameValue(c, value))
  if (typeof cell === "object" && cell !== null && "id" in cell) {
    return String((cell as { id?: unknown }).id) === String(value)
  }
  if (typeof cell === "string" && typeof value === "string") {
    return cell === value || cell.toLowerCase() === value.toLowerCase()
  }
  return sameValue(cell, value)
}

/**
 * Pure: does this projects task event pass the filter? `data` is the event's data; `task` is the
 * task as the owner reads it now (its project and fields), null when the owner cannot read it
 * (nothing matches then). From/to status come from the event itself (each transition matters,
 * not the task's current status).
 */
export function projectTaskFilterMatches(
  filter: ProjectTaskFilter,
  evt: Pick<GateEvent, "action" | "data">,
  task: { projectId: string; fields: Record<string, unknown> } | null,
): boolean {
  if (!task) return false
  const data = dataOf({ app: "", entity: "", action: "", orgId: "", data: evt.data })
  if (filter.projectId !== undefined && task.projectId !== filter.projectId) return false
  if (filter.fromStatusId !== undefined || filter.toStatusId !== undefined) {
    if (evt.action !== "status_changed") return false
    if (filter.toStatusId !== undefined && data.toStatusId !== filter.toStatusId) return false
    if (filter.fromStatusId !== undefined && (data.fromStatusId ?? null) !== filter.fromStatusId) {
      return false
    }
  }
  for (const [key, want] of Object.entries(filter.fields ?? {})) {
    const cell = task.fields[key]
    const ok = Array.isArray(want)
      ? want.some((w) => taskCellMatches(cell, w))
      : taskCellMatches(cell, want)
    if (!ok) return false
  }
  return true
}

/**
 * Evaluates a projects task filter as the routine owner: the task is read fresh under the owner's
 * RLS (its project and fields), so a task the owner cannot read never matches. Fails closed.
 */
export async function ownerProjectTaskFilterMatches(
  owner: UserContext,
  filter: ProjectTaskFilter,
  evt: GateEvent,
): Promise<boolean> {
  const taskId = asUuid(evt.entityId) ?? asUuid(dataOf(evt).id)
  if (!taskId) return false
  const task = await withRlsContext(
    owner,
    async (tx) => {
      const rows = extractRows<{ project_id: string; fields: Record<string, unknown> | null }>(
        await tx.execute(drizzleSql`
          SELECT project_id, fields FROM ${tableSql("app_projects", "tasks")}
           WHERE id = ${taskId}::uuid AND org_id = ${owner.orgId}::uuid LIMIT 1`),
      )
      const r = rows[0]
      return r ? { projectId: r.project_id, fields: r.fields ?? {} } : null
    },
    { pool: "jobs" },
  )
  return projectTaskFilterMatches(filter, evt, task)
}
