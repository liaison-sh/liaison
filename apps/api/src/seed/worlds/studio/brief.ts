// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner's Morning brief as the routine last wrote it, computed from the
// world's plan at the anchor: every figure is a sum over the seeded rows, the
// dates come from the story clock's formatter, and no sentence names a
// relative day, so the brief stays true whenever the org is handed out.
import { STORY_TIME_ZONE, storyClock } from "../story-clock"
import { studioAgreements } from "./agreements"
import { STUDIO_DELIVERY_KEYS } from "./fiction"
import { studioPlan } from "./plan"

/** Midday UTC on a Paris civil date `YYYY-MM-DD` (or `YYYY-MM` and a day). */
const middayOf = (civil: string, day?: number): Date => {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number?]
  return new Date(Date.UTC(y, m - 1, day ?? d ?? 1, 12))
}

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`

/** The brief's text at `anchor`, in English. */
export function studioMorningBrief(anchor: Date): string {
  const clock = storyClock(anchor)
  const plan = studioPlan(anchor)
  const project = (key: string) => {
    const p = plan.projects.find((x) => x.key === key)
    if (!p) throw new Error(`studio brief: no project ${key}`)
    return p
  }
  const realOn = (key: string, from = "") =>
    plan.taskTime
      .filter((t) => t.project === key && t.workDate >= from)
      .reduce((n, t) => n + t.minutes, 0)

  // The fixed-price project: its next milestone, how far it is, and its hours.
  const marlin = project("MARLIN")
  const milestones = marlin.tasks.filter((t) => t.isMilestone)
  const planned = milestones.reduce((n, t) => n + (t.timeboxMinutes ?? 0), 0)
  const next = milestones.find((t) => t.status !== "done" && t.dueOn)
  const under = next ? marlin.tasks.filter((t) => t.parent === next.key) : []
  const done = under.filter((t) => t.status === "done").length
  // The milestone counts as one of its own tasks, as the project's budget counts it.
  const pct = next ? Math.round((done / (under.length + 1)) * 100) : 0
  const due = next?.dueOn ? clock.fmt(middayOf(next.dueOn), "en", "dayMonth") : ""

  // The retainer: this month's hours against the month's included hours.
  const month = clock.monthKey()
  const sorel = project("SOREL")
  const included = sorel.periods.find((p) => p.periodStart.startsWith(month))?.minutes ?? 0
  const monthName = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: STORY_TIME_ZONE }).format(d)
  const thisMonth = monthName(middayOf(month, 15))
  const lastMonth = monthName(clock.lastMonthWeekday(1))

  // Next week: the open work of delivery due in it, against a full week each.
  const delivery = new Set<string>(STUDIO_DELIVERY_KEYS)
  const nextWeekPlanned = plan.projects
    .flatMap((p) => p.tasks)
    .filter(
      (t) =>
        t.status !== "done" &&
        t.assignee &&
        delivery.has(t.assignee) &&
        t.dueOn &&
        t.dueOn >= plan.nextWeek.from &&
        t.dueOn <= plan.nextWeek.to,
    )
    .reduce((n, t) => n + (t.timeboxMinutes ?? 0), 0)
  const available = delivery.size * 5 * plan.hoursPerDayMinutes

  const alpine = project("ALPINE")
  const tessier = studioAgreements(anchor).agreements.find((a) => a.key === "tessier-sow")
  const signer =
    tessier?.signers.find((s) => !s.at)?.person === "jean-tessier" ? "Jean Tessier" : ""

  return [
    next
      ? `${marlin.name}: ${next.title} is due ${due}, ${pct}% done, time spent ${hours(realOn("MARLIN"))} of ${hours(planned)} planned.`
      : `${marlin.name}: time spent ${hours(realOn("MARLIN"))} of ${hours(planned)} planned.`,
    `Éditions Sorel has used ${hours(realOn("SOREL", `${month}-01`))} of ${hours(included)} for ${thisMonth}.`,
    `Next week has ${hours(nextWeekPlanned)} planned of ${hours(available)} available.`,
    `Coopérative Alpine's ${lastMonth} on ${alpine.name} is ready for planned vs done` +
      (tessier && signer
        ? `, and ${signer} still has the agreement "${tessier.title}" to sign.`
        : "."),
    "Sources: Projects, Invoicing, Agreements.",
  ].join("\n\n")
}
