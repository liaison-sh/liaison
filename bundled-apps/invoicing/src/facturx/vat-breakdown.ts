// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-rate VAT breakdown (EN 16931 BG-23) for a Factur-X document. One group per (category, rate):
// taxable amount = sum of the group's line net amounts, tax amount = sum of the group's line taxes.
// Summing the line taxes (rather than recomputing rate x basis) keeps every group total equal to what
// the document itself charged, so BT-110 (sum of BT-117) is exactly the document's VAT total and the
// human PDF and the XML can never disagree by a rounding cent. Pure: no sandbox globals.

export type VatCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O"

export interface BreakdownLine {
  tax_rate_bp: number
  /** Line net amount (after the line discount), minor units. */
  subtotal_minor: bigint
  tax_minor: bigint
}

export interface VatGroup {
  category: VatCategory
  rate_bp: number
  basis_minor: bigint
  tax_minor: bigint
}

/** The VAT category of a line, from its rate and the document's tax treatment. A positive rate is
 *  always standard (S). A zero rate takes the category its treatment names: reverse charge (AE),
 *  intra-EU supply of goods (K), export (G); anything else is an exemption (E) that needs a
 *  reason. */
export function vatCategory(rateBp: number, treatment: string | null | undefined): VatCategory {
  if (rateBp > 0) return "S"
  switch (treatment) {
    case "eu_reverse_charge":
      return "AE"
    case "eu_export_non_eu":
    case "uk_export_eu":
    case "uk_export_non_eu":
    case "us_export":
      return "G"
    default:
      return "E"
  }
}

export function vatBreakdown(
  lines: BreakdownLine[],
  treatment: string | null | undefined,
): VatGroup[] {
  const groups = new Map<string, VatGroup>()
  for (const l of lines) {
    const category = vatCategory(l.tax_rate_bp, treatment)
    const key = `${category}:${l.tax_rate_bp}`
    const g = groups.get(key) ?? {
      category,
      rate_bp: l.tax_rate_bp,
      basis_minor: 0n,
      tax_minor: 0n,
    }
    g.basis_minor += l.subtotal_minor
    g.tax_minor += l.tax_minor
    groups.set(key, g)
  }
  // Deterministic order: highest rate first, then category.
  return [...groups.values()].sort(
    (a, b) => b.rate_bp - a.rate_bp || a.category.localeCompare(b.category),
  )
}
