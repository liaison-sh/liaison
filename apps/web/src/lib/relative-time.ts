// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The one compact relative-time formatter: "5m ago" / "il y a 5 min".
 *
 * Surfaces used to build "5m ago", "2h ago", "11w ago" by hand, so a French
 * reader got "mise à jour 11w ago" and "il y a 11w ago" (a translated
 * template around an English figure). The whole phrase comes from
 * `Intl.RelativeTimeFormat` in the reader's locale here, which owns every
 * language's wording; callers never glue "ago" or "il y a" around it.
 */

type Unit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year"

const STEPS: Array<[Unit, number]> = [
  ["minute", 60],
  ["hour", 3600],
  ["day", 86_400],
  ["week", 86_400 * 7],
  ["month", 86_400 * 30],
  ["year", 86_400 * 365],
]

/**
 * One phrase, as narrow as the locale can say it and still be a phrase.
 * English narrow is the compact form the product always used ("5h ago");
 * French narrow is a signed quantity ("-5 h") that reads as minus five hours,
 * so a narrow form carrying a minus sign falls back to the short form.
 */
function phrase(locale: string, value: number, unit: Unit): string {
  const narrow = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" }).format(
    value,
    unit,
  )
  if (!/[-+−]/.test(narrow)) return narrow
  // Signed: French short months and years ("2 m.", "1 a") read as minutes
  // and nothing, so those two units take the long form.
  const style = unit === "month" || unit === "year" ? "long" : "short"
  return new Intl.RelativeTimeFormat(locale, { numeric: "always", style }).format(value, unit)
}

/** "now" in the locale ("now", "maintenant"). */
export function justNow(locale: string): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second")
}

function toMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(t) ? null : t
}

function pickUnit(absSeconds: number): { unit: Unit; n: number } {
  let unit: Unit = "minute"
  let size = 60
  for (const [u, s] of STEPS) {
    if (absSeconds >= s) {
      unit = u
      size = s
    }
  }
  return { unit, n: Math.floor(absSeconds / size) }
}

/**
 * Relative time from `value` to `now`, past or future: "5m ago" /
 * "il y a 5 min" (compact, the default) or "5 minutes ago" /
 * "il y a 5 minutes" (`style: "long"`). Invalid or missing input answers ""
 * so a caller can fall back to its own placeholder.
 */
export function relativeTime(
  value: string | number | Date | null | undefined,
  locale: string,
  opts: { now?: Date; style?: "compact" | "long" } = {},
): string {
  const t = toMs(value)
  if (t === null) return ""
  const now = opts.now ?? new Date()
  const diff = (t - now.getTime()) / 1000 // negative = past
  if (Math.abs(diff) < 60) return justNow(locale)
  const { unit, n } = pickUnit(Math.abs(diff))
  const signed = diff < 0 ? -n : n
  if (opts.style === "long") {
    return new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" }).format(
      signed,
      unit,
    )
  }
  return phrase(locale, signed, unit)
}

/**
 * A bare age for dense lists ("5m", "2h", "3d" / "5 min", "2 h", "3 j"),
 * "now" under a minute and "yesterday" at one day, in the locale's words.
 * Past a week it is a short date. "" for invalid input.
 */
export function compactAge(
  value: string | number | Date | null | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  const t = toMs(value)
  if (t === null) return ""
  const seconds = Math.max(0, (now.getTime() - t) / 1000)
  if (seconds < 60) return justNow(locale)
  const { unit, n } = pickUnit(seconds)
  if (unit === "day" && n === 1) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day")
  }
  if (unit === "minute" || unit === "hour" || unit === "day") {
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(n)
  }
  return new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" })
}

/** Capitalise the first letter ("yesterday" -> "Yesterday", "hier" -> "Hier"). */
export function capitalize(text: string): string {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text
}

/**
 * A calendar day ("2026-07-05", or the day part of a timestamp) in the
 * locale's words: "5 juil." / "Jul 5" by default. Projects printed raw ISO
 * days and "09-30" slices; a YYYY-MM-DD is read as a LOCAL day so it never
 * shifts by one across a timezone.
 */
export function formatDay(
  value: string | null | undefined,
  locale: string,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
): string {
  if (!value) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(locale, opts)
}

/**
 * An instant as the reader reads a date and time everywhere else: in their
 * locale's words and THEIR time zone ("Sep 28, 2026, 11:03 PM" /
 * "28 sept. 2026, 23:03"). "" for invalid input.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  const t = toMs(value)
  if (t === null) return ""
  return new Intl.DateTimeFormat(locale, opts).format(t)
}
