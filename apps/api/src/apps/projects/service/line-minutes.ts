// SPDX-License-Identifier: FSL-1.1-ALv2
// Which minutes each line of a card counts, and what its bill leaves out of them. Pure: the minutes
// come from the project's ledger. A card and Create both read them here, so what a person was shown
// is what is claimed.
import { type BudgetTask, plannedByTask } from "./coverage"
import type { Basis } from "./time-plan"

/** How a stored line was drawn, beside its figures. */
export interface Counting {
  /** Time of work an earlier card counted: a claim of its own. */
  later?: true
  /** Drawn by the card itself: what was left out of a card is not brought back by it. */
  auto?: true
  /** Minutes of its plan worked inside a retainer's fee. */
  fee?: number
  /** Minutes of its plan on another line, or an earlier card. */
  billed?: number
  /** Minutes inside the price of work billed at its plan. */
  plan?: number
  /** Minutes billed and taken off their task since, that come off this line. */
  netted?: number
}

/** What a line's bill leaves out of what it would bill. */
export function lessOf(c: Counting): number {
  return (c.fee ?? 0) + (c.billed ?? 0) + (c.plan ?? 0) + (c.netted ?? 0)
}

export interface ShareInput {
  basis: Basis
  /** Every live task of the project. */
  tasks: readonly BudgetTask[]
  /** What a line that names the task counts of it. */
  named: (id: string) => number
  /** What the card counts of it by itself. */
  open: (id: string) => number
  /** Tasks no line above them takes in: claimed already, or left out as the client's own. */
  apart?: ReadonlySet<string>
  /** Tasks with a claim of their own. */
  claimed?: ReadonlySet<string>
  /** Tasks inside the price of work billed at its plan. */
  inPrice?: ReadonlySet<string>
  /** Minutes inside retainer months, per task. */
  inFee?: ReadonlyMap<string, number>
  /** Minutes claims counted, per task; of these, the ones left out that naming brings back. */
  counted?: ReadonlyMap<string, number>
  leftOut?: ReadonlyMap<string, number>
}

export interface ShareLine {
  ids: readonly string[]
  /** "Other closed tasks": a line that names a task above takes its minutes first. */
  other: boolean
}

export interface LineShare {
  /** The minutes it counts of each task: the ones it names, and those under them. */
  minutes: Map<string, number>
  real: number
  planned: number | null
  less: Counting
}

/** The tasks of a set that no other task of the set contains: counting them counts each once. */
export function rootsOf(ids: readonly string[], byId: ReadonlyMap<string, BudgetTask>): string[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    let parent = byId.get(id)?.parentId ?? null
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      if (set.has(parent)) return false
      seen.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
    return true
  })
}

/**
 * The minutes of every line, each minute on one line at most: a task's go to the line that names
 * it, else to the one that names the nearest task above it. On a retainer each line counts the
 * tasks it names and nothing under them.
 */
export function shareOut(input: ShareInput, lines: readonly ShareLine[]): LineShare[] {
  const byId = new Map(input.tasks.map((t) => [t.id, t]))
  const planned = plannedByTask(input.tasks)
  const named = new Map<string, number>()
  const other = new Map<string, number>()
  lines.forEach((l, i) => {
    const to = l.other ? other : named
    for (const id of l.ids) if (!to.has(id)) to.set(id, i)
  })
  const out: LineShare[] = lines.map((l) => ({
    minutes: new Map(l.ids.map((id) => [id, 0])),
    real: 0,
    planned: null,
    less: {},
  }))
  const give = (i: number, id: string, minutes: number) => {
    const line = out[i] as LineShare
    line.minutes.set(id, (line.minutes.get(id) ?? 0) + minutes)
    line.real += minutes
  }
  const nearest = (id: string, of: ReadonlyMap<string, number>): number | undefined => {
    const seen = new Set<string>([id])
    for (
      let p = byId.get(id)?.parentId ?? null;
      p && !seen.has(p);
      p = byId.get(p)?.parentId ?? null
    ) {
      seen.add(p)
      const i = of.get(p)
      if (i !== undefined) return i
      if (input.apart?.has(p) && !input.claimed?.has(p)) return undefined
    }
    return undefined
  }
  for (const t of input.tasks) {
    const own = named.get(t.id)
    if (own !== undefined) {
      give(own, t.id, input.named(t.id))
      continue
    }
    const listed = other.get(t.id)
    const above =
      input.basis === "retainer" || (input.apart?.has(t.id) && listed === undefined)
        ? undefined
        : nearest(t.id, named)
    const i =
      above ??
      listed ??
      (input.basis === "retainer" || input.apart?.has(t.id) ? undefined : nearest(t.id, other))
    if (i !== undefined) give(i, t.id, input.open(t.id))
  }

  const byTask = input.basis === "daily" || input.basis === "hourly"
  const kids = new Map<string, string[]>()
  for (const t of input.tasks)
    if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t.id])
  const under = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    return [id, ...(kids.get(id) ?? []).flatMap((k) => under(k, seen))]
  }
  lines.forEach((l, i) => {
    const line = out[i] as LineShare
    const roots = rootsOf([...new Set(l.ids)], byId)
    const plan = roots.reduce((s, id) => s + (planned.get(id) ?? 0), 0)
    line.planned = plan > 0 ? plan : null
    if (!byTask) return
    if (plan === 0) {
      const inside = [...line.minutes].reduce(
        (s, [id, m]) => s + (input.inPrice?.has(id) ? m : 0),
        0,
      )
      if (inside > 0) line.less.plan = inside
      return
    }
    // A plan bills what is not billed yet: not what a fee paid, nor what another line or an earlier
    // card bills of the work under it.
    let fee = 0
    let billed = 0
    const walk = (id: string, root: boolean, seen: Set<string>) => {
      if (seen.has(id)) return
      seen.add(id)
      const on = named.get(id)
      if (!root && on !== undefined && on !== i) {
        const theirs = out[on] as LineShare
        billed +=
          (planned.get(id) ?? 0) > 0
            ? (planned.get(id) as number)
            : under(id).reduce((s, k) => s + (theirs.minutes.get(k) ?? 0), 0)
        return
      }
      if (!root && input.claimed?.has(id) && (planned.get(id) ?? 0) > 0) {
        billed += planned.get(id) as number
        return
      }
      fee += input.inFee?.get(id) ?? 0
      billed += (input.counted?.get(id) ?? 0) - (on === i ? (input.leftOut?.get(id) ?? 0) : 0)
      for (const k of kids.get(id) ?? []) walk(k, false, seen)
    }
    const seen = new Set<string>()
    for (const id of roots) walk(id, true, seen)
    const ofFee = Math.min(fee, plan)
    const ofBilled = Math.min(Math.max(0, billed), plan - ofFee)
    if (ofFee > 0) line.less.fee = ofFee
    if (ofBilled > 0) line.less.billed = ofBilled
  })
  return out
}

/** Takes what was billed and taken off since out of what a line bills, and says how much is left. */
export function takeSpare(spare: { left: number }, bill: number, less: Counting): number {
  const taken = Math.min(spare.left, bill)
  if (taken <= 0) return bill
  spare.left -= taken
  less.netted = taken
  return bill - taken
}
