// SPDX-License-Identifier: FSL-1.1-ALv2
import { ProjectsServiceError } from "./statuses"

// Per-task and per-project limits
export const CHECKLIST_TITLE_MAX = 300
export const CHECKLIST_DETAILS_MAX = 10000
export const CHECKLIST_ITEMS_PER_TASK_MAX = 200
export const CHECKLIST_ITEMS_PER_ADD_MAX = 50
export const RELEASE_MAX = 40
export const LEVELS_MAX = 8
export const LEVEL_NAME_MAX = 24
export const FAIL_NOTE_MAX = 2000
export const SOURCE_URL_MAX = 500

export type ValidationState = "not_done" | "fail" | "success" | "na"

export interface ValidationLevel {
  id: string
  name: string
}

/**
 * Read a stored `validation_levels` value. Rows written before agents were
 * trusted on every level may carry an `agentAccess` key: it is ignored.
 */
export function parseStoredLevels(raw: unknown): ValidationLevel[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (l): l is { id: string; name: string } =>
        !!l && typeof l.id === "string" && typeof l.name === "string",
    )
    .map((l) => ({ id: l.id, name: l.name }))
}

export interface ValidationRecord {
  state: ValidationState
  by: string
  via: "human" | "agent"
  source: string | null
  at: string
}

export interface ChecklistItemLike {
  id: string
  title: string
  checked: boolean
  validations: Record<string, ValidationRecord>
}

export interface ChecklistPerLevel {
  levelId: string
  name: string
  applicable: number
  success: number
  fail: number
}

export interface ChecklistBlocking {
  itemId: string
  title: string
  levels: string[]
}

export interface ChecklistStatus {
  total: number
  complete: number
  failing: number
  perLevel: ChecklistPerLevel[]
  blocking: ChecklistBlocking[]
}

/** An item with no recorded state for a level reads as `not_done`. */
function stateFor(item: ChecklistItemLike, levelId: string): ValidationState {
  return item.validations[levelId]?.state ?? "not_done"
}

/**
 * The checklist status: a single pure function over levels + items, no DB, no I/O.
 * Plain mode (levels = []): completeness is `checked`; each unchecked item blocks, with no levels.
 * Level mode: an item is complete when every level reads `success` or `na`.
 */
export function checklistStatus(
  levels: ValidationLevel[],
  items: ChecklistItemLike[],
): ChecklistStatus {
  const total = items.length
  const plainMode = levels.length === 0

  if (plainMode) {
    const complete = items.filter((item) => item.checked).length
    return {
      total,
      complete,
      failing: 0,
      perLevel: [],
      // An unchecked item is the blocker, with no level names.
      blocking: items
        .filter((item) => !item.checked)
        .map((item) => ({ itemId: item.id, title: item.title, levels: [] })),
    }
  }

  let complete = 0
  let failing = 0
  const perLevel: ChecklistPerLevel[] = levels.map((level) => ({
    levelId: level.id,
    name: level.name,
    applicable: 0,
    success: 0,
    fail: 0,
  }))
  const blocking: ChecklistBlocking[] = []

  for (const item of items) {
    let itemComplete = true
    let itemFailing = false
    const blockingLevelNames: string[] = []

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!
      const perLevelEntry = perLevel[i]!
      const state = stateFor(item, level.id)

      if (state !== "na") {
        perLevelEntry.applicable += 1
        if (state === "success") perLevelEntry.success += 1
        if (state === "fail") perLevelEntry.fail += 1
      }

      const levelComplete = state === "success" || state === "na"
      if (!levelComplete) {
        itemComplete = false
        blockingLevelNames.push(level.name)
      }
      if (state === "fail") itemFailing = true
    }

    if (itemComplete) complete += 1
    if (itemFailing) failing += 1
    if (blockingLevelNames.length > 0) {
      blocking.push({ itemId: item.id, title: item.title, levels: blockingLevelNames })
    }
  }

  return { total, complete, failing, perLevel, blocking }
}

/**
 * Validate a project's whole validation_levels list before it is written.
 * Name 1..24 chars trimmed, unique case-insensitively, max 8 levels. Any other
 * key on an input level is dropped. Throws ProjectsServiceError(400, "validation_levels_invalid", ...)
 * on the first violation found.
 */
export function validateLevels(input: ValidationLevel[]): ValidationLevel[] {
  if (input.length > LEVELS_MAX) {
    throw new ProjectsServiceError(
      400,
      "validation_levels_invalid",
      `at most ${LEVELS_MAX} validation levels are allowed (got ${input.length})`,
    )
  }

  const seenNames = new Set<string>()
  const result: ValidationLevel[] = []

  for (const level of input) {
    const name = level.name.trim()
    if (name.length < 1 || name.length > LEVEL_NAME_MAX) {
      throw new ProjectsServiceError(
        400,
        "validation_levels_invalid",
        `level name must be 1..${LEVEL_NAME_MAX} chars (got ${JSON.stringify(level.name)})`,
      )
    }
    const key = name.toLowerCase()
    if (seenNames.has(key)) {
      throw new ProjectsServiceError(
        400,
        "validation_levels_invalid",
        `level names must be unique, case-insensitively (duplicate ${JSON.stringify(name)})`,
      )
    }
    seenNames.add(key)
    result.push({ id: level.id, name })
  }

  return result
}
