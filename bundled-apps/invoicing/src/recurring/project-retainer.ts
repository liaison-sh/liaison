// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which retainer schedule a project's month belongs to, and which of a schedule's months the
// month-end run already holds. A month is billed by one or the other, whatever was turned off, on
// again or ended since.
import {
  type DatedTermsRow,
  isRetainerMonth,
  isRetainerOn,
  isRetainerSchedule,
  nextMonth,
  type RetainerFacts,
  runDocumentRef,
} from "./retainer"
import { periodKey } from "./schedule"

type Row = Record<string, unknown>

interface Db {
  db: { findMany(table: string, q: Record<string, unknown>): Promise<unknown> }
}

const GONE = new Set(["cancelled", "voided"])

async function scheduleRows(ctx: Db, projectId: string): Promise<Row[]> {
  return (await ctx.db.findMany("recurring_schedules", {
    where: { retainer_project_id: projectId },
    limit: 20,
  })) as Row[]
}

/**
 * The project's retainer schedule for a month: the live one, or one turned off or ended since whose
 * month it still is. Null when the project has none.
 */
export async function retainerScheduleOf(
  ctx: Db,
  projectId: string,
  month: string,
): Promise<Row | null> {
  const rows = (await scheduleRows(ctx, projectId)).filter((s) => isRetainerSchedule(s))
  const held = rows.filter((s) => s.status !== "ended")
  const live = held.find(isRetainerOn)
  if (live && isRetainerMonth(live, month)) return live
  const own = (s: Row) => !isRetainerOn(s) && isRetainerMonth(s, month)
  // An ended one keeps the months its end left on the card, and no other.
  return (
    held.find(own) ?? rows.find((s) => s.status === "ended" && own(s)) ?? live ?? held[0] ?? null
  )
}

/** Whether an advance for the project's month pays for another schedule's retainer month. */
export async function advanceOfAnother(
  ctx: Db,
  s: RetainerFacts & DatedTermsRow & { id: string; retainer_from?: unknown },
  projectId: string,
  month: string,
): Promise<boolean> {
  const others = (await scheduleRows(ctx, projectId)).filter(
    (o) => String(o.id) !== s.id && isRetainerMonth(o, month),
  )
  if (others.length === 0) return false
  if (!isRetainerMonth(s, month)) return true
  return String((await retainerScheduleOf(ctx, projectId, month))?.id) !== s.id
}

/** A month the month-end run holds: its draft or issued invoice, or its row in a run. */
export async function monthOnRun(ctx: Db, scheduleId: string, month: string): Promise<boolean> {
  const one = async (table: string, where: Row) =>
    ((await ctx.db.findMany(table, { where, limit: 1 })) as Row[])[0] ?? null
  const doc = await one("documents", { external_ref: runDocumentRef(scheduleId, month) })
  if (doc && !GONE.has(String(doc.status))) return true
  const item = await one("recurring_run_items", { schedule_id: scheduleId, period_key: month })
  return !!item && item.state !== "left_out"
}

/** The periods of these the run holds, each with its invoice when it has one. */
async function periodsOnRun(
  ctx: Db,
  scheduleId: string,
  keys: string[],
): Promise<Array<{ key: string; document: Row | null }>> {
  const refs = new Map(keys.map((key) => [runDocumentRef(scheduleId, key), key]))
  const docs = (await ctx.db.findMany("documents", {
    where: { external_ref: { in: [...refs.keys()] } },
    limit: keys.length,
  })) as Row[]
  const held = new Map<string, Row | null>()
  for (const doc of docs)
    if (!GONE.has(String(doc.status))) held.set(refs.get(String(doc.external_ref)) ?? "", doc)
  const items = (await ctx.db.findMany("recurring_run_items", {
    where: { schedule_id: scheduleId, period_key: { in: keys } },
    limit: keys.length,
  })) as Row[]
  for (const item of items)
    if (item.state !== "left_out" && !held.has(String(item.period_key)))
      held.set(String(item.period_key), null)
  return [...held].map(([key, document]) => ({ key, document }))
}

/** The last month after `thisMonth` that the run already holds, with its invoice. */
export interface MonthOnRun {
  month: string
  number: string | null
  draft: boolean
}

/** How far ahead the run is looked for: it drafts one period at a time. */
const MONTHS_AHEAD = 36

export async function lastMonthOnRun(
  ctx: Db,
  scheduleId: string,
  thisMonth: string,
): Promise<MonthOnRun | null> {
  // Every period that holds a month after this one: monthly, quarterly or yearly.
  const last = new Map<string, string>()
  for (let i = 0, month = thisMonth; i < MONTHS_AHEAD; i++, month = nextMonth(month))
    for (const repeats of ["month", "quarter", "year"] as const)
      last.set(periodKey(repeats, `${month}-01`), month)
  let found: MonthOnRun | null = null
  for (const { key, document } of await periodsOnRun(ctx, scheduleId, [...last.keys()])) {
    const month = last.get(key) as string
    if (month <= thisMonth || (found && month <= found.month)) continue
    found = {
      month,
      number: typeof document?.number === "string" ? document.number : null,
      draft: !document || document.status === "draft",
    }
  }
  return found
}
