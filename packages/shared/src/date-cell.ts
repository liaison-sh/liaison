// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a date or timestamp cell reads, in the reader's language: one rule for the dashboard
// table on screen and in its PDF. A day ("2026-11-24"), a midnight, or a date column reads as
// the date alone ("Nov 24, 2026"); any other timestamp as the date and the time in the org's
// zone ("Nov 24, 2026, 10:47 PM"). Sources hand timestamps in many text forms: ISO 8601 and
// Postgres' own (`2026-11-24 22:47:30.548+00`, a space and a short offset), both read here.

export interface CellTimestamp {
  date: Date
  /** A bare day, or a midnight written in UTC (a day stored as a timestamp): it reads as that day. */
  dayOnly: boolean
  /** No offset was written: the written clock is the time (read in UTC). */
  naive: boolean
}

const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/

/** A date or timestamp written as text, or null when the text is not one. */
export function parseCellTimestamp(value: string): CellTimestamp | null {
  const m = STAMP.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, frac, off] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (h === undefined) {
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCDate() !== day) return null
    return { date, dayOnly: true, naive: true }
  }
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s ?? 0)
  if (hour > 23 || minute > 59 || second > 60) return null
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
  let offsetMin = 0
  if (off && off !== "Z") {
    const sign = off.startsWith("-") ? -1 : 1
    const digits = off.slice(1).replace(":", "")
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0))
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000
  const date = new Date(utc)
  if (Number.isNaN(date.getTime())) return null
  const midnight = hour === 0 && minute === 0 && second === 0 && ms === 0
  return { date, dayOnly: midnight && offsetMin === 0, naive: off === undefined }
}

export interface DateCellOptions {
  locale: string
  /** The org's time zone: a timestamp reads in it (a day stays as written). */
  timeZone?: string
  /** The column holds dates: the time is never shown. */
  dateOnly?: boolean
}

/** A zone Intl knows, else UTC. */
function knownZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC"
  try {
    new Intl.DateTimeFormat("en", { timeZone })
    return timeZone
  } catch {
    return "UTC"
  }
}

const DAY: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }

function isMidnightIn(date: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "-1")
  return get("hour") === 0 && get("minute") === 0 && get("second") === 0
}

/**
 * A date or timestamp cell as it reads, or null when the value is not one (the caller then
 * shows it as it came).
 */
export function formatDateCell(value: unknown, opts: DateCellOptions): string | null {
  let stamp: CellTimestamp | null = null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    stamp = { date: value, dayOnly: false, naive: false }
  } else if (typeof value === "string") {
    stamp = parseCellTimestamp(value)
  }
  if (!stamp) return null
  if (stamp.dayOnly) return stamp.date.toLocaleDateString(opts.locale, { ...DAY, timeZone: "UTC" })
  const timeZone = stamp.naive ? "UTC" : knownZone(opts.timeZone)
  if (opts.dateOnly || isMidnightIn(stamp.date, timeZone)) {
    return stamp.date.toLocaleDateString(opts.locale, { ...DAY, timeZone })
  }
  // Joined by hand: ICU versions differ on the joiner ("Nov 24, 2026 at 10:47 PM" in one, a
  // comma in another), and a table cell reads the same on screen and in the PDF.
  const day = stamp.date.toLocaleDateString(opts.locale, { ...DAY, timeZone })
  const time = stamp.date.toLocaleTimeString(opts.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  })
  return `${day}, ${time}`
}
