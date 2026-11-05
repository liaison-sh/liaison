// SPDX-License-Identifier: FSL-1.1-ALv2
// Client-side mirror of the backend due-status classifier
// (apps/api/src/apps/projects/service/due-status.ts). Kept as a small pure
// function so the sidebar's due-bucket counts, the list/kanban filter, and
// the due-date chip colouring all agree with the API's `due` query param
// on what "overdue" / "due soon" mean. If the backend rule changes, update
// both.

/** Width of the "due soon" window, in days from today (inclusive). */
export const DUE_SOON_DAYS = 7

export type DueBucket = "overdue" | "due_soon" | "later" | "none" | "done"

function toIsoDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Classify a task's due status. `dueDate` and `today` are ISO date strings
 * (a full timestamp is also accepted and truncated to its date component).
 * Terminal status always wins over the date (a done task is never overdue).
 */
export function dueBucket(dueDate: string | null, terminal: boolean, today: string): DueBucket {
  if (terminal) return "done"
  if (!dueDate) return "none"
  const due = toIsoDate(dueDate)
  const todayIso = toIsoDate(today)
  if (due < todayIso) return "overdue"
  const soonEnd = addDaysIso(todayIso, DUE_SOON_DAYS)
  if (due <= soonEnd) return "due_soon"
  return "later"
}

/**
 * Tailwind text-colour classes for a due-date chip: overdue reads danger,
 * due soon reads warning, later/none/done stay neutral (a done task's date
 * is never coloured). Shared by the list row, the cross-project home row,
 * and the kanban card so the three surfaces never disagree.
 */
export function dueChipColorClass(bucket: DueBucket): string {
  if (bucket === "overdue") return "text-danger"
  if (bucket === "due_soon") return "text-warning"
  return "text-text-tertiary"
}
