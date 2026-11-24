// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which of a schedule's months the month-end run bills. A retainer month is billed from its planned
// vs done card, and a month a retainer's invoice or an advance already covers is billed by that: the
// run bills neither, and its dates move past both, so a schedule that was a retainer always reaches
// a month it bills.
import { creditedTotalMinor } from "../mutations/credit-coverage"
import type { MutationsCtx } from "../mutations/shared"
import {
  isRetainerMonth,
  isRetainerSchedule,
  monthOf,
  nextMonth,
  retainerDocumentRef,
} from "./retainer"
import {
  addDays,
  type Cadence,
  datesFrom,
  periodStart,
  type Repeats,
  type ScheduleDates,
} from "./schedule"

type Row = Record<string, unknown>
type Db = { db: Pick<MutationsCtx["db"], "findMany" | "findOne"> }

/** What these rules read of a schedule. */
export interface RunSchedule extends Cadence {
  id: string
  retainer_project_id?: unknown
  retainer_minutes?: unknown
  retainer_from?: unknown
  retainer_terms?: unknown
  retainer_renewal?: unknown
}

const GONE = new Set(["cancelled", "voided"])
const asBig = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? 0).split(".")[0] as string)
  } catch {
    return 0n
  }
}

/** An advance that still pays for its month: a draft, or issued and not credited in full. */
async function advanceStands(ctx: Db, doc: Row): Promise<boolean> {
  if (GONE.has(String(doc.status))) return false
  if (doc.status === "draft") return true
  const raw = asBig(doc.grand_total_minor)
  const total = raw < 0n ? -raw : raw
  if (total === 0n) return true
  const notes = (await ctx.db.findMany("documents", {
    where: { original_document_id: String(doc.id) },
    limit: 50,
  })) as Row[]
  const credited = await creditedTotalMinor(
    ctx.db,
    { id: String(doc.id), lifecycle_log: (doc.lifecycle_log as Row[] | undefined) ?? [] },
    notes,
  )
  return total - credited > 0n
}

const advanceRef = (projectId: string, month: string) => `advance:${projectId}:${month}`

async function one(ctx: Db, externalRef: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", {
    where: { external_ref: externalRef },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

/** Whether a retainer's invoice, or an advance for the month, already covers the month. */
export async function monthCovered(ctx: Db, s: RunSchedule, month: string): Promise<boolean> {
  if (await one(ctx, retainerDocumentRef(s.id, month))) return true
  const project = s.retainer_project_id
  if (typeof project !== "string" || project === "") return false
  const advance = await one(ctx, advanceRef(project, month))
  return !!advance && (await advanceStands(ctx, advance))
}

/** The months of the period an issue day bills. */
export function periodMonths(repeats: Repeats, issueOn: string): string[] {
  let month = monthOf(periodStart(repeats, issueOn))
  const out = [month]
  for (let i = 1; i < (repeats === "year" ? 12 : repeats === "quarter" ? 3 : 1); i++) {
    month = nextMonth(month)
    out.push(month)
  }
  return out
}

/** Whether the run bills the period of this issue day: no month of it is the retainer's. */
export async function runBills(ctx: Db, s: RunSchedule, issueOn: string): Promise<boolean> {
  for (const month of periodMonths(s.repeats, issueOn))
    if (isRetainerMonth(s, month) || (await monthCovered(ctx, s, month))) return false
  return true
}

/**
 * The first issue day on or after `from` the run bills. A schedule that never was a retainer takes
 * its next billing day; a retainer that is on has none left to find, and takes it too: its months
 * are invoiced from their cards.
 */
export async function runDatesFrom(ctx: Db, s: RunSchedule, from: string): Promise<ScheduleDates> {
  const first = datesFrom(s, from)
  if (!isRetainerSchedule(s)) return first
  let d = first
  // Past the last dated change nothing varies: five years of months are more than any of them hold.
  for (let i = 0; i < 60; i++) {
    if (await runBills(ctx, s, d.next_issue_on)) return d
    d = datesFrom(s, addDays(d.next_issue_on, 1))
  }
  return first
}

/** A month to come that moved the run's start, with the document that covers it. */
export interface CoveredMonth {
  month: string
  by: "advance" | "invoice"
  number: string | null
}

/** How far ahead a retainer's months are looked for: no advance is paid further. */
const MONTHS_AHEAD = 36

/**
 * The month the run starts with when a retainer is turned off during `thisMonth`: the first one
 * after it, and after every month to come a retainer's invoice or an advance covers.
 */
export async function firstRunMonth(
  ctx: Db,
  s: RunSchedule,
  thisMonth: string,
): Promise<{ from: string; covered: CoveredMonth | null }> {
  const project = typeof s.retainer_project_id === "string" ? s.retainer_project_id : ""
  const refs = new Map<string, { month: string; by: CoveredMonth["by"] }>()
  for (let i = 0, month = nextMonth(thisMonth); i < MONTHS_AHEAD; i++, month = nextMonth(month)) {
    refs.set(retainerDocumentRef(s.id, month), { month, by: "invoice" })
    if (project) refs.set(advanceRef(project, month), { month, by: "advance" })
  }
  const docs = (await ctx.db.findMany("documents", {
    where: { external_ref: { in: [...refs.keys()] } },
    limit: refs.size,
  })) as Row[]
  let covered: CoveredMonth | null = null
  for (const doc of docs) {
    const held = refs.get(String(doc.external_ref))
    if (!held || (covered && held.month <= covered.month)) continue
    if (held.by === "advance" && !(await advanceStands(ctx, doc))) continue
    covered = { ...held, number: typeof doc.number === "string" ? doc.number : null }
  }
  return { from: nextMonth(covered?.month ?? thisMonth), covered }
}
