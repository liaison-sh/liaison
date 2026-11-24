// SPDX-License-Identifier: FSL-1.1-ALv2
// Work done in a period after that period was invoiced.
//
// A period may be invoiced before it ends, and time is entered late. What no invoice counted is
// found here, so the next card lists and bills it, once:
// - on a retainer, the minutes of an invoiced month its claims did not count, whatever day they are
//   dated and whenever they were entered, billed as that month's hours;
// - on a project billed by the day or the hour, the closed tasks no invoice and no card of their
//   period holds, and the time entered afterwards on a task a card counted by its time.
//
// The minutes come from the project's ledger (time-ledger.ts), so nothing is offered twice. What a
// person left out of a card stays out of the next ones, unless a line names it. A month that was the
// retainer's stays the retainer's when the project's billing changes: its closed tasks are never
// billed by the day. The claim of a month's later hours is a key of its own, `<month>+<n>`.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { TimeLedger } from "./time-ledger"

type Tx = RlsClient

export interface BilledCard {
  id: string
  basis: string
  from: string
  to: string
  draftedOn: string
  draftedAt: string
  /** A retainer month's card that billed an earlier month's hours alone: its month is not billed. */
  lateOnly: boolean
  /** The tasks its lines list, and the ones left out as the client's own work. */
  listed: Set<string>
  excluded: Set<string>
  /** Its own list of left-out tasks was not kept: some unlisted task may be the client's own. */
  excludedUnknown: boolean
}

const asList = (raw: string[] | string | null): string[] =>
  raw === null ? [] : Array.isArray(raw) ? raw : raw.replace(/[{}]/g, "").split(",").filter(Boolean)

/** The project's cards that are on an invoice or its draft, with the tasks each of them knows. */
export async function billedCards(
  tx: Tx,
  orgId: string,
  projectId: string,
  tz: string,
): Promise<BilledCard[]> {
  const rows = extractRows<{
    id: string
    basis: string
    from: string
    to: string
    drafted_on: string
    drafted_at: string
    document_ref: string | null
    excluded_count: number
    excluded_task_ids: string[] | string | null
    listed: string[] | string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT r.id::text AS id, r.basis, r.period_start::text AS "from", r.period_end::text AS "to",
             (coalesce(r.drafted_at, r.updated_at) AT TIME ZONE ${tz})::date::text AS drafted_on,
             coalesce(r.drafted_at, r.updated_at)::text AS drafted_at, r.document_ref,
             r.excluded_count, r.excluded_task_ids::text[] AS excluded_task_ids,
             (SELECT array_agg(DISTINCT t::text)
                FROM ${projectsRel("reconciliation_lines")} l, unnest(l.task_ids) t
               WHERE l.reconciliation_id = r.id AND l.org_id = r.org_id
                 AND l.work_month IS NULL) AS listed
        FROM ${projectsRel("reconciliations")} r
       WHERE r.org_id = ${orgId}::uuid AND r.project_id = ${projectId}::uuid
         AND r.period_start IS NOT NULL AND r.period_end IS NOT NULL
         AND (r.state = 'invoiced' OR (r.state = 'drafted' AND r.document_ref IS NOT NULL))
       ORDER BY r.period_start`),
  )
  return rows.map((r) => ({
    id: r.id,
    basis: r.basis,
    from: r.from,
    to: r.to,
    draftedOn: r.drafted_on,
    draftedAt: r.drafted_at,
    lateOnly: r.basis === "retainer" && (r.document_ref ?? "").startsWith("reconcile:"),
    listed: new Set(asList(r.listed)),
    excluded: new Set(asList(r.excluded_task_ids)),
    excludedUnknown: r.excluded_task_ids === null && Number(r.excluded_count) > 0,
  }))
}

export interface ClosedTask {
  id: string
  archived: boolean
  completed_on: string | null
  completed_at: string | null
}

/** A card that billed closed tasks: by the day or by the hour. */
const byTask = (c: BilledCard) => c.basis === "daily" || c.basis === "hourly"

/** Whether a billed card of closed tasks covers a day: what closed on it later is late work. */
export function coveredByCard(cards: readonly BilledCard[], on: string): boolean {
  return cards.some((c) => byTask(c) && on >= c.from && on <= c.to)
}

/** Whether a day is in a month a retainer was invoiced for: its work is inside that fee. */
export function inRetainerMonth(cards: readonly BilledCard[], on: string): boolean {
  return cards.some((c) => c.basis === "retainer" && !c.lateOnly && on >= c.from && on <= c.to)
}

/**
 * The closed tasks of periods billed by the day or the hour that nothing billed and no card of
 * theirs lists: closed, or dated into the period, after its card was made. Before `before` (the
 * card asking), and never before the first period the project was invoiced for. What any card left
 * out as the client's own work, and what a retainer month holds, is not one of them.
 */
export function lateClosedTasks(
  cards: readonly BilledCard[],
  tasks: readonly ClosedTask[],
  claimed: ReadonlySet<string>,
  before: string,
): string[] {
  const own = cards.filter(byTask)
  const first = own.reduce((m, c) => (m === "" || c.from < m ? c.from : m), "")
  const last = own.reduce((m, c) => (c.to > m ? c.to : m), "")
  if (first === "") return []
  return tasks
    .filter((t) => {
      const on = t.completed_on
      if (t.archived || on === null || on < first || on > last || on >= before) return false
      if (claimed.has(t.id) || inRetainerMonth(cards, on)) return false
      if (cards.some((c) => c.excluded.has(t.id))) return false
      const period = own.filter((c) => on >= c.from && on <= c.to)
      if (period.some((c) => c.listed.has(t.id))) return false
      // A card that kept no list of what it left out: only what closed after it is surely late.
      return !period.some((c) => c.excludedUnknown && String(t.completed_at ?? "") <= c.draftedAt)
    })
    .map((t) => t.id)
}

/** The minutes of an invoiced month still nobody's, per task. */
export interface MonthMinutes {
  /** Listed by the next card by itself. */
  offered: Map<string, number>
  /** Left out of a card on purpose: billed only by a line that names the task. */
  leftOut: Map<string, number>
}

/** The months these cards billed on a retainer, as the ledger reads them. */
export function feeMonths(cards: readonly BilledCard[]) {
  return cards.filter((c) => c.basis === "retainer" && !c.lateOnly)
}

/** The retainer months of these cards, each with the minutes still nobody's, oldest first. */
export function lateMonths(
  ledger: TimeLedger,
  cards: readonly BilledCard[],
): Array<{ month: string } & MonthMinutes> {
  const out: Array<{ month: string } & MonthMinutes> = []
  for (const card of feeMonths(cards)) {
    const month = card.from.slice(0, 7)
    const b = ledger.months.get(month)
    if (!b) continue
    const offered = new Map<string, number>()
    const leftOut = new Map(b.leftOut)
    for (const [task, open] of b.open) {
      // Left out as the client's own, on the month's card with nothing claimed (another project's
      // work), or possibly left out of a card that kept no list.
      const kept =
        card.excluded.has(task) ||
        (!b.touched.has(task) && (card.listed.has(task) || card.excludedUnknown))
      if (kept) leftOut.set(task, (leftOut.get(task) ?? 0) + open)
      else offered.set(task, open)
    }
    if (offered.size > 0 || leftOut.size > 0) out.push({ month, offered, leftOut })
  }
  return out
}

/**
 * Time entered on tasks a card before `before` counted by their time. Work inside a price (a task
 * billed at its plan, and what is under it) is none of it.
 */
export function laterTime(ledger: TimeLedger, before: string): MonthMinutes {
  const offered = new Map<string, number>()
  const leftOut = new Map<string, number>()
  for (const id of ledger.rest.byTime) {
    if (ledger.inPrice.has(id) || (ledger.billedTo.get(id) ?? "") >= before) continue
    const open = ledger.rest.open.get(id) ?? 0
    const left = ledger.rest.leftOut.get(id) ?? 0
    if (open > 0) offered.set(id, open)
    if (left > 0) leftOut.set(id, left)
  }
  return { offered, leftOut }
}
