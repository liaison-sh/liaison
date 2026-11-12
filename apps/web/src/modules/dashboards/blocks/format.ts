// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a dashboard value reads, in the viewer's language. `percent` takes a
// fraction (0.25 reads 25 %), as Intl does. A value that is not a number under
// a number format is shown as it came: a source's own text is never coerced.
import type { ValueFormat } from "../dashboards-client"

export interface FormatOptions {
  format?: ValueFormat
  currency?: string
  locale: string
  /** The org's time zone: a timestamp reads as that zone's day (a bare day stays as written). */
  timeZone?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** A date and the zone it reads in: a bare day is that day as written (read in UTC). */
function asDate(value: unknown, timeZone?: string): { date: Date; timeZone?: string } | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { date: value, timeZone }
  }
  if (typeof value === "number") return { date: new Date(value), timeZone }
  if (typeof value === "string" && ISO_DATE.test(value)) {
    const bare = value.length === 10
    const d = new Date(bare ? `${value}T00:00:00Z` : value)
    if (Number.isNaN(d.getTime())) return null
    return { date: d, timeZone: bare ? "UTC" : timeZone }
  }
  return null
}

/** A zone Intl knows, else none (the browser's). */
function zone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined
  try {
    new Intl.DateTimeFormat("en", { timeZone })
    return timeZone
  } catch {
    return undefined
  }
}

const MONTH = /^(\d{4})-(\d{2})$/
const QUARTER = /^(\d{4})-Q([1-4])$/

/** "Q4 2026" in English, "T4 2026" in French (trimestre). */
export function quarterLabel(year: string, quarter: string, locale: string): string {
  const lang = locale.toLowerCase().split(/[-_]/)[0]
  const letter = lang === "fr" || lang === "es" || lang === "it" || lang === "pt" ? "T" : "Q"
  return `${letter}${quarter} ${year}`
}

/**
 * A date bucket's label as it reads: a quarter "2026-Q4" (Q4 2026, T4 2026), a month
 * "2026-11" (Nov 2026); null for anything else (a day, a year, a category).
 */
export function bucketLabel(value: unknown, locale: string): string | null {
  if (typeof value !== "string") return null
  const q = QUARTER.exec(value)
  if (q) return quarterLabel(q[1]!, q[2]!, locale)
  const m = MONTH.exec(value)
  if (m) {
    const month = Number(m[2])
    if (month < 1 || month > 12) return null
    return new Date(Date.UTC(Number(m[1]), month - 1, 1)).toLocaleDateString(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    })
  }
  return null
}

/** Does this x value read as a day (`2026-11-07`)? A chart's day axis is formatted as dates. */
export function looksLikeDate(value: unknown): boolean {
  return typeof value === "string" && ISO_DATE.test(value)
}

export function formatValue(value: unknown, opts: FormatOptions): string {
  if (value === null || value === undefined || value === "") return ""
  const { format, locale } = opts
  if (format === "date") {
    const bucket = bucketLabel(value, locale)
    if (bucket) return bucket
    const d = asDate(value, zone(opts.timeZone))
    return d
      ? d.date.toLocaleDateString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          ...(d.timeZone ? { timeZone: d.timeZone } : {}),
        })
      : String(value)
  }
  // A year bucket ("2026") is a label, never "2,026"; a real number stays a number.
  if (!format && typeof value === "string" && /^\d{4}$/.test(value)) return value
  const n = asNumber(value)
  if (n === null) {
    if (typeof value === "boolean") return String(value)
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
  }
  try {
    if (format === "currency" && opts.currency) {
      return new Intl.NumberFormat(locale, { style: "currency", currency: opts.currency }).format(n)
    }
    if (format === "percent") {
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(n)
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n)
  } catch {
    // An unknown currency code: the amount still reads.
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n)
  }
}

/**
 * A chart axis label: a day reads as a short date (a timestamp in the org's zone), a month or a
 * quarter bucket as its period ("Nov 2026", "Q4 2026"), a year as itself, anything else as it came.
 */
export function formatAxisLabel(value: unknown, locale: string, timeZone?: string): string {
  const bucket = bucketLabel(value, locale)
  if (bucket) return bucket
  const d = looksLikeDate(value) ? asDate(value, zone(timeZone)) : null
  if (d) {
    return d.date.toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(d.timeZone ? { timeZone: d.timeZone } : {}),
    })
  }
  return value === null || value === undefined ? "" : String(value)
}
