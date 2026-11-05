// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task label taxonomy: org-wide groups (parent_id NULL) and their
// values (parent_id = the group), stored in app_projects.labels. Reads for
// everyone holding projects:projects:read; writes for projects:labels:admin.
//
// Rules shared by every write:
// - a stored node's parent never changes (a group stays a group, a value stays
//   in its group), so existing assignments are never silently reinterpreted;
// - a value is archived when its own `archived_at` or its group's is set;
//   archiving a group stamps only the group, restoring clears only the row;
//   nothing is ever deleted;
// - names are unique (trimmed, case-insensitive) among "name-active" siblings,
//   i.e. siblings whose OWN archived_at is null, whatever the group's state;
// - every write takes the per-org advisory lock first and stamps updated_at
//   with clock_timestamp(), so the version token moves on every write, even
//   two inside one transaction;
// - `name_exists` is a 400: the settings tree block reads any 409 as a version
//   conflict, and only the stale-version refusal (`conflict`) is a 409.
//
// Sibling: tickets categories (`apps/api/src/apps/tickets/admin.ts`) implement
// the same settings tree contract (version token `max(updated_at)::text#count`,
// per-org advisory lock, `{id|tempId, parentId|parentTempId, name, sortOrder,
// archived}` reorder nodes). Keep the token format and the node contract in
// step with it: the tree block treats both apps alike.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { UserContext } from "~/db/rls"
import { hasScope } from "~/modules/permissions/permissions"
import { ProjectsServiceError } from "./statuses"

export const LABEL_NAME_MAX = 60
/** Filter sentinel for "no effective value in this group"; refused as a name. */
export const LABEL_NONE = "__none__"
export const LABELS_ADMIN_SCOPE = "projects:labels:admin"

/** A client or an inner transaction: every label read and write runs on either. */
type LabelsDb = RlsClient | RlsTx

/** One `app_projects.labels` row as stored (snake_case). */
export interface DbLabelRow {
  id: string
  parent_id: string | null
  name: string
  sort_order: number
  archived_at: unknown
  created_at: unknown
  updated_at: unknown
}

export interface LabelRow {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  archivedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface LabelValue {
  id: string
  groupId: string
  name: string
  sortOrder: number
  archivedAt: string | null
  /** Own stamp or the group's. */
  archived: boolean
}

export interface LabelGroup {
  id: string
  name: string
  sortOrder: number
  archivedAt: string | null
  values: LabelValue[]
}

export interface LabelTreeRow {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  updatedAt: string | null
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function rowOut(r: DbLabelRow): LabelRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    sortOrder: r.sort_order,
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

/** Sibling order everywhere labels are listed: sort order, then case-insensitive name. */
export const byOrderThenName = (
  a: { sort_order: number; name: string },
  b: { sort_order: number; name: string },
): number => a.sort_order - b.sort_order || a.name.toLowerCase().localeCompare(b.name.toLowerCase())

function invalid(message: string, details?: unknown): ProjectsServiceError {
  return new ProjectsServiceError(400, "invalid_params", message, details)
}

function nameExists(message: string): ProjectsServiceError {
  return new ProjectsServiceError(400, "name_exists", message)
}

/** Trim and check a label name; refuses empty, too long and the filter sentinel. */
export function normalizeLabelName(raw: unknown, field = "name"): string {
  if (typeof raw !== "string") throw invalid(`${field} must be a string`)
  const name = raw.trim()
  if (!name) throw invalid(`${field} is required`)
  if (name.length > LABEL_NAME_MAX) {
    throw invalid(`${field} is longer than ${LABEL_NAME_MAX} characters`)
  }
  if (name.toLowerCase() === LABEL_NONE) {
    throw invalid(`${field} '${LABEL_NONE}' is reserved for the "no label" filter`)
  }
  return name
}

export function assertLabelsAdmin(actor: UserContext): void {
  if (!hasScope(LABELS_ADMIN_SCOPE, actor.scopes ?? [])) {
    throw new ProjectsServiceError(
      403,
      "forbidden",
      `Managing labels needs the ${LABELS_ADMIN_SCOPE} scope`,
    )
  }
}

/** The columns of a `DbLabelRow`, for every SELECT and RETURNING. */
const LABEL_COLUMNS = drizzleSql.raw(
  "id, parent_id, name, sort_order, archived_at, created_at, updated_at",
)

/**
 * Run a taxonomy write in its own transaction holding the per-org advisory
 * lock, taken before any read or check: name uniqueness is a service check,
 * so two writers must never check the same tree concurrently.
 */
function withLabelsLock<T>(
  args: { tx: RlsClient; orgId: string },
  fn: (tx: RlsTx) => Promise<T>,
): Promise<T> {
  return args.tx.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`projects.labels:${args.orgId}`}, 0))`,
    )
    return fn(tx)
  })
}

/** Every label row of the org (archived included). */
export async function loadLabelRows(tx: LabelsDb, orgId: string): Promise<DbLabelRow[]> {
  return extractRows<DbLabelRow>(
    await tx.execute(drizzleSql`
      SELECT ${LABEL_COLUMNS}
      FROM ${projectsRel("labels")}
      WHERE org_id = ${orgId}::uuid
    `),
  )
}

/** `labelsVersion`'s token from its two parts; one format for both readers. */
function versionToken(latest: string | null | undefined, count: number | undefined): string {
  return `${latest ?? "empty"}#${count ?? 0}`
}

/**
 * The version of the org's taxonomy: latest write and row count over every
 * row (archived included). The settings page loads it with the tree and hands
 * it back to `reorderLabels` as its base.
 */
export async function labelsVersion(tx: LabelsDb, orgId: string): Promise<string> {
  const [row] = extractRows<{ v: string | null; n: number }>(
    await tx.execute(drizzleSql`
      SELECT max(updated_at)::text AS v, count(*)::int AS n
      FROM ${projectsRel("labels")}
      WHERE org_id = ${orgId}::uuid
    `),
  )
  return versionToken(row?.v, row?.n)
}

/**
 * Every label row and the version token, read by ONE statement so both come
 * from the same snapshot: two statements could pair pre-write rows with a
 * post-write version, and a whole-tree save built on them would pass the
 * version check and write stale names back over a concurrent rename.
 */
async function loadLabelRowsWithVersion(
  tx: LabelsDb,
  orgId: string,
): Promise<{ rows: DbLabelRow[]; version: string }> {
  const rows = extractRows<DbLabelRow & { v: string | null; n: number }>(
    await tx.execute(drizzleSql`
      SELECT ${LABEL_COLUMNS},
        (max(updated_at) OVER ())::text AS v, (count(*) OVER ())::int AS n
      FROM ${projectsRel("labels")}
      WHERE org_id = ${orgId}::uuid
    `),
  )
  const first = rows[0]
  return {
    rows: rows.map(({ v: _v, n: _n, ...row }) => row),
    version: first ? versionToken(first.v, first.n) : versionToken(null, 0),
  }
}

/** Siblings under `parentId` whose own archived_at is null, whatever the group's state. */
function nameActiveSiblings(
  rows: DbLabelRow[],
  parentId: string | null,
  excludeId?: string,
): DbLabelRow[] {
  return rows.filter(
    (r) => r.parent_id === parentId && r.archived_at === null && r.id !== excludeId,
  )
}

function clashMessage(rows: DbLabelRow[], parentId: string | null, name: string): string {
  if (parentId === null) return `A label group named '${name}' already exists.`
  const group = rows.find((r) => r.id === parentId)
  return `Label group ${group?.name ?? parentId} already has a value named '${name}'.`
}

function assertNameFree(
  rows: DbLabelRow[],
  parentId: string | null,
  name: string,
  excludeId?: string,
): void {
  const lower = name.trim().toLowerCase()
  const clash = nameActiveSiblings(rows, parentId, excludeId).some(
    (r) => r.name.trim().toLowerCase() === lower,
  )
  if (clash) throw nameExists(clashMessage(rows, parentId, name))
}

async function queueLabelEvent(
  tx: LabelsDb,
  orgId: string,
  actor: UserContext,
  action: "created" | "updated" | "archived" | "restored" | "reordered",
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.queueEvent({
    app: "projects",
    entity: "label",
    action,
    entityId,
    data,
    actorId: actor.userId,
    actorType: "user",
    orgId,
  })
}

export interface ListLabelsArgs {
  tx: RlsClient
  orgId: string
  includeArchived?: boolean
}

/**
 * Groups in order, each with its values. Live only by default; with
 * `includeArchived`, every group and value, each value's `archived` saying
 * whether it or its group is archived.
 */
export async function listLabels(args: ListLabelsArgs): Promise<{ groups: LabelGroup[] }> {
  const rows = await loadLabelRows(args.tx, args.orgId)
  const all = args.includeArchived === true
  const groups = rows
    .filter((r) => r.parent_id === null && (all || r.archived_at === null))
    .sort(byOrderThenName)
  return {
    groups: groups.map((g) => {
      const groupArchived = g.archived_at !== null
      const values = rows
        .filter((r) => r.parent_id === g.id && (all || r.archived_at === null))
        .sort(byOrderThenName)
        .map((v) => ({
          id: v.id,
          groupId: g.id,
          name: v.name,
          sortOrder: v.sort_order,
          archivedAt: iso(v.archived_at),
          archived: groupArchived || v.archived_at !== null,
        }))
      return {
        id: g.id,
        name: g.name,
        sortOrder: g.sort_order,
        archivedAt: iso(g.archived_at),
        values,
      }
    }),
  }
}

/** The settings tree block's list op: live groups and their live values, plus the version. */
export async function labelsTree(args: {
  tx: RlsClient
  orgId: string
}): Promise<{ rows: LabelTreeRow[]; version: string }> {
  const { rows, version } = await loadLabelRowsWithVersion(args.tx, args.orgId)
  const groups = rows.filter((r) => r.parent_id === null && r.archived_at === null)
  const liveGroupIds = new Set(groups.map((g) => g.id))
  const values = rows.filter(
    (r) => r.parent_id !== null && liveGroupIds.has(r.parent_id) && r.archived_at === null,
  )
  const out = [...groups.sort(byOrderThenName), ...values.sort(byOrderThenName)].map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    sortOrder: r.sort_order,
    updatedAt: iso(r.updated_at),
  }))
  return { rows: out, version }
}

interface WriteArgs<I> {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: I
}

function optionalSortOrder(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalid("sortOrder must be a whole number")
  }
  return raw
}

function notFound(id: unknown): ProjectsServiceError {
  return new ProjectsServiceError(404, "not_found", `Label ${String(id)} not found`)
}

export interface CreateLabelInput {
  name: unknown
  parentId?: string | null
  sortOrder?: number
}

/** Create a group (no parentId) or a value under a live group. */
export async function createLabel(args: WriteArgs<CreateLabelInput>): Promise<LabelRow> {
  const { orgId, actor, input } = args
  assertLabelsAdmin(actor)
  return withLabelsLock(args, async (tx) => {
    const name = normalizeLabelName(input.name)
    const sortOrderIn = optionalSortOrder(input.sortOrder)
    const rows = await loadLabelRows(tx, orgId)
    const parentId = input.parentId ?? null
    if (parentId !== null) {
      const parent = rows.find((r) => r.id === parentId)
      if (!parent) {
        throw new ProjectsServiceError(404, "not_found", `Label group ${parentId} not found`)
      }
      if (parent.parent_id !== null) {
        throw invalid(
          `Label ${parent.name} is a value, not a group: values hold no values. Pass a group id as parentId, or omit it to create a group.`,
        )
      }
      if (parent.archived_at !== null) {
        throw invalid(`Label group ${parent.name} is archived; restore it before adding values.`)
      }
    }
    assertNameFree(rows, parentId, name)
    const siblings = rows.filter((r) => r.parent_id === parentId)
    const sortOrder =
      sortOrderIn ??
      (siblings.length === 0 ? 0 : Math.max(...siblings.map((r) => r.sort_order)) + 1)
    const [row] = extractRows<DbLabelRow>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("labels")} (
          org_id, parent_id, name, sort_order, created_at, updated_at
        ) VALUES (
          ${orgId}::uuid, ${parentId}::uuid, ${name}, ${sortOrder}, clock_timestamp(), clock_timestamp()
        )
        RETURNING ${LABEL_COLUMNS}
      `),
    )
    const out = rowOut(row!)
    await queueLabelEvent(tx, orgId, actor, "created", out.id, { ...out })
    return out
  })
}

export interface UpdateLabelInput {
  id: string
  name?: unknown
  sortOrder?: number
  parentId?: string | null
}

/** Rename or reorder one label. The parent is immutable. */
export async function updateLabel(args: WriteArgs<UpdateLabelInput>): Promise<LabelRow> {
  const { orgId, actor, input } = args
  assertLabelsAdmin(actor)
  return withLabelsLock(args, async (tx) => {
    const rows = await loadLabelRows(tx, orgId)
    const was = rows.find((r) => r.id === input.id)
    if (!was) throw notFound(input.id)
    if (input.parentId !== undefined && (input.parentId ?? null) !== was.parent_id) {
      throw invalid(
        "A label cannot move to another group (or between group and value). Create a new value instead.",
      )
    }
    const changes: Record<string, unknown> = {}
    if (input.name !== undefined) {
      const name = normalizeLabelName(input.name)
      if (name !== was.name) {
        assertNameFree(rows, was.parent_id, name, was.id)
        changes.name = name
      }
    }
    const sortOrder = optionalSortOrder(input.sortOrder)
    if (sortOrder !== undefined && sortOrder !== was.sort_order) changes.sortOrder = sortOrder
    if (Object.keys(changes).length === 0) return rowOut(was)
    const [row] = extractRows<DbLabelRow>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("labels")}
        SET name = ${(changes.name as string | undefined) ?? was.name},
            sort_order = ${(changes.sortOrder as number | undefined) ?? was.sort_order},
            updated_at = clock_timestamp()
        WHERE id = ${was.id}::uuid AND org_id = ${orgId}::uuid
        RETURNING ${LABEL_COLUMNS}
      `),
    )
    await queueLabelEvent(tx, orgId, actor, "updated", was.id, { id: was.id, changes })
    return rowOut(row!)
  })
}

export interface ArchiveLabelInput {
  id: string
  /** true (default) archives; false restores. */
  archived?: boolean
}

/** Archive or restore one label. Archiving a group stamps only the group. */
export async function archiveLabel(args: WriteArgs<ArchiveLabelInput>): Promise<LabelRow> {
  const { orgId, actor, input } = args
  assertLabelsAdmin(actor)
  const archive = input.archived !== false
  return withLabelsLock(args, async (tx) => {
    const rows = await loadLabelRows(tx, orgId)
    const was = rows.find((r) => r.id === input.id)
    if (!was) throw notFound(input.id)
    const isArchived = was.archived_at !== null
    if (archive === isArchived) return rowOut(was)
    if (!archive) assertNameFree(rows, was.parent_id, was.name, was.id)
    const [row] = extractRows<DbLabelRow>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("labels")}
        SET archived_at = ${archive ? drizzleSql`clock_timestamp()` : drizzleSql`NULL`},
            updated_at = clock_timestamp()
        WHERE id = ${was.id}::uuid AND org_id = ${orgId}::uuid
        RETURNING ${LABEL_COLUMNS}
      `),
    )
    await queueLabelEvent(tx, orgId, actor, archive ? "archived" : "restored", was.id, {
      id: was.id,
      parentId: was.parent_id,
    })
    return rowOut(row!)
  })
}

interface ReorderNode {
  id?: string
  tempId?: string
  parentId: string | null
  parentTempId?: string
  name: string
  sortOrder: number
  archived: boolean
}

function parseReorderNodes(raw: unknown): ReorderNode[] {
  if (!Array.isArray(raw)) throw invalid("nodes must be an array")
  const out: ReorderNode[] = []
  for (const [i, n] of raw.entries()) {
    if (!n || typeof n !== "object") throw invalid(`nodes[${i}] must be an object`)
    const r = n as Record<string, unknown>
    const id = typeof r.id === "string" && r.id ? r.id : undefined
    const tempId = typeof r.tempId === "string" && r.tempId ? r.tempId : undefined
    if ((id === undefined) === (tempId === undefined)) {
      throw invalid(`nodes[${i}] needs exactly one of id or tempId`)
    }
    const parentTempId =
      typeof r.parentTempId === "string" && r.parentTempId ? r.parentTempId : undefined
    const parentId = typeof r.parentId === "string" && r.parentId ? r.parentId : null
    if (parentTempId !== undefined && parentId !== null) {
      throw invalid(`nodes[${i}] names both parentId and parentTempId`)
    }
    const name = normalizeLabelName(r.name, `nodes[${i}].name`)
    if (typeof r.sortOrder !== "number" || !Number.isInteger(r.sortOrder)) {
      throw invalid(`nodes[${i}].sortOrder must be a whole number`)
    }
    out.push({
      id,
      tempId,
      parentId,
      parentTempId,
      name,
      sortOrder: r.sortOrder,
      archived: r.archived === true,
    })
  }
  return out
}

export interface ReorderLabelsInput {
  baseVersion: unknown
  nodes: unknown
}

/**
 * Save the whole tree from the settings page in one transaction. Serialized
 * per org, refused with `conflict` (409) when the taxonomy moved since
 * `baseVersion`, and fully checked before any write: parents are immutable,
 * new values go under a live group, and names stay unique among name-active
 * siblings on the final tree. New groups are inserted first, then new values
 * directly under their final parent. Nodes the payload leaves out keep their
 * state; archived rows are never in the tree, so nothing is restored here.
 */
export async function reorderLabels(
  args: WriteArgs<ReorderLabelsInput>,
): Promise<{ version: string; ids: Record<string, string> }> {
  const { orgId, actor, input } = args
  assertLabelsAdmin(actor)
  const base = input.baseVersion
  if (base !== null && base !== undefined && typeof base !== "string") {
    throw invalid("baseVersion must be the version labels.tree returned")
  }
  const nodes = parseReorderNodes(input.nodes)
  return withLabelsLock(args, async (tx) => {
    // 1. version (the lock is held).
    if ((base ?? null) !== (await labelsVersion(tx, orgId))) {
      throw new ProjectsServiceError(
        409,
        "conflict",
        "The labels changed since this page loaded. Reload to see the latest tree.",
      )
    }

    // 2. known ids, no duplicates.
    const rows = await loadLabelRows(tx, orgId)
    const existing = new Map(rows.map((r) => [r.id, r]))
    const keyOf = (n: ReorderNode) => (n.id !== undefined ? n.id : `temp:${n.tempId}`)
    const seen = new Set<string>()
    for (const n of nodes) {
      const key = keyOf(n)
      if (seen.has(key)) throw invalid(`label ${n.id ?? n.tempId} appears twice`)
      seen.add(key)
      if (n.id !== undefined && !existing.has(n.id)) throw notFound(n.id)
    }
    const newByTemp = new Map(
      nodes.flatMap((n) => (n.tempId !== undefined ? [[n.tempId, n] as const] : [])),
    )
    const payloadById = new Map(
      nodes.flatMap((n) => (n.id !== undefined ? [[n.id, n] as const] : [])),
    )

    // 3. parent immutability of stored nodes.
    for (const n of nodes) {
      if (n.id === undefined) continue
      const stored = existing.get(n.id)!
      if (n.parentTempId !== undefined || n.parentId !== stored.parent_id) {
        throw invalid(
          `Label ${stored.name} cannot move: values cannot move between groups. Create a new value instead.`,
        )
      }
    }

    // 4. new nodes go at the root or under a live group.
    const archivedInPayload = (id: string) => payloadById.get(id)?.archived === true
    for (const n of nodes) {
      if (n.tempId === undefined) continue
      if (n.parentTempId !== undefined) {
        const parent = newByTemp.get(n.parentTempId)
        if (!parent) throw invalid(`parentTempId ${n.parentTempId} names no new label`)
        if (parent.parentId !== null || parent.parentTempId !== undefined) {
          throw invalid(`New label ${n.name} would sit under a value: labels nest two levels.`)
        }
        if (parent.archived) {
          throw invalid(`New value ${n.name} cannot go under a group archived in the same save.`)
        }
      } else if (n.parentId !== null) {
        const parent = existing.get(n.parentId)
        if (!parent) {
          throw new ProjectsServiceError(404, "not_found", `Label group ${n.parentId} not found`)
        }
        if (parent.parent_id !== null) {
          throw invalid(
            `New label ${n.name} would sit under the value ${parent.name}: labels nest two levels.`,
          )
        }
        if (parent.archived_at !== null || archivedInPayload(parent.id)) {
          throw invalid(`New value ${n.name} cannot go under the archived group ${parent.name}.`)
        }
      }
    }

    // 5. names on the final tree, among name-active siblings.
    interface FinalNode {
      parent: string | null
      name: string
      active: boolean
    }
    const final = new Map<string, FinalNode>()
    for (const r of rows) {
      const p = payloadById.get(r.id)
      final.set(r.id, {
        parent: r.parent_id,
        name: p ? p.name : r.name,
        active: r.archived_at === null && !(p?.archived === true),
      })
    }
    for (const n of nodes) {
      if (n.tempId === undefined) continue
      final.set(`temp:${n.tempId}`, {
        parent: n.parentTempId !== undefined ? `temp:${n.parentTempId}` : n.parentId,
        name: n.name,
        active: !n.archived,
      })
    }
    const byParentName = new Map<string, string>()
    for (const [, node] of final) {
      if (!node.active) continue
      const k = `${node.parent ?? ""}\u0000${node.name.trim().toLowerCase()}`
      if (byParentName.has(k)) {
        const where =
          node.parent === null
            ? "Two label groups would both be named"
            : `Two labels under ${final.get(node.parent)?.name ?? node.parent} would both be named`
        throw nameExists(`${where} '${node.name}'.`)
      }
      byParentName.set(k, node.name)
    }

    // 6. writes.
    const ids: Record<string, string> = {}
    const insert = async (n: ReorderNode, parentId: string | null) => {
      const [row] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${projectsRel("labels")} (
            org_id, parent_id, name, sort_order, archived_at, created_at, updated_at
          ) VALUES (
            ${orgId}::uuid, ${parentId}::uuid, ${n.name}, ${n.sortOrder},
            ${n.archived ? drizzleSql`clock_timestamp()` : drizzleSql`NULL`},
            clock_timestamp(), clock_timestamp()
          )
          RETURNING id
        `),
      )
      ids[n.tempId!] = row!.id
    }
    for (const n of nodes) {
      if (n.tempId !== undefined && n.parentId === null && n.parentTempId === undefined) {
        await insert(n, null)
      }
    }
    for (const n of nodes) {
      if (n.tempId === undefined) continue
      if (n.parentTempId !== undefined) await insert(n, ids[n.parentTempId]!)
      else if (n.parentId !== null) await insert(n, n.parentId)
    }
    for (const n of nodes) {
      if (n.id === undefined) continue
      const was = existing.get(n.id)!
      if (was.name === n.name && was.sort_order === n.sortOrder) continue
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("labels")}
        SET name = ${n.name}, sort_order = ${n.sortOrder}, updated_at = clock_timestamp()
        WHERE id = ${n.id}::uuid AND org_id = ${orgId}::uuid
      `)
    }
    for (const n of nodes) {
      if (n.id === undefined || !n.archived) continue
      const was = existing.get(n.id)!
      if (was.archived_at !== null) continue
      // The block sends the whole removed subtree: a value whose group is
      // archived in the same save stays unstamped (the group's stamp covers it).
      if (was.parent_id !== null && archivedInPayload(was.parent_id)) continue
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("labels")}
        SET archived_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${n.id}::uuid AND org_id = ${orgId}::uuid
      `)
    }

    // 7. one event.
    const version = await labelsVersion(tx, orgId)
    await queueLabelEvent(tx, orgId, actor, "reordered", orgId, { version })
    return { version, ids }
  })
}
