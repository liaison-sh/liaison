// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard tables (kernel.dashboard_tables, migration 0298): org data with typed columns that
// people edit in a table block and agents write with kernel tools. Every function runs under the
// caller's RLS (the row policies decide who reads and writes; this module checks the same rules
// first so a refusal names its reason).
//
// - Rows are kernel.app_documents of app `dashboards`, collection `t_<table id hex>`, cells at
//   the top level of `data` (the data store's where / orderBy reach them). The collections are
//   never declared: no data tool, store source or search index reaches them.
// - Every row write (add, update, delete, undo) appends a kernel.dashboard_table_changes row in
//   the same transaction, with the actor (a person, an agent, a routine), moves the table's
//   `rows_generation` (cached block reads key on it) and queues one
//   `kernel:dashboard_table_row:<created|updated|deleted>` event carrying ids, the changed keys
//   and its audience, never a cell or the table's name.
// - A batch is all or none (a savepoint): a refused op leaves no row and no change behind.
// - Undo writes the change's `before` back as a new `undo` change, only while that change is
//   still the row's latest (checked under the row's advisory lock, which every write takes).

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { withReleasedSavepoint } from "~/db/savepoint"
import {
  agents,
  appDocumentUsage,
  type DashboardTableChangeOp,
  type DashboardTableRow,
  dashboards,
  dashboardTableChanges,
  dashboardTables,
  resourceGrants,
  routines,
  userRoles,
  users,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  applyCells,
  CellError,
  type Column,
  changedKeys,
  columnSchema,
  columnsSchema,
  type LinkCell,
  MAX_COLUMNS,
  personIdsIn,
  pick,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import {
  type ContainsQuery,
  DataStoreError,
  deleteDocument,
  getDocument,
  MAX_QUERY_LIMIT,
  queryDocuments,
  type StoreCaller,
  type StoreDocument,
  setDocument,
  type Where,
} from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"
import {
  canManageSharing,
  listGrants,
  type OrgAccess,
  recomputeSearchAcl,
  replaceGrants,
  type ShareRole,
} from "~/modules/sharing/service"

export const TABLE_RESOURCE = "kernel.dashboard_table"
export const TABLES_STORE_APP = "dashboards"
export const READ_SCOPE = "kernel:dashboards:read"
export const WRITE_SCOPE = "kernel:dashboards:write"
export const SHARE_SCOPE = "kernel:dashboards:share"
export const ADMIN_SCOPE = "kernel:dashboards:admin"

/** Ops one rows write takes (all or none). */
export const MAX_OPS_PER_WRITE = 50
export const DEFAULT_ROWS_PAGE = 50
/** Changes kept per row (older ones are pruned on write). */
export const KEPT_CHANGES_PER_ROW = 200
/** Days a change is kept: infra/jobs/kernel-jobs.ts runDashboardTableChangesRetention. */
/** What a person sees for a linked record they cannot open. */
export const HIDDEN_LINK_LABEL = "Linked record"

export type TableErrorCode =
  | "invalid_cell"
  | "version_conflict"
  | "not_found"
  | "forbidden"
  | "limit"
  | "invalid_request"
  | "conflict"

export const TABLE_ERROR_STATUS: Record<TableErrorCode, 400 | 403 | 404 | 409 | 422> = {
  invalid_cell: 422,
  version_conflict: 409,
  not_found: 404,
  forbidden: 403,
  limit: 422,
  invalid_request: 400,
  conflict: 409,
}

/** A refused table call; `code` is the REST error code (plan.md contract). */
export class TableError extends Error {
  constructor(
    readonly code: TableErrorCode,
    message: string,
    readonly details: { column?: string; rowId?: string; current?: Row | null } = {},
  ) {
    super(message)
    this.name = "TableError"
  }
}

export interface Actor {
  type: "user" | "agent" | "system"
  id: string | null
  label: string
}

export interface TableInfo {
  id: string
  name: string
  description?: string
  columns: Column[]
  /** Keys of dropped columns: retired, never reused. */
  droppedKeys: string[]
  agentWritesNeedApproval: boolean
  orgAccess: OrgAccess
  myRole: "viewer" | "editor" | "owner"
  rowCount: number
  version: number
  updatedAt: string
}

export interface Row {
  id: string
  cells: Record<string, unknown>
  version: number
  updatedAt: string
  updatedBy: Actor
}

export interface Change {
  id: string
  rowId: string
  op: DashboardTableChangeOp
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  actor: Actor
  at: string
  undoable: boolean
}

export type RowOp =
  | { op: "add"; cells: Record<string, unknown> }
  | { op: "update"; id: string; ifVersion: number; cells: Record<string, unknown> }
  | { op: "delete"; id: string; ifVersion: number }

export type RowResult = Row | { id: string; deleted: true }

/** Who a write is recorded for, beside the person (an agent run, a routine, an approval). */
export interface WriteVia {
  agentId?: string | null
  routineId?: string | null
  approvalId?: string | null
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The data store collection of a table's rows. */
export function tableCollection(tableId: string): string {
  return `t_${tableId.toLowerCase().replace(/-/g, "")}`
}

function storeCaller(viewer: UserContext): StoreCaller {
  return { orgId: viewer.orgId, app: TABLES_STORE_APP, userId: viewer.userId }
}

function inTx<T>(viewer: UserContext, tx: RlsClient | undefined, fn: (t: RlsClient) => Promise<T>) {
  return tx ? fn(tx) : withRlsContext(viewer, fn)
}

const K = () => sql.raw(quoteIdent(schemaRef("kernel")))

/**
 * Runs `fn` in a released savepoint of the caller's RLS transaction, so a refused batch leaves
 * nothing behind even on a transaction the caller keeps using (an agent tool's). The savepoint
 * is the same RLS session, and its handle carries queueEvent (db/queue-event.ts wires nested
 * transactions); only its static type differs from the outer handle's.
 */
function inSavepoint<T>(outer: RlsClient, fn: (t: RlsClient) => Promise<T>): Promise<T> {
  return withReleasedSavepoint(outer, (sp) => fn(sp as unknown as RlsClient))
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code
}

// ---------------------------------------------------------------------------
// Reading a table
// ---------------------------------------------------------------------------

interface LoadedTable {
  row: DashboardTableRow
  canEdit: boolean
  columns: Column[]
}

/** The table under the viewer's RLS, with its edit right; NOT_FOUND when they cannot see it. */
export async function loadTable(
  t: RlsClient,
  viewer: UserContext,
  id: string,
): Promise<LoadedTable> {
  if (!UUID.test(id)) throw new TableError("not_found", "no such table")
  const [found] = await t
    .select({
      row: dashboardTables,
      canEdit: sql<boolean>`${K()}.dashboard_table_can_edit(${dashboardTables.ownerUserId}, ${dashboardTables.orgAccess}, ${dashboardTables.id})`,
    })
    .from(dashboardTables)
    .where(and(eq(dashboardTables.id, id), eq(dashboardTables.orgId, viewer.orgId)))
    .limit(1)
  if (!found) throw new TableError("not_found", "no such table")
  return {
    row: found.row,
    canEdit: found.canEdit === true,
    columns: found.row.columns as unknown as Column[],
  }
}

function myRole(viewer: UserContext, loaded: LoadedTable): TableInfo["myRole"] {
  if (loaded.row.ownerUserId === viewer.userId) return "owner"
  return loaded.canEdit ? "editor" : "viewer"
}

async function rowCounts(t: RlsClient, orgId: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await t
    .select({ collection: appDocumentUsage.collection, docs: appDocumentUsage.docs })
    .from(appDocumentUsage)
    .where(
      and(
        eq(appDocumentUsage.orgId, orgId),
        eq(appDocumentUsage.app, TABLES_STORE_APP),
        inArray(appDocumentUsage.collection, ids.map(tableCollection)),
      ),
    )
  return new Map(rows.map((r) => [r.collection, Number(r.docs)]))
}

function toInfo(viewer: UserContext, loaded: LoadedTable, count: number): TableInfo {
  const r = loaded.row
  return {
    id: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    columns: loaded.columns,
    droppedKeys: (r.droppedColumns as unknown as Column[]).map((c) => c.key),
    agentWritesNeedApproval: r.agentWritesNeedApproval,
    orgAccess: r.orgAccess,
    myRole: myRole(viewer, loaded),
    rowCount: count,
    version: r.version,
    updatedAt: iso(r.updatedAt),
  }
}

function assertRead(viewer: UserContext): void {
  if (!hasScope(READ_SCOPE, viewer.scopes) && !hasScope(WRITE_SCOPE, viewer.scopes)) {
    throw new TableError("forbidden", `reading tables needs ${READ_SCOPE}`)
  }
}

/** The tables the viewer can see, by name. */
export async function listTables(viewer: UserContext, tx?: RlsClient): Promise<TableInfo[]> {
  assertRead(viewer)
  return inTx(viewer, tx, async (t) => {
    const found = await t
      .select({
        row: dashboardTables,
        canEdit: sql<boolean>`${K()}.dashboard_table_can_edit(${dashboardTables.ownerUserId}, ${dashboardTables.orgAccess}, ${dashboardTables.id})`,
      })
      .from(dashboardTables)
      .where(eq(dashboardTables.orgId, viewer.orgId))
      .orderBy(sql`lower(${dashboardTables.name})`)
      .limit(500)
    const counts = await rowCounts(
      t,
      viewer.orgId,
      found.map((f) => f.row.id),
    )
    return found.map((f) =>
      toInfo(
        viewer,
        { row: f.row, canEdit: f.canEdit === true, columns: f.row.columns as unknown as Column[] },
        counts.get(tableCollection(f.row.id)) ?? 0,
      ),
    )
  })
}

export async function getTable(
  viewer: UserContext,
  id: string,
  tx?: RlsClient,
): Promise<TableInfo> {
  assertRead(viewer)
  return inTx(viewer, tx, async (t) => {
    const loaded = await loadTable(t, viewer, id)
    const counts = await rowCounts(t, viewer.orgId, [id])
    return toInfo(viewer, loaded, counts.get(tableCollection(id)) ?? 0)
  })
}

// ---------------------------------------------------------------------------
// Events and audience
// ---------------------------------------------------------------------------

export interface TableAudience {
  orgWide: boolean
  /** Who may hear a frame about the table when it is not org-wide. */
  userIds: string[]
}

/**
 * Everyone who reads a table not shared org-wide: its owner, the people granted, the members of
 * the roles granted. Read privileged (role memberships are routing metadata, no row content).
 */
export async function tableAudience(
  orgId: string,
  row: Pick<DashboardTableRow, "id" | "orgAccess" | "ownerUserId">,
): Promise<TableAudience> {
  if (row.orgAccess !== "none") return { orgWide: true, userIds: [] }
  const ids = await withPrivilegedDb(orgId, "dashboard-table-audience", async (tx) => {
    const grants = await tx
      .select({ kind: resourceGrants.granteeKind, grantee: resourceGrants.grantee })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.orgId, orgId),
          eq(resourceGrants.resourceType, TABLE_RESOURCE),
          eq(resourceGrants.resourceId, row.id),
        ),
      )
    const people = grants.filter((g) => g.kind === "user").map((g) => g.grantee)
    const roleIds = grants.filter((g) => g.kind === "role").map((g) => g.grantee)
    const members = roleIds.length
      ? await tx
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.roleId, roleIds)))
      : []
    return [...people, ...members.map((m) => m.userId)]
  })
  const all = new Set(ids)
  if (row.ownerUserId) all.add(row.ownerUserId)
  return { orgWide: false, userIds: [...all] }
}

/** What a `kernel:dashboard_table_row` event carries: ids and changed keys, never a cell. */
export interface TableRowEventData {
  tableId: string
  rowId: string
  changeId: string
  changed: string[]
  audience: TableAudience
}

export interface TableEventData {
  tableId: string
  version: number
  audience: TableAudience
}

function eventActor(viewer: UserContext, writer: Writer) {
  return {
    actorId: viewer.userId,
    actorType: writer.type === "agent" ? ("agent" as const) : ("user" as const),
    ...(writer.agentId ? { agentId: writer.agentId } : {}),
  }
}

async function queueTableEvent(
  t: RlsClient,
  viewer: UserContext,
  action: "created" | "updated" | "deleted",
  row: Pick<DashboardTableRow, "id" | "orgAccess" | "ownerUserId" | "version">,
  audience: TableAudience,
): Promise<void> {
  const data: TableEventData = { tableId: row.id, version: row.version, audience }
  await t.queueEvent({
    app: "kernel",
    entity: "dashboard_table",
    action,
    entityId: row.id,
    data: data as unknown as Record<string, unknown>,
    actorId: viewer.userId,
    actorType: "user",
    orgId: viewer.orgId,
    timestamp: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Who writes
// ---------------------------------------------------------------------------

interface Writer {
  type: "user" | "agent"
  agentId: string | null
  routineId: string | null
  approvalId: string | null
  /** An agent's handle or a routine's name (never a person's name, which is read at view time). */
  label: string | null
}

/** The writer: the run's agent or routine when the call comes from one, else the person. */
async function writerOf(viewer: UserContext, via: WriteVia = {}): Promise<Writer> {
  const run = currentRunContext()
  const agentId = via.agentId ?? run?.agentId ?? null
  const routineId = via.routineId ?? run?.routineId ?? null
  const approvalId = via.approvalId ?? null
  if (!agentId && !routineId) {
    return { type: "user", agentId: null, routineId: null, approvalId, label: null }
  }
  const label = await withPrivilegedDb(viewer.orgId, "dashboard-table-writer-label", async (tx) => {
    if (routineId && UUID.test(routineId)) {
      const [r] = await tx
        .select({ name: routines.name })
        .from(routines)
        .where(and(eq(routines.id, routineId), eq(routines.orgId, viewer.orgId)))
        .limit(1)
      if (r) return `Routine ${r.name}`.slice(0, 200)
    }
    if (agentId && UUID.test(agentId)) {
      const [a] = await tx
        .select({ handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, viewer.orgId)))
        .limit(1)
      if (a) return `@${a.handle}`.slice(0, 200)
    }
    return null
  })
  return {
    type: "agent",
    agentId: agentId && UUID.test(agentId) ? agentId : null,
    routineId: routineId && UUID.test(routineId) ? routineId : null,
    approvalId: approvalId && UUID.test(approvalId) ? approvalId : null,
    label,
  }
}

interface ChangeActorRow {
  actorType: "user" | "agent" | "system"
  actorId: string | null
  actorLabel: string | null
}

async function actorLabels(
  t: RlsClient,
  orgId: string,
  rows: ChangeActorRow[],
): Promise<(r: ChangeActorRow) => Actor> {
  const ids = [
    ...new Set(rows.filter((r) => r.actorType === "user" && r.actorId).map((r) => r.actorId!)),
  ]
  const names = ids.length
    ? await t
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.orgId, orgId), inArray(users.id, ids)))
    : []
  const byId = new Map(names.map((n) => [n.id, n.name]))
  return (r) => {
    if (r.actorType === "user") {
      return {
        type: "user",
        id: r.actorId,
        label: (r.actorId && byId.get(r.actorId)) || "Former member",
      }
    }
    return {
      type: r.actorType,
      id: r.actorType === "agent" ? r.actorId : null,
      label: r.actorLabel ?? (r.actorType === "agent" ? "An agent" : "System"),
    }
  }
}

// ---------------------------------------------------------------------------
// Rows: reading
// ---------------------------------------------------------------------------

/** May the viewer open records of `app` (a link cell's label is theirs to see)? */
function seesApp(viewer: UserContext, app: string): boolean {
  if (app === "kernel") return true
  return viewer.scopes.some((s) => s === "*" || s === app || s.startsWith(`${app}:`))
}

/** The cells a reader sees: active columns only, link labels they may not open replaced (A16). */
export function visibleCells(
  viewer: UserContext,
  columns: Column[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const col of columns) {
    const v = data[col.key]
    if (v === undefined) continue
    if (col.type === "link" && v && typeof v === "object") {
      const link = v as LinkCell
      out[col.key] = seesApp(viewer, link.app) ? link : { ...link, label: HIDDEN_LINK_LABEL }
    } else out[col.key] = v
  }
  return out
}

/** The cells of a change a reader sees: as for a row (A16), so a dropped column's old values and
 *  a link label they may not open never reach them through the history. */
function visibleChangeCells(
  viewer: UserContext,
  columns: Column[],
  cells: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return cells === null ? null : visibleCells(viewer, columns, cells)
}

/**
 * What the grid's text search reaches for this reader: the active columns' values, and a link
 * cell's label only when the reader may open the link's app (the display rule, A16). A dropped
 * column's cells and a hidden label never match, so the search is no oracle on them.
 */
function searchFor(viewer: UserContext, columns: Column[], text: string): ContainsQuery {
  const plain = columns.filter((c) => c.type !== "link").map((c) => c.key)
  const linkFields = columns.filter((c) => c.type === "link").map((c) => c.key)
  const apps = viewer.scopes.includes("*")
    ? ("all" as const)
    : [...new Set(["kernel", ...viewer.scopes.map((s) => s.split(":")[0] ?? "")])].filter(Boolean)
  return { text, fields: plain, links: { fields: linkFields, apps } }
}

/** A filter names active columns only: a dropped column's retired cells are not queryable. */
function checkWhere(where: Where | undefined, columns: Column[]): void {
  if (!where) return
  for (const key of Object.keys(where)) {
    if (!columns.some((c) => c.key === key)) {
      throw new TableError("invalid_request", `'${key}' is not a column of this table`, {
        column: key,
      })
    }
  }
}

async function latestActors(
  t: RlsClient,
  orgId: string,
  tableId: string,
  rowIds: string[],
): Promise<Map<string, Actor>> {
  if (rowIds.length === 0) return new Map()
  const rows = extractRows<{
    row_id: string
    actor_type: "user" | "agent" | "system"
    actor_id: string | null
    actor_label: string | null
  }>(
    await t.execute(sql`
      SELECT DISTINCT ON (row_id) row_id, actor_type, actor_id::text AS actor_id, actor_label
        FROM ${K()}.dashboard_table_changes
       WHERE org_id = ${orgId}::uuid AND table_id = ${tableId}::uuid
         AND row_id IN (${sql.join(
           rowIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       ORDER BY row_id, at DESC, id DESC`),
  )
  const mapped = rows.map((r) => ({
    rowId: r.row_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorLabel: r.actor_label,
  }))
  const label = await actorLabels(t, orgId, mapped)
  return new Map(mapped.map((r) => [r.rowId, label(r)]))
}

const UNKNOWN_ACTOR: Actor = { type: "system", id: null, label: "System" }

async function toRows(
  t: RlsClient,
  viewer: UserContext,
  loaded: LoadedTable,
  docs: StoreDocument[],
): Promise<Row[]> {
  const actors = await latestActors(
    t,
    viewer.orgId,
    loaded.row.id,
    docs.map((d) => d.id),
  )
  return docs.map((d) => ({
    id: d.id,
    cells: visibleCells(viewer, loaded.columns, d.data),
    version: d.version,
    updatedAt: d.updatedAt,
    updatedBy: actors.get(d.id) ?? UNKNOWN_ACTOR,
  }))
}

export interface ListRowsOptions {
  limit?: number
  cursor?: string
  sort?: string
  dir?: "asc" | "desc"
  q?: string
  where?: Where
}

function storeError(err: unknown): never {
  if (err instanceof DataStoreError) {
    if (
      err.code === "invalid_cursor" ||
      err.code === "invalid_query" ||
      err.code === "invalid_field"
    ) {
      throw new TableError("invalid_request", err.message)
    }
    if (err.code === "query_timeout") throw new TableError("limit", err.message)
    if (err.code === "collection_full" || err.code === "doc_too_large") {
      throw new TableError("limit", err.message)
    }
  }
  throw err
}

function orderField(sort: string | undefined, columns: Column[]): string | undefined {
  if (sort === undefined || sort === "updated_at") return sort
  if (sort === "id") return "doc_id"
  if (!columns.some((c) => c.key === sort)) {
    throw new TableError("invalid_request", `'${sort}' is not a column of this table`)
  }
  return sort
}

/** One page of the table's rows, sorted by any column (default: most recently updated first). */
export async function listRows(
  viewer: UserContext,
  id: string,
  opts: ListRowsOptions = {},
  tx?: RlsClient,
): Promise<{ rows: Row[]; nextCursor: string | null }> {
  assertRead(viewer)
  return inTx(viewer, tx, async (t) => {
    const loaded = await loadTable(t, viewer, id)
    const field = orderField(opts.sort, loaded.columns)
    checkWhere(opts.where, loaded.columns)
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_ROWS_PAGE, 1), MAX_QUERY_LIMIT)
    const page = await queryDocuments(
      t,
      storeCaller(viewer),
      tableCollection(id),
      {
        ...(opts.where ? { where: opts.where } : {}),
        ...(field ? { orderBy: { field, dir: opts.dir ?? "asc" } } : {}),
        limit,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      },
      opts.q?.trim() ? { contains: searchFor(viewer, loaded.columns, opts.q) } : {},
    ).catch(storeError)
    return { rows: await toRows(t, viewer, loaded, page.items), nextCursor: page.nextCursor }
  })
}

/** Reads up to `max` rows (a block source, an agent query): `truncated` when more matched. */
export async function readAllRows(
  t: RlsClient,
  viewer: UserContext,
  loaded: LoadedTable,
  opts: { where?: Where; sort?: string; dir?: "asc" | "desc"; max: number },
): Promise<{ docs: StoreDocument[]; truncated: boolean }> {
  const field = orderField(opts.sort, loaded.columns)
  checkWhere(opts.where, loaded.columns)
  const docs: StoreDocument[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await queryDocuments(t, storeCaller(viewer), tableCollection(loaded.row.id), {
      ...(opts.where ? { where: opts.where } : {}),
      ...(field ? { orderBy: { field, dir: opts.dir ?? "asc" } } : {}),
      limit: MAX_QUERY_LIMIT,
      ...(cursor ? { cursor } : {}),
    }).catch(storeError)
    for (const d of page.items) {
      if (docs.length >= opts.max) return { docs, truncated: true }
      docs.push(d)
    }
    if (!page.nextCursor) return { docs, truncated: false }
    cursor = page.nextCursor
  }
}

export { toRows as rowsOf }

// ---------------------------------------------------------------------------
// Rows: writing
// ---------------------------------------------------------------------------

async function activeMembers(t: RlsClient, orgId: string, ids: string[]): Promise<Set<string>> {
  const valid = ids.filter((id) => UUID.test(id))
  if (valid.length === 0) return new Set()
  const rows = await t
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.id, valid), eq(users.status, "active")))
  return new Set(rows.map((r) => r.id.toLowerCase()))
}

/** Serializes every write and undo of one row (the row may not exist to lock). */
async function lockRow(t: RlsClient, tableId: string, rowId: string): Promise<void> {
  await t.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dashboard-table:${tableId}:${rowId}`}, 0))`,
  )
}

async function recordChange(
  t: RlsClient,
  viewer: UserContext,
  writer: Writer,
  change: {
    tableId: string
    rowId: string
    op: DashboardTableChangeOp
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    rowVersion: number | null
    undoes?: string | null
  },
): Promise<string> {
  const [row] = await t
    .insert(dashboardTableChanges)
    .values({
      orgId: viewer.orgId,
      tableId: change.tableId,
      rowId: change.rowId,
      op: change.op,
      before: change.before,
      after: change.after,
      rowVersion: change.rowVersion,
      undoes: change.undoes ?? null,
      actorType: writer.type,
      actorId: viewer.userId,
      agentId: writer.agentId,
      routineId: writer.routineId,
      approvalId: writer.approvalId,
      actorLabel: writer.label,
      at: sql`clock_timestamp()`,
    })
    .returning({ id: dashboardTableChanges.id })
  return row!.id
}

async function queueRowEvent(
  t: RlsClient,
  viewer: UserContext,
  writer: Writer,
  action: "created" | "updated" | "deleted",
  data: TableRowEventData,
): Promise<void> {
  await t.queueEvent({
    app: "kernel",
    entity: "dashboard_table_row",
    action,
    entityId: data.rowId,
    data: data as unknown as Record<string, unknown>,
    ...eventActor(viewer, writer),
    orgId: viewer.orgId,
    timestamp: new Date().toISOString(),
  })
}

async function bumpGeneration(t: RlsClient, tableId: string): Promise<void> {
  await t
    .update(dashboardTables)
    .set({ rowsGeneration: sql`${dashboardTables.rowsGeneration} + 1` })
    .where(eq(dashboardTables.id, tableId))
}

async function currentRow(
  t: RlsClient,
  viewer: UserContext,
  loaded: LoadedTable,
  rowId: string,
): Promise<Row | null> {
  const doc = await getDocument(t, storeCaller(viewer), tableCollection(loaded.row.id), rowId)
  if (!doc) return null
  const [row] = await toRows(t, viewer, loaded, [doc])
  return row ?? null
}

/** A version conflict naming who changed the row since, with the row as it is now. */
async function conflict(
  t: RlsClient,
  viewer: UserContext,
  loaded: LoadedTable,
  rowId: string,
  what = "the row",
): Promise<TableError> {
  const current = await currentRow(t, viewer, loaded, rowId)
  const by = current ? ` by ${current.updatedBy.label}` : ""
  return new TableError(
    "version_conflict",
    current ? `${what} changed since${by}` : `${what} was deleted since`,
    { rowId, current },
  )
}

function assertEditor(loaded: LoadedTable): void {
  if (!loaded.canEdit) {
    throw new TableError(
      "forbidden",
      `changing this table's rows needs editor access to it and ${WRITE_SCOPE}`,
    )
  }
}

/** Writes several row operations at once, all or none; returns each op's row (or its deletion). */
export async function writeRows(
  viewer: UserContext,
  tableId: string,
  ops: RowOp[],
  opts: { tx?: RlsClient; via?: WriteVia } = {},
): Promise<RowResult[]> {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new TableError("invalid_request", "give 1 to 50 operations")
  }
  if (ops.length > MAX_OPS_PER_WRITE) {
    throw new TableError("limit", `one write takes at most ${MAX_OPS_PER_WRITE} operations`)
  }
  const writer = await writerOf(viewer, opts.via)
  return inTx(viewer, opts.tx, (outer) =>
    inSavepoint(outer, async (t) => {
      const loaded = await loadTable(t, viewer, tableId)
      assertEditor(loaded)
      const audience = await tableAudience(viewer.orgId, loaded.row)
      const caller = storeCaller(viewer)
      const collection = tableCollection(tableId)
      const memberIds = ops.flatMap((op) =>
        op.op === "delete" ? [] : personIdsIn(loaded.columns, op.cells ?? {}),
      )
      const members = await activeMembers(t, viewer.orgId, memberIds)
      const results: RowResult[] = []
      for (const [i, op] of ops.entries()) {
        const at = `operation ${i + 1}`
        try {
          if (op.op === "add") {
            const cells = validateCells(loaded.columns, op.cells, { full: true, members })
            const rowId = randomUUID()
            await lockRow(t, tableId, rowId)
            const data = applyCells({}, cells)
            const doc = await setDocument(t, caller, collection, rowId, data, { ifVersion: 0 })
            const keys = Object.keys(data).sort()
            const changeId = await recordChange(t, viewer, writer, {
              tableId,
              rowId,
              op: "create",
              before: null,
              after: data,
              rowVersion: doc.version,
            })
            await queueRowEvent(t, viewer, writer, "created", {
              tableId,
              rowId,
              changeId,
              changed: keys,
              audience,
            })
            results.push({
              id: rowId,
              cells: visibleCells(viewer, loaded.columns, doc.data),
              version: doc.version,
              updatedAt: doc.updatedAt,
              updatedBy: actorNow(viewer, writer),
            })
          } else if (op.op === "update") {
            const cells = validateCells(loaded.columns, op.cells, { full: false, members })
            await lockRow(t, tableId, op.id)
            const doc = await getDocument(t, caller, collection, op.id)
            if (!doc)
              throw new TableError("not_found", `${at}: no row '${op.id}'`, { rowId: op.id })
            if (doc.version !== op.ifVersion) throw await conflict(t, viewer, loaded, op.id)
            const next = applyCells(doc.data, cells)
            const keys = changedKeys(doc.data, next)
            if (keys.length === 0) {
              const [same] = await toRows(t, viewer, loaded, [doc])
              results.push(same!)
              continue
            }
            const written = await setDocument(t, caller, collection, op.id, next, {
              ifVersion: op.ifVersion,
            })
            const changeId = await recordChange(t, viewer, writer, {
              tableId,
              rowId: op.id,
              op: "update",
              before: pick(doc.data, keys),
              after: pick(next, keys),
              rowVersion: written.version,
            })
            await queueRowEvent(t, viewer, writer, "updated", {
              tableId,
              rowId: op.id,
              changeId,
              changed: keys,
              audience,
            })
            results.push({
              id: op.id,
              cells: visibleCells(viewer, loaded.columns, written.data),
              version: written.version,
              updatedAt: written.updatedAt,
              updatedBy: actorNow(viewer, writer),
            })
          } else if (op.op === "delete") {
            await lockRow(t, tableId, op.id)
            const doc = await getDocument(t, caller, collection, op.id)
            if (!doc)
              throw new TableError("not_found", `${at}: no row '${op.id}'`, { rowId: op.id })
            if (doc.version !== op.ifVersion) throw await conflict(t, viewer, loaded, op.id)
            await deleteDocument(t, caller, collection, op.id, { ifVersion: op.ifVersion })
            const changeId = await recordChange(t, viewer, writer, {
              tableId,
              rowId: op.id,
              op: "delete",
              before: doc.data,
              after: null,
              rowVersion: null,
            })
            await queueRowEvent(t, viewer, writer, "deleted", {
              tableId,
              rowId: op.id,
              changeId,
              changed: Object.keys(doc.data).sort(),
              audience,
            })
            results.push({ id: op.id, deleted: true })
          } else {
            throw new TableError("invalid_request", `${at}: op is add, update or delete`)
          }
        } catch (err) {
          if (err instanceof CellError) {
            throw new TableError("invalid_cell", `${at}: ${err.message}`, {
              column: err.column,
              ...(op.op !== "add" ? { rowId: op.id } : {}),
            })
          }
          if (err instanceof DataStoreError && err.code === "version_conflict" && op.op !== "add") {
            throw await conflict(t, viewer, loaded, op.id)
          }
          storeError(err)
        }
      }
      await bumpGeneration(t, tableId)
      await pruneChanges(t, viewer.orgId, tableId, ops)
      return results
    }),
  )
}

function actorNow(viewer: UserContext, writer: Writer): Actor {
  if (writer.type === "agent") {
    return { type: "agent", id: viewer.userId, label: writer.label ?? "An agent" }
  }
  return { type: "user", id: viewer.userId, label: "You" }
}

/**
 * Keeps the last KEPT_CHANGES_PER_ROW changes of the rows just written. Under RLS a change is
 * never deleted (no policy): this runs privileged, pinned to the org and the rows.
 */
async function pruneChanges(t: RlsClient, orgId: string, tableId: string, ops: RowOp[]) {
  const ids = [...new Set(ops.flatMap((o) => (o.op === "add" ? [] : [o.id])))]
  if (ids.length === 0) return
  // Cheap check under RLS first: only a row past the cap needs the privileged prune.
  const over = extractRows<{ row_id: string }>(
    await t.execute(sql`
      SELECT row_id FROM ${K()}.dashboard_table_changes
       WHERE org_id = ${orgId}::uuid AND table_id = ${tableId}::uuid
         AND row_id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
       GROUP BY row_id HAVING count(*) > ${KEPT_CHANGES_PER_ROW}`),
  ).map((r) => r.row_id)
  if (over.length === 0) return
  await withPrivilegedDb(orgId, "dashboard-table-changes-prune", (tx) =>
    tx.execute(sql`
      DELETE FROM ${K()}.dashboard_table_changes c
       WHERE c.org_id = ${orgId}::uuid AND c.table_id = ${tableId}::uuid
         AND c.row_id IN (${sql.join(
           over.map((id) => sql`${id}`),
           sql`, `,
         )})
         AND c.id NOT IN (
           SELECT k.id FROM ${K()}.dashboard_table_changes k
            WHERE k.org_id = c.org_id AND k.table_id = c.table_id AND k.row_id = c.row_id
            ORDER BY k.at DESC, k.id DESC LIMIT ${KEPT_CHANGES_PER_ROW})`),
  )
}

// ---------------------------------------------------------------------------
// History and undo
// ---------------------------------------------------------------------------

function encodeChangeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url")
}

function decodeChangeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (
      Array.isArray(v) &&
      typeof v[0] === "string" &&
      typeof v[1] === "string" &&
      UUID.test(v[1])
    ) {
      return [v[0], v[1]]
    }
  } catch {}
  throw new TableError("invalid_request", "the cursor is not one this list returned")
}

/** The table's changes, newest first, one row's or all of them. */
export async function listChanges(
  viewer: UserContext,
  tableId: string,
  opts: { rowId?: string; limit?: number; cursor?: string } = {},
  tx?: RlsClient,
): Promise<{ changes: Change[]; nextCursor: string | null }> {
  assertRead(viewer)
  return inTx(viewer, tx, async (t) => {
    const loaded = await loadTable(t, viewer, tableId)
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const conds: (SQL | undefined)[] = [
      eq(dashboardTableChanges.orgId, viewer.orgId),
      eq(dashboardTableChanges.tableId, tableId),
      opts.rowId ? eq(dashboardTableChanges.rowId, opts.rowId) : undefined,
    ]
    if (opts.cursor) {
      const [at, id] = decodeChangeCursor(opts.cursor)
      conds.push(
        or(
          lt(dashboardTableChanges.at, sql`${at}::timestamptz`),
          and(
            eq(dashboardTableChanges.at, sql`${at}::timestamptz`),
            lt(dashboardTableChanges.id, id),
          ),
        ),
      )
    }
    const rows = await t
      .select({
        row: dashboardTableChanges,
        atText: sql<string>`${dashboardTableChanges.at}::text`,
      })
      .from(dashboardTableChanges)
      .where(and(...conds))
      .orderBy(desc(dashboardTableChanges.at), desc(dashboardTableChanges.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const label = await actorLabels(
      t,
      viewer.orgId,
      page.map((r) => r.row),
    )
    // A change is undoable while it is its row's latest (and the viewer edits the table).
    const latest = new Map<string, string>()
    const rowIds = [...new Set(page.map((r) => r.row.rowId))]
    if (rowIds.length && loaded.canEdit) {
      const heads = extractRows<{ row_id: string; id: string }>(
        await t.execute(sql`
          SELECT DISTINCT ON (row_id) row_id, id::text AS id FROM ${K()}.dashboard_table_changes
           WHERE org_id = ${viewer.orgId}::uuid AND table_id = ${tableId}::uuid
             AND row_id IN (${sql.join(
               rowIds.map((id) => sql`${id}`),
               sql`, `,
             )})
           ORDER BY row_id, at DESC, id DESC`),
      )
      for (const h of heads) latest.set(h.row_id, h.id)
    }
    const last = page[page.length - 1]
    return {
      changes: page.map(({ row }) => ({
        id: row.id,
        rowId: row.rowId,
        op: row.op,
        before: visibleChangeCells(viewer, loaded.columns, row.before),
        after: visibleChangeCells(viewer, loaded.columns, row.after),
        actor: label(row),
        at: iso(row.at),
        undoable: latest.get(row.rowId) === row.id,
      })),
      nextCursor: rows.length > limit && last ? encodeChangeCursor(last.atText, last.row.id) : null,
    }
  })
}

/**
 * Undoes one change: writes its `before` back as a new `undo` change. Only while it is still
 * its row's latest change (else version_conflict "changed since by X"). An undone create deletes
 * the row; an undone delete brings it back with the same id.
 */
export async function undoChange(
  viewer: UserContext,
  tableId: string,
  changeId: string,
  opts: { tx?: RlsClient; via?: WriteVia } = {},
): Promise<RowResult> {
  if (!UUID.test(changeId)) throw new TableError("not_found", "no such change")
  const writer = await writerOf(viewer, opts.via)
  return inTx(viewer, opts.tx, (outer) =>
    inSavepoint(outer, async (t) => {
      const loaded = await loadTable(t, viewer, tableId)
      assertEditor(loaded)
      const [change] = await t
        .select()
        .from(dashboardTableChanges)
        .where(
          and(
            eq(dashboardTableChanges.id, changeId),
            eq(dashboardTableChanges.tableId, tableId),
            eq(dashboardTableChanges.orgId, viewer.orgId),
          ),
        )
        .limit(1)
      if (!change) throw new TableError("not_found", "no such change")
      await lockRow(t, tableId, change.rowId)
      const [head] = await t
        .select({ id: dashboardTableChanges.id })
        .from(dashboardTableChanges)
        .where(
          and(
            eq(dashboardTableChanges.orgId, viewer.orgId),
            eq(dashboardTableChanges.tableId, tableId),
            eq(dashboardTableChanges.rowId, change.rowId),
          ),
        )
        .orderBy(desc(dashboardTableChanges.at), desc(dashboardTableChanges.id))
        .limit(1)
      if (head?.id !== change.id) throw await conflict(t, viewer, loaded, change.rowId)
      const audience = await tableAudience(viewer.orgId, loaded.row)
      const caller = storeCaller(viewer)
      const collection = tableCollection(tableId)
      const doc = await getDocument(t, caller, collection, change.rowId)
      let result: RowResult
      let action: "created" | "updated" | "deleted"
      let before: Record<string, unknown> | null
      let after: Record<string, unknown> | null
      let rowVersion: number | null
      let keys: string[]
      if (change.before === null) {
        // Undo a create (or an undo that re-created): the row goes.
        if (!doc) throw await conflict(t, viewer, loaded, change.rowId)
        await deleteDocument(t, caller, collection, change.rowId, { ifVersion: doc.version })
        before = doc.data
        after = null
        rowVersion = null
        keys = Object.keys(doc.data).sort()
        action = "deleted"
        result = { id: change.rowId, deleted: true }
      } else if (change.after === null) {
        // Undo a delete: the row comes back with its cells and id, if they still fit the columns.
        if (doc) throw await conflict(t, viewer, loaded, change.rowId)
        const restored = applyCells({}, await undoCells(t, viewer, loaded, change.before, true))
        const written = await setDocument(t, caller, collection, change.rowId, restored, {
          ifVersion: 0,
        })
        before = null
        after = written.data
        rowVersion = written.version
        keys = Object.keys(written.data).sort()
        action = "created"
        result = (await toRowsNow(viewer, loaded, written, writer))!
      } else {
        if (!doc) throw await conflict(t, viewer, loaded, change.rowId)
        const next = applyCells(doc.data, await undoCells(t, viewer, loaded, change.before, false))
        keys = changedKeys(doc.data, next)
        const written = await setDocument(t, caller, collection, change.rowId, next, {
          ifVersion: doc.version,
        })
        before = pick(doc.data, keys)
        after = pick(next, keys)
        rowVersion = written.version
        action = "updated"
        result = (await toRowsNow(viewer, loaded, written, writer))!
      }
      const newChangeId = await recordChange(t, viewer, writer, {
        tableId,
        rowId: change.rowId,
        op: "undo",
        before,
        after,
        rowVersion,
        undoes: change.id,
      })
      await queueRowEvent(t, viewer, writer, action, {
        tableId,
        rowId: change.rowId,
        changeId: newChangeId,
        changed: keys,
        audience,
      })
      await bumpGeneration(t, tableId)
      return result
    }),
  )
}

/**
 * The cells an undo writes back, checked against the columns as they are now (S1): a cell of a
 * column dropped since, a choice removed since, a person no longer a member, a required column
 * left empty are refused, naming the column. An undone delete brings back the row's active
 * cells only: a dropped column's cells stay retired (and in the history).
 */
async function undoCells(
  t: RlsClient,
  viewer: UserContext,
  loaded: LoadedTable,
  before: Record<string, unknown>,
  wholeRow: boolean,
): Promise<Record<string, unknown>> {
  const active = new Set(loaded.columns.map((c) => c.key))
  const cells: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(before)) {
    if (active.has(key)) cells[key] = value
    else if (!wholeRow) {
      throw new TableError(
        "invalid_cell",
        `cannot undo: the column '${key}' was dropped since, so its old value cannot be written back`,
        { column: key },
      )
    }
  }
  const members = await activeMembers(t, viewer.orgId, personIdsIn(loaded.columns, cells))
  try {
    return validateCells(loaded.columns, cells, { full: wholeRow, members })
  } catch (err) {
    if (err instanceof CellError) {
      throw new TableError("invalid_cell", `cannot undo: ${err.message}`, { column: err.column })
    }
    throw err
  }
}

async function toRowsNow(
  viewer: UserContext,
  loaded: LoadedTable,
  doc: StoreDocument,
  writer: Writer,
): Promise<Row> {
  return {
    id: doc.id,
    cells: visibleCells(viewer, loaded.columns, doc.data),
    version: doc.version,
    updatedAt: doc.updatedAt,
    updatedBy: actorNow(viewer, writer),
  }
}

/** One change, as the routine owner (or anyone) reads it under RLS; null when unreadable. */
export async function readChange(
  t: RlsClient,
  orgId: string,
  changeId: string,
): Promise<{
  tableId: string
  rowId: string
  op: DashboardTableChangeOp
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
} | null> {
  if (!UUID.test(changeId)) return null
  const [row] = await t
    .select({
      tableId: dashboardTableChanges.tableId,
      rowId: dashboardTableChanges.rowId,
      op: dashboardTableChanges.op,
      before: dashboardTableChanges.before,
      after: dashboardTableChanges.after,
    })
    .from(dashboardTableChanges)
    .where(and(eq(dashboardTableChanges.id, changeId), eq(dashboardTableChanges.orgId, orgId)))
    .limit(1)
  return row ?? null
}

// ---------------------------------------------------------------------------
// Tables: create, change, delete
// ---------------------------------------------------------------------------

export interface CreateTableInput {
  name: string
  description?: string | null
  columns: unknown
  agentWritesNeedApproval?: boolean
  /** Copy this dashboard's sharing (its org access and grants); else the table is the creator's. */
  fromDashboardId?: string
  /** Explicit org access when no dashboard is given (default none). */
  orgAccess?: OrgAccess
}

function parseColumns(raw: unknown): Column[] {
  const parsed = columnsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` (columns.${issue.path.join(".")})` : ""
    throw new TableError("invalid_request", `${issue?.message ?? "invalid columns"}${at}`)
  }
  return parsed.data as Column[]
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 120) {
    throw new TableError("invalid_request", "a table's name is 1 to 120 characters")
  }
  return name.trim()
}

function translateWriteError(err: unknown, name?: string): never {
  const code = pgCode(err)
  if (code === "23505") {
    throw new TableError("conflict", `a table named '${name ?? ""}' already exists`)
  }
  if (code === "42501") {
    throw new TableError("forbidden", "this change needs editor access to the table and its scopes")
  }
  throw err
}

export async function createTable(
  viewer: UserContext,
  input: CreateTableInput,
  tx?: RlsClient,
): Promise<TableInfo> {
  if (!hasScope(WRITE_SCOPE, viewer.scopes)) {
    throw new TableError("forbidden", `a table needs ${WRITE_SCOPE}`)
  }
  const name = cleanName(input.name)
  const columns = parseColumns(input.columns)
  return inTx(viewer, tx, (outer) =>
    inSavepoint(outer, async (t) => {
      let orgAccess: OrgAccess = input.orgAccess ?? "none"
      let grants: {
        users: { userId: string; role: ShareRole }[]
        roles: { roleId: string; role: ShareRole }[]
      } = {
        users: [],
        roles: [],
      }
      if (input.fromDashboardId) {
        const [dash] = await t
          .select({ orgAccess: dashboards.orgAccess, ownerUserId: dashboards.ownerUserId })
          .from(dashboards)
          .where(and(eq(dashboards.id, input.fromDashboardId), eq(dashboards.orgId, viewer.orgId)))
          .limit(1)
        if (!dash) throw new TableError("not_found", "no such dashboard")
        orgAccess = dash.orgAccess
        const g = await listGrants(t, "kernel.dashboard", input.fromDashboardId)
        grants = { users: g.users, roles: g.roles }
        // The dashboard's owner keeps editing what they share (the creator owns the table).
        if (dash.ownerUserId && dash.ownerUserId !== viewer.userId) {
          grants.users = [
            ...grants.users.filter((u) => u.userId !== dash.ownerUserId),
            { userId: dash.ownerUserId, role: "editor" },
          ]
        }
      }
      const shared = orgAccess !== "none" || grants.users.length > 0 || grants.roles.length > 0
      if (
        shared &&
        !hasScope(SHARE_SCOPE, viewer.scopes) &&
        !hasScope(ADMIN_SCOPE, viewer.scopes)
      ) {
        throw new TableError(
          "forbidden",
          `a table shared with others (as the dashboard is) needs ${SHARE_SCOPE}`,
        )
      }
      let inserted: DashboardTableRow
      try {
        inserted = await t.transaction(async (sp) => {
          const [row] = await sp
            .insert(dashboardTables)
            .values({
              orgId: viewer.orgId,
              name,
              description: input.description ?? null,
              columns: columns as unknown as Record<string, unknown>[],
              agentWritesNeedApproval: input.agentWritesNeedApproval ?? false,
              orgAccess,
              ownerUserId: viewer.userId,
              createdBy: viewer.userId,
              updatedBy: viewer.userId,
            })
            .returning()
          return row!
        })
      } catch (err) {
        translateWriteError(err, name)
      }
      if (grants.users.length || grants.roles.length) {
        await replaceGrants(
          t,
          { orgId: viewer.orgId, userId: viewer.userId },
          TABLE_RESOURCE,
          inserted.id,
          grants,
        )
      } else {
        await recomputeSearchAcl(t, TABLE_RESOURCE, inserted.id)
      }
      await queueTableEvent(
        t,
        viewer,
        "created",
        inserted,
        await tableAudience(viewer.orgId, inserted),
      )
      const loaded = await loadTable(t, viewer, inserted.id)
      return toInfo(viewer, loaded, 0)
    }),
  )
}

export interface ColumnOps {
  add?: unknown[]
  rename?: { key: string; label: string }[]
  setChoices?: { key: string; choices: string[] }[]
  drop?: string[]
}

export interface UpdateTableInput {
  ifVersion: number
  name?: string
  description?: string | null
  agentWritesNeedApproval?: boolean
  columns?: ColumnOps
}

/** The columns after `ops`, and the dropped ones; refuses an unknown, retired or duplicate key. */
export function applyColumnOps(
  current: Column[],
  dropped: Column[],
  ops: ColumnOps,
): { columns: Column[]; dropped: Column[] } {
  let columns = current.map((c) => ({ ...c }))
  const droppedNow = [...dropped]
  const find = (key: string) => {
    const col = columns.find((c) => c.key === key)
    if (!col) throw new TableError("invalid_request", `no column '${key}'`, { column: key })
    return col
  }
  for (const key of ops.drop ?? []) {
    const col = find(key)
    columns = columns.filter((c) => c.key !== key)
    droppedNow.push(col)
  }
  for (const r of ops.rename ?? []) {
    const label = typeof r.label === "string" ? r.label.trim() : ""
    if (!label || label.length > 80) {
      throw new TableError("invalid_request", "a column label is 1 to 80 characters", {
        column: r.key,
      })
    }
    find(r.key).label = label
  }
  for (const s of ops.setChoices ?? []) {
    const col = find(s.key)
    if (col.type !== "choice" && col.type !== "choices") {
      throw new TableError("invalid_request", `column '${s.key}' has no choices`, { column: s.key })
    }
    col.choices = s.choices
  }
  for (const raw of ops.add ?? []) {
    const parsed = columnSchema.safeParse(raw)
    if (!parsed.success) {
      throw new TableError("invalid_request", parsed.error.issues[0]?.message ?? "invalid column")
    }
    const col = parsed.data as Column
    if (droppedNow.some((d) => d.key === col.key)) {
      throw new TableError(
        "invalid_request",
        `'${col.key}' was a dropped column: pick another key`,
        {
          column: col.key,
        },
      )
    }
    columns.push(col)
  }
  if (columns.length > MAX_COLUMNS) {
    throw new TableError("limit", `a table has at most ${MAX_COLUMNS} columns`)
  }
  return { columns: parseColumns(columns), dropped: droppedNow }
}

/** Changes a table's name, description, agent switch or columns (an editor's change applies at once). */
export async function updateTable(
  viewer: UserContext,
  id: string,
  input: UpdateTableInput,
  tx?: RlsClient,
): Promise<TableInfo> {
  return inTx(viewer, tx, (outer) =>
    inSavepoint(outer, async (t) => {
      const loaded = await loadTable(t, viewer, id)
      if (!loaded.canEdit) {
        throw new TableError(
          "forbidden",
          `changing this table needs editor access and ${WRITE_SCOPE}`,
        )
      }
      if (loaded.row.version !== input.ifVersion) {
        throw new TableError(
          "version_conflict",
          `the table is at version ${loaded.row.version}, not ${input.ifVersion}`,
        )
      }
      const set: Partial<typeof dashboardTables.$inferInsert> = {}
      if (input.name !== undefined) set.name = cleanName(input.name)
      if (input.description !== undefined) {
        if (input.description !== null && input.description.length > 2000) {
          throw new TableError("invalid_request", "a description is at most 2,000 characters")
        }
        set.description = input.description
      }
      if (input.agentWritesNeedApproval !== undefined) {
        set.agentWritesNeedApproval = input.agentWritesNeedApproval
      }
      if (input.columns) {
        const next = applyColumnOps(
          loaded.columns,
          loaded.row.droppedColumns as unknown as Column[],
          input.columns,
        )
        set.columns = next.columns as unknown as Record<string, unknown>[]
        set.droppedColumns = next.dropped as unknown as Record<string, unknown>[]
      }
      let saved: DashboardTableRow
      try {
        saved = await t.transaction(async (sp) => {
          const [row] = await sp
            .update(dashboardTables)
            .set({
              ...set,
              version: sql`${dashboardTables.version} + 1`,
              // A column change alters what a cached block shows.
              rowsGeneration: sql`${dashboardTables.rowsGeneration} + 1`,
              updatedBy: viewer.userId,
              updatedAt: sql`now()`,
            })
            .where(and(eq(dashboardTables.id, id), eq(dashboardTables.version, input.ifVersion)))
            .returning()
          if (!row) throw new TableError("version_conflict", "the table changed since")
          return row
        })
      } catch (err) {
        if (err instanceof TableError) throw err
        translateWriteError(err, set.name)
      }
      await queueTableEvent(t, viewer, "updated", saved, await tableAudience(viewer.orgId, saved))
      const counts = await rowCounts(t, viewer.orgId, [id])
      return toInfo(viewer, await loadTable(t, viewer, id), counts.get(tableCollection(id)) ?? 0)
    }),
  )
}

/**
 * Deletes a table and its rows (one table event, no row events). Its history stays for
 * retention and export (no foreign key), and no RLS reader reaches it once the table is gone.
 */
export async function deleteTable(viewer: UserContext, id: string, tx?: RlsClient): Promise<void> {
  return inTx(viewer, tx, (outer) =>
    inSavepoint(outer, async (t) => {
      const loaded = await loadTable(t, viewer, id)
      const r = loaded.row
      const mayDelete =
        (r.ownerUserId === viewer.userId && hasScope(WRITE_SCOPE, viewer.scopes)) ||
        (r.orgAccess !== "none" && hasScope(ADMIN_SCOPE, viewer.scopes))
      if (!mayDelete) {
        throw new TableError(
          "forbidden",
          `only its owner deletes this table (or ${ADMIN_SCOPE} when the whole organisation sees it)`,
        )
      }
      const audience = await tableAudience(viewer.orgId, r)
      const collection = tableCollection(id)
      // Rows first, while the table still lets the restrictive policies through.
      await t.execute(sql`
        DELETE FROM ${K()}.app_documents
         WHERE org_id = ${viewer.orgId}::uuid AND app = ${TABLES_STORE_APP} AND collection = ${collection}`)
      await t
        .delete(appDocumentUsage)
        .where(
          and(
            eq(appDocumentUsage.orgId, viewer.orgId),
            eq(appDocumentUsage.app, TABLES_STORE_APP),
            eq(appDocumentUsage.collection, collection),
          ),
        )
      await t
        .delete(resourceGrants)
        .where(
          and(eq(resourceGrants.resourceType, TABLE_RESOURCE), eq(resourceGrants.resourceId, id)),
        )
      await t.delete(dashboardTables).where(eq(dashboardTables.id, id))
      await queueTableEvent(t, viewer, "deleted", r, audience)
    }),
  )
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export interface TableSharing {
  orgAccess: OrgAccess
  ownerUserId: string | null
  ownerName: string | null
  canManage: boolean
  users: Array<{ userId: string; role: ShareRole; name: string | null }>
  roles: Array<{ roleId: string; role: ShareRole; name: string | null }>
  /** Dimension grants are not offered for tables; always empty (the dashboards shape). */
  dimensions: never[]
}

export async function getTableSharing(
  viewer: UserContext,
  id: string,
  tx?: RlsClient,
): Promise<TableSharing> {
  assertRead(viewer)
  return inTx(viewer, tx, async (t) => {
    const { row } = await loadTable(t, viewer, id)
    const grants = await listGrants(t, TABLE_RESOURCE, id)
    const ids = [
      ...grants.users.map((g) => g.userId),
      ...(row.ownerUserId ? [row.ownerUserId] : []),
    ]
    const names = ids.length
      ? await t
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(eq(users.orgId, viewer.orgId), inArray(users.id, ids)))
      : []
    const roleRows = grants.roles.length
      ? extractRows<{ id: string; name: string }>(
          await t.execute(sql`
            SELECT id::text AS id, name FROM ${K()}.roles
             WHERE org_id = ${viewer.orgId}::uuid AND id IN (${sql.join(
               grants.roles.map((g) => sql`${g.roleId}::uuid`),
               sql`, `,
             )})`),
        )
      : []
    const n = new Map(names.map((x) => [x.id, x.name]))
    const rn = new Map(roleRows.map((x) => [x.id, x.name]))
    return {
      orgAccess: row.orgAccess,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId ? (n.get(row.ownerUserId) ?? null) : null,
      canManage: await canManageSharing(t, TABLE_RESOURCE, id),
      users: grants.users.map((g) => ({ ...g, name: n.get(g.userId) ?? null })),
      roles: grants.roles.map((g) => ({ ...g, name: rn.get(g.roleId) ?? null })),
      dimensions: [],
    }
  })
}

export interface TableSharingInput {
  orgAccess?: OrgAccess
  users?: Array<{ userId: string; role: ShareRole }>
  roles?: Array<{ roleId: string; role: ShareRole }>
}

/** Changes who sees the table (editor access + kernel:dashboards:share, the database enforces it). */
export async function setTableSharing(
  viewer: UserContext,
  id: string,
  input: TableSharingInput,
  tx?: RlsClient,
): Promise<TableSharing> {
  return inTx(viewer, tx, (outer) =>
    inSavepoint(outer, async (t) => {
      const { row } = await loadTable(t, viewer, id)
      if (!(await canManageSharing(t, TABLE_RESOURCE, id))) {
        throw new TableError(
          "forbidden",
          `changing who sees a table needs editor access to it and ${SHARE_SCOPE}`,
        )
      }
      const userIds = [...new Set((input.users ?? []).map((g) => g.userId.toLowerCase()))]
      const known = await activeMembers(t, viewer.orgId, userIds)
      const unknown = userIds.filter((u) => !known.has(u))
      if (unknown.length) {
        throw new TableError(
          "invalid_request",
          `not a member of this organisation: ${unknown.join(", ")}`,
        )
      }
      await replaceGrants(t, { orgId: viewer.orgId, userId: viewer.userId }, TABLE_RESOURCE, id, {
        ...(input.users ? { users: input.users } : {}),
        ...(input.roles ? { roles: input.roles } : {}),
      })
      const orgAccess = input.orgAccess ?? row.orgAccess
      const before = await tableAudience(viewer.orgId, row)
      try {
        await t.transaction(async (sp) => {
          await sp
            .update(dashboardTables)
            .set({
              orgAccess,
              ownerUserId:
                orgAccess === "none" && !row.ownerUserId ? viewer.userId : row.ownerUserId,
              version: sql`${dashboardTables.version} + 1`,
              // Who reads it changed: cached block reads must not outlive it.
              rowsGeneration: sql`${dashboardTables.rowsGeneration} + 1`,
            })
            .where(eq(dashboardTables.id, id))
        })
      } catch (err) {
        if (pgCode(err) === "42501") {
          throw new TableError(
            "forbidden",
            "you would lose access to this table: share it with yourself as editor first",
          )
        }
        throw err
      }
      const [after] = await t
        .select()
        .from(dashboardTables)
        .where(eq(dashboardTables.id, id))
        .limit(1)
      if (after) {
        const now = await tableAudience(viewer.orgId, after)
        // The frame (ids only) reaches who sees it now and who saw it before, so a list drops it.
        const audience: TableAudience =
          now.orgWide || before.orgWide
            ? { orgWide: true, userIds: [] }
            : { orgWide: false, userIds: [...new Set([...now.userIds, ...before.userIds])] }
        await queueTableEvent(t, viewer, "updated", after, audience)
      }
      return getTableSharing(viewer, id, t)
    }),
  )
}
