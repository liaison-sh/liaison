// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Quiet hours, the way people say them, over the stored WORK-hours model.
 *
 * Storage keeps a work window (`start`-`end` on `days`; outside it phone and
 * computer stay quiet). People speak the other way round: "quiet from 21:00 to
 * 08:00 on weekdays, and all weekend". A weak model asked to invert that itself
 * stored the quiet window AS the work window (2026-09-29), so the agent tool
 * takes the quiet form and the conversion lives here, once, tested.
 *
 * The rule: the work window runs from the end of the quiet period to its start
 * (`to` -> `from`), on every day that is not quiet all day. A quiet period that
 * does not cross midnight (a lunch break, 12:00-14:00) gives a work window that
 * does (14:00-12:00); the router anchors such a window to the day it starts on.
 */

/** 0 = Sunday ... 6 = Saturday, the tool contract's numbering. */
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
export type DayKey = (typeof DAY_KEYS)[number]

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export interface QuietHoursInput {
  /** Quiet period start, HH:MM (e.g. 21:00). */
  from: string
  /** Quiet period end, HH:MM (e.g. 08:00). */
  to: string
  /** Days with no phone or computer notifications at all. */
  allDayOn?: DayKey[]
  /** Shorthand for allDayOn sat + sun. */
  allWeekend?: boolean
  timezone?: string
}

export interface WorkWindow {
  start: string
  end: string
  /** 0 = Sunday ... 6 = Saturday, ascending. */
  days: number[]
  timezone?: string
}

export type QuietHoursResult = { ok: true; value: WorkWindow } | { ok: false; message: string }

/** Convert the quiet form to the stored work window. */
export function quietHoursToWorkWindow(q: QuietHoursInput): QuietHoursResult {
  if (q.from === q.to) {
    return {
      ok: false,
      message:
        "Quiet hours need a start and an end that differ (from 21:00 to 08:00, for example). For a whole day use allDayOn.",
    }
  }
  const allDay = new Set<number>((q.allDayOn ?? []).map((d) => DAY_KEYS.indexOf(d)))
  if (q.allWeekend) {
    allDay.add(0)
    allDay.add(6)
  }
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => !allDay.has(d))
  if (days.length === 0) {
    return {
      ok: false,
      message:
        "Quiet all day on every day would silence the phone and computer for good. Switch those channels off instead (notifications_set cells).",
    }
  }
  return {
    ok: true,
    value: {
      start: q.to,
      end: q.from,
      days,
      ...(q.timezone ? { timezone: q.timezone } : {}),
    },
  }
}

function dayList(days: number[]): string {
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) // Monday first
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d))) return "Mon-Fri"
  if (sorted.length === 7) return "every day"
  return sorted.map((d) => DAY_LABELS[d]).join(", ")
}

/** The stored work window described as quiet hours, one plain sentence. */
export function describeQuietHours(w: {
  start: string
  end: string
  days: number[]
  timezone: string
  explicit: boolean
  /** False: no quiet time at all (default quiet hours off and none set). */
  quiet?: boolean
}): string {
  if (w.quiet === false) return "Quiet hours: none set, phone and computer notify at any time."
  const allDay = [0, 1, 2, 3, 4, 5, 6].filter((d) => !w.days.includes(d))
  const nightly =
    w.start === w.end
      ? `none on ${dayList(w.days)}`
      : `${w.end} to ${w.start} on ${dayList(w.days)}`
  const whole = allDay.length > 0 ? `, and all day on ${dayList(allDay)}` : ""
  const which = w.explicit ? "Quiet hours" : "Quiet hours (the default, not set by the user)"
  return `${which} (phone and computer silent; only a critical incident for the people on call comes through): ${nightly}${whole}, time zone ${w.timezone}.`
}
