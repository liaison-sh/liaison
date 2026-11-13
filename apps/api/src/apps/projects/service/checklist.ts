// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import {
  CHECKLIST_DETAILS_MAX,
  CHECKLIST_ITEMS_PER_ADD_MAX,
  CHECKLIST_ITEMS_PER_TASK_MAX,
  CHECKLIST_TITLE_MAX,
  type ChecklistItemLike,
  type ChecklistStatus,
  checklistStatus,
  FAIL_NOTE_MAX,
  parseStoredLevels,
  SOURCE_URL_MAX,
  type ValidationLevel,
  type ValidationRecord,
  type ValidationState,
  validateLevels,
} from "./checklist-status"
import { statusIsTerminal } from "./move-task"
import { ProjectsServiceError } from "./statuses"
import { postTaskComment } from "./task-comment"

/**
 * Who is acting, as far as the checklist cares. Distinct from `actorType`,
 * which reads "user" for a person and for an MCP agent alike. It records who
 * set a validation (`via`), who authored a fail note, and whether items can
 * still be added to a task already in a terminal status (humans only). REST
 * routes pass "human", the sandbox bridge derives it from the dispatch origin.
 */
export type ActorKind = "human" | "agent"

interface ItemRow {
  id: string
  task_id: string
  title: string
  checked: boolean
  validations: Record<string, ValidationRecord> | null
}

function uuidList(ids: string[]) {
  return drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
}

/** Level names match case-insensitively, ignoring surrounding spaces. */
function levelKey(name: string): string {
  return name.trim().toLowerCase()
}

export async function readProjectLevels(
  tx: RlsTx | RlsClient,
  orgId: string,
  projectId: string,
): Promise<ValidationLevel[]> {
  const rows = extractRows<{ validation_levels: unknown }>(
    await tx.execute(drizzleSql`
      SELECT validation_levels FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  return parseStoredLevels(rows[0]?.validation_levels)
}

export async function readItems(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskIds: string[],
): Promise<Map<string, ChecklistItemLike[]>> {
  const byTask = new Map<string, ChecklistItemLike[]>()
  if (taskIds.length === 0) return byTask
  const rows = extractRows<ItemRow>(
    await tx.execute(drizzleSql`
      SELECT id, task_id, title, checked, validations
      FROM ${projectsRel("task_checklist_items")}
      WHERE org_id = ${orgId}::uuid AND task_id IN (${uuidList(taskIds)})
      ORDER BY task_id, position ASC, id ASC
    `),
  )
  for (const r of rows) {
    const list = byTask.get(r.task_id) ?? []
    list.push({ id: r.id, title: r.title, checked: r.checked, validations: r.validations ?? {} })
    byTask.set(r.task_id, list)
  }
  return byTask
}

/**
 * Re-key an item's validations from the source project's levels to the
 * target's, matching level names case-insensitively. Keys with no matching
 * target level (or no known source level) are dropped.
 */
function mapValidationsByLevelName(
  validations: Record<string, ValidationRecord>,
  sourceLevels: ValidationLevel[],
  targetLevels: ValidationLevel[],
): Record<string, ValidationRecord> {
  const targetByName = new Map(targetLevels.map((l) => [levelKey(l.name), l]))
  const out: Record<string, ValidationRecord> = {}
  for (const level of sourceLevels) {
    const record = validations[level.id]
    if (!record) continue
    const target = targetByName.get(levelKey(level.name))
    if (!target) continue
    out[target.id] = record
  }
  return out
}

/**
 * Write side of a cross-project move: re-key the validations of every item
 * of the moved tasks to the target project's levels, in the move's transaction.
 */
export async function remapChecklistValidations(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskIds: string[],
  sourceLevels: ValidationLevel[],
  targetLevels: ValidationLevel[],
): Promise<void> {
  const itemsByTask = await readItems(tx, orgId, taskIds)
  for (const items of itemsByTask.values()) {
    for (const item of items) {
      const mapped = mapValidationsByLevelName(item.validations, sourceLevels, targetLevels)
      if (JSON.stringify(mapped) === JSON.stringify(item.validations)) continue
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("task_checklist_items")}
        SET validations = ${JSON.stringify(mapped)}::jsonb, updated_at = now()
        WHERE id = ${item.id}::uuid AND org_id = ${orgId}::uuid
      `)
    }
  }
}

/** What an agent reads after it put a task with an incomplete checklist in a terminal status. */
export interface ChecklistWarning {
  message: string
  status: ChecklistStatus
}

/**
 * The checklist never blocks a status change. When a task sits in a
 * terminal status with an incomplete checklist, this returns the warning an
 * agent's tool result carries so the agent sees what is not proven; null when
 * the task has no items, its checklist is complete, or its status is not terminal.
 */
export async function checklistWarningForTerminal(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskId: string,
): Promise<ChecklistWarning | null> {
  const rows = extractRows<{ project_id: string; terminal: boolean | null }>(
    await tx.execute(drizzleSql`
      SELECT t.project_id, s.terminal
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
      WHERE t.id = ${taskId}::uuid AND t.org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (row?.terminal !== true) return null
  const items = (await readItems(tx, orgId, [taskId])).get(taskId) ?? []
  if (items.length === 0) return null
  const status = checklistStatus(await readProjectLevels(tx, orgId, row.project_id), items)
  if (status.blocking.length === 0) return null
  const n = status.blocking.length
  return {
    message: `The task is now in a terminal status but its checklist is incomplete: ${n} item${n === 1 ? "" : "s"} not proven (see status.blocking). Tell the user which items are not proven.`,
    status,
  }
}

// ---------------------------------------------------------------------------
// Items, validations and levels
// ---------------------------------------------------------------------------

const CHECKLIST_TASK_TERMINAL = "checklist_task_terminal"
const CHECKLIST_FAIL_NOTE_REQUIRED = "checklist_fail_note_required"
const CHECKLIST_LEVEL_UNKNOWN = "checklist_level_unknown"
const CHECKLIST_ITEM_INVALID = "checklist_item_invalid"
const CHECKLIST_TOO_MANY_ITEMS = "checklist_too_many_items"
const CHECKLIST_VALIDATION_INVALID = "checklist_validation_invalid"
const CHECKLIST_CHECKED_IN_LEVEL_MODE = "checklist_checked_in_level_mode"

function refuseCheckedInLevelMode(levels: ValidationLevel[]): void {
  if (levels.length === 0) return
  throw new ProjectsServiceError(
    400,
    CHECKLIST_CHECKED_IN_LEVEL_MODE,
    `${CHECKLIST_CHECKED_IN_LEVEL_MODE}: this project has validation levels; set a level state instead of checked`,
  )
}

const VALIDATION_STATES: ValidationState[] = ["not_done", "fail", "success", "na"]

const STATE_LABEL: Record<ValidationState, string> = {
  fail: "Fail",
  success: "Success",
  na: "N/A",
  not_done: "Not done",
}

export interface ChecklistItem {
  id: string
  taskId: string
  position: number
  title: string
  details: string | null
  checked: boolean
  validations: Record<string, ValidationRecord>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ChecklistView {
  levels: ValidationLevel[]
  items: ChecklistItem[]
  status: ChecklistStatus
}

interface FullItemRow {
  id: string
  task_id: string
  position: number
  title: string
  details: string | null
  checked: boolean
  validations: Record<string, ValidationRecord> | null
  created_by: string
  created_at: Date | string
  updated_at: Date | string
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function itemFromRow(r: FullItemRow): ChecklistItem {
  return {
    id: r.id,
    taskId: r.task_id,
    position: Number(r.position),
    title: r.title,
    details: r.details,
    checked: r.checked,
    validations: r.validations ?? {},
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

const ITEM_COLUMNS = drizzleSql`id, task_id, position, title, details, checked, validations, created_by, created_at, updated_at`

interface SharedTask {
  id: string
  projectId: string
  statusId: string
}

/**
 * Read the live parent task of an item write. A binned task reads as not
 * found: its items are hidden with it. Writes that grow the checklist pass
 * `"update"`: two concurrent appends must serialize on the task row, or both
 * read the same count and pass the per-task cap.
 */
async function readLiveTask(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskId: string,
  mode: "read" | "update" = "read",
): Promise<SharedTask> {
  const lock = mode === "update" ? drizzleSql`FOR UPDATE` : drizzleSql``
  const rows = extractRows<{ id: string; project_id: string; status_id: string }>(
    await tx.execute(drizzleSql`
      SELECT id, project_id, status_id FROM ${projectsRel("tasks")}
      WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
      ${lock}
    `),
  )
  const row = rows[0]
  if (!row) throw new ProjectsServiceError(404, "not_found", "task not found")
  return { id: row.id, projectId: row.project_id, statusId: row.status_id }
}

async function readLevelsLocked(
  tx: RlsTx | RlsClient,
  orgId: string,
  projectId: string,
  mode: "share" | "update",
): Promise<ValidationLevel[]> {
  const lock = mode === "update" ? drizzleSql`FOR UPDATE` : drizzleSql`FOR SHARE`
  const rows = extractRows<{ validation_levels: unknown }>(
    await tx.execute(drizzleSql`
      SELECT validation_levels FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ${lock}
    `),
  )
  if (rows.length === 0) throw new ProjectsServiceError(404, "not_found", "project not found")
  return parseStoredLevels(rows[0]?.validation_levels)
}

async function readFullItems(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskId: string,
): Promise<ChecklistItem[]> {
  const rows = extractRows<FullItemRow>(
    await tx.execute(drizzleSql`
      SELECT ${ITEM_COLUMNS} FROM ${projectsRel("task_checklist_items")}
      WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid
      ORDER BY position ASC, id ASC
    `),
  )
  return rows.map(itemFromRow)
}

async function queueItemEvent(
  tx: RlsTx | RlsClient,
  orgId: string,
  userId: string,
  action: "created" | "updated" | "deleted",
  item: { id: string; taskId: string } & Partial<ChecklistItem>,
): Promise<void> {
  await tx.queueEvent({
    app: "projects",
    entity: "task_checklist_item",
    action,
    entityId: item.id,
    data: item,
    actorId: userId,
    actorType: "user",
    orgId,
  })
}

export interface ChecklistReadArgs {
  tx: RlsClient
  orgId: string
  taskId: string
}

/** Levels, items and status summary of a live task (404 for a binned one). */
export async function listChecklist(args: ChecklistReadArgs): Promise<ChecklistView> {
  const { tx, orgId, taskId } = args
  const rows = extractRows<{ project_id: string }>(
    await tx.execute(drizzleSql`
      SELECT project_id FROM ${projectsRel("tasks")}
      WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
      LIMIT 1
    `),
  )
  if (!rows[0]) throw new ProjectsServiceError(404, "not_found", "task not found")
  const levels = await readProjectLevels(tx, orgId, rows[0].project_id)
  const items = await readFullItems(tx, orgId, taskId)
  return { levels, items, status: checklistStatus(levels, items) }
}

/** The status summary alone, for the task detail. */
export async function getChecklistStatus(args: ChecklistReadArgs): Promise<ChecklistStatus> {
  return (await listChecklist(args)).status
}

interface ChecklistWriteBase {
  tx: RlsClient
  orgId: string
  userId: string
  actorKind: ActorKind
}

function normalizeTitle(raw: unknown, field: string): string {
  const title = typeof raw === "string" ? raw.trim() : ""
  if (title.length < 1 || title.length > CHECKLIST_TITLE_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_ITEM_INVALID,
      `${field} must be 1..${CHECKLIST_TITLE_MAX} characters`,
    )
  }
  return title
}

function normalizeDetails(raw: unknown, field: string): string | null {
  if (raw == null) return null
  if (typeof raw !== "string" || raw.length > CHECKLIST_DETAILS_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_ITEM_INVALID,
      `${field} must be at most ${CHECKLIST_DETAILS_MAX} characters`,
    )
  }
  return raw.length === 0 ? null : raw
}

export interface AddItemsArgs extends ChecklistWriteBase {
  taskId: string
  items: { title: string; details?: string | null }[]
}

/**
 * Append items to a task's checklist (within the per-task limits). Never touches the task's
 * status: an item added to a Done task leaves it Done and the counters show it.
 * An agent cannot add to a task that is already terminal; a human can.
 */
export async function addItems(args: AddItemsArgs): Promise<ChecklistItem[]> {
  const { tx, orgId, userId, actorKind, taskId } = args
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new ProjectsServiceError(400, CHECKLIST_ITEM_INVALID, "items must hold at least one item")
  }
  if (args.items.length > CHECKLIST_ITEMS_PER_ADD_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_TOO_MANY_ITEMS,
      `items: at most ${CHECKLIST_ITEMS_PER_ADD_MAX} items per call (got ${args.items.length})`,
    )
  }
  const inputs = args.items.map((item, i) => ({
    title: normalizeTitle(item?.title, `items[${i}].title`),
    details: normalizeDetails(item?.details, `items[${i}].details`),
  }))
  const task = await readLiveTask(tx, orgId, taskId, "update")
  if (actorKind !== "human" && (await statusIsTerminal(tx, orgId, task.statusId))) {
    throw new ProjectsServiceError(
      409,
      CHECKLIST_TASK_TERMINAL,
      `${CHECKLIST_TASK_TERMINAL}: an agent cannot add checklist items to a task in a terminal status`,
    )
  }
  const [agg] = extractRows<{ n: number; max_pos: number | null }>(
    await tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS n, MAX(position) AS max_pos
      FROM ${projectsRel("task_checklist_items")}
      WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid
    `),
  )
  const existing = agg?.n ?? 0
  if (existing + inputs.length > CHECKLIST_ITEMS_PER_TASK_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_TOO_MANY_ITEMS,
      `items: a task holds at most ${CHECKLIST_ITEMS_PER_TASK_MAX} checklist items (has ${existing}, adding ${inputs.length})`,
    )
  }
  // Same append scheme as task positions: max + 1 (1000 + 1 when empty).
  let position = agg?.max_pos != null ? Number(agg.max_pos) : 1000
  const created: ChecklistItem[] = []
  for (const input of inputs) {
    position += 1
    const [row] = extractRows<FullItemRow>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("task_checklist_items")}
          (org_id, task_id, position, title, details, created_by)
        VALUES (${orgId}::uuid, ${taskId}::uuid, ${position}, ${input.title}, ${input.details}, ${userId}::uuid)
        RETURNING ${ITEM_COLUMNS}
      `),
    )
    const item = itemFromRow(row!)
    created.push(item)
    await queueItemEvent(tx, orgId, userId, "created", item)
  }
  return created
}

async function readItemForWrite(
  tx: RlsTx | RlsClient,
  orgId: string,
  itemId: string,
  taskId?: string,
): Promise<{ item: ChecklistItem; task: SharedTask }> {
  const found = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      SELECT task_id FROM ${projectsRel("task_checklist_items")}
      WHERE id = ${itemId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  const ownerTaskId = found[0]?.task_id
  if (!ownerTaskId || (taskId && ownerTaskId !== taskId)) {
    throw new ProjectsServiceError(404, "not_found", "checklist item not found")
  }
  const task = await readLiveTask(tx, orgId, ownerTaskId)
  const rows = extractRows<FullItemRow>(
    await tx.execute(drizzleSql`
      SELECT ${ITEM_COLUMNS} FROM ${projectsRel("task_checklist_items")}
      WHERE id = ${itemId}::uuid AND org_id = ${orgId}::uuid AND task_id = ${ownerTaskId}::uuid
    `),
  )
  if (!rows[0]) throw new ProjectsServiceError(404, "not_found", "checklist item not found")
  return { item: itemFromRow(rows[0]), task }
}

/**
 * Position among the task's items, same scheme as task positions
 * (`computePosition`, move-task.ts): midpoint between the two neighbours,
 * after + 1 / before - 1 with one neighbour, append otherwise, and a dense
 * re-balance when a midpoint collides.
 */
async function computeItemPosition(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskId: string,
  itemId: string,
  req: { beforeItemId?: string | null; afterItemId?: string | null },
): Promise<number> {
  const positionOf = async (id: string): Promise<number | null> => {
    const rows = extractRows<{ position: number }>(
      await tx.execute(drizzleSql`
        SELECT position FROM ${projectsRel("task_checklist_items")}
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid LIMIT 1
      `),
    )
    return rows[0] ? Number(rows[0].position) : null
  }
  let candidate: number | null = null
  if (req.beforeItemId && req.afterItemId) {
    const a = await positionOf(req.afterItemId)
    const b = await positionOf(req.beforeItemId)
    if (a !== null && b !== null) candidate = (a + b) / 2
  }
  if (candidate === null && req.afterItemId) {
    const a = await positionOf(req.afterItemId)
    if (a !== null) candidate = a + 1
  }
  if (candidate === null && req.beforeItemId) {
    const b = await positionOf(req.beforeItemId)
    if (b !== null) candidate = b - 1
  }
  if (candidate === null) {
    const rows = extractRows<{ max_pos: number | null }>(
      await tx.execute(drizzleSql`
        SELECT MAX(position) AS max_pos FROM ${projectsRel("task_checklist_items")}
        WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND id <> ${itemId}::uuid
      `),
    )
    return (rows[0]?.max_pos != null ? Number(rows[0].max_pos) : 1000) + 1
  }
  const collision = extractRows<{ cnt: number }>(
    await tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS cnt FROM ${projectsRel("task_checklist_items")}
      WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid
        AND id <> ${itemId}::uuid AND position = ${candidate}
    `),
  )
  if ((collision[0]?.cnt ?? 0) === 0) return candidate
  await tx.execute(drizzleSql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) * 1000 AS new_pos
      FROM ${projectsRel("task_checklist_items")}
      WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND id <> ${itemId}::uuid
    )
    UPDATE ${projectsRel("task_checklist_items")} i
    SET position = ranked.new_pos
    FROM ranked
    WHERE i.id = ranked.id
  `)
  return computeItemPosition(tx, orgId, taskId, itemId, req)
}

export interface UpdateItemArgs extends ChecklistWriteBase {
  itemId: string
  /** When set, the item must belong to this task (REST path scoping). */
  taskId?: string
  patch: {
    title?: string
    details?: string | null
    checked?: boolean
    beforeItemId?: string | null
    afterItemId?: string | null
  }
}

/** Edit title/details, set the plain-mode `checked`, or reorder. */
export async function updateItem(args: UpdateItemArgs): Promise<ChecklistItem> {
  const { tx, orgId, userId, itemId, patch } = args
  const title = patch.title !== undefined ? normalizeTitle(patch.title, "title") : undefined
  const details =
    patch.details !== undefined ? normalizeDetails(patch.details, "details") : undefined
  if (patch.checked !== undefined && typeof patch.checked !== "boolean") {
    throw new ProjectsServiceError(400, CHECKLIST_ITEM_INVALID, "checked must be a boolean")
  }
  const { item, task } = await readItemForWrite(tx, orgId, itemId, args.taskId)
  if (patch.checked !== undefined) {
    refuseCheckedInLevelMode(await readLevelsLocked(tx, orgId, task.projectId, "share"))
  }
  const sets: ReturnType<typeof drizzleSql>[] = []
  if (title !== undefined) sets.push(drizzleSql`title = ${title}`)
  if (details !== undefined) sets.push(drizzleSql`details = ${details}`)
  if (patch.checked !== undefined) sets.push(drizzleSql`checked = ${patch.checked}`)
  if (patch.beforeItemId || patch.afterItemId) {
    const position = await computeItemPosition(tx, orgId, item.taskId, itemId, patch)
    sets.push(drizzleSql`position = ${position}`)
  }
  if (sets.length === 0) return item
  sets.push(drizzleSql`updated_at = now()`)
  const [row] = extractRows<FullItemRow>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("task_checklist_items")}
      SET ${drizzleSql.join(sets, drizzleSql`, `)}
      WHERE id = ${itemId}::uuid AND org_id = ${orgId}::uuid
      RETURNING ${ITEM_COLUMNS}
    `),
  )
  const updated = itemFromRow(row!)
  await queueItemEvent(tx, orgId, userId, "updated", updated)
  return updated
}

export interface RemoveItemArgs extends ChecklistWriteBase {
  itemId: string
  taskId?: string
}

/** Remove one item. Agents reach this only through the gated tool. */
export async function removeItem(args: RemoveItemArgs): Promise<{ id: string; taskId: string }> {
  const { tx, orgId, userId, itemId } = args
  const { item } = await readItemForWrite(tx, orgId, itemId, args.taskId)
  await tx.execute(drizzleSql`
    DELETE FROM ${projectsRel("task_checklist_items")}
    WHERE id = ${itemId}::uuid AND org_id = ${orgId}::uuid
  `)
  await queueItemEvent(tx, orgId, userId, "deleted", { id: item.id, taskId: item.taskId })
  return { id: item.id, taskId: item.taskId }
}

export interface ValidationEntry {
  itemId: string
  /** Level id, or its name matched case-insensitively. Omit with `checked`. */
  level?: string
  state?: ValidationState
  /** Plain mode: the item's boolean, settable by humans and agents alike. */
  checked?: boolean
  note?: string | null
  source?: string | null
}

export interface SetValidationsArgs extends ChecklistWriteBase {
  /** When set, every item must belong to this task. */
  taskId?: string
  entries: ValidationEntry[]
  /** Scopes a reader needs to see the note comment (REST: [], sandbox: the taint). */
  commentRequiredScopes: string[]
  /**
   * The agent whose turn wrote this (sandbox: the agent captured with the
   * calling turn's frame), so an agent's note comment names it. Undefined
   * leaves sendMessage to resolve one.
   */
  agentId?: string | null
  /** Who signs an agent's note comment when a routine acted ("Routine <title>"). */
  agentAuthorLabel?: string | null
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function resolveLevel(levels: ValidationLevel[], ref: string): ValidationLevel {
  const byId = levels.find((l) => l.id === ref)
  if (byId) return byId
  const key = levelKey(ref)
  const byName = levels.find((l) => levelKey(l.name) === key)
  if (byName) return byName
  throw new ProjectsServiceError(
    400,
    CHECKLIST_LEVEL_UNKNOWN,
    `level ${JSON.stringify(ref)} is not a validation level of this project`,
  )
}

/**
 * Record validation states, one entry or a batch of up to 50.
 *
 * Each state is written as ONE JSONB key with bound parameters (`jsonb_set`),
 * never a whole-object overwrite, so concurrent writes on different levels of
 * the same item both survive and the same level ends last-write-wins. A note
 * (required for `fail`) becomes a comment on the task thread in the same
 * transaction, authored by the actor. Never touches the task's status.
 */
export async function setValidations(args: SetValidationsArgs): Promise<ChecklistItem[]> {
  const { tx, orgId, userId, actorKind } = args
  const entries = args.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_VALIDATION_INVALID,
      "at least one entry is required",
    )
  }
  if (entries.length > CHECKLIST_ITEMS_PER_ADD_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_VALIDATION_INVALID,
      `at most ${CHECKLIST_ITEMS_PER_ADD_MAX} validations per call (got ${entries.length})`,
    )
  }
  const levelsByProject = new Map<string, ValidationLevel[]>()
  const planned: {
    entry: ValidationEntry
    item: ChecklistItem
    level: ValidationLevel | null
    note: string | null
    source: string | null
  }[] = []
  for (const entry of entries) {
    if (!entry?.itemId) {
      throw new ProjectsServiceError(400, CHECKLIST_VALIDATION_INVALID, "itemId is required")
    }
    const { item, task } = await readItemForWrite(tx, orgId, entry.itemId, args.taskId)
    let levels = levelsByProject.get(task.projectId)
    if (!levels) {
      levels = await readLevelsLocked(tx, orgId, task.projectId, "share")
      levelsByProject.set(task.projectId, levels)
    }
    const note = typeof entry.note === "string" && entry.note.trim() ? entry.note.trim() : null
    if (note && note.length > FAIL_NOTE_MAX) {
      throw new ProjectsServiceError(
        400,
        CHECKLIST_VALIDATION_INVALID,
        `note must be at most ${FAIL_NOTE_MAX} characters`,
      )
    }
    // Optional for everyone; when present, an https URL.
    const source = typeof entry.source === "string" && entry.source ? entry.source.trim() : null
    if (source !== null && (source.length > SOURCE_URL_MAX || !isHttpsUrl(source))) {
      throw new ProjectsServiceError(
        400,
        CHECKLIST_VALIDATION_INVALID,
        `source must be an https URL of at most ${SOURCE_URL_MAX} characters`,
      )
    }
    if (entry.level === undefined || entry.level === null) {
      // Plain mode boolean.
      if (typeof entry.checked !== "boolean") {
        throw new ProjectsServiceError(
          400,
          CHECKLIST_VALIDATION_INVALID,
          "each entry needs a level and a state, or checked",
        )
      }
      refuseCheckedInLevelMode(levels)
      planned.push({ entry, item, level: null, note, source })
      continue
    }
    const level = resolveLevel(levels, String(entry.level))
    if (!entry.state || !VALIDATION_STATES.includes(entry.state)) {
      throw new ProjectsServiceError(
        400,
        CHECKLIST_VALIDATION_INVALID,
        `state must be one of ${VALIDATION_STATES.join(", ")}`,
      )
    }
    if (entry.state === "fail" && !note) {
      throw new ProjectsServiceError(
        400,
        CHECKLIST_FAIL_NOTE_REQUIRED,
        `${CHECKLIST_FAIL_NOTE_REQUIRED}: a fail needs a note of 1..${FAIL_NOTE_MAX} characters`,
      )
    }
    planned.push({ entry, item, level, note, source })
  }

  const via: ValidationRecord["via"] = actorKind === "human" ? "human" : "agent"
  const updated = new Map<string, ChecklistItem>()
  for (const { entry, item, level, note, source } of planned) {
    let row: FullItemRow | undefined
    let commentBody: string | null = null
    if (level === null) {
      ;[row] = extractRows<FullItemRow>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_checklist_items")}
          SET checked = ${entry.checked === true}, updated_at = now()
          WHERE id = ${item.id}::uuid AND org_id = ${orgId}::uuid
          RETURNING ${ITEM_COLUMNS}
        `),
      )
      if (note) {
        commentBody = `${entry.checked ? "Checked" : "Unchecked"} "${item.title}": ${note}`
      }
    } else {
      const state = entry.state as ValidationState
      const record: ValidationRecord = {
        state,
        by: userId,
        via,
        source,
        at: new Date().toISOString(),
      }
      ;[row] = extractRows<FullItemRow>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_checklist_items")}
          SET validations = jsonb_set(validations, ARRAY[${level.id}]::text[], ${JSON.stringify(record)}::jsonb, true),
              updated_at = now()
          WHERE id = ${item.id}::uuid AND org_id = ${orgId}::uuid
          RETURNING ${ITEM_COLUMNS}
        `),
      )
      if (note) {
        commentBody = `${STATE_LABEL[state]} on ${level.name} for "${item.title}": ${note}`
      }
    }
    const saved = itemFromRow(row!)
    updated.set(saved.id, saved)
    if (commentBody) {
      const posted = await postTaskComment(tx, {
        orgId,
        userId,
        taskId: item.taskId,
        body: commentBody,
        requiredScopes: args.commentRequiredScopes,
        authorType: actorKind === "agent" ? "agent" : "user",
        ...(actorKind === "agent" && args.agentId ? { agentId: args.agentId } : {}),
        ...(actorKind === "agent" && args.agentAuthorLabel
          ? { agentAuthorLabel: args.agentAuthorLabel }
          : {}),
      })
      if (!posted.messageId) throw new Error("checklist_note_not_posted")
    }
    await queueItemEvent(tx, orgId, userId, "updated", saved)
  }
  return [...updated.values()]
}

export interface SetValidationLevelsArgs {
  tx: RlsClient
  orgId: string
  userId: string
  projectId: string
  /** Any key other than id and name (a legacy `agentAccess`) is ignored. */
  levels: { id?: string | null; name: string }[]
}

/**
 * Replace a project's whole ordered level list. Existing ids are kept;
 * an input without a known id gets a new one. A removed level's key is deleted
 * from every item of the project in the same transaction; an added level
 * leaves every item `not_done` on it; a rename keeps every state (same id).
 */
export async function setValidationLevels(
  args: SetValidationLevelsArgs,
): Promise<ValidationLevel[]> {
  const { tx, orgId, userId, projectId } = args
  if (!Array.isArray(args.levels)) {
    throw new ProjectsServiceError(400, "validation_levels_invalid", "levels must be a list")
  }
  const archived = extractRows<{ archived_at: Date | string | null }>(
    await tx.execute(drizzleSql`
      SELECT archived_at FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      FOR UPDATE
    `),
  )
  if (archived.length === 0) throw new ProjectsServiceError(404, "not_found", "project not found")
  if (archived[0]?.archived_at) {
    throw new ProjectsServiceError(409, "project_archived", "project is archived")
  }
  const current = await readLevelsLocked(tx, orgId, projectId, "update")
  const currentIds = new Set(current.map((l) => l.id))
  const seenIds = new Set<string>()
  const next = validateLevels(
    args.levels.map((l) => {
      const keep = typeof l?.id === "string" && currentIds.has(l.id) && !seenIds.has(l.id)
      const id = keep ? (l.id as string) : randomUUID()
      seenIds.add(id)
      return {
        id,
        name: typeof l?.name === "string" ? l.name : "",
      }
    }),
  )
  const nextIds = new Set(next.map((l) => l.id))
  for (const removed of current.filter((l) => !nextIds.has(l.id))) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("task_checklist_items")} i
      SET validations = i.validations - ${removed.id}::text, updated_at = now()
      FROM ${projectsRel("tasks")} t
      WHERE t.id = i.task_id AND t.org_id = ${orgId}::uuid AND t.project_id = ${projectId}::uuid
        AND i.org_id = ${orgId}::uuid AND i.validations ? ${removed.id}::text
    `)
  }
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("projects")}
    SET validation_levels = ${JSON.stringify(next)}::jsonb, updated_at = now()
    WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
  `)
  await tx.queueEvent({
    app: "projects",
    entity: "project",
    action: "updated",
    entityId: projectId,
    data: { id: projectId, validationLevels: next },
    actorId: userId,
    actorType: "user",
    orgId,
  })
  return next
}

/**
 * Merge side of the checklist: append the source task's items after the
 * target's own, keeping validations within a project and mapping them by
 * level name across projects. Refused when the total would pass the per-task
 * limit.
 */
export async function appendChecklistOnMerge(
  tx: RlsClient,
  orgId: string,
  userId: string,
  sourceTaskId: string,
  targetTaskId: string,
): Promise<void> {
  const source = await readLiveTask(tx, orgId, sourceTaskId)
  const target = await readLiveTask(tx, orgId, targetTaskId, "update")
  const sourceItems = await readFullItems(tx, orgId, sourceTaskId)
  if (sourceItems.length === 0) return
  const targetItems = await readFullItems(tx, orgId, targetTaskId)
  if (sourceItems.length + targetItems.length > CHECKLIST_ITEMS_PER_TASK_MAX) {
    throw new ProjectsServiceError(
      400,
      CHECKLIST_TOO_MANY_ITEMS,
      `items: merging would give the target ${sourceItems.length + targetItems.length} checklist items (max ${CHECKLIST_ITEMS_PER_TASK_MAX})`,
    )
  }
  const sameProject = source.projectId === target.projectId
  const sourceLevels = sameProject ? [] : await readProjectLevels(tx, orgId, source.projectId)
  const targetLevels = sameProject ? [] : await readProjectLevels(tx, orgId, target.projectId)
  let position = targetItems.reduce((max, i) => Math.max(max, i.position), 1000)
  for (const item of sourceItems) {
    position += 1
    const validations = sameProject
      ? item.validations
      : mapValidationsByLevelName(item.validations, sourceLevels, targetLevels)
    const [row] = extractRows<FullItemRow>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("task_checklist_items")}
        SET task_id = ${targetTaskId}::uuid, position = ${position},
            validations = ${JSON.stringify(validations)}::jsonb, updated_at = now()
        WHERE id = ${item.id}::uuid AND org_id = ${orgId}::uuid
        RETURNING ${ITEM_COLUMNS}
      `),
    )
    await queueItemEvent(tx, orgId, userId, "updated", itemFromRow(row!))
  }
}
