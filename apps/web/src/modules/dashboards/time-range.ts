// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD TIME RANGE, as the web app handles it: the presets and compare
// modes the server knows, the choice in a URL (`?range=&from=&to=&compare=`),
// which choice a dashboard opens on (the link's, else the person's saved one,
// else the dashboard's default), and how a window reads ("1–11 Nov 2026").
//
// The server resolves every window itself (in the org's time zone) and returns
// it with each block's data; `resolveTimeRange` and `compareWindowOf` mirror its
// rules only so the label reads right before the first block answers.

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

export interface TimeRange {
  preset: TimePreset
  /** YYYY-MM-DD, only (and both) for `custom`. */
  from?: string
  to?: string
}

/** Two days, YYYY-MM-DD, both inclusive. */
export interface DayWindow {
  from: string
  to: string
}

/** What a viewer looks at: a range and what it is compared with. */
export interface RangeChoice {
  timeRange: TimeRange
  compare: CompareMode
}

/** The server's defaults when a dashboard names none (owner: compare with last year). */
export const DEFAULT_CHOICE: RangeChoice = { timeRange: { preset: "last30d" }, compare: "lastYear" }

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

interface CalendarDate {
  y: number
  m: number
  d: number
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function parseDay(s: string | null | undefined): CalendarDate | null {
  const m = s ? DAY.exec(s) : null
  if (!m) return null
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (c.m < 1 || c.m > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.m)) return null
  return c
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
const format = (c: CalendarDate) => `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`
const fromUtc = (t: Date): CalendarDate => ({
  y: t.getUTCFullYear(),
  m: t.getUTCMonth() + 1,
  d: t.getUTCDate(),
})
const addDays = (c: CalendarDate, n: number) => fromUtc(new Date(Date.UTC(c.y, c.m - 1, c.d + n)))
function addMonths(c: CalendarDate, n: number): CalendarDate {
  const index = c.y * 12 + (c.m - 1) + n
  const y = Math.floor(index / 12)
  const m = index - y * 12 + 1
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) }
}
const dayNumber = (c: CalendarDate) => Date.UTC(c.y, c.m - 1, c.d) / 86_400_000
const quarterStart = (c: CalendarDate): CalendarDate => ({ y: c.y, m: c.m - ((c.m - 1) % 3), d: 1 })

/** Today in the viewer's own calendar. */
export function localToday(now: Date = new Date()): string {
  return format({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() })
}

/** Is this a range the server accepts (a known preset; custom with two days in order)? */
export function isValidTimeRange(tr: TimeRange): boolean {
  if (!(TIME_PRESETS as readonly string[]).includes(tr.preset)) return false
  if (tr.preset !== "custom") return tr.from === undefined && tr.to === undefined
  const from = parseDay(tr.from)
  const to = parseDay(tr.to)
  return !!from && !!to && dayNumber(from) <= dayNumber(to)
}

/** The days a range covers, `today` being YYYY-MM-DD. */
export function resolveTimeRange(tr: TimeRange, today: string): DayWindow {
  const t = parseDay(today) ?? parseDay(localToday())!
  const win = (from: CalendarDate, to: CalendarDate) => ({ from: format(from), to: format(to) })
  switch (tr.preset) {
    case "last7d":
      return win(addDays(t, -6), t)
    case "last30d":
      return win(addDays(t, -29), t)
    case "last90d":
      return win(addDays(t, -89), t)
    case "mtd":
      return win({ ...t, d: 1 }, t)
    case "lastMonth": {
      const start = addMonths({ ...t, d: 1 }, -1)
      return win(start, { ...start, d: daysInMonth(start.y, start.m) })
    }
    case "qtd":
      return win(quarterStart(t), t)
    case "lastQuarter": {
      const start = addMonths(quarterStart(t), -3)
      const end = addMonths(start, 2)
      return win(start, { ...end, d: daysInMonth(end.y, end.m) })
    }
    case "ytd":
      return win({ y: t.y, m: 1, d: 1 }, t)
    case "lastYear":
      return win({ y: t.y - 1, m: 1, d: 1 }, { y: t.y - 1, m: 12, d: 31 })
    case "custom":
      return { from: tr.from ?? today, to: tr.to ?? today }
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

function shiftMonths(w: DayWindow, months: number): DayWindow {
  const from = parseDay(w.from)!
  const to = parseDay(w.to)!
  const shifted = addMonths(to, months)
  const lastDay = to.d === daysInMonth(to.y, to.m)
  return {
    from: format(addMonths(from, months)),
    to: format(lastDay ? { ...shifted, d: daysInMonth(shifted.y, shifted.m) } : shifted),
  }
}

/** The window a range is compared with (the server's rule), or null for `none`. */
export function compareWindowOf(
  preset: TimePreset,
  window: DayWindow,
  mode: CompareMode,
): DayWindow | null {
  if (mode === "none" || !parseDay(window.from) || !parseDay(window.to)) return null
  if (mode === "lastYear") return shiftMonths(window, -12)
  const step = CALENDAR_STEP[preset]
  if (step) return shiftMonths(window, -step)
  const from = parseDay(window.from)!
  const days = dayNumber(parseDay(window.to)!) - dayNumber(from) + 1
  return { from: format(addDays(from, -days)), to: format(addDays(from, -1)) }
}

/** The same choice? (Used to tell a person's pick from the one already shown.) */
export function sameChoice(a: RangeChoice | null, b: RangeChoice | null): boolean {
  if (!a || !b) return a === b
  return (
    a.compare === b.compare &&
    a.timeRange.preset === b.timeRange.preset &&
    (a.timeRange.from ?? "") === (b.timeRange.from ?? "") &&
    (a.timeRange.to ?? "") === (b.timeRange.to ?? "")
  )
}

/** A stable key for a choice: blocks re-read when it changes. */
export function choiceKey(c: RangeChoice): string {
  const tr = c.timeRange
  return tr.preset === "custom"
    ? `custom:${tr.from}:${tr.to}:${c.compare}`
    : `${tr.preset}:${c.compare}`
}

/** What a link carries: the parts of a choice found in a query string, each checked. */
export function choiceFromQuery(search: string): Partial<RangeChoice> {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const out: Partial<RangeChoice> = {}
  const range = q.get("range")
  const from = q.get("from") ?? undefined
  const to = q.get("to") ?? undefined
  const custom = range === "custom" || (range === null && (from !== undefined || to !== undefined))
  const tr: TimeRange | null = custom
    ? { preset: "custom", from, to }
    : range
      ? { preset: range as TimePreset }
      : null
  if (tr && isValidTimeRange(tr)) out.timeRange = tr
  const compare = q.get("compare")
  if (compare && (COMPARE_MODES as readonly string[]).includes(compare)) {
    out.compare = compare as CompareMode
  }
  return out
}

/** A choice as query parameters (`range`, `from`, `to` for custom, `compare`). */
export function choiceToParams(c: RangeChoice): URLSearchParams {
  const q = new URLSearchParams()
  q.set("range", c.timeRange.preset)
  if (c.timeRange.preset === "custom") {
    q.set("from", c.timeRange.from ?? "")
    q.set("to", c.timeRange.to ?? "")
  }
  q.set("compare", c.compare)
  return q
}

/** `path` with the choice's parameters in place of any it had. Other parameters stay. */
export function withChoiceInPath(path: string, c: RangeChoice): string {
  const [base, query = ""] = path.split("?", 2)
  const q = new URLSearchParams(query)
  for (const k of ["range", "from", "to", "compare"]) q.delete(k)
  for (const [k, v] of choiceToParams(c)) q.set(k, v)
  return `${base}?${q.toString()}`
}

/** `path` without any range parameters (back to the remembered or default range). */
export function withoutChoiceInPath(path: string): string {
  const [base, query = ""] = path.split("?", 2)
  const q = new URLSearchParams(query)
  for (const k of ["range", "from", "to", "compare"]) q.delete(k)
  const rest = q.toString()
  return rest ? `${base}?${rest}` : base
}

/** The query part of a path ("" when none). */
export function queryOf(path: string | undefined): string {
  const i = path?.indexOf("?") ?? -1
  return i >= 0 ? path!.slice(i + 1) : ""
}

/**
 * The choice a dashboard opens on: each part from the link when it carries a valid one, else
 * from the person's saved choice (the server's `range`, which is already the dashboard's
 * default when they saved none), else the defaults.
 */
export function initialChoice(
  fromUrl: Partial<RangeChoice>,
  saved: RangeChoice | null | undefined,
): RangeChoice {
  const base = saved ?? DEFAULT_CHOICE
  return {
    timeRange: fromUrl.timeRange ?? base.timeRange,
    compare: fromUrl.compare ?? base.compare,
  }
}

const utc = (s: string) => {
  const c = parseDay(s)
  return c ? new Date(Date.UTC(c.y, c.m - 1, c.d)) : null
}

/** One day, short: "11 Nov 2026" (the year left out when `withYear` is false). */
export function formatDay(day: string, locale: string, withYear = true): string {
  const d = utc(day)
  if (!d) return day
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
}

/** A window as it reads: "1–11 Nov 2026" (the locale's own range form). */
export function formatWindow(w: DayWindow, locale: string): string {
  const from = utc(w.from)
  const to = utc(w.to)
  if (!from || !to) return `${w.from} – ${w.to}`
  const fmt = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
  const range = (fmt as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string })
    .formatRange
  if (typeof range === "function") return range.call(fmt, from, to)
  return w.from === w.to ? fmt.format(from) : `${fmt.format(from)} – ${fmt.format(to)}`
}

/**
 * The change from `previous` to `value`, as a fraction ((value - previous) / |previous|).
 * Null when there is nothing to compare: no previous value, a previous 0, a missing value.
 */
export function deltaOf(value: unknown, previous: unknown): number | null {
  if (typeof value !== "number" || typeof previous !== "number") return null
  if (!Number.isFinite(value) || !Number.isFinite(previous) || previous === 0) return null
  return (value - previous) / Math.abs(previous)
}
