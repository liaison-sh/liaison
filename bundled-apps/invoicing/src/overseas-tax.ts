// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sale's source tax against the French overseas rules, line by line, before it issues. Pure.
//
// Shopify charges 0 % to Guadeloupe, Martinique and La Réunion unless a merchant configures them,
// and Stripe Tax computes nothing there or in Monaco. Yet a digital service to a consumer there is
// taxed where the consumer is (CGI art. 259 D) at that territory's rate (8.5 %, art. 296-1), and
// Monaco is French VAT territory (20 %). On a tax-inclusive price the buyer paid the same gross
// either way, so the VAT is extracted from it: net = gross / (1 + rate), VAT = gross - net,
// total = gross. Any other difference (a rate the source charged that is not the territory's, no
// tax on a tax-exclusive price, a business buyer) is a person's call: the sale parks with a reason.

import { lineSubtotal, lineTax, netOfIncludedTax } from "./money"
import type { ClassifyLineKind, ClassifyResult } from "./tax"
import { territoryKind } from "./vat-territory"

/** The fields of a sale line this reads and rewrites (OrderPaidPayload line items). */
export interface OverseasLine {
  description: string
  quantity: string
  unit_price_minor: bigint | number | string
  discount_minor?: bigint | number | string
  tax_rate_bp?: number
  shopify_tax_minor?: string
  shopify_tax_line_count?: number
  line_kind?: ClassifyLineKind
  /** Set on a line whose VAT was extracted from its gross: its tax is `shopify_tax_minor`. */
  tax_from_gross?: boolean
}

export type OverseasTaxResult<L extends OverseasLine> =
  | { ok: true; lines: L[]; applied: boolean }
  | {
      ok: false
      reason: "overseas_tax_mismatch" | "overseas_tax_not_collected"
      message: string
      lines: Array<{ description: string; expected_rate_bp: number; source_rate_bp: number | null }>
    }

function big(v: bigint | number | string | undefined): bigint {
  if (v === undefined || v === "") return 0n
  return typeof v === "bigint" ? v : BigInt(v)
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`
}

/** The territories whose VAT a source may have left out: the departments with VAT and Monaco. */
export function overseasRulesApply(territory: string | null | undefined): boolean {
  const t = (territory ?? "").trim().toUpperCase()
  return t === "MC" || (territoryKind(t) !== "fr_metro" && territoryKind(t) !== "other")
}

/**
 * A line whose source charged no tax, re-expressed at `rateBp` with the gross it carried kept as
 * its total: net unit and discount, and the tax as the source amount (`shopify_tax_minor`), so
 * issuance takes it as is (within its one-minor-unit check).
 */
function extract<L extends OverseasLine>(l: L, rateBp: number): L {
  const qty = l.quantity
  const unit = big(l.unit_price_minor)
  const discount = big(l.discount_minor)
  const gross = lineSubtotal({ quantity: qty, unit_price_minor: unit }) - discount
  const net = netOfIncludedTax(gross, rateBp)
  const done = (quantity: string, description: string, u: bigint, d: bigint): L => ({
    ...l,
    description,
    quantity,
    unit_price_minor: u.toString(),
    discount_minor: d.toString(),
    tax_rate_bp: rateBp,
    shopify_tax_minor: (gross - net).toString(),
    shopify_tax_line_count: 1,
    tax_from_gross: true,
  })
  let unitNet = netOfIncludedTax(unit, rateBp)
  const typed = lineSubtotal({ quantity: qty, unit_price_minor: unitNet })
  if (discount === 0n) {
    if (typed === net) return done(qty, l.description, unitNet, 0n)
    // The per-unit net does not add up to the line's net: one line of the whole quantity, so no
    // rounding cent appears as a discount nobody gave.
    return done("1", `${qty} x ${l.description}`, net, 0n)
  }
  // A real discount takes the rounding: unit net, then whatever discount lands the line on `net`.
  let disc = typed - net
  if (disc < 0n) {
    unitNet += 1n
    disc = lineSubtotal({ quantity: qty, unit_price_minor: unitNet }) - net
  }
  if (disc < 0n) return done("1", `${qty} x ${l.description}`, net, 0n)
  return done(qty, l.description, unitNet, disc)
}

/**
 * Check (and, for the one case above, extract) each line's tax against the territory's rule.
 * `classification` is the sale's own (`classify` with its line kinds); a sale the overseas rules
 * did not decide is returned untouched.
 */
export function overseasLineTax<L extends OverseasLine>(
  lines: L[],
  classification: Pick<ClassifyResult, "rate_bp_by_kind" | "default_rate_bp">,
  opts: { territory: string | null | undefined; consumer: boolean; pricesIncludeTax: boolean },
): OverseasTaxResult<L> {
  const byKind = classification.rate_bp_by_kind
  const territory = (opts.territory ?? "").trim().toUpperCase()
  if (!byKind || !overseasRulesApply(territory)) return { ok: true, lines, applied: false }
  const out: L[] = []
  const mismatched: Array<{
    description: string
    expected_rate_bp: number
    source_rate_bp: number | null
  }> = []
  const uncollected: typeof mismatched = []
  for (const l of lines) {
    const expected = byKind[l.line_kind ?? "goods"] ?? classification.default_rate_bp
    const source = typeof l.tax_rate_bp === "number" ? l.tax_rate_bp : null
    const sourceTax =
      l.shopify_tax_minor != null && l.shopify_tax_minor !== "" ? big(l.shopify_tax_minor) : null
    const chargedNothing =
      (source === null || source === 0) && (sourceTax === null || sourceTax === 0n)
    if (source === expected) {
      out.push(l)
      continue
    }
    if (expected === 0 && chargedNothing) {
      // Exported goods, or no VAT where the buyer is: the rate is stated, never the default's.
      out.push(source === 0 ? l : { ...l, tax_rate_bp: 0 })
      continue
    }
    if (expected > 0 && chargedNothing) {
      if (opts.consumer && opts.pricesIncludeTax) {
        out.push(extract(l, expected))
        continue
      }
      uncollected.push({
        description: l.description,
        expected_rate_bp: expected,
        source_rate_bp: source,
      })
      out.push(l)
      continue
    }
    mismatched.push({
      description: l.description,
      expected_rate_bp: expected,
      source_rate_bp: source,
    })
    out.push(l)
  }
  if (mismatched.length > 0) {
    const first = mismatched[0] as (typeof mismatched)[number]
    return {
      ok: false,
      reason: "overseas_tax_mismatch",
      message:
        `The buyer is in ${territory}: "${first.description}" is taxed there at ${pct(first.expected_rate_bp)} ` +
        `(French overseas VAT rules), the source charged ${first.source_rate_bp == null ? "no rate" : pct(first.source_rate_bp)}. ` +
        "A person decides which is right.",
      lines: mismatched,
    }
  }
  if (uncollected.length > 0) {
    const first = uncollected[0] as (typeof uncollected)[number]
    return {
      ok: false,
      reason: "overseas_tax_not_collected",
      message:
        `The buyer is in ${territory}: "${first.description}" is taxed there at ${pct(first.expected_rate_bp)}, ` +
        `the source charged none, and ${opts.consumer ? "its prices are not tax inclusive" : "the buyer is a business"}, ` +
        "so the VAT cannot be taken out of what was paid. A person decides.",
      lines: uncollected,
    }
  }
  // Sanity: every extracted line still reproduces its tax within one minor unit.
  for (const [i, l] of out.entries()) {
    if (l === lines[i] || l.shopify_tax_minor == null || typeof l.tax_rate_bp !== "number") continue
    const sub =
      lineSubtotal({ quantity: l.quantity, unit_price_minor: big(l.unit_price_minor) }) -
      big(l.discount_minor)
    const computed = lineTax({ subtotal_minor: sub, tax_rate_bp: l.tax_rate_bp })
    const reported = big(l.shopify_tax_minor)
    const diff = computed > reported ? computed - reported : reported - computed
    if (diff > 1n) {
      return {
        ok: false,
        reason: "overseas_tax_mismatch",
        message: `"${l.description}": the tax ${reported} the source reported is not the line's at ${pct(l.tax_rate_bp)}.`,
        lines: [
          {
            description: l.description,
            expected_rate_bp: l.tax_rate_bp,
            source_rate_bp: l.tax_rate_bp,
          },
        ],
      }
    }
  }
  return { ok: true, lines: out, applied: out.some((l, i) => l !== lines[i]) }
}
