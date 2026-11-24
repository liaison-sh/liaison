// SPDX-License-Identifier: FSL-1.1-ALv2
// Work done in a period after that period was invoiced.
//
// A period may be invoiced before it ends, and time is entered late. What no invoice counted is
// found here, so the next card lists and bills it, once:
// - on a retainer, the minutes of an invoiced month its claims did not count, whatever day they are
//   dated and whenever they were entered, billed as that month's hours;
// - on a project billed by the day or the hour, the closed tasks no invoice and no card of their
//   period holds, and the time entered afterwards on a task that was billed by its time.
//
// Nothing is offered twice: a claim records the minutes it counted (`counted_minutes`), billed or
// left off on purpose. What a person left out of a card stays out of the next ones, unless a line
// names it. A month that was the retainer's stays the retainer's when the project's billing
// changes: its closed tasks are never billed by the day. The claim of a month's later hours is a
// key of its own, `<month>+<n>`.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"

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

/** Each task's own minutes between two days; every day when they are null. */
export async function taskMinutes(
  tx: Tx,
  projectId: string,
  from: string | null,
  to: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (from !== null && to !== null && from > to) return out
  for (const r of extractRows<{ task_id: string; minutes: string | number }>(
    await tx.execute(drizzleSql`
      SELECT task_id::text AS task_id, minutes
        FROM ${projectsRel("task_time_totals")}(${projectId}::uuid, ${from}::date, ${to}::date)`),
  )) {
    const m = Number(r.minutes)
    if (m > 0) out.set(r.task_id, m)
  }
  return out
}

/** A retainer month's base claim key: `2027-01` for `2027-01` and for a later claim's `2027-01+2`. */
export function claimMonth(periodKey: string): string {
  return periodKey.split("+")[0] as string
}

/** What live and left-off claims counted of one task. */
export interface Counted {
  /** Every minute counted, billed or left off. */
  all: number
  /** The part left off on purpose. */
  leftOut: number
  /** A live claim holds the task. */
  held: boolean
}

interface CountsInput {
  orgId: string
  projectId: string
  tz: string
  /** Leaves one card's own claims out of the reckoning. */
  exceptReconciliation?: string
  /** Only the claims of other cards than the ones of the period starting this day. */
  notOfPeriod?: string
  /** Leaves out what a card still proposed for this period reserved, in a try that stopped. */
  notProposedFor?: string
}

/** A claim of a card still proposed for a period: a try to create it that stopped half way. */
const ofStoppedTry = (period: string | undefined) => drizzleSql`
  (r.state = 'proposed' AND r.period_start = ${period ?? null}::date) IS TRUE`

/**
 * What the claims of a retainer month counted, per task. A claim older than the recorded minutes
 * counts what is dated up to the day it was made.
 */
export async function monthCounts(
  tx: Tx,
  input: CountsInput & { from: string; to: string },
): Promise<Map<string, Counted>> {
  const month = input.from.slice(0, 7)
  const rows = extractRows<{
    task: string
    state: string
    counted: number | null
    day: string
  }>(
    await tx.execute(drizzleSql`
      SELECT c.source_ref AS task, c.state, c.counted_minutes AS counted,
             (c.created_at AT TIME ZONE ${input.tz})::date::text AS day
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r
          ON r.id = c.reconciliation_id AND r.org_id = c.org_id
       WHERE c.org_id = ${input.orgId}::uuid AND c.project_id = ${input.projectId}::uuid
         AND c.source_kind = 'task' AND c.state IN ('reserved', 'billed', 'left_off')
         AND (c.period_key = ${month} OR starts_with(c.period_key, ${`${month}+`}))
         AND c.reconciliation_id IS DISTINCT FROM ${input.exceptReconciliation ?? null}::uuid
         AND NOT ${ofStoppedTry(input.notProposedFor)}
         AND (${input.notOfPeriod ?? null}::date IS NULL
              OR r.period_start IS DISTINCT FROM ${input.notOfPeriod ?? null}::date)`),
  )
  const out = new Map<string, Counted>()
  const add = (task: string, minutes: number, state: string) => {
    const c = out.get(task) ?? { all: 0, leftOut: 0, held: false }
    out.set(task, {
      all: c.all + minutes,
      leftOut: c.leftOut + (state === "left_off" ? minutes : 0),
      held: c.held || state !== "left_off",
    })
  }
  for (const r of rows) if (r.counted !== null) add(r.task, Number(r.counted), r.state)
  // Older claims: the latest of a task's says the day up to which its time was counted.
  const older = new Map<string, { day: string; state: string }>()
  for (const r of rows) {
    if (r.counted !== null) continue
    const was = older.get(r.task)
    if (!was || r.day > was.day || (r.day === was.day && was.state === "left_off"))
      older.set(r.task, { day: r.day, state: r.state })
  }
  const upTo = new Map<string, Map<string, number>>()
  for (const [task, { day, state }] of older) {
    const to = day < input.to ? day : input.to
    if (!upTo.has(to)) upTo.set(to, await taskMinutes(tx, input.projectId, input.from, to))
    add(task, upTo.get(to)?.get(task) ?? 0, state)
  }
  return out
}

/** The minutes of an invoiced month still nobody's, per task. */
export interface MonthMinutes {
  /** Listed by the next card by itself. */
  offered: Map<string, number>
  /** Left out of a card on purpose: billed only by a line that names the task. */
  leftOut: Map<string, number>
}

/** The minutes worked in an invoiced retainer month that its invoice did not count, per task. */
export async function lateRetainerMinutes(
  tx: Tx,
  input: CountsInput & { card: BilledCard; archived: ReadonlySet<string> },
): Promise<MonthMinutes> {
  const { card } = input
  const offered = new Map<string, number>()
  const leftOut = new Map<string, number>()
  const worked = await taskMinutes(tx, input.projectId, card.from, card.to)
  if (worked.size === 0) return { offered, leftOut }
  const counts = await monthCounts(tx, { ...input, from: card.from, to: card.to })
  for (const [task, all] of worked) {
    if (input.archived.has(task)) continue
    const claim = counts.get(task)
    const open = all - (claim?.all ?? 0)
    // Left out as the client's own, on the month's card with nothing claimed (another project's
    // work), or possibly left out of a card that kept no list.
    const out =
      card.excluded.has(task) || (!claim && (card.listed.has(task) || card.excludedUnknown))
    if (!out && open > 0) offered.set(task, open)
    const kept = Math.min(all, (claim?.leftOut ?? 0) + (out ? Math.max(0, open) : 0))
    if (kept > 0) leftOut.set(task, kept)
  }
  return { offered, leftOut }
}

/** The retainer months of these cards, each with the minutes still nobody's, oldest first. */
export async function lateMonths(
  tx: Tx,
  input: CountsInput & { cards: readonly BilledCard[]; archived: ReadonlySet<string> },
): Promise<Array<{ month: string } & MonthMinutes>> {
  const out: Array<{ month: string } & MonthMinutes> = []
  for (const card of input.cards) {
    if (card.basis !== "retainer" || card.lateOnly) continue
    const minutes = await lateRetainerMinutes(tx, { ...input, card })
    if (minutes.offered.size > 0 || minutes.leftOut.size > 0)
      out.push({ month: card.from.slice(0, 7), ...minutes })
  }
  return out
}

/** Each task's minutes inside the retainer months these cards billed: never billed by the day. */
export async function retainerFeeMinutes(
  tx: Tx,
  projectId: string,
  cards: readonly BilledCard[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const c of cards) {
    if (c.basis !== "retainer" || c.lateOnly) continue
    for (const [task, m] of await taskMinutes(tx, projectId, c.from, c.to))
      out.set(task, (out.get(task) ?? 0) + m)
  }
  return out
}

/** What a task billed by its time had counted, on a project billed by the day or the hour. */
export interface CountedTask extends Counted {
  /** The last day of the last period that billed it. */
  billedTo: string
}

/**
 * The tasks billed by their time, with the minutes their claims counted. A task billed by its plan
 * has none: its time moves the margin, never a bill.
 */
export async function countedTasks(
  tx: Tx,
  input: Pick<CountsInput, "orgId" | "projectId" | "exceptReconciliation" | "notProposedFor">,
): Promise<Map<string, CountedTask>> {
  const rows = extractRows<{
    task: string
    state: string
    counted: number
    period_end: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT c.source_ref AS task, c.state, c.counted_minutes AS counted,
             r.period_end::text AS period_end
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r
          ON r.id = c.reconciliation_id AND r.org_id = c.org_id
       WHERE c.org_id = ${input.orgId}::uuid AND c.project_id = ${input.projectId}::uuid
         AND c.source_kind = 'task' AND c.state IN ('reserved', 'billed', 'left_off')
         AND (c.period_key = 'all' OR starts_with(c.period_key, 'all+'))
         AND c.counted_minutes IS NOT NULL
         AND NOT ${ofStoppedTry(input.notProposedFor)}
         AND c.reconciliation_id IS DISTINCT FROM ${input.exceptReconciliation ?? null}::uuid`),
  )
  const out = new Map<string, CountedTask>()
  for (const r of rows) {
    const c = out.get(r.task) ?? { all: 0, leftOut: 0, held: false, billedTo: "" }
    out.set(r.task, {
      all: c.all + Number(r.counted),
      leftOut: c.leftOut + (r.state === "left_off" ? Number(r.counted) : 0),
      held: c.held || r.state !== "left_off",
      billedTo: (r.period_end ?? "") > c.billedTo ? (r.period_end as string) : c.billedTo,
    })
  }
  for (const [task, c] of out) if (!c.held) out.delete(task)
  return out
}

/** The project's tasks on a reserved, billed or left-off claim. */
export async function claimedTasks(
  tx: Tx,
  input: Pick<CountsInput, "orgId" | "projectId" | "notProposedFor">,
): Promise<Set<string>> {
  return new Set(
    extractRows<{ task: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT c.source_ref AS task
          FROM ${projectsRel("billing_claims")} c
          LEFT JOIN ${projectsRel("reconciliations")} r
            ON r.id = c.reconciliation_id AND r.org_id = c.org_id
         WHERE c.org_id = ${input.orgId}::uuid AND c.project_id = ${input.projectId}::uuid
           AND c.source_kind = 'task' AND c.state IN ('reserved', 'billed', 'left_off')
           AND NOT ${ofStoppedTry(input.notProposedFor)}`),
    ).map((r) => r.task),
  )
}
