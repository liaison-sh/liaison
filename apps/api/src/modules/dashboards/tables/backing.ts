// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A backed dashboard table (kernel.dashboard_tables.backing, migration 0305): its rows are the
// records of one parent record of an app (a project's tasks), read under the reader's RLS, so a
// record the reader cannot read is no row.
//
// - The app declares it on the entity (`entities.<e>.tableBacking: {parent, provider}`,
//   app-registries.ts tableBackingRegistry): `provider` is a TableBackingProvider exported by
//   the app's own server module. The kernel knows no app: it finds the provider by the
//   backing's `app` and `entity`.
// - `backing` = {app, entity, parentId, fields}: `fields` names the record values the table
//   shows, read through, as the columns the provider describes for that parent (keyed, typed).
// - The table's own columns are an overlay stored per record id exactly as a plain table's rows
//   (row id = record id), with the same history, undo and events; an overlay row is made by its
//   first write. An overlay column key never equals a read-through one.
// - A read-through write goes through the provider as the writer (the app's own write path, its
//   history is the record), refused when the writer lacks the provider's write scope. Adding a
//   row creates a record; deleting one is refused.
import { z } from "zod"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { COLUMN_KEY_RE, type Column } from "~/modules/dashboards/tables/columns"
import type { StoreDocument, Where } from "~/modules/data-store/service"

/** The records a backed table reads at most (a block source's own cap is lower). */
export const MAX_BACKED_ROWS = 2000

/** The cap in force (MAX_BACKED_ROWS; a test lowers it to reach the cut). */
export const backedRowCap = { max: MAX_BACKED_ROWS }

/** Who last changed a record, as its app knows it (a person, "<Name>'s agent", a routine). */
export interface RecordActor {
  type: "user" | "agent" | "system"
  id: string | null
  label: string
}

/** One record as a backed table reads it: its id and the read-through cells asked for. */
export interface BackedRecord {
  id: string
  cells: Record<string, unknown>
  updatedAt: string
  /** Who made the record's last change, when the app knows (else the table's own history says). */
  changedBy?: RecordActor
  /** Moves whenever the record changes (an opaque token): a read-through edit names the one it
   *  read (`ifRecordVersion`) and is refused when the record changed since. */
  version: string
  /** The record is finished in its app (a task in a done or cancelled status): the grid draws
   *  no late or near tint on its deadline columns. The kernel does not know what finished means. */
  terminal?: boolean
}

/** A merged row of a backed table: the overlay document plus its record's version. */
export type BackedDocument = StoreDocument & {
  recordVersion?: string
  terminal?: boolean
  /** The record's own last change: when, and who made it (when its app knows). */
  recordUpdatedAt?: string
  recordChangedBy?: RecordActor
}

/**
 * What an app implements to back a table (its entity's records under one parent record). Every
 * call runs on the caller's RLS transaction. A refused value throws the dashboard CellError
 * naming the column; any other refusal an error carrying an HTTP `status`.
 */
export interface TableBackingProvider {
  /** The scope a read-through write needs (checked first; the app's own write path rechecks). */
  writeScope: string
  /** The app's own read tool that lists the parent's records: a backed read needs its scopes and
   *  taints the turn exactly as calling it would (scope-taint.ts). */
  readTool: string
  /** The app's own write tool a read-through write goes through: the scope taint judges a write
   *  holding read-through cells as a call of it, not by the table's sharing. */
  writeTool: string
  /** The columns the parent's records offer, keyed and typed; null when it is unreadable. */
  describe(t: RlsClient, orgId: string, parentId: string): Promise<{ columns: Column[] } | null>
  /** The parent's records the reader can read, in the app's order (one when `id` is given). */
  rows(
    t: RlsClient,
    orgId: string,
    parentId: string,
    keys: readonly string[],
    /** `lock` (with `id`): holds the record until the transaction ends (a read-through edit). */
    opts: { id?: string; max: number; lock?: boolean },
  ): Promise<BackedRecord[]>
  /** The ids of every record of the parent the reader can read (null past `max`). */
  ids(t: RlsClient, orgId: string, parentId: string, max: number): Promise<string[] | null>
  /** Writes read-through cells as the writer: a new record (id null) or an update; its id. */
  write(
    t: RlsClient,
    viewer: UserContext,
    parentId: string,
    cells: Record<string, unknown>,
    id: string | null,
  ): Promise<string>
  /** Moves whenever the parent's records or its shape (columns, choices) change, whenever the
   *  change committed (a cached block read keys on it). */
  stamp(t: RlsClient, orgId: string, parentId: string): Promise<string>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const APP_RE = /^[a-z][a-z0-9_-]{0,62}$/
const ENTITY_RE = /^[a-z][a-zA-Z0-9_-]{0,62}$/

export const backingSchema = z
  .object({
    app: z.string().regex(APP_RE, "an app name"),
    entity: z.string().regex(ENTITY_RE, "an entity type"),
    parentId: z.string().regex(UUID, "the parent record's id"),
    fields: z
      .array(z.string().regex(COLUMN_KEY_RE, "a column key the backing offers"))
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

function isProvider(v: unknown): v is TableBackingProvider {
  const p = v as Partial<TableBackingProvider> | null
  return (
    !!p &&
    typeof p.writeScope === "string" &&
    typeof p.readTool === "string" &&
    typeof p.writeTool === "string" &&
    typeof p.ids === "function" &&
    typeof p.describe === "function" &&
    typeof p.rows === "function" &&
    typeof p.write === "function" &&
    typeof p.stamp === "function"
  )
}

/** The provider the app declares for `entity`, or null (no such declaration in this org). */
export async function backingProvider(
  orgId: string,
  backing: Pick<TableBacking, "app" | "entity">,
): Promise<TableBackingProvider | null> {
  // A request, a tool call and a block run have set the org's apps up already.
  const { tableBackingRegistry } = await import("~/modules/apps/app-registries")
  const decl = tableBackingRegistry.get([orgId, backing.app, backing.entity])
  if (!decl) return null
  const mod = await decl.load()
  const provider = mod[decl.provider]
  return isProvider(provider) ? provider : null
}

/** A tool definition as the registry holds it (its scopes, its taint declarations). */
export type BackingToolDef = NonNullable<
  ReturnType<typeof import("~/modules/apps/app-registries")["toolRegistry"]["get"]>
>

/**
 * May `scopes` read the parent's records through a backed table? Exactly when they may call the
 * app's own read tool (`readTool`) and the app is on for the org: then the read is that tool's
 * (`tool`, what it taints the turn with). Otherwise why not, and the table shows no row.
 */
export async function backedReadAccess(
  orgId: string,
  backing: Pick<TableBacking, "app">,
  provider: TableBackingProvider,
  scopes: readonly string[],
): Promise<{ ok: true; tool: BackingToolDef } | { ok: false; reason: string }> {
  const [{ toolRegistry }, { isAppActiveForOrgAsync }, { checkToolScopes }] = await Promise.all([
    import("~/modules/apps/app-registries"),
    import("~/modules/apps/org-apps"),
    import("~/modules/agent/scopes/required-scopes"),
  ])
  const tool = toolRegistry.get([orgId, backing.app, provider.readTool])
  if (!tool) return { ok: false, reason: `${backing.app} is not set up in this organisation` }
  if (!(await isAppActiveForOrgAsync(orgId, backing.app))) {
    return { ok: false, reason: `${backing.app} is turned off` }
  }
  const check = checkToolScopes(tool, [...scopes])
  if (!check.authorized) {
    return { ok: false, reason: `reading its records needs ${check.missing.join(", ")}` }
  }
  return { ok: true, tool }
}

/** The read-through columns, in `fields` order; a key the parent no longer offers is left out. */
export function readThroughColumns(
  backing: TableBacking,
  shape: { columns: Column[] } | null,
): Column[] {
  if (!shape) return []
  return backing.fields.flatMap((key) => shape.columns.filter((c) => c.key === key))
}

/** Why a backing cannot be saved (null = fine): no provider, an unreadable parent, a key it does
 *  not offer, a key an overlay column uses too. */
export function backingProblem(
  backing: TableBacking,
  shape: { columns: Column[] } | null,
  overlay: Column[],
): string | null {
  if (!shape) return `no ${backing.app} record you can read with that id`
  for (const key of backing.fields) {
    if (!shape.columns.some((c) => c.key === key)) {
      return `'${key}' is not offered (offered: ${shape.columns.map((c) => c.key).join(", ")})`
    }
    if (overlay.some((c) => c.key === key)) {
      return `the column '${key}' is read through: give the table's own column another key`
    }
  }
  return null
}

/** The own column that takes a read-through key (null = none): what a columns-only alter checks,
 *  so a field the parent retired since does not block every later column change. */
export function overlayCollision(backing: TableBacking, overlay: Column[]): string | null {
  const key = backing.fields.find((k) => overlay.some((c) => c.key === k))
  return key ? `the column '${key}' is read through: give the table's own column another key` : null
}

/** The records merged with their overlay documents (row id = record id). */
export function mergeOverlay(
  tasks: BackedRecord[],
  overlay: StoreDocument[],
  overlayColumns: Column[],
): BackedDocument[] {
  const byId = new Map(overlay.map((d) => [d.id, d]))
  const own = new Set(overlayColumns.map((c) => c.key))
  return tasks.map((task) => {
    const doc = byId.get(task.id)
    const data: Record<string, unknown> = { ...task.cells }
    if (doc) for (const [k, v] of Object.entries(doc.data)) if (own.has(k)) data[k] = v
    const updatedAt = doc && doc.updatedAt > task.updatedAt ? doc.updatedAt : task.updatedAt
    return {
      id: task.id,
      data,
      version: doc?.version ?? 0,
      updatedAt,
      recordVersion: task.version,
      recordUpdatedAt: task.updatedAt,
      ...(task.changedBy ? { recordChangedBy: task.changedBy } : {}),
      ...(task.terminal ? { terminal: true } : {}),
    }
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

export function sortDocs<D extends StoreDocument>(
  docs: D[],
  field: string | undefined,
  dir: "asc" | "desc",
): D[] {
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
