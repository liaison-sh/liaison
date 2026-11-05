// SPDX-License-Identifier: FSL-1.1-ALv2
// Task labels on the client: the read shape, the effective labels of a
// loaded board (own entry, else the nearest loaded ancestor's, like
// `effectiveRelease`), the board filter and its query-string form.
import type { TranslateParams } from "~/modules/i18n/i18n-context"

/** One effective label of a task, as the API returns it. */
export interface TaskLabel {
  groupId: string
  groupName: string
  groupArchived: boolean
  valueId: string
  valueName: string
  /** The value's own archive stamp or its group's. */
  archived: boolean
  inherited: boolean
  /** Display key of the ancestor holding the value; null on own entries. */
  inheritedFromKey: string | null
}

/** "bug", or "bug (archived)" for an archived value: one wording for every label surface. */
export function labelValueText(
  t: (key: string, params?: TranslateParams) => string,
  valueName: string,
  archived: boolean,
): string {
  return archived ? t("projects.labels.archivedValue", { value: valueName }) : valueName
}

/** Filter value selecting tasks with no effective value in a group (API `__none__`). */
export const LABEL_NONE = "__none__"

/** Same depth limit as the API's parent walk (MAX_TASK_DEPTH). */
export const MAX_DEPTH = 8

export interface LabelNode {
  id: string
  parentTaskId: string | null
  key?: string
  labels?: TaskLabel[]
}

function entriesOf(node: LabelNode | undefined): TaskLabel[] {
  return node && Array.isArray(node.labels) ? node.labels : []
}

/**
 * The task's effective labels: its own entries, then for each group still
 * unset the nearest ancestor's own entry among `byId`. The walk covers at most
 * `MAX_DEPTH - 1` ancestors, the server's bound (the task is depth 1). When an
 * ancestor is missing from `byId`, the groups still unset take the server
 * entries flagged `inherited` of the deepest loaded node and the walk stops; a
 * fully loaded chain ignores those, so a parent's change shows on its children
 * at once.
 */
export function effectiveLabels(
  task: LabelNode,
  byId: ReadonlyMap<string, LabelNode>,
  groupOrder?: readonly string[],
): TaskLabel[] {
  const own = entriesOf(task)
  const out = new Map<string, TaskLabel>()
  for (const entry of own) {
    if (!entry.inherited) out.set(entry.groupId, entry)
  }
  let cur: LabelNode = task
  for (let step = 1; step < MAX_DEPTH; step++) {
    const parentId = cur.parentTaskId
    if (!parentId) break
    const parent = byId.get(parentId)
    if (!parent) {
      // The rest of the chain is not loaded: the deepest loaded node's server
      // entries (its inherited ones) say what lies above it. They are the
      // task's own entries only when no ancestor is loaded at all.
      for (const entry of entriesOf(cur)) {
        if (entry.inherited && !out.has(entry.groupId)) out.set(entry.groupId, entry)
      }
      break
    }
    for (const entry of entriesOf(parent)) {
      if (entry.inherited || out.has(entry.groupId)) continue
      out.set(entry.groupId, { ...entry, inherited: true, inheritedFromKey: parent.key ?? null })
    }
    cur = parent
  }
  return sortLabels([...out.values()], groupOrder)
}

/** Catalog group order first (unknown groups last), then group name. */
function sortLabels(entries: TaskLabel[], groupOrder?: readonly string[]): TaskLabel[] {
  const rank = (id: string): number => {
    const i = groupOrder ? groupOrder.indexOf(id) : -1
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...entries].sort(
    (a, b) =>
      rank(a.groupId) - rank(b.groupId) ||
      a.groupName.toLowerCase().localeCompare(b.groupName.toLowerCase()),
  )
}

/**
 * AND over the filter's groups: `LABEL_NONE` wants no effective entry in that
 * group, any other value the effective entry's `valueId`.
 */
export function matchesLabelFilter(
  task: LabelNode,
  byId: ReadonlyMap<string, LabelNode>,
  filter: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(filter)
  if (keys.length === 0) return true
  const effective = new Map(effectiveLabels(task, byId).map((l) => [l.groupId, l.valueId]))
  for (const groupId of keys) {
    const want = filter[groupId]
    const have = effective.get(groupId)
    if (want === LABEL_NONE) {
      if (have !== undefined) return false
    } else if (have !== want) {
      return false
    }
  }
  return true
}

interface CatalogGroupLike {
  id: string
  values: readonly { id: string }[]
}

/**
 * Drop the filter keys the catalog no longer knows: a group id absent from
 * `groups` (archived groups count as known), or a value id that is not one of
 * that group's values. `LABEL_NONE` is kept for any known group.
 */
export function sanitizeLabelFilter(
  filter: Readonly<Record<string, string>>,
  groups: readonly CatalogGroupLike[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [groupId, valueId] of Object.entries(filter)) {
    const group = groups.find((g) => g.id === groupId)
    if (!group) continue
    if (valueId !== LABEL_NONE && !group.values.some((v) => v.id === valueId)) continue
    out[groupId] = valueId
  }
  return out
}

/** `labels=<encoded JSON map>` for a task list fetch, or null when the filter is empty. */
export function labelsQueryParam(filter: Readonly<Record<string, string>>): string | null {
  if (Object.keys(filter).length === 0) return null
  return `labels=${encodeURIComponent(JSON.stringify(filter))}`
}
