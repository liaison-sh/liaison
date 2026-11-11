// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Relative dates in a block's source params: a token such as `{{today-30d}}` or
// `{{startOfMonth}}`, written as a whole string value or inside one (a query's
// `BETWEEN '{{today-30d}}' AND '{{today}}'`), is replaced with a YYYY-MM-DD date at
// every run, so a "last 30 days" block keeps rolling instead of freezing on the day it
// was built. A literal date stays that date.
//
// The grammar is closed: an anchor, then at most one signed offset.
//   anchors: today, yesterday, startOfWeek (Monday), startOfMonth, startOfQuarter,
//            startOfYear, endOfWeek (Sunday), endOfMonth, endOfQuarter, endOfYear,
//            range.from, range.to (the dashboard's time range, both days inclusive)
//   offset:  +N or -N with a unit: d (days), w (weeks), M (months), y (years)
// plus date-times without offset, ISO 8601 with the org's UTC offset: range.fromTime (the
// range's first instant), range.toTime (its last second) and range.endExclusive (the first
// instant after the range: midnight of the next day, for a filter written `< end`).
// Dates are the calendar dates of the org's timezone. A month or year offset keeps the
// day and clamps it to the target month's last day (2026-03-31 -1M is 2026-02-28); on an
// endOf anchor it moves the period first, so {{endOfMonth-1M}} is last month's last day.
// Anything else between `{{` and `}}`, or a lone `{{` / `}}`, is a spec problem: refused
// at save and at preview, never passed through to a tool.
//
// The dashboard time range: a preset (last30d, mtd, lastQuarter...) or a custom from..to,
// resolved to a day window in the org's timezone (resolveTimeRange), and its comparison
// window (compareWindow): the same dates a year earlier, or the period just before.

const CALENDAR_ANCHORS = [
  "today",
  "yesterday",
  "startOfWeek",
  "startOfMonth",
  "startOfQuarter",
  "startOfYear",
  "endOfWeek",
  "endOfMonth",
  "endOfQuarter",
  "endOfYear",
] as const
type CalendarAnchor = (typeof CALENDAR_ANCHORS)[number]
type Anchor = CalendarAnchor | "range.from" | "range.to"
type Unit = "d" | "w" | "M" | "y"

const TOKEN = /\{\{([^{}]*)\}\}/g
const TOKEN_BODY = new RegExp(
  `^(${[...CALENDAR_ANCHORS, "range\\.from", "range\\.to"].join("|")})(?:([+-])(\\d{1,4})([dwMy]))?$`,
)
const DATETIME_BODY = /^range\.(fromTime|toTime|endExclusive)$/
const RANGE_TOKEN = /\{\{range\.[^{}]*\}\}/
/** A dashboard filter's value (filters.ts resolves it before the dates): `{{filter.market}}`. */
export const FILTER_TOKEN_BODY = /^filter\.([A-Za-z][A-Za-z0-9_]{0,39})$/
const isFilterToken = (body: string) => FILTER_TOKEN_BODY.test(body)

export const DATE_TOKEN_HELP =
  "a date token is {{today}}, {{yesterday}}, {{startOfWeek}}, {{startOfMonth}}, {{startOfQuarter}}, {{startOfYear}}, {{endOfWeek}}, {{endOfMonth}}, {{endOfQuarter}}, {{endOfYear}}, or the dashboard range {{range.from}} / {{range.to}}, optionally with one offset such as {{today-30d}}, {{startOfMonth-1M}}, {{today+1w}} or {{startOfYear-1y}} (d days, w weeks, M months, y years); {{range.fromTime}} and {{range.toTime}} give the range's first and last second as date-times, {{range.endExclusive}} the first instant after it (filter with < on it)"

/** The presets of a dashboard time range. */
export const TIME_PRESETS = [
  "last7d",
  "last30d",
  "last90d",
  "mtd",
  "lastMonth",
  "qtd",
  "lastQuarter",
  "ytd",
  "lastYear",
  "custom",
] as const
export type TimePreset = (typeof TIME_PRESETS)[number]
export const COMPARE_MODES = ["lastYear", "previousPeriod", "none"] as const
export type CompareMode = (typeof COMPARE_MODES)[number]

/** A dashboard time range: a preset, or `custom` with both days (YYYY-MM-DD, inclusive). */
export interface TimeRange {
  preset: TimePreset
  from?: string
  to?: string
}

/** A resolved window: two calendar days (YYYY-MM-DD), both inclusive, in the org's timezone. */
export interface DayWindow {
  from: string
  to: string
}

/** What a dashboard shows when its spec names no range or comparison (owner decision: last year). */
export const DEFAULT_TIME_RANGE: TimeRange = { preset: "last30d" }
export const DEFAULT_COMPARE: CompareMode = "lastYear"

type ParsedToken =
  | { kind: "date"; anchor: Anchor; offset: number; unit: Unit }
  | { kind: "datetime"; edge: "from" | "to" | "endExclusive" }

function parseToken(body: string): ParsedToken | null {
  const dt = DATETIME_BODY.exec(body)
  if (dt) {
    return {
      kind: "datetime",
      edge: dt[1] === "fromTime" ? "from" : dt[1] === "toTime" ? "to" : "endExclusive",
    }
  }
  const m = TOKEN_BODY.exec(body)
  if (!m) return null
  const sign = m[2] === "-" ? -1 : 1
  return {
    kind: "date",
    anchor: m[1] as Anchor,
    offset: m[3] ? sign * Number(m[3]) : 0,
    unit: (m[4] ?? "d") as Unit,
  }
}

/** A calendar date, months 1-12. */
interface CalendarDate {
  y: number
  m: number
  d: number
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

function fromUtc(t: Date): CalendarDate {
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

function addDays(c: CalendarDate, n: number): CalendarDate {
  return fromUtc(new Date(Date.UTC(c.y, c.m - 1, c.d + n)))
}

function addMonths(c: CalendarDate, n: number): CalendarDate {
  const index = c.y * 12 + (c.m - 1) + n
  const y = Math.floor(index / 12)
  const m = index - y * 12 + 1
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) }
}

const dayNumber = (c: CalendarDate) => Date.UTC(c.y, c.m - 1, c.d) / 86_400_000
const isLastOfMonth = (c: CalendarDate) => c.d === daysInMonth(c.y, c.m)
const endOfMonthOf = (c: CalendarDate): CalendarDate => ({ ...c, d: daysInMonth(c.y, c.m) })

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0")
const format = (c: CalendarDate) => `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`

/** A YYYY-MM-DD string as a calendar date, or null when it is not a real day. */
export function parseDay(s: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (c.m < 1 || c.m > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.m)) return null
  return c
}

/** Today's calendar date in `timeZone` (an IANA name) at `now`. */
export function todayIn(timeZone: string, now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { y: part("year"), m: part("month"), d: part("day") }
}

type Period = "week" | "month" | "quarter" | "year"

function startOf(period: Period, c: CalendarDate): CalendarDate {
  switch (period) {
    case "week": {
      const dow = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay()
      return addDays(c, -((dow + 6) % 7))
    }
    case "month":
      return { ...c, d: 1 }
    case "quarter":
      return { y: c.y, m: c.m - ((c.m - 1) % 3), d: 1 }
    case "year":
      return { y: c.y, m: 1, d: 1 }
  }
}

const PERIOD_MONTHS = { month: 1, quarter: 3, year: 12 } as const

function endOf(period: Period, c: CalendarDate): CalendarDate {
  if (period === "week") return addDays(startOf("week", c), 6)
  return addDays(addMonths(startOf(period, c), PERIOD_MONTHS[period]), -1)
}

function shift(c: CalendarDate, offset: number, unit: Unit): CalendarDate {
  switch (unit) {
    case "d":
      return addDays(c, offset)
    case "w":
      return addDays(c, offset * 7)
    case "M":
      return addMonths(c, offset)
    case "y":
      return addMonths(c, offset * 12)
  }
}

interface TokenContext {
  today: CalendarDate
  range: { from: CalendarDate; to: CalendarDate } | null
  timeZone: string
}

export class DateTokenError extends Error {}

function resolveDate(
  t: Extract<ParsedToken, { kind: "date" }>,
  ctx: TokenContext,
  raw: string,
): string {
  const { anchor, offset, unit } = t
  if (anchor === "range.from" || anchor === "range.to") {
    if (!ctx.range) throw new DateTokenError(`${raw} needs the dashboard's time range`)
    return format(shift(anchor === "range.from" ? ctx.range.from : ctx.range.to, offset, unit))
  }
  if (anchor.startsWith("endOf")) {
    const period = anchor.slice(5).toLowerCase() as Period
    // A month or year offset moves the period, then takes its last day.
    if (unit === "M" || unit === "y") {
      return format(endOf(period, shift(startOf(period, ctx.today), offset, unit)))
    }
    return format(shift(endOf(period, ctx.today), offset, unit))
  }
  const base =
    anchor === "today"
      ? ctx.today
      : anchor === "yesterday"
        ? addDays(ctx.today, -1)
        : startOf(anchor.slice(7).toLowerCase() as Period, ctx.today)
  return format(shift(base, offset, unit))
}

/** The UTC offset of `timeZone` at `instant`, in minutes (Paris in winter: 60). */
function offsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant))
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  )
  return Math.round((local - instant) / 60_000)
}

/** A wall-clock time of the org's zone as ISO 8601 with its offset: `2026-11-01T00:00:00+01:00`. */
function zonedDateTime(c: CalendarDate, time: "00:00:00" | "23:59:59", timeZone: string): string {
  const [h, mi, s] = time.split(":").map(Number) as [number, number, number]
  const wall = Date.UTC(c.y, c.m - 1, c.d, h, mi, s)
  const first = wall - offsetMinutes(timeZone, wall) * 60_000
  let offset = offsetMinutes(timeZone, first)
  let instant = wall - offset * 60_000
  // A wall time the zone skips (a DST change at midnight): the day starts at the change.
  if (offsetMinutes(timeZone, instant) !== offset) {
    instant = first
    offset = offsetMinutes(timeZone, first)
  }
  const local = new Date(instant + offset * 60_000).toISOString().slice(0, 19)
  const sign = offset < 0 ? "-" : "+"
  return `${local}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

function resolveToken(t: ParsedToken, ctx: TokenContext, raw: string): string {
  if (t.kind === "date") return resolveDate(t, ctx, raw)
  if (!ctx.range) throw new DateTokenError(`${raw} needs the dashboard's time range`)
  if (t.edge === "from") return zonedDateTime(ctx.range.from, "00:00:00", ctx.timeZone)
  if (t.edge === "to") return zonedDateTime(ctx.range.to, "23:59:59", ctx.timeZone)
  return zonedDateTime(addDays(ctx.range.to, 1), "00:00:00", ctx.timeZone)
}

/** The problems of one string: each unknown token, or a stray `{{` / `}}`. */
function stringProblems(s: string): string[] {
  if (!s.includes("{{") && !s.includes("}}")) return []
  const out: string[] = []
  for (const m of s.matchAll(TOKEN)) {
    if (!parseToken(m[1]!) && !isFilterToken(m[1]!)) {
      out.push(`unknown date token ${m[0]}: ${DATE_TOKEN_HELP}`)
    }
  }
  const rest = s.replace(TOKEN, "")
  if (rest.includes("{{") || rest.includes("}}")) {
    out.push(`a "{{" or "}}" that is not a whole date token: ${DATE_TOKEN_HELP}`)
  }
  return out
}

function walk(value: unknown, path: string, visit: (s: string, path: string) => void): void {
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key))
  if (typeof value === "string") visit(value, path)
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, at(i), visit)
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, at(k), visit)
  }
}

/** Every date-token problem in `value`, as `path: problem` lines (path prefixed by `prefix`). */
export function dateTokenProblems(value: unknown, prefix: string): string[] {
  const out: string[] = []
  walk(value, prefix, (s, path) => {
    for (const p of stringProblems(s)) out.push(`${path}: ${p}`)
  })
  return out
}

/** Does `value` hold at least one date token anywhere? */
export function hasDateTokens(value: unknown): boolean {
  let found = false
  walk(value, "", (s) => {
    if (!found && s.includes("{{")) found = true
  })
  return found
}

/** Does `value` use the dashboard's time range ({{range.from}}, {{range.toTime}}...)? */
export function hasRangeTokens(value: unknown): boolean {
  let found = false
  walk(value, "", (s) => {
    if (!found && RANGE_TOKEN.test(s)) found = true
  })
  return found
}

/** The distinct date tokens in `value`, in order of appearance (`{{today-30d}}`); filter tokens are not. */
export function dateTokensIn(value: unknown): string[] {
  const seen = new Set<string>()
  walk(value, "", (s) => {
    for (const m of s.matchAll(TOKEN)) if (!isFilterToken(m[1]!)) seen.add(m[0])
  })
  return [...seen]
}

/** The distinct filter ids `value` reads through `{{filter.<id>}}`, in order of appearance. */
export function filterTokensIn(value: unknown): string[] {
  const seen = new Set<string>()
  walk(value, "", (s) => {
    for (const m of s.matchAll(TOKEN)) {
      const f = FILTER_TOKEN_BODY.exec(m[1]!)
      if (f) seen.add(f[1]!)
    }
  })
  return [...seen]
}

/**
 * `value` with every date token replaced by its date in `timeZone` at `now`, the range
 * tokens by `range` (a resolved window); keys and non-string values are kept. Throws
 * DateTokenError on an unknown token (a spec saved before the check, or one that skipped
 * it), and on a range token without a range: an unresolved token never reaches a tool.
 */
export function resolveDateTokens<T>(
  value: T,
  opts: { timeZone: string; now: Date; range?: DayWindow | null },
): T {
  const range = opts.range ? windowDates(opts.range) : null
  const ctx: TokenContext = {
    today: todayIn(opts.timeZone, opts.now),
    range,
    timeZone: opts.timeZone,
  }
  const resolveString = (s: string): string => {
    if (!s.includes("{{") && !s.includes("}}")) return s
    const problems = stringProblems(s)
    if (problems.length) throw new DateTokenError(problems.join("; "))
    return s.replace(TOKEN, (raw, body: string) => {
      const t = parseToken(body)
      // A filter token is resolved before the dates (filters.ts); one left here never reaches a tool.
      if (!t) throw new DateTokenError(`${raw} is a filter token that was not resolved`)
      return resolveToken(t, ctx, raw)
    })
  }
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return resolveString(v)
    if (Array.isArray(v)) return v.map(visit)
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]))
    }
    return v
  }
  return visit(value) as T
}

function windowDates(w: DayWindow): { from: CalendarDate; to: CalendarDate } {
  const from = parseDay(w.from)
  const to = parseDay(w.to)
  if (!from || !to) throw new DateTokenError(`the time range ${w.from}..${w.to} is not two days`)
  return { from, to }
}

/** The problems of a time range as written (a spec's default, a viewer's choice). */
export function timeRangeProblems(tr: TimeRange): string[] {
  if (tr.preset !== "custom") {
    return tr.from !== undefined || tr.to !== undefined
      ? [`from and to go with the preset "custom" only, not "${tr.preset}"`]
      : []
  }
  if (tr.from === undefined || tr.to === undefined) {
    return ['a "custom" time range needs from and to (YYYY-MM-DD)']
  }
  const from = parseDay(tr.from)
  const to = parseDay(tr.to)
  const out: string[] = []
  if (!from) out.push(`from '${tr.from}' is not a day (YYYY-MM-DD)`)
  if (!to) out.push(`to '${tr.to}' is not a day (YYYY-MM-DD)`)
  if (from && to && dayNumber(from) > dayNumber(to)) out.push("from is after to")
  return out
}

/** A time range as the days it covers today, in `timeZone` at `now`. */
export function resolveTimeRange(tr: TimeRange, opts: { timeZone: string; now: Date }): DayWindow {
  const today = todayIn(opts.timeZone, opts.now)
  const win = (from: CalendarDate, to: CalendarDate): DayWindow => ({
    from: format(from),
    to: format(to),
  })
  switch (tr.preset) {
    case "last7d":
      return win(addDays(today, -6), today)
    case "last30d":
      return win(addDays(today, -29), today)
    case "last90d":
      return win(addDays(today, -89), today)
    case "mtd":
      return win(startOf("month", today), today)
    case "lastMonth": {
      const start = addMonths(startOf("month", today), -1)
      return win(start, endOf("month", start))
    }
    case "qtd":
      return win(startOf("quarter", today), today)
    case "lastQuarter": {
      const start = addMonths(startOf("quarter", today), -3)
      return win(start, endOf("quarter", start))
    }
    case "ytd":
      return win(startOf("year", today), today)
    case "lastYear": {
      const start = { y: today.y - 1, m: 1, d: 1 }
      return win(start, endOf("year", start))
    }
    case "custom": {
      const problems = timeRangeProblems(tr)
      if (problems.length) throw new DateTokenError(problems.join("; "))
      return { from: tr.from!, to: tr.to! }
    }
  }
}

/** Both ends moved by `months`; an end on its month's last day stays on the last day. */
function shiftWindowMonths(w: { from: CalendarDate; to: CalendarDate }, months: number): DayWindow {
  const to = addMonths(w.to, months)
  return {
    from: format(addMonths(w.from, months)),
    to: format(isLastOfMonth(w.to) ? endOfMonthOf(to) : to),
  }
}

const CALENDAR_STEP: Partial<Record<TimePreset, number>> = {
  mtd: 1,
  lastMonth: 1,
  qtd: 3,
  lastQuarter: 3,
  ytd: 12,
  lastYear: 12,
}

/**
 * The window a range is compared with: `lastYear` the same days a year earlier (a calendar
 * preset keeps its month ends; a rolling or custom range keeps its number of days);
 * `previousPeriod` the month, quarter or year before for a calendar preset (the same
 * day span: month to date Nov 1-11 compares with Oct 1-11), else the equal-length span
 * just before. `none`: null.
 */
export function compareWindow(
  preset: TimePreset,
  window: DayWindow,
  mode: CompareMode,
): DayWindow | null {
  if (mode === "none") return null
  const w = windowDates(window)
  const step = CALENDAR_STEP[preset]
  const days = dayNumber(w.to) - dayNumber(w.from) + 1
  if (mode === "lastYear") {
    if (step) return shiftWindowMonths(w, -12)
    // A rolling or custom range keeps its length (29 Feb is no reason for a 6- or 8-day week).
    const from = addMonths(w.from, -12)
    return { from: format(from), to: format(addDays(from, days - 1)) }
  }
  if (step) return shiftWindowMonths(w, -step)
  return { from: format(addDays(w.from, -days)), to: format(addDays(w.from, -1)) }
}
