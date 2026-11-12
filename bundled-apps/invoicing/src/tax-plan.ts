// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a document WILL charge, computed the way issuance computes it: the classifier's treatment
// and rate, the issuer's price basis (typed prices are gross under `prices_include_tax`, netted
// once at the document's rate; nothing is netted when the document charges no tax), then the
// per-line subtotal and tax. Pure, so the approval card (summarizer, gate time) and the handlers
// show the same numbers the issued document will carry.

import { readMinorAmount } from "@liaison/app-sdk"
import { lineAmounts, lineSubtotal, netOfIncludedTax } from "./money"
import { classify, type TaxTreatment } from "./tax"

export interface TaxPlanLine {
  quantity?: unknown
  unit_price_minor?: unknown
  discount_minor?: unknown
  tax_rate_bp_override?: unknown
}

export interface TaxPlanInput {
  issuerCountry: string | null | undefined
  pricesIncludeTax: boolean
  taxCountry: string | null | undefined
  hasVatId: boolean
  lines: TaxPlanLine[]
  /** Lines that are already net (a saved draft, a Shopify draft order): never netted again. */
  linesAreNet?: boolean
}

export type PriceBasis = "net" | "gross_netted" | "no_tax"

export interface TaxPlan {
  treatment: TaxTreatment
  /** The document's default rate (a line may override it). */
  rate_bp: number
  price_basis: PriceBasis
  /** Sum of the lines exactly as typed (before any netting). */
  typed_total_minor: bigint
  subtotal_minor: bigint
  tax_minor: bigint
  total_minor: bigint
}

/** An absent amount is 0. An unreadable one is refused before a plan matters (lineAmountsError),
 *  and a card that still meets one says so (unreadableLineAmount). */
function minor(v: unknown): bigint {
  return readMinorAmount(v) ?? 0n
}

function qty(v: unknown): string | number {
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? v : 1
}

export function planTax(input: TaxPlanInput): TaxPlan {
  const c = classify({
    issuer_country: input.issuerCountry,
    counterparty_country: input.taxCountry,
    has_vat_id: input.hasVatId,
  })
  let typed = 0n
  let subtotal = 0n
  let tax = 0n
  let netted = false
  let anyTax = false
  for (const l of input.lines) {
    const rate =
      typeof l.tax_rate_bp_override === "number" ? l.tax_rate_bp_override : c.default_rate_bp
    let unit = minor(l.unit_price_minor)
    let discount = minor(l.discount_minor)
    let lineTyped = 0n
    try {
      lineTyped = lineSubtotal({ quantity: qty(l.quantity), unit_price_minor: unit }) - discount
    } catch {
      lineTyped = 0n
    }
    typed += lineTyped
    if (input.pricesIncludeTax && !input.linesAreNet && rate > 0) {
      unit = netOfIncludedTax(unit, rate)
      discount = netOfIncludedTax(discount, rate)
      netted = true
    }
    if (rate > 0) anyTax = true
    try {
      const amounts = lineAmounts(
        { quantity: qty(l.quantity), unit_price_minor: unit, discount_minor: discount },
        rate,
      )
      subtotal += amounts.subtotal_minor
      tax += amounts.tax_minor
    } catch {
      // A quantity that cannot be read is refused at issue; it adds nothing here.
    }
  }
  const price_basis: PriceBasis = netted
    ? "gross_netted"
    : anyTax || input.lines.length === 0
      ? "net"
      : "no_tax"
  return {
    treatment: c.treatment,
    rate_bp: c.default_rate_bp,
    price_basis,
    typed_total_minor: typed,
    subtotal_minor: subtotal,
    tax_minor: tax,
    total_minor: subtotal + tax,
  }
}

/** "22%" / "25.5%" from basis points. */
export function ratePercent(bp: number): string {
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, "")
  return `${s}%`
}

/** The treatment in words, with the rate it charges. */
export function treatmentWords(
  treatment: TaxTreatment,
  rateBp: number,
  taxCountry: string | null | undefined,
): string {
  const cc = (taxCountry ?? "").toUpperCase()
  switch (treatment) {
    case "eu_domestic":
      return `domestic sale, ${cc} VAT ${ratePercent(rateBp)}`
    case "eu_reverse_charge":
      return "intra EU business sale, reverse charge, no VAT charged (the buyer accounts for it)"
    case "eu_b2c_oss":
      return `EU consumer sale (OSS), ${cc} VAT ${ratePercent(rateBp)}`
    case "eu_export_non_eu":
    case "uk_export_eu":
    case "uk_export_non_eu":
    case "us_export":
      return "export, no VAT charged"
    case "uk_domestic":
      return `UK VAT ${ratePercent(rateBp)}`
    case "us_domestic":
      return "US sales tax, per line"
    case "ambiguous":
      return `country not recognised, issuer VAT ${ratePercent(rateBp)} charged (check the country)`
    case "unconfigured":
      return "issuer country has no tax rules, no tax computed"
  }
}
