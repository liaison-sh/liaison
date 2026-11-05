// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"

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
 * The single due-status classifier shared by the attention feed and the task
 * list filters, so "overdue" / "due soon" mean exactly the same thing
 * everywhere. Terminal status always wins over the date (a done task is never
 * overdue). `dueDate` and `today` are ISO date strings (a full timestamp is
 * also accepted and truncated to its date component).
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
 * SQL fragment computing the SAME bucket in Postgres (using CURRENT_DATE for
 * "today"), for use in a WHERE clause or SELECT list. `taskAlias` and
 * `statusAlias` are table aliases already in scope in the caller's query
 * (fixed identifiers from source, never user input) — e.g.
 * `dueBucketSql("t", "s")` against `... tasks t JOIN project_statuses s ...`.
 */
export function dueBucketSql(
  taskAlias: string,
  statusAlias: string,
): ReturnType<typeof drizzleSql> {
  const dueDateCol = drizzleSql.raw(`${taskAlias}.due_date`)
  const terminalCol = drizzleSql.raw(`${statusAlias}.terminal`)
  const soonInterval = drizzleSql.raw(`INTERVAL '${DUE_SOON_DAYS} days'`)
  return drizzleSql`(CASE
    WHEN ${terminalCol} IS TRUE THEN 'done'
    WHEN ${dueDateCol} IS NULL THEN 'none'
    WHEN ${dueDateCol} < CURRENT_DATE THEN 'overdue'
    WHEN ${dueDateCol} <= CURRENT_DATE + ${soonInterval} THEN 'due_soon'
    ELSE 'later'
  END)`
}
