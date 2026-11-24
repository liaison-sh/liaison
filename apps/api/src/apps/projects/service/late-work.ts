// SPDX-License-Identifier: FSL-1.1-ALv2
// Work done in a period after that period was invoiced.
//
// A period may be invoiced before it ends. What is closed in it afterwards belongs to no card: its
// own period is locked, and it is not in the next one. It is found here, so the next card lists and
// bills it, once. On a project billed by the day or the hour it is the closed tasks no invoice and
// no card of their period holds; on a retainer it is the hours worked in an invoiced month that its
// invoice did not count, billed as that month's hours.
//
// Nothing is offered twice: a task on a live claim, left off on purpose, left out as the client's
// own work or listed on its period's card is not late work. On a retainer a task already claimed
// for the month counts only the time worked after the claim (a change of an earlier day's time
// moves the margin, never a bill), and the claim for it is a key of its own, `<month>+<n>`.
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
    excluded_count: number
    excluded_task_ids: string[] | string | null
    listed: string[] | string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT r.id::text AS id, r.basis, r.period_start::text AS "from", r.period_end::text AS "to",
             (coalesce(r.drafted_at, r.updated_at) AT TIME ZONE ${tz})::date::text AS drafted_on,
             coalesce(r.drafted_at, r.updated_at)::text AS drafted_at,
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

/**
 * The closed tasks of invoiced periods that nothing billed and no card of theirs lists: closed, or
 * dated into the period, after its card was made. Before `before` (the card asking), and never
 * before the first period the project was invoiced for.
 */
export function lateClosedTasks(
  cards: readonly BilledCard[],
  tasks: readonly ClosedTask[],
  claimed: ReadonlySet<string>,
  before: string,
): string[] {
  const first = cards[0]?.from
  const last = cards.reduce((m, c) => (c.to > m ? c.to : m), "")
  if (first === undefined) return []
  return tasks
    .filter((t) => {
      const on = t.completed_on
      if (t.archived || on === null || on < first || on > last || on >= before) return false
      if (claimed.has(t.id)) return false
      const own = cards.filter((c) => on >= c.from && on <= c.to)
      if (own.some((c) => c.listed.has(t.id) || c.excluded.has(t.id))) return false
      // A card that kept no list of what it left out: only what closed after it is surely late.
      return !own.some((c) => c.excludedUnknown && String(t.completed_at ?? "") <= c.draftedAt)
    })
    .map((t) => t.id)
}

async function totals(tx: Tx, projectId: string, from: string, to: string) {
  const out = new Map<string, number>()
  if (from > to) return out
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

/** A task's time on one day, for the claims made that day. */
export async function minutesOnDay(tx: Tx, projectId: string, day: string) {
  return totals(tx, projectId, day, day)
}

/**
 * The minutes worked in an invoiced retainer month that its invoice did not count, per task.
 * `exceptReconciliation` leaves one card's own claims out of the reckoning.
 */
export async function lateRetainerMinutes(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    tz: string
    card: BilledCard
    archived: ReadonlySet<string>
    exceptReconciliation?: string
  },
): Promise<Map<string, number>> {
  const { card, orgId, projectId } = input
  const month = card.from.slice(0, 7)
  const worked = await totals(tx, projectId, card.from, card.to)
  if (worked.size === 0) return worked
  const claims = extractRows<{ task: string; day: string; day_minutes: number | null }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT ON (source_ref) source_ref AS task,
             (created_at AT TIME ZONE ${input.tz})::date::text AS day, day_minutes
        FROM ${projectsRel("billing_claims")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
         AND source_kind = 'task' AND state IN ('reserved', 'billed', 'left_off')
         AND (period_key = ${month} OR starts_with(period_key, ${`${month}+`}))
         AND reconciliation_id IS DISTINCT FROM ${input.exceptReconciliation ?? null}::uuid
       ORDER BY source_ref, created_at DESC`),
  )
  const byTask = new Map(claims.map((c) => [c.task, c]))
  const sinceByDay = new Map<string, Map<string, number>>()
  const dayTotals = new Map<string, Map<string, number>>()
  for (const day of new Set(claims.map((c) => c.day))) {
    const from = day < card.from ? card.from : day
    sinceByDay.set(day, await totals(tx, projectId, from, card.to))
    dayTotals.set(
      day,
      day < card.from || day > card.to ? new Map() : await totals(tx, projectId, day, day),
    )
  }
  const out = new Map<string, number>()
  for (const [task, all] of worked) {
    if (input.archived.has(task) || card.excluded.has(task)) continue
    const claim = byTask.get(task)
    if (claim) {
      const since = sinceByDay.get(claim.day)?.get(task) ?? 0
      const before = claim.day_minutes ?? dayTotals.get(claim.day)?.get(task) ?? 0
      const late = since - (claim.day < card.from ? 0 : before)
      if (late > 0) out.set(task, late)
      continue
    }
    // Listed on the month's card with nothing claimed (another project's work), or possibly left
    // out of a card that kept no list: not late.
    if (card.listed.has(task) || card.excludedUnknown) continue
    out.set(task, all)
  }
  return out
}
