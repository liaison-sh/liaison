// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import type { ActivityBarEntry } from "~/framework/app-registry"

const STORAGE_KEY = "liaison:activityBarOrder"

function readInitial(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
  } catch {
    return []
  }
}

// Custom top-section order (entry ids, first = topmost). Entries not in the
// list (newly installed apps) fall back to their registered `order` and sort
// after the customized ones. A device-local layout preference — intentionally
// NOT reset on session teardown so it survives logout.
const [customActivityBarOrder, _setCustomActivityBarOrder] = createSignal<string[]>(readInitial())

export { customActivityBarOrder }

/** Sort entries by the user's custom order, falling back to registered `order`. */
export function applyActivityBarOrder(entries: ActivityBarEntry[]): ActivityBarEntry[] {
  const custom = customActivityBarOrder()
  const rank = new Map(custom.map((id, i) => [id, i]))
  return [...entries].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.order - b.order
  })
}

/** Persist a full display order (entry ids, topmost first). */
export function setActivityBarOrder(ids: string[]): void {
  _setCustomActivityBarOrder(ids)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* quota exceeded or unavailable — non-critical */
  }
}

/** Move `draggedId` to the position of `targetId` within the currently displayed order. */
export function moveActivityBarEntry(
  displayedIds: string[],
  draggedId: string,
  targetId: string,
): void {
  if (draggedId === targetId) return
  const next = displayedIds.filter((id) => id !== draggedId)
  const targetIdx = next.indexOf(targetId)
  if (targetIdx === -1) return
  const draggedWasBefore = displayedIds.indexOf(draggedId) < displayedIds.indexOf(targetId)
  next.splice(draggedWasBefore ? targetIdx + 1 : targetIdx, 0, draggedId)
  setActivityBarOrder(next)
}

export function resetActivityBarOrderStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* non-critical */
  }
  _setCustomActivityBarOrder([])
}
