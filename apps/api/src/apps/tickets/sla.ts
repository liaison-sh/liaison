// SPDX-License-Identifier: FSL-1.1-ALv2
import { DateTime } from "luxon"

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"

export interface BusinessHours {
  timezone: string
  weekly: Record<DayOfWeek, [string, string][]>
  holidays: Array<string | { date: string; label?: string }>
}

const DOW_ORDER: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

function validateHours(hours: BusinessHours): void {
  if (!DateTime.now().setZone(hours.timezone).isValid) {
    throw new Error(`business_hours_invalid_timezone: ${hours.timezone}`)
  }
  if (!Object.values(hours.weekly).some((d) => d.length > 0)) {
    throw new Error("business_hours_empty")
  }
}

function dowKey(weekday: number): DayOfWeek {
  return DOW_ORDER[weekday - 1]
}

interface DayWindow {
  start: DateTime
  end: DateTime
}

function windowsForDate(d: DateTime, hours: BusinessHours): DayWindow[] {
  const iso = d.toISODate()
  if (iso && hours.holidays.some((h) => (typeof h === "string" ? h : h.date) === iso)) return []
  const wins = hours.weekly[dowKey(d.weekday)] ?? []
  return wins.map(([startStr, endStr]) => {
    const [sh, sm] = startStr.split(":").map(Number)
    const [eh, em] = endStr.split(":").map(Number)
    return {
      start: d.set({ hour: sh, minute: sm, second: 0, millisecond: 0 }),
      end: d.set({ hour: eh, minute: em, second: 0, millisecond: 0 }),
    }
  })
}

export function walkForwardBusinessHours(start: Date, seconds: number, hours: BusinessHours): Date {
  validateHours(hours)
  let remaining = seconds
  let cursor = DateTime.fromJSDate(start, { zone: hours.timezone })
  for (let safety = 0; safety < 366 * 24; safety++) {
    const wins = windowsForDate(cursor.startOf("day"), hours)
    for (const w of wins) {
      if (cursor >= w.end) continue
      const effectiveStart = cursor < w.start ? w.start : cursor
      const available = w.end.diff(effectiveStart, "seconds").seconds
      if (available >= remaining) {
        return effectiveStart.plus({ seconds: remaining }).toUTC().toJSDate()
      }
      remaining -= available
    }
    cursor = cursor.startOf("day").plus({ days: 1 })
  }
  throw new Error("business_hours_unreachable_deadline")
}

export function businessHoursBetween(a: Date, b: Date, hours: BusinessHours): number {
  validateHours(hours)
  if (b <= a) return 0
  let total = 0
  let cursorA = DateTime.fromJSDate(a, { zone: hours.timezone })
  const cursorB = DateTime.fromJSDate(b, { zone: hours.timezone })
  while (cursorA < cursorB) {
    const wins = windowsForDate(cursorA.startOf("day"), hours)
    for (const w of wins) {
      const start = cursorA > w.start ? cursorA : w.start
      const end = cursorB < w.end ? cursorB : w.end
      if (end > start) total += end.diff(start, "seconds").seconds
    }
    cursorA = cursorA.startOf("day").plus({ days: 1 })
  }
  return Math.round(total)
}
