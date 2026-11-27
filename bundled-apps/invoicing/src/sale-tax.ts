// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tax facts of a sale a source reports (a checkout that computed its own tax, a payment
// provider's tax engine), checked against the rules before anything issues. Pure, apart from
// `supplyDateOf`, which asks the host for the issuer's civil date.
//
// What it decides, for an EU (French) seller:
//  - B2B (a VAT number checked valid): another member state is a reverse charge at 0 %
//    (Directive 2006/112/EC art. 44 and 196 for services, art. 138 for goods); the seller's own
//    country is domestic VAT; outside the EU is outside the scope of French VAT.
//  - B2C electronically supplied services (line kind `software`): taxed where the consumer is
//    established (Directive art. 58; CGI art. 259 D), at that member state's rate through the OSS
//    (Directive art. 369a-369k), backed by two non-contradictory pieces of location evidence
//    (Implementing Regulation (EU) 282/2011 art. 24b(d) and 24f), or one for a seller under
//    EUR 100 000 (art. 24b(d), second subparagraph; the profile's `vat_single_evidence`).
//    Under the EUR 10 000 EU-wide threshold without the OSS (Directive art. 59c; CGI art. 259 D II,
//    the profile's `vat_eu_b2c_below_threshold`), the seller's own rate instead.
//  - B2C goods: destination VAT through the OSS (distance sales, Directive art. 33 and 369a).
//  - B2C services that are not electronic (line kind `service`): the place of supply depends on the
//    service (Directive art. 45 and the special rules after it), so a person decides: parked.
// A source's own tax amount is never overwritten: it is checked, and a difference parks the sale.

import type { OperationCategory } from "./einvoicing/classify-operation"
import { DEFAULT_ZONE, type TimeSurface } from "./issue-date"
import { lineTax } from "./money"
import { EU_STANDARD_RATE_BP, isEuCountry, type TaxTreatment } from "./tax"

export type SaleLineKind = "goods" | "software" | "service" | "shipping"

export interface SaleTaxEvidence {
  billing_country?: string | null
  ip_country?: string | null
  card_country?: string | null
}

export interface SaleTaxInput {
  /** The issuer profile's country (the seller's establishment). */
  issuer_country: string
  buyer: {
    /** As the source states it; null when it does not say. */
    kind: "individual" | "company" | null
    /** The tax destination: the billing country (or the delivery country for goods). */
    country: string | null
    vat_id: string | null
    /** The VAT number's check against VIES before issue: true valid, false invalid, null not run. */
    vat_id_valid: boolean | null
    /** Stripe `customer_details.tax_exempt`; `reverse` means the source applied a reverse charge. */
    tax_exempt?: "none" | "exempt" | "reverse" | null
    tax_evidence?: SaleTaxEvidence | null
  }
  lines: Array<{
    kind: SaleLineKind
    /** Net amount of the line after discount, minor units. */
    subtotal_minor: bigint
    /** The tax the source charged on this line, minor units; null when it reports none. */
    source_tax_minor: bigint | null
  }>
  /** Implementing Regulation (EU) 282/2011 art. 24b(d), second subparagraph: a seller whose
   *  cross-border B2C telecommunications, broadcasting and electronic services stayed under
   *  EUR 100 000 in the current and the previous calendar year may rely on ONE piece of location
   *  evidence. Off unless the issuer profile says so (`vat_single_evidence`): two otherwise. */
  single_evidence_allowed?: boolean
  /** Directive 2006/112/EC art. 59c (CGI art. 259 D II for the services, art. 258 A for goods):
   *  a seller established in one member state only, whose B2C electronic services and intra-EU
   *  distance sales of goods stayed under EUR 10 000 EU-wide in the current and the previous
   *  calendar year, and who has NOT opted to tax them in the consumer's member state (the OSS),
   *  charges its own country's VAT to consumers in other member states. Off unless the issuer
   *  profile says so (`vat_eu_b2c_below_threshold`): an OSS-registered seller leaves it off and
   *  always charges the consumer's member state rate. */
  eu_b2c_below_threshold?: boolean
}

/** The issuer profile's VAT settings as `classifySaleTax` reads them; both off by default. */
export function saleTaxSettings(issuer: {
  vat_single_evidence?: boolean | null
  vat_eu_b2c_below_threshold?: boolean | null
}): Required<Pick<SaleTaxInput, "single_evidence_allowed" | "eu_b2c_below_threshold">> {
  return {
    single_evidence_allowed: issuer.vat_single_evidence === true,
    eu_b2c_below_threshold: issuer.vat_eu_b2c_below_threshold === true,
  }
}

export interface PlaceOfSupply {
  country: string
  /** The rule that placed it: `customer_establishment` (B2B), `consumer_residence` (B2C
   *  electronic services), `goods_arrival` (distance sale of goods), `seller_establishment`. */
  rule: "customer_establishment" | "consumer_residence" | "goods_arrival" | "seller_establishment"
  evidence: SaleTaxEvidence
  /** The evidence kinds that point at `country`. */
  agreeing: Array<keyof SaleTaxEvidence>
}

export type SaleTaxPark =
  | "buyer_vat_missing"
  | "buyer_vat_unverified"
  | "buyer_vat_invalid"
  | "place_of_supply_evidence"
  | "service_place_of_supply_review"
  | "foreign_tax_collected"
  | "sale_tax_mismatch"
  | "buyer_country_missing"

export type SaleTaxResult =
  | {
      ok: true
      treatment: TaxTreatment
      operation_category: OperationCategory
      customer_kind: "business" | "individual"
      /** The rate each line issues at, in input order. */
      line_rates_bp: number[]
      place_of_supply: PlaceOfSupply
    }
  | { ok: false; park: SaleTaxPark; message: string; details?: Record<string, unknown> }

function cc(v: string | null | undefined): string {
  return (v ?? "").trim().toUpperCase()
}

/** goods + shipping are goods; software + service are services; both is mixed. */
export function saleOperationCategory(kinds: ReadonlyArray<SaleLineKind>): OperationCategory {
  const services = kinds.some((k) => k === "software" || k === "service")
  const goods = kinds.some((k) => k === "goods" || k === "shipping")
  return services && goods ? "mixed" : services ? "services" : "goods"
}

/**
 * The location evidence for a consumer's electronic services: the evidence kinds that name
 * `country`. Implementing Regulation 282/2011 art. 24b(d) asks for two non-contradictory items
 * among those art. 24f lists (billing address, IP address, bank or card country, ...).
 */
export function evidenceFor(
  country: string,
  evidence: SaleTaxEvidence | null | undefined,
): Array<keyof SaleTaxEvidence> {
  const out: Array<keyof SaleTaxEvidence> = []
  for (const kind of ["billing_country", "ip_country", "card_country"] as const) {
    if (cc(evidence?.[kind]) === country) out.push(kind)
  }
  return out
}

function evidenceCountries(evidence: SaleTaxEvidence | null | undefined): string[] {
  return (["billing_country", "ip_country", "card_country"] as const)
    .map((k) => cc(evidence?.[k]))
    .filter((c) => c !== "")
}

/** Each line's tax at `rate`, against what the source charged: the lines that differ by more than
 *  one minor unit (each jurisdiction rounds on its own, as Shopify's check allows). */
function mismatches(
  lines: SaleTaxInput["lines"],
  rates: number[],
): Array<{ line: number; expected_minor: string; reported_minor: string }> {
  const out: Array<{ line: number; expected_minor: string; reported_minor: string }> = []
  for (const [i, l] of lines.entries()) {
    if (l.source_tax_minor == null) continue
    const expected = lineTax({ subtotal_minor: l.subtotal_minor, tax_rate_bp: rates[i] ?? 0 })
    const diff =
      expected > l.source_tax_minor ? expected - l.source_tax_minor : l.source_tax_minor - expected
    if (diff > 1n) {
      out.push({
        line: i,
        expected_minor: expected.toString(),
        reported_minor: l.source_tax_minor.toString(),
      })
    }
  }
  return out
}

export function classifySaleTax(input: SaleTaxInput): SaleTaxResult {
  const seller = cc(input.issuer_country)
  const country = cc(input.buyer.country)
  const evidence = input.buyer.tax_evidence ?? {}
  const category = saleOperationCategory(input.lines.map((l) => l.kind))
  if (!isEuCountry(seller)) {
    return {
      ok: false,
      park: "service_place_of_supply_review",
      message: `Sales of an issuer outside the EU (${seller || "no country"}) are not classified here.`,
    }
  }
  if (!country) {
    return {
      ok: false,
      park: "buyer_country_missing",
      message: "The sale names no buyer country, so its place of supply is unknown.",
    }
  }
  const vatId = (input.buyer.vat_id ?? "").trim()
  const reverseBySource = input.buyer.tax_exempt === "reverse"

  // A business: a VAT number, valid in VIES. A number we could not check, or one VIES refuses,
  // never becomes a reverse charge (Directive art. 138 and 196 need a taxable customer, which the
  // seller must be able to show: Implementing Regulation 282/2011 art. 18(1)).
  if (vatId) {
    if (input.buyer.vat_id_valid === false) {
      return {
        ok: false,
        park: "buyer_vat_invalid",
        message: `The buyer's VAT number ${vatId} is not valid in VIES.`,
      }
    }
    if (input.buyer.vat_id_valid !== true) {
      return {
        ok: false,
        park: "buyer_vat_unverified",
        message: `The buyer's VAT number ${vatId} has not been checked in VIES yet.`,
      }
    }
  } else if (reverseBySource || (input.buyer.kind === "company" && country !== seller)) {
    // A company in another country, or a source that applied a reverse charge, with no number to
    // show for it: the reverse charge cannot be claimed and consumer VAT may be wrong too.
    if (isEuCountry(country) || reverseBySource) {
      return {
        ok: false,
        park: "buyer_vat_missing",
        message: "The buyer is a business in another EU country but gave no VAT number.",
      }
    }
  }
  const business = vatId !== ""
  const reported = (rates: number[]) => mismatches(input.lines, rates)
  const done = (
    treatment: TaxTreatment,
    rates: number[],
    place: Omit<PlaceOfSupply, "evidence" | "agreeing">,
  ): SaleTaxResult => {
    const diff = reported(rates)
    if (diff.length) {
      return {
        ok: false,
        park: "sale_tax_mismatch",
        message: `The tax the source charged differs from ${treatment} on ${diff.length} line(s).`,
        details: { treatment, lines: diff },
      }
    }
    return {
      ok: true,
      treatment,
      operation_category: category,
      customer_kind: business ? "business" : "individual",
      line_rates_bp: rates,
      place_of_supply: { ...place, evidence, agreeing: evidenceFor(place.country, evidence) },
    }
  }
  const all = (bp: number) => input.lines.map(() => bp)
  const domesticBp = EU_STANDARD_RATE_BP[seller] ?? 0

  if (business) {
    if (country === seller) {
      // Domestic B2B: the seller's VAT (FR 20 %); the e-invoicing regime is decided at issue.
      return done("eu_domestic", all(domesticBp), {
        country,
        rule: "customer_establishment",
      })
    }
    if (isEuCountry(country)) {
      // Intra-EU B2B: reverse charge, no VAT on the document (Directive art. 196 services,
      // art. 138 goods; CGI art. 283-2 and 262 ter I). The mention is worded per category.
      return done("eu_reverse_charge", all(0), { country, rule: "customer_establishment" })
    }
    // B2B outside the EU: outside the scope of French VAT (Directive art. 44; CGI art. 259-1°)
    // for services; an export (art. 146; CGI art. 262 I) for goods.
    if (input.lines.some((l) => (l.source_tax_minor ?? 0n) > 0n)) {
      return {
        ok: false,
        park: "foreign_tax_collected",
        message: `The source charged tax on a sale to a business in ${country}: which registration it belongs to is a person's call.`,
      }
    }
    return done("eu_export_non_eu", all(0), { country, rule: "customer_establishment" })
  }

  // Consumers.
  if (input.lines.some((l) => l.kind === "service")) {
    if (country !== seller) {
      return {
        ok: false,
        park: "service_place_of_supply_review",
        message:
          "A service that is not electronically supplied, sold to a consumer abroad: its place of supply depends on the service.",
      }
    }
  }
  const electronic = input.lines.some((l) => l.kind === "software")
  if (electronic) {
    // Electronic services to a consumer are taxed where the consumer is (Directive art. 58),
    // which two non-contradictory pieces of evidence must support (Reg. 282/2011 art. 24b(d));
    // one is enough for a seller under EUR 100 000 (art. 24b(d), second subparagraph).
    const agreeing = evidenceFor(country, evidence)
    const needed = input.single_evidence_allowed ? 1 : 2
    if (agreeing.length < needed) {
      return {
        ok: false,
        park: "place_of_supply_evidence",
        message: `Only ${agreeing.length} piece(s) of location evidence point at ${country} (${needed} needed): ${evidenceCountries(evidence).join(", ") || "none"}.`,
        details: { country, evidence, agreeing },
      }
    }
  }
  if (country === seller) {
    return done("eu_domestic", all(domesticBp), { country, rule: "seller_establishment" })
  }
  const rule = electronic ? "consumer_residence" : "goods_arrival"
  if (isEuCountry(country) && input.eu_b2c_below_threshold) {
    // Under the EUR 10 000 EU-wide threshold and not opted for the OSS (Directive art. 59c;
    // CGI art. 259 D II and 258 A): supplied where the seller is established, at its own rate.
    return done("eu_domestic", all(domesticBp), { country: seller, rule: "seller_establishment" })
  }
  if (isEuCountry(country)) {
    // OSS: the member state of consumption's standard rate, for goods and electronic services
    // alike. A reduced rate the source applied (an e-book, say) shows as a mismatch: a person
    // decides, as for a Shopify order.
    return done("eu_b2c_oss", all(EU_STANDARD_RATE_BP[country] ?? 0), { country, rule })
  }
  // A consumer outside the EU: electronic services are outside the scope of French VAT (Directive
  // art. 58), goods are an export. Tax a source collected for a non-EU registration (UK, CH, NO,
  // AU, ...) is not ours to print without knowing that registration: a person decides.
  if (input.lines.some((l) => (l.source_tax_minor ?? 0n) > 0n)) {
    return {
      ok: false,
      park: "foreign_tax_collected",
      message: `The source charged tax on a sale to a consumer in ${country}, outside the EU: which registration it belongs to is a person's call.`,
    }
  }
  return done("eu_export_non_eu", all(0), { country, rule })
}

/** The issuer's civil date of a sale's payment instant: the sale date printed on its invoice. */
export async function supplyDateOf(
  ctx: TimeSurface,
  issuer: { timezone?: string | null },
  soldAt: string,
): Promise<string> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(soldAt)) return soldAt
  if (Number.isNaN(new Date(soldAt).getTime())) throw new Error(`sold_at "${soldAt}" is no instant`)
  const civil = await ctx.time.civil({ timezone: issuer.timezone || DEFAULT_ZONE, at: soldAt })
  return civil.date
}
