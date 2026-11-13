// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Working time: deadlines counted in an org's working hours (its time zone and
// `organizations.business_hours`, Mon-Fri 09:00-18:00 by default), with a per-routine override
// (a flow's `calendar`). Used by routine flow waits ("after 2 working days, if still ...").
//
// - `working_hours` N: N hours of working time from the start (time outside the window does not
//   count; a start outside it counts from the next window's opening).
// - `working_days` N: N full working days of working time, so a start inside the window lands at
//   the same wall time N working days later (Friday 17:00 + 1 working day = Monday 17:00).
// - `hours` / `days`: plain elapsed time, `days` in the calendar's time zone (a day across a DST
//   change keeps its wall time).
import { DateTime } from "luxon"

export interface WorkingCalendar {
  timezone: string
  /** Working days, 0 = Sunday ... 6 = Saturday (JavaScript `getDay`). */
  days: number[]
  /** Window opening and closing, "HH:MM" local time. */
  start: string
  end: string
}

export type WorkingTimeUnit = "working_hours" | "working_days" | "hours" | "days"

export const DEFAULT_WORKING_CALENDAR: WorkingCalendar = {
  timezone: "UTC",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function minutesOf(hhmm: string): number | null {
  const m = HHMM.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * The calendar in force: the org's time zone and business hours, then the override's fields on
 * top. Anything malformed falls back to the default for that field, never throws.
 */
export function resolveWorkingCalendar(
  org: { timezone?: string | null; businessHours?: unknown } | null,
  override?: Partial<WorkingCalendar> | null,
): WorkingCalendar {
  const bh =
    org?.businessHours && typeof org.businessHours === "object"
      ? (org.businessHours as Partial<WorkingCalendar>)
      : {}
  const pick = <K extends keyof WorkingCalendar>(
    key: K,
    valid: (v: unknown) => boolean,
  ): WorkingCalendar[K] => {
    for (const v of [override?.[key], key === "timezone" ? org?.timezone : bh[key]]) {
      if (v !== undefined && v !== null && valid(v)) return v as WorkingCalendar[K]
    }
    return DEFAULT_WORKING_CALENDAR[key]
  }
  const cal: WorkingCalendar = {
    timezone: pick("timezone", (v) => typeof v === "string" && DateTime.now().setZone(v).isValid),
    days: pick(
      "days",
      (v) =>
        Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    ),
    start: pick("start", (v) => typeof v === "string" && minutesOf(v) !== null),
    end: pick("end", (v) => typeof v === "string" && minutesOf(v) !== null),
  }
  if ((minutesOf(cal.start) ?? 0) >= (minutesOf(cal.end) ?? 0)) {
    return { ...cal, start: DEFAULT_WORKING_CALENDAR.start, end: DEFAULT_WORKING_CALENDAR.end }
  }
  return cal
}

function windowOf(day: DateTime, cal: WorkingCalendar): { start: DateTime; end: DateTime } | null {
  if (!cal.days.includes(day.weekday % 7)) return null
  const s = minutesOf(cal.start) ?? 0
  const e = minutesOf(cal.end) ?? 0
  const base = day.startOf("day")
  return {
    start: base.set({ hour: Math.floor(s / 60), minute: s % 60 }),
    end: base.set({ hour: Math.floor(e / 60), minute: e % 60 }),
  }
}

/** Walks `seconds` of working time forward from `from`. */
function walkWorkingSeconds(from: Date, seconds: number, cal: WorkingCalendar): Date {
  let remaining = seconds
  let cursor = DateTime.fromJSDate(from, { zone: cal.timezone })
  // At most 60 days of waits, and at least one working day a week: 2 years bounds the walk.
  for (let i = 0; i < 800; i++) {
    const w = windowOf(cursor, cal)
    if (w && remaining === 0 && cursor <= w.start) return w.start.toUTC().toJSDate()
    if (w && cursor < w.end) {
      const begin = cursor < w.start ? w.start : cursor
      const available = w.end.diff(begin, "seconds").seconds
      // Strictly inside the window: a deadline that falls on the closing time moves to the next
      // opening (Friday 09:00 + 1 working day = Monday 09:00, not Friday 18:00).
      if (available > remaining) return begin.plus({ seconds: remaining }).toUTC().toJSDate()
      remaining -= available
    }
    cursor = cursor.startOf("day").plus({ days: 1 })
  }
  throw new Error("working_time_unreachable: the calendar has no working window")
}

/** The deadline `amount` `unit`s after `from` in the calendar. */
export function addWorkingTime(
  from: Date,
  amount: number,
  unit: WorkingTimeUnit,
  cal: WorkingCalendar,
): Date {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("working_time_invalid_amount")
  if (unit === "hours") return new Date(from.getTime() + amount * 3_600_000)
  if (unit === "days") {
    return DateTime.fromJSDate(from, { zone: cal.timezone })
      .plus({ days: amount })
      .toUTC()
      .toJSDate()
  }
  if (unit === "working_hours") return walkWorkingSeconds(from, amount * 3600, cal)
  const dayMinutes = (minutesOf(cal.end) ?? 0) - (minutesOf(cal.start) ?? 0)
  return walkWorkingSeconds(from, amount * dayMinutes * 60, cal)
}

/** The org's calendar, read from its row, with the override on top. */
export async function loadOrgWorkingCalendar(
  orgId: string,
  override?: Partial<WorkingCalendar> | null,
): Promise<WorkingCalendar> {
  const { withPrivilegedDb } = await import("~/db/privileged")
  const { organizations } = await import("~/db/schema/kernel")
  const { eq } = await import("drizzle-orm")
  const [org] = await withPrivilegedDb(orgId, "working-calendar", (tx) =>
    tx
      .select({ timezone: organizations.timezone, businessHours: organizations.businessHours })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return resolveWorkingCalendar(org ?? null, override)
}
