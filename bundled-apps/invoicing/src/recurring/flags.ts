// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The facts a month-end row shows beside its amounts: whether this period bills what the last one
// billed, whether the last invoice is still unpaid, whether this is the first. Each flag is read
// from stored data with plain comparisons, never from a model.

export interface PreviousInvoice {
  /** The previous period's key, `2026-10`, `2026-Q3` or `2026`. */
  period_key: string | null
  /** What the previous invoice billed, before tax, in minor units. */
  net_minor: bigint
  /** The billed lines' description, quantity, price and rate, in order. */
  lines_signature: string
  payment_status: string | null
}

export interface CurrentDraft {
  net_minor: bigint
  lines_signature: string
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** How a row names a period: `October`, `Q3 2026`, `2026`. */
export function periodName(periodKey: string | null): string {
  if (!periodKey) return "the last period"
  const month = /^(\d{4})-(\d{2})$/.exec(periodKey)
  if (month) return MONTHS[Number(month[2]) - 1] ?? periodKey
  const quarter = /^(\d{4})-Q([1-4])$/.exec(periodKey)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  return periodKey
}

/** How a line's `{period}` reads: `November 2026`, `Q4 2026`, `2026`. */
export function periodLabel(periodKey: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(periodKey)
  if (month) return `${MONTHS[Number(month[2]) - 1]} ${month[1]}`
  const quarter = /^(\d{4})-Q([1-4])$/.exec(periodKey)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  return periodKey
}

/** One canonical string per line set, so two periods compare by value. */
export function linesSignature(
  lines: Array<{ description?: unknown; quantity?: unknown; unit_price_minor?: unknown; tax_rate_bp?: unknown }>,
): string {
  return JSON.stringify(
    lines.map((l) => [String(l.description ?? ""), String(l.quantity ?? ""), String(l.unit_price_minor ?? ""), l.tax_rate_bp ?? null]),
  )
}

/** The flags of one row, in the order a person reads them. */
export function runItemFlags(previous: PreviousInvoice | null, current: CurrentDraft): string[] {
  if (!previous) return ["First invoice"]
  const name = periodName(previous.period_key)
  const flags: string[] = []
  const same = previous.lines_signature === current.lines_signature && previous.net_minor === current.net_minor
  flags.push(same ? `Same as ${name}` : `Changed since ${name}`)
  if (previous.payment_status !== "paid") flags.push(`${name} is still unpaid`)
  return flags
}
