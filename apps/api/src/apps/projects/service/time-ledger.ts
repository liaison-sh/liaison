// SPDX-License-Identifier: FSL-1.1-ALv2
// The minutes of a project's tasks that no card has counted yet.
//
// Everything a card shows, what Create claims and what a later card lists again is read from here,
// so it is one sum: for every task, entered = counted by claims + still open. A claim counts the
// task's own minutes; a line of a task with work under it claims each of them apart.
//
// Minutes are counted in one of two ways, and never in both:
// - in a month a retainer was invoiced for, by that month's claims (`2026-09`, `2026-09+2`);
// - outside of these months, by the claims of the task's whole life (`all`, `all+2`).
// A minute counted by the hour in a month that became a retainer's later stays counted.
//
// Three things are told apart from an open minute: what a person left out (billed only by a line
// that names its task), what is inside a price (a task billed at its plan, and the work under it),
// and the spare: minutes billed and taken off their task since, which come off what else is offered
// in the same month, or project.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { ShareInput } from "./line-minutes"
import { taskMinutes } from "./task-minutes"

type Tx = RlsClient

/** A card whose month is inside a retainer's fee. */
export interface FeeMonth {
  from: string
  to: string
}

/** What the claims counted of one task in one bucket. */
interface Counted {
  /** By claims that stand on an invoice or its draft. */
  held: number
  /** The part of `held` that can be taken off again: billed by its time, for time entered then. */
  billed: number
  /** Left off a card on purpose. */
  leftOut: number
  /** A standing claim. */
  live: boolean
  /** Billed whole, at its plan or by an older claim: nothing of it is offered again. */
  whole: boolean
  /** Left out whole, by an older claim. */
  leftWhole: boolean
  /** A claim that counted its time. */
  byTime: boolean
}

const nothing = (): Counted => ({
  held: 0,
  billed: 0,
  leftOut: 0,
  live: false,
  whole: false,
  leftWhole: false,
  byTime: false,
})

/** One bucket: a retainer month, or the rest of the project's time. */
export interface Bucket {
  /** Listed by the next card by itself, per task. */
  open: Map<string, number>
  /** Left out on purpose, per task: billed only by a line that names it. */
  leftOut: Map<string, number>
  /** Claimed in this bucket, left out included. */
  touched: Set<string>
  /** Tasks a standing claim of this bucket holds. */
  held: Set<string>
  /** Tasks whose claims counted their time, left out included. */
  byTime: Set<string>
  /** Minutes billed here and taken off their task since, not yet off another line. */
  spare: number
}

export interface TimeLedger {
  /** Outside the retainer months. */
  rest: Bucket
  /** Each retainer month, by `YYYY-MM`. */
  months: Map<string, Bucket>
  /** Every task on a standing or left-off claim. */
  claimed: Set<string>
  /** Tasks billed at their plan. */
  priced: Set<string>
  /** The live tasks under a task billed at its plan, itself included: inside that price. */
  inPrice: Set<string>
  /** Tasks whose claim was credited, with none of its own standing since. */
  credited: Set<string>
  /** The last day of the last period that claimed a task outside the retainer months. */
  billedTo: Map<string, string>
  /** Minutes inside retainer months, per task. */
  inFee: Map<string, number>
  /** Minutes the claims counted outside the retainer months, per task, left out included. */
  counted: Map<string, number>
}

interface ClaimRow {
  task: string
  state: string
  key: string
  counted: number | null
  day: string
  line: string | null
  planned: number
  real: number | null
  bill: number | null
  netted: number
  period_start: string | null
  period_end: string | null
}

export interface LedgerInput {
  orgId: string
  projectId: string
  tz: string
  /** The months invoiced on a retainer. */
  fee: readonly FeeMonth[]
  /** The retainer month a card asks for: counted as one, less its own cards' claims. */
  own?: FeeMonth
  /** Leaves one card's own claims out of the reckoning. */
  exceptReconciliation?: string
  /** Leaves out what a card still proposed for this period reserved, in a try that stopped. */
  notProposedFor?: string
}

async function claimRows(tx: Tx, input: LedgerInput): Promise<ClaimRow[]> {
  // What a credited card left off counts no more than what it billed.
  return extractRows<ClaimRow>(
    await tx.execute(drizzleSql`
      SELECT c.source_ref AS task, c.state, c.period_key AS key, c.counted_minutes AS counted,
             (c.created_at AT TIME ZONE ${input.tz})::date::text AS day,
             c.line_id::text AS line, coalesce(l.planned_minutes, 0) AS planned,
             l.real_minutes AS real, l.bill_minutes AS bill,
             coalesce((l.counting->>'netted')::int, 0) AS netted,
             r.period_start::text AS period_start, r.period_end::text AS period_end
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r
          ON r.id = c.reconciliation_id AND r.org_id = c.org_id
        LEFT JOIN ${projectsRel("reconciliation_lines")} l
          ON l.id = c.line_id AND l.org_id = c.org_id
       WHERE c.org_id = ${input.orgId}::uuid AND c.project_id = ${input.projectId}::uuid
         AND c.source_kind = 'task' AND c.state IN ('reserved', 'billed', 'left_off')
         AND r.state IS DISTINCT FROM 'credited'
         AND NOT (r.state = 'proposed'
                  AND r.period_start = ${input.notProposedFor ?? null}::date) IS TRUE
         AND c.reconciliation_id IS DISTINCT FROM ${input.exceptReconciliation ?? null}::uuid`),
  )
}

/** The key of a claim without its number: `2027-01` for `2027-01` and for `2027-01+2`. */
export function claimMonth(periodKey: string): string {
  return periodKey.split("+")[0] as string
}

/** The minutes of `counted` a line's bill covers: less when a person billed less than it showed. */
function billedPart(r: ClaimRow): number {
  if (r.counted === null || Number(r.planned) > 0 || !r.real || Number(r.real) <= 0) return 0
  const shown = Number(r.real)
  const bills = Math.min(shown, Number(r.bill ?? 0) + Number(r.netted))
  return Math.floor((Number(r.counted) * bills) / shown)
}

export async function timeLedger(tx: Tx, input: LedgerInput): Promise<TimeLedger> {
  const { projectId } = input
  const rows = await claimRows(tx, input)
  const tree = new Map(
    extractRows<{ id: string; parent: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, parent_task_id::text AS parent FROM ${projectsRel("tasks")}
         WHERE org_id = ${input.orgId}::uuid AND project_id = ${projectId}::uuid
           AND archived_at IS NULL`),
    ).map((t) => [t.id, t.parent]),
  )
  const feeMonths = new Map(input.fee.map((f) => [f.from.slice(0, 7), f]))
  const all = new Map(feeMonths)
  if (input.own) all.set(input.own.from.slice(0, 7), input.own)

  const entered = new Map<string, Map<string, number>>()
  for (const [m, f] of all) entered.set(m, await taskMinutes(tx, projectId, f.from, f.to))
  const total = await taskMinutes(tx, projectId, null, null)
  const outside = new Map(total)
  for (const of of entered.values())
    for (const [id, m] of of) outside.set(id, (outside.get(id) ?? 0) - m)

  // What the claims counted, per bucket and task.
  const ALL = "all"
  const counts = new Map<string, Map<string, Counted>>()
  const of = (bucket: string, task: string): Counted => {
    const b = counts.get(bucket) ?? new Map<string, Counted>()
    counts.set(bucket, b)
    const c = b.get(task) ?? nothing()
    b.set(task, c)
    return c
  }
  const add = (r: ClaimRow, bucket: string, minutes: number, billed: number) => {
    const c = of(bucket, r.task)
    c.byTime = true
    if (r.state === "left_off") c.leftOut += minutes
    else {
      c.held += minutes
      c.billed += billed
      c.live = true
    }
  }
  const ownMonth = input.own?.from.slice(0, 7)
  const older: Array<ClaimRow & { bucket: string }> = []
  const billedTo = new Map<string, string>()
  const lastClaim = new Map<string, string>()
  const priced = new Set<string>()
  const netted = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const month = claimMonth(r.key)
    const bucket = month !== ALL && all.has(month) ? month : ALL
    // The card's own month is told less the hours a later month's card holds, not its own cards'.
    if (bucket === ownMonth && r.period_start === input.own?.from) continue
    if (bucket === ALL) {
      if ((r.period_end ?? "") > (billedTo.get(r.task) ?? ""))
        billedTo.set(r.task, r.period_end as string)
      if (r.day > (lastClaim.get(r.task) ?? "")) lastClaim.set(r.task, r.day)
    }
    if (r.line && Number(r.netted) > 0) {
      const lines = netted.get(bucket) ?? new Map<string, number>()
      netted.set(bucket, lines.set(r.line, Number(r.netted)))
    }
    if (r.counted !== null) {
      add(r, bucket, Number(r.counted), r.state === "left_off" ? 0 : billedPart(r))
      continue
    }
    if (month === ALL) {
      const c = of(ALL, r.task)
      if (r.state === "left_off") c.leftWhole = true
      else {
        c.whole = true
        c.live = true
        if (Number(r.planned) > 0) priced.add(r.task)
      }
      continue
    }
    if (bucket !== ALL) older.push({ ...r, bucket })
  }
  // A retainer claim older than the recorded minutes counts what is dated up to the day it was
  // made: the latest of a task's says it.
  const latest = new Map<string, ClaimRow & { bucket: string }>()
  for (const r of older) {
    const k = `${r.bucket} ${r.task}`
    const was = latest.get(k)
    if (!was || r.day > was.day || (r.day === was.day && was.state === "left_off")) latest.set(k, r)
  }
  const upTo = new Map<string, Map<string, number>>()
  for (const r of latest.values()) {
    const f = all.get(r.bucket) as FeeMonth
    const to = r.day < f.to ? r.day : f.to
    const k = `${f.from} ${to}`
    if (!upTo.has(k)) upTo.set(k, await taskMinutes(tx, projectId, f.from, to))
    add(r, r.bucket, upTo.get(k)?.get(r.task) ?? 0, 0)
  }

  const bucket = (): Bucket => ({
    open: new Map(),
    leftOut: new Map(),
    touched: new Set(),
    held: new Set(),
    byTime: new Set(),
    spare: 0,
  })
  const rest = bucket()
  const months = new Map([...all.keys()].sort().map((m) => [m, bucket()]))
  const buckets: Array<[string, Bucket, ReadonlyMap<string, number>]> = [
    ...[...months].map(
      ([m, b]) => [m, b, entered.get(m) ?? new Map()] as [string, Bucket, Map<string, number>],
    ),
    [ALL, rest, outside],
  ]
  const ids = new Set([...total.keys(), ...rows.map((r) => r.task)])
  for (const id of ids) {
    const gaps: Array<{ b: Bucket; from: string; gap: number; c: Counted; minutes: number }> = []
    let surplus = 0
    for (const [key, b, worked] of buckets) {
      const c = counts.get(key)?.get(id)
      const minutes = worked.get(id) ?? 0
      if (c) b.touched.add(id)
      if (c?.live) b.held.add(id)
      if (c?.byTime) b.byTime.add(id)
      const from = all.get(key)?.from ?? ""
      gaps.push({
        b,
        from,
        c: c ?? nothing(),
        minutes,
        gap: minutes - (c?.held ?? 0) - (c?.leftOut ?? 0),
      })
      if (key === ALL) surplus = Math.max(0, (c?.held ?? 0) - minutes)
    }
    // Counted by the hour before its month was a retainer's: it stays counted. A claim made before
    // the month began counted none of it.
    const claimedOn = lastClaim.get(id) ?? ""
    const spent = surplus
    for (const g of gaps) {
      if (g.b === rest || surplus === 0 || g.gap <= 0 || claimedOn < g.from) continue
      const take = Math.min(surplus, g.gap)
      g.gap -= take
      surplus -= take
    }
    for (const g of gaps) {
      const inRest = g.b === rest
      if (tree.has(id) && !(inRest && (g.c.whole || g.c.leftWhole)) && g.gap > 0)
        g.b.open.set(id, g.gap)
      const standing = Math.min(g.minutes, g.c.leftWhole && inRest ? g.minutes : g.c.leftOut)
      const left = inRest && g.c.whole ? 0 : Math.min(standing, Math.max(0, g.minutes - g.c.held))
      if (tree.has(id) && left > 0) g.b.leftOut.set(id, left)
      const over = Math.max(0, g.c.billed - g.minutes) - (inRest ? spent - surplus : 0)
      if (over > 0) g.b.spare += over
    }
  }
  for (const [key, b] of buckets)
    b.spare = Math.max(
      0,
      b.spare - [...(netted.get(key)?.values() ?? [])].reduce((x, y) => x + y, 0),
    )

  const inPrice = new Set<string>()
  if (priced.size > 0)
    for (const id of tree.keys()) {
      const seen = new Set<string>()
      for (let p: string | null | undefined = id; p && !seen.has(p); p = tree.get(p)) {
        seen.add(p)
        if (priced.has(p)) inPrice.add(id)
      }
    }

  const inFee = new Map<string, number>()
  for (const m of feeMonths.keys())
    for (const [id, x] of entered.get(m) ?? new Map<string, number>())
      inFee.set(id, (inFee.get(id) ?? 0) + x)
  const counted = new Map<string, number>()
  for (const [id, c] of counts.get(ALL) ?? new Map<string, Counted>())
    if (c.held + c.leftOut > 0) counted.set(id, c.held + c.leftOut)
  return {
    rest,
    months,
    claimed: new Set(rows.map((r) => r.task)),
    priced,
    inPrice,
    credited: await creditedTasks(tx, input),
    billedTo,
    inFee,
    counted,
  }
}

/** The tasks a credited card billed by the day or the hour. */
async function creditedTasks(tx: Tx, input: LedgerInput): Promise<Set<string>> {
  return new Set(
    extractRows<{ task: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT source_ref AS task FROM ${projectsRel("billing_claims")}
         WHERE org_id = ${input.orgId}::uuid AND project_id = ${input.projectId}::uuid
           AND source_kind = 'task' AND state = 'credited' AND starts_with(period_key, 'all')`),
    ).map((r) => r.task),
  )
}

/** What a line that names a task counts of it: what is open, and what was left out of a card. */
function nameable(b: Bucket, id: string): number {
  return (b.open.get(id) ?? 0) + (b.leftOut.get(id) ?? 0)
}

/** The spare minutes of the bucket a line is counted in: its earlier month, or the card's own. */
export function spares(ledger: TimeLedger, own: string | null) {
  const left = new Map<string, { left: number }>()
  return (workMonth: string | null): { left: number } | null => {
    const key = workMonth ?? own
    const b = key === null ? ledger.rest : ledger.months.get(key)
    if (!b) return null
    const of = left.get(key ?? "") ?? { left: b.spare }
    left.set(key ?? "", of)
    return of
  }
}

/** What each line of a card counts, from the project's ledger. */
export function shareOf(
  ledger: TimeLedger,
  own: string | null,
  excluded: ReadonlySet<string>,
): Omit<ShareInput, "basis" | "tasks"> {
  const month = own === null ? undefined : ledger.months.get(own)
  if (month) {
    const open = (id: string) => month.open.get(id) ?? 0
    return { named: open, open }
  }
  return {
    named: (id) => nameable(ledger.rest, id),
    open: (id) => ledger.rest.open.get(id) ?? 0,
    apart: new Set([...ledger.rest.touched, ...excluded]),
    claimed: ledger.rest.touched,
    inPrice: ledger.inPrice,
    inFee: ledger.inFee,
    counted: ledger.counted,
    leftOut: ledger.rest.leftOut,
  }
}
