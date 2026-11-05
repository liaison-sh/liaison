// SPDX-License-Identifier: FSL-1.1-ALv2
// Recurrence expansion for Google Calendar series, shared by the web calendar (client-side
// expansion of `list_events`) and the API (window filtering, occurrence probes). One
// implementation, so the two sides cannot disagree on which occurrences a series has.
//
// Supported (anything else is "complex": the caller shows the series' own first occurrence):
// - FREQ=DAILY | WEEKLY | MONTHLY | YEARLY with INTERVAL, COUNT and UNTIL
// - WEEKLY with BYDAY=MO,TU,... (plain weekdays) and WKST
// - MONTHLY with one BYMONTHDAY (15, -1) or one ordinal BYDAY (2TU, -1FR)
// - EXDATE lines (UTC, floating with TZID, or VALUE=DATE)
//
// Occurrences keep the series' wall-clock time in its time zone (`start.timeZone`), so a
// 09:00 Europe/Paris meeting stays at 09:00 across daylight-saving changes, and its instants
// match the `originalStartTime` Google stamps on that series' exceptions.

/** Google's `{ date }` (all-day) / `{ dateTime, timeZone }` (timed) event point. */
export interface CalendarPointLike {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

export interface RecurrenceOccurrence {
  start: Date
  end: Date
}

export interface RecurrenceExpansion {
  /** True when the rule is outside the supported subset: `occurrences` is then empty. */
  complex: boolean
  occurrences: RecurrenceOccurrence[]
}

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"

interface ParsedRule {
  freq: Freq
  interval: number
  count?: number
  until?: Date
  /** WEEKLY: the weekdays (0 = SU .. 6 = SA) an occurrence falls on. */
  byDay?: number[]
  /** MONTHLY: one ordinal weekday (2TU = { nth: 2, weekday: 2 }, -1FR = last Friday). */
  monthlyNth?: { nth: number; weekday: number }
  /** MONTHLY: one day of the month (negative counts from the end). */
  byMonthDay?: number
  /** Week start (0 = SU .. 6 = SA), RFC 5545 default MO. */
  wkst: number
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const DAY_MS = 86_400_000
const MAX_PERIODS = 5000

/** A stored point as an instant: `dateTime` as given, an all-day `date` at UTC midnight. */
export function calendarPointToDate(point: unknown): Date | null {
  if (!point || typeof point !== "object") return null
  const p = point as CalendarPointLike
  if (p.dateTime) {
    const d = new Date(p.dateTime)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (p.date) {
    const d = new Date(`${p.date}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

// --- Time zone arithmetic (Intl only, no dependency) -------------------------------------------

interface Wall {
  y: number
  /** 0-based month. */
  mo: number
  d: number
  h: number
  mi: number
  s: number
  ms: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The zone name when Intl knows it, else undefined (the caller then works in UTC). */
function validTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== "string" || !timeZone) return undefined
  try {
    formatterFor(timeZone)
    return timeZone
  } catch {
    return undefined
  }
}

function wallAt(instantMs: number, timeZone: string | undefined): Wall {
  if (!timeZone) {
    const d = new Date(instantMs)
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth(),
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
      ms: d.getUTCMilliseconds(),
    }
  }
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return {
    y: parts.year as number,
    mo: (parts.month as number) - 1,
    d: parts.day as number,
    h: (parts.hour as number) % 24,
    mi: parts.minute as number,
    s: parts.second as number,
    ms: ((instantMs % 1000) + 1000) % 1000,
  }
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const w = wallAt(instantMs, timeZone)
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s, w.ms) - instantMs
}

/**
 * The instant a wall-clock time has in a zone (UTC when no zone), as RFC 5545 reads it: a time
 * repeated by a fall-back change is its FIRST instance, and a time skipped by a spring-forward
 * gap is read with the offset in force before the gap (02:30 becomes 03:30). The candidates are
 * the time read with the offsets a day before and a day after (a zone changes at most once in
 * between).
 */
function wallToInstant(w: Wall, timeZone: string | undefined): number {
  const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s, w.ms)
  if (!timeZone) return asUtc
  const before = asUtc - zoneOffsetMs(asUtc - DAY_MS, timeZone)
  const after = asUtc - zoneOffsetMs(asUtc + DAY_MS, timeZone)
  const matches = (instant: number) => {
    const back = wallAt(instant, timeZone)
    return (
      back.y === w.y &&
      back.mo === w.mo &&
      back.d === w.d &&
      back.h === w.h &&
      back.mi === w.mi &&
      back.s === w.s
    )
  }
  const valid = [before, after].filter(matches)
  if (valid.length > 0) return Math.min(...valid)
  return before
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
}

function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo, d)).getUTCDay()
}

/** Normalises a wall date whose day may overflow (d + n). */
function shiftDays(
  y: number,
  mo: number,
  d: number,
  n: number,
): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo, d + n))
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() }
}

// --- RRULE parsing ------------------------------------------------------------------------------

const ICAL_UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const ICAL_FLOATING = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/
const ICAL_DATE = /^(\d{4})(\d{2})(\d{2})$/

/**
 * An RFC 5545 DATE or DATE-TIME value as an instant: basic UTC (`20210602T215959Z`), floating
 * (`20210602T215959`, read in `timeZone`, UTC when none) or a date (`20210602`, the start of
 * that day, or its last millisecond with `dateAs: "end"`). Extended ISO strings are accepted
 * too. Null when the value cannot be read.
 */
export function parseIcalDateTime(
  value: string,
  timeZone?: string | null,
  dateAs: "start" | "end" = "start",
): Date | null {
  const v = value.trim()
  const zone = validTimeZone(timeZone)
  let m = ICAL_UTC.exec(v)
  if (m) {
    return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!))
  }
  m = ICAL_FLOATING.exec(v)
  if (m) {
    const wall: Wall = {
      y: +m[1]!,
      mo: +m[2]! - 1,
      d: +m[3]!,
      h: +m[4]!,
      mi: +m[5]!,
      s: +m[6]!,
      ms: 0,
    }
    return new Date(wallToInstant(wall, zone))
  }
  m = ICAL_DATE.exec(v)
  if (m) {
    const wall: Wall =
      dateAs === "end"
        ? { y: +m[1]!, mo: +m[2]! - 1, d: +m[3]!, h: 23, mi: 59, s: 59, ms: 999 }
        : { y: +m[1]!, mo: +m[2]! - 1, d: +m[3]!, h: 0, mi: 0, s: 0, ms: 0 }
    return new Date(wallToInstant(wall, zone))
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * The supported subset of an RRULE line, or null when it is outside it ("complex"). `UNTIL`
 * is inclusive; a date-only `UNTIL` covers that whole day in the series' zone.
 */
function parseRule(rrule: string, timeZone: string | undefined): ParsedRule | null {
  const map: Record<string, string> = {}
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    map[part.slice(0, eq).trim().toUpperCase()] = part
      .slice(eq + 1)
      .trim()
      .toUpperCase()
  }
  const freq = map.FREQ
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null
  for (const key of Object.keys(map)) {
    if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"].includes(key)) {
      return null
    }
  }
  const interval = map.INTERVAL ? Number(map.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1) return null
  const rule: ParsedRule = { freq, interval, wkst: WEEKDAYS[map.WKST ?? "MO"] ?? 1 }
  if (map.COUNT) {
    const count = Number(map.COUNT)
    if (!Number.isInteger(count) || count < 0) return null
    rule.count = count
  }
  if (map.UNTIL) {
    const until = parseIcalDateTime(map.UNTIL, timeZone, "end")
    if (!until) return null
    rule.until = until
  }
  if (map.BYMONTHDAY) {
    const day = Number(map.BYMONTHDAY)
    if (freq !== "MONTHLY" || !Number.isInteger(day) || day === 0 || Math.abs(day) > 31) {
      return null
    }
    rule.byMonthDay = day
  }
  if (map.BYDAY) {
    const entries = map.BYDAY.split(",").map((s) => s.trim())
    if (freq === "WEEKLY") {
      const days: number[] = []
      for (const entry of entries) {
        const wd = WEEKDAYS[entry]
        if (wd === undefined) return null
        if (!days.includes(wd)) days.push(wd)
      }
      rule.byDay = days
    } else if (freq === "MONTHLY" && entries.length === 1 && rule.byMonthDay === undefined) {
      const m = /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(entries[0] ?? "")
      if (!m) return null
      rule.monthlyNth = { nth: Number(m[1]), weekday: WEEKDAYS[m[2]!] as number }
    } else {
      return null
    }
  }
  return rule
}

/** The dates (wall, in the series' zone) period `k` of the rule produces, ascending. */
function periodDates(
  rule: ParsedRule,
  base: Wall,
  k: number,
): Array<{ y: number; mo: number; d: number }> {
  switch (rule.freq) {
    case "DAILY":
      return [shiftDays(base.y, base.mo, base.d, k * rule.interval)]
    case "WEEKLY": {
      if (!rule.byDay) return [shiftDays(base.y, base.mo, base.d, 7 * k * rule.interval)]
      const baseDow = weekdayOf(base.y, base.mo, base.d)
      const weekStartOffset = -((baseDow - rule.wkst + 7) % 7) + 7 * k * rule.interval
      return rule.byDay
        .map((wd) => (wd - rule.wkst + 7) % 7)
        .sort((a, b) => a - b)
        .map((off) => shiftDays(base.y, base.mo, base.d, weekStartOffset + off))
    }
    case "MONTHLY": {
      const total = base.mo + k * rule.interval
      const y = base.y + Math.floor(total / 12)
      const mo = ((total % 12) + 12) % 12
      const dim = daysInMonth(y, mo)
      let d: number
      if (rule.monthlyNth) {
        const { nth, weekday } = rule.monthlyNth
        if (nth > 0) {
          d = 1 + ((weekday - weekdayOf(y, mo, 1) + 7) % 7) + (nth - 1) * 7
        } else {
          d = dim - ((weekdayOf(y, mo, dim) - weekday + 7) % 7) + (nth + 1) * 7
        }
      } else if (rule.byMonthDay !== undefined) {
        d = rule.byMonthDay > 0 ? rule.byMonthDay : dim + rule.byMonthDay + 1
      } else {
        d = base.d
      }
      // A month without that day (the 31st, a fifth Tuesday) has no occurrence (RFC 5545).
      return d >= 1 && d <= dim ? [{ y, mo, d }] : []
    }
    case "YEARLY": {
      const y = base.y + k * rule.interval
      return base.d <= daysInMonth(y, base.mo) ? [{ y, mo: base.mo, d: base.d }] : []
    }
  }
}

/** A lower bound on how many occurrences come before period `k` (exact when the rule makes the
 * same number every period: DAILY, WEEKLY). Null when it is not known without walking. */
function occurrencesBeforePeriod(
  rule: ParsedRule,
  base: Wall,
  baseMs: number,
  k: number,
  zone: string | undefined,
): number | null {
  if (k === 0) return 0
  if (rule.freq === "DAILY") return k
  if (rule.freq !== "WEEKLY") return null
  if (!rule.byDay) return k
  const firstWeekBeforeStart = periodDates(rule, base, 0).filter(
    (date) => wallToInstant({ ...base, ...date }, zone) < baseMs,
  ).length
  return k * rule.byDay.length - firstWeekBeforeStart
}

function exdateInstants(recurrence: string[], zone: string | undefined): Set<number> {
  const out = new Set<number>()
  for (const line of recurrence) {
    if (!/^EXDATE[;:]/i.test(line)) continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const params = line.slice(0, colon)
    const tzid = /;TZID=([^;:]+)/i.exec(params)?.[1]
    for (const value of line.slice(colon + 1).split(",")) {
      const at = parseIcalDateTime(value, tzid ?? zone)
      if (at) out.add(at.getTime())
    }
  }
  return out
}

/**
 * The occurrences of a recurring series that overlap [windowStart, windowEnd). `start`/`end`
 * are the series' first occurrence (Google points), `recurrence` its RRULE/EXDATE lines.
 * The walk starts near the window, so a series begun decades before it costs the same as one
 * begun last week. Exceptions (moved or cancelled instances) are the caller's to apply.
 */
export function expandRecurrence(
  series: { start: unknown; end: unknown; recurrence: string[] | null | undefined },
  windowStart: Date,
  windowEnd: Date,
): RecurrenceExpansion {
  const recurrence = (series.recurrence ?? []).filter((l) => typeof l === "string")
  const rruleLine = recurrence.find((l) => /^RRULE:/i.test(l))
  const startDate = calendarPointToDate(series.start)
  const endDate = calendarPointToDate(series.end)
  if (!rruleLine || !startDate || !endDate) return { complex: !rruleLine, occurrences: [] }
  const startPoint = series.start as CalendarPointLike
  const allDay = !startPoint.dateTime && !!startPoint.date
  const zone = allDay ? undefined : validTimeZone(startPoint.timeZone)
  const rule = parseRule(rruleLine, zone)
  if (!rule) return { complex: true, occurrences: [] }

  const baseMs = startDate.getTime()
  const durationMs = endDate.getTime() - baseMs
  const base = wallAt(baseMs, zone)
  const exdates = exdateInstants(recurrence, zone)
  const winStart = windowStart.getTime()
  const winEnd = windowEnd.getTime()

  // Jump to a couple of periods before the window. Period lengths are taken at their longest
  // (31-day months, 366-day years) so the jump never passes the window, and only when the
  // occurrences before the jump can be counted exactly (or no COUNT applies).
  const periodMaxMs =
    {
      DAILY: DAY_MS,
      WEEKLY: 7 * DAY_MS,
      MONTHLY: 31 * DAY_MS,
      YEARLY: 366 * DAY_MS,
    }[rule.freq] * rule.interval
  let k = 0
  let index = 0
  const lead = winStart - durationMs - baseMs
  if (lead > 0) {
    const candidate = Math.max(0, Math.floor(lead / periodMaxMs) - 2)
    const before = occurrencesBeforePeriod(rule, base, baseMs, candidate, zone)
    if (rule.count === undefined || before !== null) {
      k = candidate
      index = before ?? 0
    }
  }

  const occurrences: RecurrenceOccurrence[] = []
  for (let periods = 0; periods < MAX_PERIODS; periods++, k++) {
    let done = false
    for (const date of periodDates(rule, base, k)) {
      const s = wallToInstant({ ...base, ...date }, zone)
      if (s < baseMs) continue
      if (rule.count !== undefined && index >= rule.count) {
        done = true
        break
      }
      if (s >= winEnd || (rule.until && s > rule.until.getTime())) {
        done = true
        break
      }
      index++
      if (exdates.has(s)) continue
      const e = s + durationMs
      if (e > winStart) occurrences.push({ start: new Date(s), end: new Date(e) })
    }
    if (done) break
  }
  return { complex: false, occurrences }
}

/** `YYYY-MM-DD` of an instant in UTC (all-day series live on UTC midnights). */
export function utcDateString(at: Date): string {
  return at.toISOString().slice(0, 10)
}
