// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The destination country as its own column (To prepare and Ready to ship): the ISO-2 code in the
// cell, the country's name on hover, a sort and a filter. Shipping decisions split on it all day
// (EU or not, customs paperwork, which carrier), and a code tucked under the customer's name was
// easy to miss. Pure helpers, so both lists sort and filter the same way.

/** "FR" -> "France", in the viewer's language; the code itself when the name is unknown. */
export function countryName(iso2: string | null | undefined, locale?: string): string {
  const code = (iso2 ?? "").trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return code
  try {
    const names = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "region" })
    return names.of(code) ?? code
  } catch {
    return code
  }
}

/** The distinct countries of a list, sorted, blanks left out (the filter's options). */
export function countryOptions(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>()
  for (const v of values) {
    const code = (v ?? "").trim().toUpperCase()
    if (code) set.add(code)
  }
  return [...set].sort()
}

/** Whether a row's country passes the filter ("" lets every row through). */
export function matchesCountry(value: string | null | undefined, filter: string): boolean {
  if (!filter) return true
  return (value ?? "").trim().toUpperCase() === filter.trim().toUpperCase()
}

/** Country order; a row with no country sorts last in either direction (unknown, not "A"). */
export function compareCountry(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: "asc" | "desc",
): number {
  const x = (a ?? "").trim().toUpperCase()
  const y = (b ?? "").trim().toUpperCase()
  if (!x && !y) return 0
  if (!x) return 1
  if (!y) return -1
  return (dir === "asc" ? 1 : -1) * x.localeCompare(y)
}

/** A stable sort by country (rows of one country keep their order: oldest request first). */
export function sortByCountry<T>(
  rows: T[],
  countryOf: (row: T) => string | null | undefined,
  dir: "asc" | "desc" | null,
): T[] {
  if (!dir) return rows
  return rows
    .map((row, i) => ({ row, i }))
    .sort((p, q) => compareCountry(countryOf(p.row), countryOf(q.row), dir) || p.i - q.i)
    .map((p) => p.row)
}

/** Header click cycling, as on the prep grid: ascending, descending, then back to the list order. */
export function nextCountrySort(current: "asc" | "desc" | null): "asc" | "desc" | null {
  if (current === null) return "asc"
  if (current === "asc") return "desc"
  return null
}
