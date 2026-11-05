// SPDX-License-Identifier: FSL-1.1-ALv2
// Client shapes of the task checklist (validation levels, items, records and
// the per-task status summary). They mirror the projects API
// (apps/api/src/apps/projects/service/checklist-status.ts and checklist.ts).

export type ValidationState = "not_done" | "fail" | "success" | "na"

export interface ValidationLevel {
  id: string
  name: string
}

/** One recorded state of an item for one level. */
export interface ValidationRecord {
  state: ValidationState
  by: string
  via: "human" | "agent"
  source: string | null
  at: string
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

export interface ChecklistPerLevel {
  levelId: string
  name: string
  /** Items whose state for the level is not `na`: the counter's denominator. */
  applicable: number
  success: number
  fail: number
}

export interface ChecklistBlocking {
  itemId: string
  title: string
  /** Names of the levels not in success or N/A (empty in plain mode). */
  levels: string[]
}

export interface ChecklistStatus {
  total: number
  complete: number
  failing: number
  perLevel: ChecklistPerLevel[]
  blocking: ChecklistBlocking[]
}

export interface ChecklistView {
  levels: ValidationLevel[]
  items: ChecklistItem[]
  status: ChecklistStatus
}

/** One entry of POST .../checklist/validations. */
export interface ValidationEntry {
  itemId: string
  /** Level id or name; omit in plain mode and send `checked`. */
  level?: string
  state?: ValidationState
  checked?: boolean
  /** Required for `fail`; posted to the task discussion. */
  note?: string | null
}

/** Level as sent to PUT /projects/:id/validation-levels (no id = new level). */
export interface ValidationLevelInput {
  id?: string | null
  name: string
}

export interface ChecklistItemPatch {
  title?: string
  details?: string | null
  checked?: boolean
  beforeItemId?: string | null
  afterItemId?: string | null
}

function stateFor(item: ChecklistItem, levelId: string): ValidationState {
  return item.validations?.[levelId]?.state ?? "not_done"
}

/**
 * Client copy of the API's status computation, used to recompute a task's
 * summary after a local echo or a realtime item event without a round trip.
 * Plain mode (no levels): complete = checked, unchecked items block.
 * Level mode: complete when every level reads success or N/A; a missing key
 * reads `not_done`.
 */
export function computeChecklistStatus(
  levels: ValidationLevel[],
  items: ChecklistItem[],
): ChecklistStatus {
  const total = items.length
  if (levels.length === 0) {
    return {
      total,
      complete: items.filter((i) => i.checked).length,
      failing: 0,
      perLevel: [],
      blocking: items
        .filter((i) => !i.checked)
        .map((i) => ({ itemId: i.id, title: i.title, levels: [] })),
    }
  }
  let complete = 0
  let failing = 0
  const perLevel: ChecklistPerLevel[] = levels.map((l) => ({
    levelId: l.id,
    name: l.name,
    applicable: 0,
    success: 0,
    fail: 0,
  }))
  const blocking: ChecklistBlocking[] = []
  for (const item of items) {
    const missing: string[] = []
    let itemFailing = false
    levels.forEach((level, i) => {
      const entry = perLevel[i]!
      const state = stateFor(item, level.id)
      if (state !== "na") {
        entry.applicable += 1
        if (state === "success") entry.success += 1
        if (state === "fail") entry.fail += 1
      }
      if (state !== "success" && state !== "na") missing.push(level.name)
      if (state === "fail") itemFailing = true
    })
    if (missing.length === 0) complete += 1
    else blocking.push({ itemId: item.id, title: item.title, levels: missing })
    if (itemFailing) failing += 1
  }
  return { total, complete, failing, perLevel, blocking }
}
