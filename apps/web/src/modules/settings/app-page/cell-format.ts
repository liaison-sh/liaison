// SPDX-License-Identifier: FSL-1.1-ALv2
// Value formatters of the list block's declared column formats that are not
// labels: a stored timestamp read back as the instant it names, and basis
// points read as a percentage. Kept apart from ListBlock so the cell reads
// stay one pure, tested function each.

/**
 * A stored timestamp as an instant the browser can parse. Postgres text
 * (`2026-10-21 15:13:02.817+00`) has a space for the `T` and an hour-only
 * offset, which not every engine's `Date` accepts; both are normalised to
 * ISO 8601. Anything else passes through unchanged.
 */
export function normaliseTimestamp(v: unknown): string | number | null {
  if (typeof v === "number") return v
  if (typeof v !== "string" || v === "") return null
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      v.trim(),
    )
  if (!m) return v
  const [, day, time, zone] = m
  let tz = zone ?? "Z"
  if (/^[+-]\d{2}$/.test(tz)) tz = `${tz}:00`
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`
  return `${day}T${time}${tz}`
}

/** Basis points as a percentage in the reader's locale: 2000 → "20%" (en), "20 %" (fr). */
export function formatBasisPoints(v: unknown, locale: string): string {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) return v === null || v === undefined ? "" : String(v)
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
    n / 10_000,
  )
}
