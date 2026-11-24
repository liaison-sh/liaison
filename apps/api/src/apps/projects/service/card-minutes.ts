// SPDX-License-Identifier: FSL-1.1-ALv2
// What each line of a stored card would count now.
//
// A card may stay open for days while time is entered, so Create reads the minutes again before it
// claims them. A line whose minutes, or whose bill by default, moved is stale: it is refused, never
// billed at the minutes it was drawn with. What is claimed is what is counted here, task by task.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { type BudgetTask, liveTasks } from "./coverage"
import { billedCards, feeMonths, lateMonths, laterTime, type MonthMinutes } from "./late-work"
import { type Counting, lessOf, shareOut, takeSpare } from "./line-minutes"
import { defaultBill, LATE_RELATED_LINE_NAME, type LineKind } from "./reconcile-lines"
import { shareOf, spares, timeLedger } from "./time-ledger"
import type { Basis } from "./time-plan"

type Tx = RlsClient

/** A stored line, as far as its minutes go. */
export interface LineMinutes {
  id: string
  /** The name it was drawn with, whatever a person words it as. */
  drawnAs: string | null
  kind: string | null
  taskIds: string[]
  plannedMinutes: number | null
  realMinutes: number
  billMinutes: number
  workMonth: string | null
  counting: Counting | null
}

/** What a line counts now. */
export interface LineNow {
  real: number
  /** What it bills by default, at the minutes it was drawn with and at these. */
  billWas: number
  bill: number
  counting: Counting | null
  /** The minutes of each task it counts, the ones under its own included; null when it counts none. */
  counted: Map<string, number> | null
  /** Billed at its plan: the tasks it names count whole. */
  atPlan: boolean
  /** Time of work an earlier card counted: its claims take a key of their own. */
  later: boolean
  /** It is not what the card says any more. */
  moved: boolean
  /** Tasks it names that it counts nothing of any more. */
  gone: string[]
  /** It names work that was left out of a card on purpose: billing it puts it back. */
  addsBack: string[]
}

export interface CardHead {
  id: string
  project_id: string
  basis: string
  period_start: string | null
  period_end: string | null
}

async function treeOf(tx: Tx, orgId: string, projectId: string): Promise<BudgetTask[]> {
  const rows = extractRows<{
    id: string
    parent_id: string | null
    timebox: number | null
    archived: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, parent_task_id::text AS parent_id, timebox_minutes AS timebox,
             archived_at IS NOT NULL AS archived
        FROM ${projectsRel("tasks")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
       ORDER BY position, number`),
  )
  return liveTasks(
    rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: "",
      position: 0,
      number: 0,
      timebox: r.timebox,
      isMilestone: false,
      archived: r.archived,
      closed: false,
      started: false,
    })),
  )
}

const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

/** Minutes billed before any were entered, over the tasks of a line. */
function ahead(ids: readonly string[], bill: number): Map<string, number> {
  return new Map(
    ids.map((id, i) => [id, Math.floor(bill / ids.length) + (i < bill % ids.length ? 1 : 0)]),
  )
}

export interface CardMinutes {
  lines: Map<string, LineNow>
  /** The later hours of earlier months, as they stand now. */
  months: Array<{ month: string } & MonthMinutes>
  /** Time entered on tasks an earlier card counted by their time (empty on a retainer). */
  after: MonthMinutes
  /** Tasks a claim of another card holds by their time, outside the retainer months. */
  held: ReadonlySet<string>
}

/** Every line of a card, counted again. Read under the project's lock. */
export async function cardMinutesNow(
  tx: Tx,
  input: {
    orgId: string
    tz: string
    head: CardHead
    lines: readonly LineMinutes[]
    excluded: ReadonlySet<string>
  },
): Promise<CardMinutes> {
  const { orgId, tz, head, lines } = input
  const projectId = head.project_id
  const basis = head.basis as Basis
  const from = head.period_start ?? ""
  const tree = await treeOf(tx, orgId, projectId)
  const cards = (await billedCards(tx, orgId, projectId, tz)).filter((c) => c.id !== head.id)
  const retainer = basis === "retainer" && head.period_end !== null
  const byTask = basis === "daily" || basis === "hourly"
  const ledger = await timeLedger(tx, {
    orgId,
    projectId,
    tz,
    fee: feeMonths(cards),
    ...(retainer ? { own: { from, to: head.period_end as string } } : {}),
    exceptReconciliation: head.id,
  })
  const months = lateMonths(
    ledger,
    cards.filter((c) => c.to < from),
  )
  const after: MonthMinutes = byTask
    ? laterTime(ledger, from)
    : { offered: new Map(), leftOut: new Map() }
  const ownMonth = retainer ? from.slice(0, 7) : null
  const spareOf = spares(ledger, ownMonth)

  const own = lines.filter((l) => !l.workMonth && !l.counting?.later && l.taskIds.length > 0)
  const shares =
    retainer || byTask
      ? shareOut(
          { basis, tasks: tree, ...shareOf(ledger, ownMonth, input.excluded) },
          own.map((l) => ({ ids: l.taskIds, other: l.kind === "other" })),
        )
      : []
  const shareAt = new Map(own.map((l, i) => [l.id, shares[i]]))
  const periodPlanned = lines.some((l) => !l.workMonth && (l.plannedMinutes ?? 0) > 0)

  const out = new Map<string, LineNow>()
  for (const l of lines) {
    const ids = [...new Set(l.taskIds)]
    const share = shareAt.get(l.id)
    const later = Boolean(l.workMonth) || l.counting?.later === true
    if (ids.length === 0 || !(later || share)) {
      out.set(l.id, {
        real: l.realMinutes,
        billWas: l.billMinutes,
        bill: l.billMinutes,
        counting: l.counting,
        counted: null,
        atPlan: false,
        later: false,
        moved: false,
        gone: [],
        addsBack: [],
      })
      continue
    }
    const planned = l.plannedMinutes ?? 0
    const atPlan = !later && byTask && planned > 0
    let counted: Map<string, number>
    let counting: Counting = {}
    let left: ReadonlyMap<string, number> = new Map()
    if (later) {
      const m = l.workMonth ? months.find((x) => x.month === l.workMonth) : after
      const auto = l.counting?.auto === true
      counted = new Map(
        ids.map((id) => [id, (m?.offered.get(id) ?? 0) + (auto ? 0 : (m?.leftOut.get(id) ?? 0))]),
      )
      counting = { later: true, ...(auto ? { auto: true as const } : {}) }
      if (!auto && m) left = m.leftOut
    } else {
      counted = (share as NonNullable<typeof share>).minutes
      counting = { ...(share as NonNullable<typeof share>).less }
      if (byTask && l.kind !== "other") left = ledger.rest.leftOut
    }
    const now = sum(counted)
    const related = l.drawnAs === LATE_RELATED_LINE_NAME
    const gross = (minutes: number) =>
      related
        ? 0
        : later
          ? minutes
          : defaultBill(basis, (l.kind ?? "manual") as LineKind, planned, minutes, periodPlanned)
              .bill
    const billWas = Math.max(0, gross(l.realMinutes) - lessOf(l.counting ?? {}))
    let bill = Math.max(0, gross(now) - lessOf(counting))
    const spare = spareOf(l.workMonth)
    if (spare && !atPlan) bill = takeSpare(spare, bill, counting)
    // A plan's line bills its plan: its time moves nothing but what its bill leaves out.
    const moved = atPlan ? bill !== billWas : now !== l.realMinutes || bill !== billWas
    const named = ids.filter((id) => (counted.get(id) ?? 0) === 0)
    out.set(l.id, {
      real: now,
      billWas,
      bill,
      counting: Object.keys(counting).length > 0 ? counting : null,
      counted:
        now === 0 && l.realMinutes === 0 && l.billMinutes > 0 && !atPlan
          ? ahead(ids, l.billMinutes)
          : counted,
      atPlan,
      later,
      moved,
      gone: now < l.realMinutes ? named : [],
      addsBack: ids.filter((id) => (left.get(id) ?? 0) > 0),
    })
  }
  const heldByTime = new Set([...ledger.rest.held].filter((id) => ledger.rest.byTime.has(id)))
  return { lines: out, months, after, held: heldByTime }
}
