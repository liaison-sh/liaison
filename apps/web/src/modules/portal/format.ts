// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How the portal writes money, dates and hours. Hours are only ever a project's
// total: billed time for an hourly or daily project, or a retainer's period
// "so far". There is no per-person, per-task or live figure to write.

import type { Translate } from "~/modules/i18n/i18n-context"

/** A minor-unit amount (a decimal string, never a JS number on the wire) as money. */
export function money(minor: string | null | undefined, currency: string | null, locale: string) {
  if (minor === null || minor === undefined || !/^-?\d+$/.test(minor)) return ""
  const negative = minor.startsWith("-")
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0")
  const value = Number(`${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`)
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency ?? "EUR",
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency ?? ""}`.trim()
  }
}

/** A date or a timestamp as a day, in the person's language. */
export function day(value: string | null | undefined, locale: string): string {
  if (!value) return ""
  const d = value.length === 10 ? noonOf(value) : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(
    d,
  )
}

/** A date-only string at noon local time, so no time zone moves it a day. */
function noonOf(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)
}

export interface ProjectHours {
  kind: "billed" | "so_far" | string
  usedMinutes: number
  ofMinutes: number | null
  period: string | null
}

function hoursOf(minutes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(minutes / 60)
}

/**
 * The one hours line of a project, or null when the project shows none (closed,
 * fixed price, time and budgets off: the server answers no row).
 */
export function hoursLine(h: ProjectHours | null, t: Translate, locale: string): string | null {
  if (!h) return null
  const used = hoursOf(h.usedMinutes, locale)
  if (h.kind === "so_far") {
    return h.ofMinutes
      ? t("portal.project.hours.soFarOf", { used, of: hoursOf(h.ofMinutes, locale) })
      : t("portal.project.hours.soFar", { used })
  }
  if (h.kind === "billed") return t("portal.project.hours.billed", { used })
  return null
}

/** The month a retainer's "so far" counts, named, from its `from/to` period. */
export function periodLabel(period: string | null, locale: string): string | null {
  const from = period?.split("/")[0]
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null
  const d = noonOf(from)
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(d)
}

const DOC_STATES = new Set(["signed", "accepted", "declined", "expired", "withdrawn"])

/**
 * A document's status in the client's words: a voided one was withdrawn by the
 * sender; anything not final reads as waiting.
 */
export function documentState(status: string | null | undefined): string {
  if (status === "voided") return "withdrawn"
  return status && DOC_STATES.has(status) ? status : "waiting"
}
