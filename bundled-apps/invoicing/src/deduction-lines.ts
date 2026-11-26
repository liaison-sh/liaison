// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a final invoice words the advances it deducts: one line per advance and VAT rate, each
// citing the advance's number and date. Pure, so the draft and every screen that shows a
// deduction (the advance's own page included) read the same lines from the same function.

type Row = Record<string, unknown>

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const asBig = (v: unknown): bigint => {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v))
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return 0n
}

/** "16 Apr 2026" for a YYYY-MM-DD day, or an ISO instant's day. */
export function shortDate(day: unknown): string {
  const s = typeof day === "string" ? day.slice(0, 10) : ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return s
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

export interface DeductionLine {
  advanceDocumentId: string
  advanceNumber: string
  advanceDate: string
  /** YYYY-MM-DD, the advance's issue day. */
  advanceIssuedOn: string
  taxRateBp: number
  /** Excl. VAT, positive: the amount the line takes off. */
  amountMinor: number
  description: string
}

/**
 * The deduction lines of a final invoice: one per advance and VAT rate, each citing the advance's
 * number and date, from the advance's own issued lines. The one place a deduction is worded, used
 * by the draft and by every screen that shows it.
 */
export function renderDeductionLines(advances: Array<{ doc: Row; lines: Row[] }>): DeductionLine[] {
  const out: DeductionLine[] = []
  for (const { doc, lines } of advances) {
    const byRate = new Map<number, bigint>()
    for (const l of lines) {
      const rate = Number(l.tax_rate_bp ?? 0)
      byRate.set(rate, (byRate.get(rate) ?? 0n) + asBig(l.subtotal_minor))
    }
    const number = String(doc.number ?? doc.id)
    const date = shortDate(doc.issued_at)
    const rates = [...byRate.keys()].sort((a, b) => b - a)
    for (const rate of rates) {
      const amount = byRate.get(rate) ?? 0n
      if (amount <= 0n) continue
      out.push({
        advanceDocumentId: String(doc.id),
        advanceNumber: number,
        advanceDate: date,
        advanceIssuedOn: typeof doc.issued_at === "string" ? doc.issued_at.slice(0, 10) : "",
        taxRateBp: rate,
        amountMinor: Number(amount),
        description:
          rates.length > 1
            ? `Advance invoice ${number} of ${date}, VAT ${rate / 100}%`
            : `Advance invoice ${number} of ${date}`,
      })
    }
  }
  return out
}
