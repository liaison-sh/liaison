// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Retainers: a recurring schedule with a monthly timebox of included hours and an overage rate.
// A retainer month is never drafted by the month-end run: a person reconciles the month on its
// planned vs done card and presses Create invoice there, and that one draft carries the fee and
// any overage. This file holds the one predicate every drafting path asks, and the month's
// arithmetic (pure: minutes and minor units in, lines out).

/** The fields that make a schedule a retainer. */
export interface RetainerFacts {
  retainer_project_id?: unknown
  retainer_minutes?: unknown
}

/** A schedule with included minutes is a retainer: every drafting path asks this one question. */
export function isRetainerSchedule(s: RetainerFacts | null | undefined): boolean {
  if (!s) return false
  const minutes = Number(s.retainer_minutes)
  return s.retainer_minutes !== null && s.retainer_minutes !== undefined && minutes > 0
}

/**
 * True when the schedule's month `YYYY-MM` is a retainer month: the schedule is a retainer and
 * the month is on or after the one it became a retainer from (a schedule made a retainer during a
 * month keeps that month on the month-end run).
 */
export function isRetainerMonth(
  s: (RetainerFacts & { retainer_from?: unknown }) | null | undefined,
  month: string,
): boolean {
  if (!isRetainerSchedule(s)) return false
  const from = typeof s?.retainer_from === "string" ? s.retainer_from : null
  return from === null || month >= from
}

/** The key a retainer month's draft carries: one draft per schedule and month. */
export function retainerDocumentRef(scheduleId: string, month: string): string {
  return `retainer:${scheduleId}:${month}`
}

/** The key the month-end run gives the same schedule's month: a month billed by one or the other. */
export function runDocumentRef(scheduleId: string, month: string): string {
  return `recurring:${scheduleId}:${month}`
}

/** `2026-10` for any day of October 2026. */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** The month before `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

/** The month after `YYYY-MM`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

export type Rollover = "none" | "next"

/**
 * The hours a month passes to the next: its own included hours it did not use, at most the
 * month's timebox. Hours rolled in are not passed on again, so they never reach the month after.
 */
export function rolloverOut(rollover: Rollover, includedMinutes: number, usedMinutes: number) {
  if (rollover !== "next") return 0
  return Math.min(includedMinutes, Math.max(0, includedMinutes - Math.max(0, usedMinutes)))
}

export interface RetainerMonthInput {
  includedMinutes: number
  /** What the card bills for the month: its billed total. */
  usedMinutes: number
  /** Hours rolled in from the month before, counted before any overage. */
  rolloverInMinutes: number
  waived: boolean
}

export interface RetainerMonth {
  includedMinutes: number
  usedMinutes: number
  rolloverInMinutes: number
  /** Hours above the included and rolled-in hours; 0 under the timebox or when waived. */
  overageMinutes: number
  /** What the overage would have been, kept when it is waived. */
  waivedMinutes: number
}

/** overage = max(0, used - included - rolled in), or nothing when the month's overage is waived. */
export function retainerMonth(input: RetainerMonthInput): RetainerMonth {
  const included = Math.max(0, Math.round(input.includedMinutes))
  const used = Math.max(0, Math.round(input.usedMinutes))
  const rolledIn = Math.min(included, Math.max(0, Math.round(input.rolloverInMinutes)))
  const over = Math.max(0, used - included - rolledIn)
  return {
    includedMinutes: included,
    usedMinutes: used,
    rolloverInMinutes: rolledIn,
    overageMinutes: input.waived ? 0 : over,
    waivedMinutes: input.waived ? over : 0,
  }
}

/** The figures a retainer draft keeps in its `external_refs`, read again by the next month. */
export interface RetainerRefs {
  schedule_id: string
  month: string
  included_minutes: number
  used_minutes: number
  rollover_in_minutes: number
  overage_minutes: number
  waived_minutes: number
}

/** The retainer figures of a document, when it is a retainer month's. */
export function retainerRefsOf(doc: { external_refs?: unknown } | null): RetainerRefs | null {
  if (!doc) return null
  let refs = doc.external_refs as unknown
  if (typeof refs === "string") {
    try {
      refs = JSON.parse(refs)
    } catch {
      return null
    }
  }
  const r = (refs as { retainer?: RetainerRefs } | null)?.retainer
  return r && typeof r.month === "string" ? r : null
}

/** "6 h", "6 h 30": minutes as the draft's lines and messages say them. */
export function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}

/** The warning a prepaid retainer carries: billed before the month, settled after it. */
export const PREPAID_WARNING =
  "Prepaid: each month's fee is invoiced ahead as an advance, and the month-end invoice deducts it and adds any overage, so it can total zero; check this way of billing with your accountant."
