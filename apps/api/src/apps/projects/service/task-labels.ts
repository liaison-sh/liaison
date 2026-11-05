// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task labels: resolving a caller's label map against the org's
// taxonomy, writing a task's own values inside the task transaction, and the
// batched read of every task's effective labels.
//
// A task's effective value for a group is its own value, else the nearest
// ancestor's (walking parent_task_id, the task itself at depth 1, at most
// MAX_TASK_DEPTH levels), per group independently, like `release`. It is never
// materialised, so a move or re-parent needs no rewrite.
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { byOrderThenName, type DbLabelRow, LABEL_NONE, loadLabelRows } from "./labels"
import { ProjectsServiceError } from "./statuses"
import { MAX_TASK_DEPTH } from "./task-depth"
import { formatTaskKey } from "./task-key"

/** One effective label of a task (one entry per group that has a value). */
export interface TaskLabel {
  groupId: string
  groupName: string
  groupArchived: boolean
  valueId: string
  valueName: string
  /** The value's own stamp or its group's. */
  archived: boolean
  inherited: boolean
  /** Display key of the ancestor holding the value; null on own entries. */
  inheritedFromKey: string | null
}

/**
 * Label input map: key = group id or name (case-insensitive, trimmed), value =
 * value id or name, or null to clear the task's own value for that group.
 * Groups left out are untouched.
 */
export type LabelInput = Record<string, string | null>

export interface ResolvedLabel {
  groupId: string
  /** null: clear (write mode) or "no value" (filter mode, LABEL_NONE). */
  valueId: string | null
}

type Mode = "write" | "filter"

const ordered = (rows: DbLabelRow[]) => [...rows].sort(byOrderThenName)

const isOwnArchived = (r: DbLabelRow) => r.archived_at !== null

function listNames(rows: Array<{ name: string; archived?: boolean }>): string {
  if (rows.length === 0) return "none"
  return rows.map((r) => (r.archived ? `${r.name} (archived)` : r.name)).join(", ")
}

function invalid(message: string, details?: unknown): ProjectsServiceError {
  return new ProjectsServiceError(400, "invalid_params", message, details)
}

/**
 * Pick the row a key names among `candidates`: id equality first, else a
 * case-insensitive name. A live (own stamp null) match wins; with none, a
 * single archived match is used and several are refused as ambiguous.
 */
function pick(candidates: DbLabelRow[], key: string, what: string): DbLabelRow | undefined {
  const byId = candidates.find((r) => r.id === key)
  if (byId) return byId
  const lower = key.trim().toLowerCase()
  const named = candidates.filter((r) => r.name.trim().toLowerCase() === lower)
  const live = named.filter((r) => !isOwnArchived(r))
  if (live.length > 0) return live[0]
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    const ids = named.map((r) => r.id)
    throw invalid(
      `Several archived ${what} are named '${key}'; pass the id instead: ${ids.join(", ")}.`,
      {
        candidates: ids,
      },
    )
  }
  return undefined
}

async function resolveLabels(
  tx: RlsClient | RlsTx,
  orgId: string,
  input: unknown,
  mode: Mode,
): Promise<ResolvedLabel[]> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("labels must be an object mapping a label group to a value")
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return []
  for (const [key, val] of entries) {
    const ok = typeof val === "string" || (mode === "write" && val === null)
    if (!ok) {
      throw invalid(
        mode === "write"
          ? `labels.${key} must be a value name or id, or null to clear it`
          : `labels.${key} must be a value name or id, or ${LABEL_NONE}`,
      )
    }
  }
  const rows = await loadLabelRows(tx, orgId)
  const groups = ordered(rows.filter((r) => r.parent_id === null))
  const liveGroups = groups.filter((g) => !isOwnArchived(g))
  const shownGroups = mode === "write" ? liveGroups : groups

  const out: ResolvedLabel[] = []
  const seen = new Set<string>()
  for (const [key, val] of entries) {
    const group = pick(groups, key, "label groups")
    if (!group) {
      const valid = shownGroups.map((g) => ({ id: g.id, name: g.name, archived: isOwnArchived(g) }))
      throw new ProjectsServiceError(
        404,
        "label_not_found",
        `Unknown label group '${key}'. Valid groups: ${listNames(valid)}.`,
        { group: key, validValues: valid.map(({ id, name }) => ({ id, name })) },
      )
    }
    if (seen.has(group.id)) {
      throw invalid(`labels names the label group ${group.name} twice`)
    }
    seen.add(group.id)
    if (val === null) {
      out.push({ groupId: group.id, valueId: null })
      continue
    }
    const value = val as string
    if (mode === "filter" && value === LABEL_NONE) {
      out.push({ groupId: group.id, valueId: null })
      continue
    }
    const groupArchived = isOwnArchived(group)
    const values = ordered(rows.filter((r) => r.parent_id === group.id))
    const liveValues = groupArchived ? [] : values.filter((v) => !isOwnArchived(v))
    const shown =
      mode === "write"
        ? liveValues.map((v) => ({ id: v.id, name: v.name, archived: false }))
        : values.map((v) => ({
            id: v.id,
            name: v.name,
            archived: groupArchived || isOwnArchived(v),
          }))
    const details = {
      group: group.name,
      value,
      validValues: shown.map(({ id, name }) => ({ id, name })),
    }
    const chosen = pick(values, value, `values in label group ${group.name}`)
    if (!chosen) {
      throw new ProjectsServiceError(
        404,
        "label_not_found",
        `Unknown value '${value}' for label group ${group.name}. Valid values: ${listNames(shown)}.`,
        details,
      )
    }
    if (mode === "write" && (groupArchived || isOwnArchived(chosen))) {
      throw new ProjectsServiceError(
        409,
        "label_archived",
        `Value '${chosen.name}' of label group ${group.name} is archived. Valid values: ${listNames(shown)}.`,
        details,
      )
    }
    out.push({ groupId: group.id, valueId: chosen.id })
  }
  return out
}

/**
 * Resolve the label map of a task write; undefined (labels not sent) is null,
 * so nothing is written. null clears on any group; an archived value (own or
 * group) is `label_archived`; an unknown group or value is `label_not_found`.
 * Both list the valid live names in the message (agents see only the message)
 * and in `details.validValues`. Runs before any write.
 */
export async function resolveLabelInput(
  tx: RlsClient | RlsTx,
  orgId: string,
  input: unknown,
): Promise<ResolvedLabel[] | null> {
  return input === undefined ? null : resolveLabels(tx, orgId, input, "write")
}

/**
 * Correlated scalar subquery: the effective value id of group `groupId` for
 * the task row aliased `alias` (the nearest holder within MAX_TASK_DEPTH
 * levels, the task itself at depth 1), NULL when no task of the chain holds
 * one. Nearest only, so a child's own value hides its parent's.
 */
function effectiveLabelValueSql(alias: string, orgId: string, groupId: string): SQL {
  const ref = drizzleSql.identifier(alias)
  return drizzleSql`(
    WITH RECURSIVE lbl_anc AS (
      SELECT ${ref}.id AS tid, ${ref}.parent_task_id, 1 AS depth
      UNION ALL
      SELECT p.id, p.parent_task_id, a.depth + 1
      FROM ${projectsRel("tasks")} p
      JOIN lbl_anc a ON p.id = a.parent_task_id
      WHERE a.depth < ${MAX_TASK_DEPTH} AND p.org_id = ${orgId}::uuid
    )
    SELECT tl.value_id FROM lbl_anc a
    JOIN ${projectsRel("task_labels")} tl
      ON tl.task_id = a.tid AND tl.org_id = ${orgId}::uuid AND tl.group_id = ${groupId}::uuid
    ORDER BY a.depth LIMIT 1
  )`
}

/** WHERE fragment ANDing one effective-value condition per resolved group; null when empty. */
function labelFilterSql(alias: string, orgId: string, resolved: ResolvedLabel[]): SQL | null {
  if (resolved.length === 0) return null
  const conds = resolved.map((r) => {
    const eff = effectiveLabelValueSql(alias, orgId, r.groupId)
    return r.valueId === null ? drizzleSql`${eff} IS NULL` : drizzleSql`${eff} = ${r.valueId}::uuid`
  })
  return drizzleSql`(${drizzleSql.join(conds, drizzleSql` AND `)})`
}

/**
 * The WHERE condition for a caller's label filter on the task rows aliased
 * `alias`, or null when there is no filter. One value per group; archived
 * groups and values are accepted and LABEL_NONE ("__none__") means "no
 * effective value". An unknown group or value is `label_not_found` listing
 * live and archived names: a filter is never ignored.
 */
export async function labelFilterCondition(
  tx: RlsClient | RlsTx,
  orgId: string,
  alias: string,
  labels: unknown,
): Promise<SQL | null> {
  if (labels === undefined) return null
  return labelFilterSql(alias, orgId, await resolveLabels(tx, orgId, labels, "filter"))
}

/**
 * Write a task's own values: a null value deletes the row for its group, a
 * value upserts it (last writer wins); null assignments write nothing. Runs
 * inside the caller's transaction.
 */
export async function applyTaskLabels(
  tx: RlsClient | RlsTx,
  orgId: string,
  taskId: string,
  assignments: ResolvedLabel[] | null,
): Promise<void> {
  for (const a of assignments ?? []) {
    if (a.valueId === null) {
      await tx.execute(drizzleSql`
        DELETE FROM ${projectsRel("task_labels")}
        WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND group_id = ${a.groupId}::uuid
      `)
      continue
    }
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("task_labels")} (org_id, task_id, group_id, value_id)
      VALUES (${orgId}::uuid, ${taskId}::uuid, ${a.groupId}::uuid, ${a.valueId}::uuid)
      ON CONFLICT (org_id, task_id, group_id)
      DO UPDATE SET value_id = EXCLUDED.value_id, updated_at = now()
    `)
  }
}

interface EffectiveRow {
  origin: string
  depth: number
  group_id: string
  group_name: string
  group_archived_at: unknown
  group_sort: number
  value_id: string
  value_name: string
  value_archived_at: unknown
  holder_number: number | null
  holder_project_key: string | null
}

/**
 * Effective labels of every task in `taskIds`, in ONE statement: a recursive
 * walk up parent_task_id from each task (depth 1) to its 7th ancestor (depth
 * MAX_TASK_DEPTH), the nearest holder per (task, group) kept. Each list is
 * ordered by group sort order, then group name. Tasks with no label map to [].
 */
export async function loadTaskLabels(
  tx: RlsClient | RlsTx,
  orgId: string,
  taskIds: readonly string[],
): Promise<Map<string, TaskLabel[]>> {
  const out = new Map<string, TaskLabel[]>()
  const unique = [...new Set(taskIds)]
  if (unique.length === 0) return out
  for (const id of unique) out.set(id, [])
  const ids = drizzleSql.join(
    unique.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  const rows = extractRows<EffectiveRow>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE anc AS (
        SELECT t.id AS origin, t.id AS tid, t.parent_task_id, 1 AS depth
        FROM ${projectsRel("tasks")} t
        WHERE t.id IN (${ids}) AND t.org_id = ${orgId}::uuid
        UNION ALL
        SELECT a.origin, p.id, p.parent_task_id, a.depth + 1
        FROM ${projectsRel("tasks")} p
        JOIN anc a ON p.id = a.parent_task_id
        WHERE a.depth < ${MAX_TASK_DEPTH} AND p.org_id = ${orgId}::uuid
      ),
      nearest AS (
        SELECT DISTINCT ON (a.origin, tl.group_id)
          a.origin, a.tid, a.depth, tl.group_id, tl.value_id
        FROM anc a
        JOIN ${projectsRel("task_labels")} tl ON tl.task_id = a.tid AND tl.org_id = ${orgId}::uuid
        ORDER BY a.origin, tl.group_id, a.depth
      )
      SELECT n.origin, n.depth, n.group_id,
        g.name AS group_name, g.archived_at AS group_archived_at, g.sort_order AS group_sort,
        n.value_id, v.name AS value_name, v.archived_at AS value_archived_at,
        h.number AS holder_number, pr.key AS holder_project_key
      FROM nearest n
      JOIN ${projectsRel("labels")} g ON g.id = n.group_id AND g.org_id = ${orgId}::uuid
      JOIN ${projectsRel("labels")} v ON v.id = n.value_id AND v.org_id = ${orgId}::uuid
      JOIN ${projectsRel("tasks")} h ON h.id = n.tid AND h.org_id = ${orgId}::uuid
      LEFT JOIN ${projectsRel("projects")} pr ON pr.id = h.project_id AND pr.org_id = h.org_id
      ORDER BY n.origin, g.sort_order, lower(g.name)
    `),
  )
  for (const r of rows) {
    const inherited = Number(r.depth) > 1
    const groupArchived = r.group_archived_at !== null
    out.get(r.origin)?.push({
      groupId: r.group_id,
      groupName: r.group_name,
      groupArchived,
      valueId: r.value_id,
      valueName: r.value_name,
      archived: groupArchived || r.value_archived_at !== null,
      inherited,
      inheritedFromKey:
        inherited && r.holder_project_key != null && r.holder_number != null
          ? formatTaskKey(r.holder_project_key, Number(r.holder_number))
          : null,
    })
  }
  return out
}

/** Set `labels` on each row from one batched read. */
export async function attachTaskLabels<T extends { id: string; labels: TaskLabel[] }>(
  tx: RlsClient | RlsTx,
  orgId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows
  const map = await loadTaskLabels(
    tx,
    orgId,
    rows.map((r) => r.id),
  )
  for (const r of rows) r.labels = map.get(r.id) ?? []
  return rows
}
