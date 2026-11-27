// SPDX-License-Identifier: FSL-1.1-ALv2
// The repeat rule the event tab edits: frequency, interval, weekdays (weekly), and how it ends
// (never, on a date, after a number of times), read from and written to one RRULE line. A rule
// this editor cannot show (BYSETPOS, several monthly days...) reads as null: the tab keeps it as
// it is and says so instead of rewriting it.

export type RepeatFreq = "none" | "daily" | "weekly" | "monthly" | "yearly"
export type RepeatEnd =
  | { kind: "never" }
  | { kind: "until"; date: string }
  | { kind: "count"; count: number }

export interface RepeatRule {
  freq: RepeatFreq
  interval: number
  /** Weekly: the weekdays, "MO".."SU". */
  byDay: string[]
  end: RepeatEnd
}

export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const

export const NO_REPEAT: RepeatRule = {
  freq: "none",
  interval: 1,
  byDay: [],
  end: { kind: "never" },
}

/** The rule of a recurrence list, NO_REPEAT for none, null when this editor cannot show it. */
export function parseRepeat(recurrence: string[] | null | undefined): RepeatRule | null {
  const lines = (recurrence ?? []).filter((l) => typeof l === "string")
  const rrule = lines.find((l) => /^RRULE:/i.test(l))
  if (!rrule) return lines.length === 0 ? NO_REPEAT : null
  const parts: Record<string, string> = {}
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=")
    if (k && v) parts[k.trim().toUpperCase()] = v.trim().toUpperCase()
  }
  const freq = parts.FREQ?.toLowerCase()
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly" && freq !== "yearly") return null
  for (const key of Object.keys(parts)) {
    if (!["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT", "WKST"].includes(key)) return null
  }
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1) return null
  const byDay = parts.BYDAY ? parts.BYDAY.split(",") : []
  if (
    byDay.length > 0 &&
    (freq !== "weekly" || byDay.some((d) => !(WEEKDAY_CODES as readonly string[]).includes(d)))
  ) {
    return null
  }
  let end: RepeatEnd = { kind: "never" }
  if (parts.COUNT) {
    const count = Number(parts.COUNT)
    if (!Number.isInteger(count) || count < 1) return null
    end = { kind: "count", count }
  } else if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL)
    if (!m) return null
    end = { kind: "until", date: `${m[1]}-${m[2]}-${m[3]}` }
  }
  return { freq, interval, byDay, end }
}

/**
 * The RRULE line for a rule (undefined for no repeat). An end date covers that whole day: a
 * timed series gets UNTIL at the day's last second in UTC, an all-day one the date itself.
 */
export function buildRepeat(rule: RepeatRule, allDay: boolean): string[] | undefined {
  if (rule.freq === "none") return undefined
  const parts = [`FREQ=${rule.freq.toUpperCase()}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.freq === "weekly" && rule.byDay.length > 0) {
    const ordered = WEEKDAY_CODES.filter((d) => rule.byDay.includes(d))
    parts.push(`BYDAY=${ordered.join(",")}`)
  }
  if (rule.end.kind === "count") parts.push(`COUNT=${rule.end.count}`)
  if (rule.end.kind === "until") {
    const day = rule.end.date.replace(/-/g, "")
    parts.push(allDay ? `UNTIL=${day}` : `UNTIL=${day}T235959Z`)
  }
  return [`RRULE:${parts.join(";")}`]
}

/** The other lines of a recurrence (EXDATE, RDATE) an edit of the rule keeps. */
export function withRule(
  recurrence: string[] | null | undefined,
  rule: string[] | undefined,
): string[] {
  const rest = (recurrence ?? []).filter((l) => !/^RRULE:/i.test(l))
  return rule ? [...rule, ...rest] : []
}
