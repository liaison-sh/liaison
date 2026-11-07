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
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === "number") return new Date(value)
  if (typeof value === "string" && ISO_DATE.test(value)) {
    // A bare day is that day where the viewer is, not midnight UTC.
    const d = new Date(value.length === 10 ? `${value}T00:00:00` : value)
    return Number.isNaN(d.getTime()) ? null : d
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
    const d = asDate(value)
    return d
      ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })
      : String(value)
  }
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

/** A chart axis label: a day reads as a short date, anything else as it came. */
export function formatAxisLabel(value: unknown, locale: string): string {
  const d = looksLikeDate(value) ? asDate(value) : null
  if (d) return d.toLocaleDateString(locale, { month: "short", day: "numeric" })
  return value === null || value === undefined ? "" : String(value)
}
