// SPDX-License-Identifier: FSL-1.1-ALv2
// What each line of a stored card would count now.
//
// A card may stay open for days while time is entered, so Create reads the minutes again before it
// claims them. A line billed by its time whose minutes moved is stale: it is refused, never billed
// at the minutes it was drawn with. What is claimed is what is counted here, task by task.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { type BudgetTask, liveTasks, realByTask } from "./coverage"
import {
  billedCards,
  countedTasks,
  lateMonths,
  type MonthMinutes,
  monthCounts,
  retainerFeeMinutes,
  taskMinutes,
} from "./late-work"
import { defaultBill, type LineKind, rootsOf } from "./reconcile-lines"
import type { Basis } from "./time-plan"

type Tx = RlsClient

/** A stored line, as far as its minutes go. */
export interface LineMinutes {
  id: string
  kind: string | null
  taskIds: string[]
  plannedMinutes: number | null
  realMinutes: number
  billMinutes: number
  workMonth: string | null
}

/** What a line counts now. */
export interface LineNow {
  real: number
  /** The minutes each of its tasks counts; null when the line is not billed by its time. */
  counted: Map<string, number> | null
  /** An earlier month's hours, or time entered after a task was billed: no month of its own. */
  later: boolean
  /** Every minute of it is on another card. */
  gone: boolean
  /** It names work that was left out of a card on purpose: billing it puts it back. */
  addsBack: boolean
}

export interface CardHead {
  id: string
  project_id: string
  basis: string
  period_start: string | null
  period_end: string | null
}

async function treeOf(tx: Tx, orgId: string, projectId: string): Promise<BudgetTask[]> {
  const rows = extractRows<{ id: string; parent_id: string | null; archived: boolean }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, parent_task_id::text AS parent_id,
             archived_at IS NOT NULL AS archived
        FROM ${projectsRel("tasks")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid`),
  )
  return liveTasks(
    rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: "",
      position: 0,
      number: 0,
      timebox: null,
      isMilestone: false,
      archived: r.archived,
      closed: false,
      started: false,
    })),
  )
}

const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

/** The month's minutes of a line's tasks, the ones left out on purpose counted when `withLeftOut`. */
function ofMonth(ids: readonly string[], m: MonthMinutes | undefined, withLeftOut: boolean) {
  return new Map(
    ids.map((id) => [
      id,
      (m?.offered.get(id) ?? 0) + (withLeftOut ? (m?.leftOut.get(id) ?? 0) : 0),
    ]),
  )
}

export interface CardMinutes {
  lines: Map<string, LineNow>
  /** The later hours of earlier months, as they stand now. */
  months: Array<{ month: string } & MonthMinutes>
  /** Time entered after a task was billed by its time (empty on a retainer). */
  after: MonthMinutes
}

/** Every line of a card, counted again. Read under the project's lock. */
export async function cardMinutesNow(
  tx: Tx,
  input: { orgId: string; tz: string; head: CardHead; lines: readonly LineMinutes[] },
): Promise<CardMinutes> {
  const { orgId, tz, head, lines } = input
  const projectId = head.project_id
  const tree = await treeOf(tx, orgId, projectId)
  const live = new Set(tree.map((t) => t.id))
  const parents = new Map(tree.map((t) => [t.id, t]))
  const from = head.period_start ?? ""
  const cards = (await billedCards(tx, orgId, projectId, tz)).filter((c) => c.id !== head.id)
  const archived = new Set(
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${projectsRel("tasks")}
         WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
           AND archived_at IS NOT NULL`),
    ).map((r) => r.id),
  )
  const months = await lateMonths(tx, {
    orgId,
    projectId,
    tz,
    cards: cards.filter((c) => c.to < from),
    archived,
    exceptReconciliation: head.id,
  })
  const retainer = head.basis === "retainer"
  const byTask = head.basis === "daily" || head.basis === "hourly"

  // The card's own minutes: the month's on a retainer, less what another card of a later month
  // counted of it; the task's whole life otherwise, less what is inside a retainer's fee.
  const own = new Map<string, number>()
  if (retainer && head.period_end) {
    const held = await monthCounts(tx, {
      orgId,
      projectId,
      tz,
      from,
      to: head.period_end,
      exceptReconciliation: head.id,
      notOfPeriod: from,
    })
    for (const [id, m] of await taskMinutes(tx, projectId, from, head.period_end))
      if (live.has(id)) own.set(id, Math.max(0, m - (held.get(id)?.all ?? 0)))
  } else if (byTask) {
    const fee = await retainerFeeMinutes(tx, projectId, cards)
    for (const [id, m] of await taskMinutes(tx, projectId, null, null))
      if (live.has(id)) own.set(id, Math.max(0, m - (fee.get(id) ?? 0)))
  }
  const real = byTask ? realByTask(tree, own) : own
  const billedByTime = byTask
    ? await countedTasks(tx, { orgId, projectId, exceptReconciliation: head.id })
    : new Map<string, never>()
  const after: MonthMinutes = { offered: new Map(), leftOut: new Map() }
  for (const [id, c] of billedByTime) {
    if (!live.has(id)) continue
    const open = (real.get(id) ?? 0) - c.all
    if (open > 0) after.offered.set(id, open)
    if (c.leftOut > 0) after.leftOut.set(id, c.leftOut)
  }

  const periodPlanned = lines.some((l) => !l.workMonth && (l.plannedMinutes ?? 0) > 0)
  const out = new Map<string, LineNow>()
  for (const l of lines) {
    const ids = [...new Set(l.taskIds)]
    const none = { counted: null, later: false, gone: false, addsBack: false }
    if (ids.length === 0) {
      out.set(l.id, { real: l.realMinutes, ...none })
      continue
    }
    const planned = l.plannedMinutes ?? 0
    const later = l.workMonth
      ? (months.find((x) => x.month === l.workMonth) ?? { offered: new Map(), leftOut: new Map() })
      : byTask && planned === 0 && ids.every((id) => billedByTime.has(id))
        ? after
        : null
    if (later) {
      const offered = ofMonth(ids, later, false)
      const all = ofMonth(ids, later, true)
      const addsBack = sum(all) !== sum(offered) && sum(all) === l.realMinutes
      const counted = addsBack ? all : offered
      const gone = l.realMinutes > 0 && ids.some((id) => (counted.get(id) ?? 0) === 0)
      out.set(l.id, { real: sum(counted), counted, later: true, gone, addsBack })
      continue
    }
    if (retainer) {
      const counted = new Map(ids.map((id) => [id, own.get(id) ?? 0]))
      const now = sum(counted)
      // Billed with no time entered yet: what is billed is that work, whenever its time is entered.
      if (now === 0 && l.realMinutes === 0 && l.billMinutes > 0)
        for (const [i, id] of ids.entries())
          counted.set(
            id,
            Math.floor(l.billMinutes / ids.length) + (i < l.billMinutes % ids.length ? 1 : 0),
          )
      out.set(l.id, { real: now, counted, later: false, gone: false, addsBack: false })
      continue
    }
    if (!byTask) {
      out.set(l.id, { real: l.realMinutes, ...none })
      continue
    }
    const roots = rootsOf(ids, parents)
    const now = roots.reduce((a, id) => a + (real.get(id) ?? 0), 0)
    const bills = (minutes: number) =>
      defaultBill(
        head.basis as Basis,
        (l.kind ?? "manual") as LineKind,
        planned,
        minutes,
        periodPlanned,
      ).bill
    // Billed by its time: by default, or set to it by hand on a line with no plan.
    const byDefault = l.realMinutes > 0 && bills(l.realMinutes) === l.realMinutes
    const byTime =
      planned === 0 && l.billMinutes > 0 && (byDefault || l.billMinutes === l.realMinutes)
    const moves = byTime || bills(l.realMinutes) !== bills(now)
    out.set(l.id, {
      real: moves ? now : l.realMinutes,
      counted: byTime
        ? new Map(ids.map((id) => [id, roots.includes(id) ? (real.get(id) ?? 0) : 0]))
        : null,
      later: false,
      gone: false,
      addsBack: false,
    })
  }
  return { lines: out, months, after }
}
