// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Grouping rollups for the unified Documents view. The standalone All-sales /
// B2B / By-market dashboards were collapsed into one Documents view with a
// "Group by" switch; their rollup logic lives here (pure, unit-testable) and is
// shared with the per-currency footer summary.
import { formatMoney } from "./columns"
import type { DocumentRow } from "./types"

const big = (v: bigint | number | undefined): bigint =>
  typeof v === "bigint" ? v : BigInt(v ?? 0)

export interface CustomerRollup extends DocumentRow {
  group_count: number
}

/** One row per (customer × currency): document count + summed grand total. */
export function groupByCustomer(rows: DocumentRow[]): CustomerRollup[] {
  const acc = new Map<string, CustomerRollup>()
  for (const r of rows) {
    const key = `${r.counterparty_contact_id ?? r.counterparty_name ?? "?"}::${r.currency}`
    const existing = acc.get(key)
    if (existing) {
      existing.group_count++
      existing.grand_total_minor = big(existing.grand_total_minor) + big(r.grand_total_minor)
      if ((r.issued_at ?? "") > (existing.issued_at ?? "")) existing.issued_at = r.issued_at
    } else {
      acc.set(key, { ...r, group_count: 1 })
    }
  }
  return [...acc.values()].sort((a, b) => (b.issued_at ?? "").localeCompare(a.issued_at ?? ""))
}

export interface MarketRollup extends DocumentRow {
  group_count: number
  customs_documents_count: number
}

/** One row per (destination country × currency): count, revenue, VAT, customs. */
export function groupByCountry(rows: DocumentRow[]): MarketRollup[] {
  const acc = new Map<string, MarketRollup>()
  for (const r of rows) {
    const key = `${r.destination_country ?? "-"}::${r.currency}`
    const isCustoms =
      !!r.tax_treatment && r.tax_treatment !== "domestic" && r.tax_treatment !== "intracom_b2b"
    const existing = acc.get(key)
    if (existing) {
      existing.group_count++
      existing.grand_total_minor = big(existing.grand_total_minor) + big(r.grand_total_minor)
      existing.tax_total_minor = big(existing.tax_total_minor) + big(r.tax_total_minor)
      if (isCustoms) existing.customs_documents_count++
    } else {
      acc.set(key, { ...r, group_count: 1, customs_documents_count: isCustoms ? 1 : 0 })
    }
  }
  return [...acc.values()]
}

/** Per-currency total summary string for the table footer. */
export function perCurrencyRollup(
  rows: DocumentRow[],
  nounForms: string | { one: string; other: string } = "documents",
): string {
  if (rows.length === 0) return ""
  // One row reads "1 invoice", any other count "2 invoices" (the caller passes both forms,
  // already in the reader's language).
  const noun = typeof nounForms === "string" ? nounForms : rows.length === 1 ? nounForms.one : nounForms.other
  // A sum is only meaningful over documents of one kind: invoices, quotes, proformas,
  // purchase orders (payables) and credit notes added together are no figure anyone
  // can use, so a mixed list shows its count alone.
  const types = new Set(rows.map((r) => r.type))
  if (types.size > 1) return `${rows.length} ${noun}`
  const perCurrency = new Map<string, bigint>()
  for (const r of rows) {
    perCurrency.set(r.currency, (perCurrency.get(r.currency) ?? 0n) + big(r.grand_total_minor))
  }
  // The same grouped figures the rows show ("131 622.80 EUR").
  const parts = [...perCurrency.entries()].map(([cur, sum]) => formatMoney(sum, cur))
  return `${rows.length} ${noun}: ${parts.join(", ")}`
}
