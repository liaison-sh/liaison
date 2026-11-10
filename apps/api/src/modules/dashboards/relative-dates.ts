// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Relative dates in a block's source params: a token such as `{{today-30d}}` or
// `{{startOfMonth}}`, written as a whole string value or inside one (a query's
// `BETWEEN '{{today-30d}}' AND '{{today}}'`), is replaced with a YYYY-MM-DD date at
// every run, so a "last 30 days" block keeps rolling instead of freezing on the day it
// was built. A literal date stays that date.
//
// The grammar is closed: an anchor, then at most one signed offset.
//   anchors: today, startOfWeek (Monday), startOfMonth, startOfYear
//   offset:  +N or -N with a unit: d (days), w (weeks), M (months), y (years)
// Dates are the calendar dates of the org's timezone. A month or year offset keeps the
// day and clamps it to the target month's last day (2026-03-31 -1M is 2026-02-28).
// Anything else between `{{` and `}}`, or a lone `{{` / `}}`, is a spec problem: refused
// at save and at preview, never passed through to a tool.

const ANCHORS = ["today", "startOfWeek", "startOfMonth", "startOfYear"] as const
type Anchor = (typeof ANCHORS)[number]
type Unit = "d" | "w" | "M" | "y"

const TOKEN = /\{\{([^{}]*)\}\}/g
const TOKEN_BODY = /^(today|startOfWeek|startOfMonth|startOfYear)(?:([+-])(\d{1,4})([dwMy]))?$/

export const DATE_TOKEN_HELP =
  "a date token is {{today}}, {{startOfWeek}}, {{startOfMonth}} or {{startOfYear}}, optionally with one offset such as {{today-30d}}, {{startOfMonth-1M}}, {{today+1w}} or {{startOfYear-1y}} (d days, w weeks, M months, y years)"

interface ParsedToken {
  anchor: Anchor
  offset: number
  unit: Unit
}

function parseToken(body: string): ParsedToken | null {
  const m = TOKEN_BODY.exec(body)
  if (!m) return null
  const sign = m[2] === "-" ? -1 : 1
  return {
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

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
const format = (c: CalendarDate) => `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`

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

function anchorDate(anchor: Anchor, today: CalendarDate): CalendarDate {
  switch (anchor) {
    case "today":
      return today
    case "startOfWeek": {
      const dow = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay()
      return addDays(today, -((dow + 6) % 7))
    }
    case "startOfMonth":
      return { ...today, d: 1 }
    case "startOfYear":
      return { y: today.y, m: 1, d: 1 }
  }
}

function resolveToken(t: ParsedToken, today: CalendarDate): string {
  const base = anchorDate(t.anchor, today)
  switch (t.unit) {
    case "d":
      return format(addDays(base, t.offset))
    case "w":
      return format(addDays(base, t.offset * 7))
    case "M":
      return format(addMonths(base, t.offset))
    case "y":
      return format(addMonths(base, t.offset * 12))
  }
}

/** The problems of one string: each unknown token, or a stray `{{` / `}}`. */
function stringProblems(s: string): string[] {
  if (!s.includes("{{") && !s.includes("}}")) return []
  const out: string[] = []
  for (const m of s.matchAll(TOKEN)) {
    if (!parseToken(m[1]!)) out.push(`unknown date token ${m[0]}: ${DATE_TOKEN_HELP}`)
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

/** The distinct tokens in `value`, in order of appearance (`{{today-30d}}`). */
export function dateTokensIn(value: unknown): string[] {
  const seen = new Set<string>()
  walk(value, "", (s) => {
    for (const m of s.matchAll(TOKEN)) seen.add(m[0])
  })
  return [...seen]
}

export class DateTokenError extends Error {}

/**
 * `value` with every date token replaced by its date in `timeZone` at `now`; keys and
 * non-string values are kept. Throws DateTokenError on an unknown token (a spec saved
 * before the check, or one that skipped it): an unresolved token never reaches a tool.
 */
export function resolveDateTokens<T>(value: T, opts: { timeZone: string; now: Date }): T {
  const today = todayIn(opts.timeZone, opts.now)
  const resolveString = (s: string): string => {
    if (!s.includes("{{") && !s.includes("}}")) return s
    const problems = stringProblems(s)
    if (problems.length) throw new DateTokenError(problems.join("; "))
    return s.replace(TOKEN, (_, body: string) => resolveToken(parseToken(body)!, today))
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
