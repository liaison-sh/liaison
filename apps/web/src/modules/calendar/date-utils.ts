// SPDX-License-Identifier: FSL-1.1-ALv2
// Small date-grid helpers shared by MonthGrid/WeekGrid. Kept dependency-free (no date library) —
// the RRULE expansion is the only place needing real recurrence math; grid layout only needs
// day-boundary arithmetic in the browser's local timezone (Intl handles DST transitions
// correctly because we always construct Dates from real calendar fields, never offset math).
/**
 * The first day of the week for a UI locale, as a JS `getDay()` index
 * (0 = Sunday, 1 = Monday). French weeks start on Monday; the grid used to
 * start every locale on Sunday. `Intl.Locale#getWeekInfo` answers when the
 * engine has it; the fallback covers the shipped locales.
 */
export function weekStartsOn(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay
    // An `en` without a region is resolved as en-US (Sunday) by the engines.
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7
  } catch {
    // Unknown tag: fall through.
  }
  return locale.toLowerCase().startsWith("en") ? 0 : 1
}

export function startOfMonthGrid(year: number, month: number, firstDay = 0): Date {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() - firstDay + 7) % 7
  return new Date(year, month, 1 - offset)
}

export function monthGridDays(year: number, month: number, firstDay = 0): Date[] {
  const start = startOfMonthGrid(year, month, firstDay)
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }
  return days
}

export function startOfWeek(date: Date, firstDay = 0): Date {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7))
  d.setHours(0, 0, 0, 0)
  return d
}

/** Seven weekday labels in display order, starting on `firstDay`. */
export function weekdayLabels(
  locale: string,
  firstDay: number,
  style: "short" | "narrow",
): string[] {
  const base = new Date(2026, 5, 7) // a Sunday
  return Array.from({ length: 7 }, (_, i) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + firstDay + i).toLocaleDateString(
      locale,
      { weekday: style },
    ),
  )
}

export function weekDays(weekStart: Date): Date[] {
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    days.push(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i))
  }
  return days
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
