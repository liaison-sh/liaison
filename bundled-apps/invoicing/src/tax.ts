// SPDX-License-Identifier: FSL-1.1-ALv2
// Tax regime classifier — pure function consumed by the issuance pipeline (D7)
// and PDF templates (D6). Covers the four v1 issuer regimes (FR / DE / GB / US)
// per spec §2; other EU countries return `unconfigured` until org admins seed
// the `tax_regimes` config table.

import type { OperationCategory } from "./einvoicing/classify-operation"
import {
  frTerritoryRateBp,
  frVatZone,
  isFrenchOverseas,
  territoryKind,
  vatTerritoryOf,
} from "./vat-territory"

export type TaxTreatment =
  | "eu_domestic"
  | "eu_reverse_charge"
  | "eu_b2c_oss"
  | "eu_export_non_eu"
  | "uk_domestic"
  | "uk_export_eu"
  | "uk_export_non_eu"
  | "us_domestic"
  | "us_export"
  | "ambiguous"
  | "unconfigured"

export interface ClassifyInput {
  // Nullable to match reality: an issuer profile or a counterparty contact may have NO country
  // (e.g. an agent-created contact). A missing country must DEGRADE (unconfigured/ambiguous, below),
  // never crash issuance — the type now says so instead of pretending these are always present.
  issuer_country: string | null | undefined
  counterparty_country: string | null | undefined
  has_vat_id: boolean
  /** The issuer's postcode: a French issuer with a 971/972/974 postcode is established in a
   *  department where French VAT applies at its own rates. */
  issuer_postcode?: string | null
  /** The tax destination's postcode: `FR` with an overseas postcode is that territory. */
  counterparty_postcode?: string | null
  /** The document's line kinds (goods, software, service, shipping). They decide the French
   *  overseas rules: goods are exported to a department, its services are taxed there. Absent,
   *  the document reads as goods. */
  line_kinds?: ReadonlyArray<string | null | undefined>
}

export type ClassifyLineKind = "goods" | "software" | "service" | "shipping"

export interface ClassifyResult {
  treatment: TaxTreatment
  default_rate_bp: number
  legal_mention_key: string
  requires_hs_code: boolean
  /** Set when the French overseas rules decided the sale: the rate of each line kind (goods
   *  exported at 0 next to services taxed at 8.5 %, say). A line takes its kind's rate before the
   *  document default. */
  rate_bp_by_kind?: Record<ClassifyLineKind, number>
  /** The buyer's tax territory the overseas rules read (RE for FR 97411). */
  territory?: string
}

/**
 * Treatments whose legal mention declares the document EXEMPT from (or zero rated for) the
 * issuer's tax: reverse charge and every export. A document under one of these must carry no tax
 * of its own: a nonzero tax line next to "VAT-exempt under Article 146" contradicts itself on the
 * page. `us_domestic` is deliberately absent (US sales tax is charged per line, rate 0 is only its
 * default), and so is `ambiguous`. The PDF templates keep a copy of this set
 * (templates/shared.ts EXEMPT_TAX_TREATMENTS): they are sandbox-isolated from src/.
 */
export const EXEMPT_TREATMENTS: ReadonlySet<TaxTreatment> = new Set<TaxTreatment>([
  "eu_reverse_charge",
  "eu_export_non_eu",
  "uk_export_eu",
  "uk_export_non_eu",
  "us_export",
])

// EU member-states (2026 set). Used to discriminate intra-EU vs export flows.
const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
])

// EVERY ISO 3166-1 alpha-2 code, not a hand-picked subset of trading partners.
// This set answers only "is this a real country code", and the EU_COUNTRIES set
// above answers "is it in the EU" — so a code that is real but not European is
// an EXPORT, which for a FR issuer means 0% VAT.
//
// It used to list ~45 countries we happened to trade with, and `classify` reads
// a miss as `ambiguous` and then "safely" over-collects at the issuer's
// domestic rate. That is not safe, it is a wrong tax on a real customer: quote
// QUO-2026-0006 charged 20% French VAT to a customer in Yerevan because
// Armenia was not on the list, and the same held for most of the world
// (Ukraine, Vietnam, Morocco, Nigeria, Thailand, Indonesia, Egypt, Saudi
// Arabia...). Over-collecting VAT on an export is a real liability and the
// customer sees it on the document, so the failure is neither silent nor safe.
//
// `ambiguous` now means what it says: the code is not a country at all (a typo,
// an empty string, a treatment keyword that leaked into the field).
//
// Exported so the draft-line boundary (`liftMisplacedCountry`, BL-44) can
// recognise a country token a weak agent misplaced into
// `tax_treatment`/`customs_description` — single source of truth.
export const KNOWN_COUNTRIES = new Set<string>([
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
])
// Issuer regimes that v1 ships with rule sets. Anything else returns
// `unconfigured` so the document creator surfaces a clear error.
const SUPPORTED_ISSUER_REGIMES = new Set<string>(["FR", "DE", "GB", "US"])

// Domestic rate per regime, in basis points (1bp = 0.01%). US is 0 because
// sales tax is per-line manual.
const DOMESTIC_RATE_BP: Record<string, number> = {
  FR: 2000, // 20% standard VAT
  DE: 1900, // 19% standard VAT
  GB: 2000, // 20% standard VAT
  US: 0,
}

/**
 * The STANDARD VAT rate of every EU member state, in basis points. A cross-border EU sale to a
 * consumer under the One-Stop-Shop is taxed at the DESTINATION's rate, never the issuer's: a French
 * issuer selling to an Italian consumer charges Italian VAT (22%), not French VAT (20%). A product
 * under a reduced rate takes its rate as a per-line `tax_rate_bp_override`.
 */
export const EU_STANDARD_RATE_BP: Readonly<Record<string, number>> = {
  AT: 2000,
  BE: 2100,
  BG: 2000,
  HR: 2500,
  CY: 1900,
  CZ: 2100,
  DK: 2500,
  EE: 2400,
  FI: 2550,
  FR: 2000,
  DE: 1900,
  GR: 2400,
  HU: 2700,
  IE: 2300,
  IT: 2200,
  LV: 2100,
  LT: 2100,
  LU: 1700,
  MT: 1800,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  RO: 2100,
  SK: 2300,
  SI: 2200,
  ES: 2100,
  SE: 2500,
}

/**
 * A sale to a buyer in ANOTHER EU member state that carries no VAT number and is charged no VAT
 * (tax exempt, or a zero tax). It is neither invoice: a consumer there owes that country's VAT
 * (OSS), and a business needs the reverse charge, which takes its VAT number. Shared by the
 * order auto-flow (which parks it for review) and the invoiceability check (which predicts that).
 */
export function isUntaxedIntraEuSaleWithoutVat(
  treatment: TaxTreatment | string,
  chargesNoTax: boolean,
): boolean {
  return treatment === "eu_b2c_oss" && chargesNoTax
}

/** True for an EU member-state code (case-insensitive). */
export function isEuCountry(code: string | null | undefined): boolean {
  return EU_COUNTRIES.has((code ?? "").trim().toUpperCase())
}

const UNCONFIGURED: ClassifyResult = {
  treatment: "unconfigured",
  default_rate_bp: 0,
  legal_mention_key: "",
  requires_hs_code: false,
}

/**
 * The French overseas rules (decision table: docs/apps/invoicing.md, "Overseas France").
 * Applies when the seller is in French VAT (metropolitan France or a department where VAT
 * applies) and either side is overseas, or the buyer is in Monaco. Null leaves the sale to the
 * general rules. Sources: BOI-TVA-GEO-20, BOI-TVA-GEO-20-40, BOI-TVA-CHAMP-20-10.
 */
function classifyOverseas(input: ClassifyInput): ClassifyResult | null {
  const seller = vatTerritoryOf(input.issuer_country, input.issuer_postcode)
  const buyer = vatTerritoryOf(input.counterparty_country, input.counterparty_postcode)
  const sellerKind = territoryKind(seller)
  const buyerKind = territoryKind(buyer)
  const sellerOverseas = sellerKind !== "fr_metro" && sellerKind !== "other"
  const buyerOverseas = isFrenchOverseas(buyer)
  if (!sellerOverseas && !buyerOverseas && buyer !== "MC") return null
  // A seller in Guyane or Mayotte charges no VAT, a seller in a COM is outside French VAT: not
  // modelled, a person decides.
  if (sellerKind === "dom_no_vat" || sellerKind === "com") return UNCONFIGURED
  const kinds = (input.line_kinds ?? []).map((k) =>
    k === "software" || k === "service" || k === "shipping" ? k : "goods",
  ) as ClassifyLineKind[]
  if (kinds.length === 0) kinds.push("goods")
  const services = kinds.some((k) => k === "software" || k === "service")
  const goods = kinds.some((k) => k === "goods" || k === "shipping")
  const sellerZone = frVatZone(seller)
  const buyerZone = frVatZone(buyer)
  const sellerRate = frTerritoryRateBp(seller) ?? 0
  const byKind = (goodsBp: number, softwareBp: number, serviceBp: number) => ({
    goods: goodsBp,
    shipping: goodsBp,
    software: softwareBp,
    service: serviceBp,
  })
  const result = (
    treatment: TaxTreatment,
    rates: Record<ClassifyLineKind, number>,
  ): ClassifyResult => {
    const first = kinds.find((k) => k === "software" || k === "service") ?? kinds[0] ?? "goods"
    return {
      treatment,
      default_rate_bp: rates[first],
      legal_mention_key: treatment,
      requires_hs_code: goods && rates.goods === 0,
      rate_bp_by_kind: rates,
      territory: buyer,
    }
  }

  if (sellerZone === null) {
    // A seller in another member state (or anywhere outside French VAT): goods to a department are
    // an export from the EU, as before. Its services taxed in a department under French law are
    // not modelled (UNCONFIRMED: how it accounts for them): a person decides.
    if (isEuCountry(seller) && buyerKind === "dom_vat" && services) return UNCONFIGURED
    return null
  }

  // Inside French VAT.
  if (buyerZone !== null) {
    if (buyerZone === sellerZone) {
      // Domestic: one territory (the Antilles are one market).
      return result("eu_domestic", byKind(sellerRate, sellerRate, sellerRate))
    }
    // Different French VAT territories: goods are exported (CGI 262 I, 294-2); services are taxed
    // where art. 259-259 D place them, with no reverse charge (BOI-TVA-GEO-20-40 § 110-230):
    // a business's territory (259-1°), a consumer's for electronic services (259 D), the seller's
    // for other consumer services (259-2°).
    const buyerRate = frTerritoryRateBp(buyer) ?? 0
    const software = buyerRate
    const service = input.has_vat_id ? buyerRate : sellerRate
    return result(services ? "eu_domestic" : "eu_export_non_eu", byKind(0, software, service))
  }
  if (buyerKind === "dom_no_vat") {
    // Guyane, Mayotte: VAT not applicable (CGI 294-1); goods are exported to them (294-2).
    return result("eu_export_non_eu", byKind(0, 0, 0))
  }
  if (sellerOverseas) {
    // A seller in a department selling outside French VAT. Another member state: goods are an
    // export (CGI 294-2); services are UNCONFIRMED (the EU OSS does not cover a seller outside
    // the EU VAT territory): a person decides.
    if (isEuCountry(buyer) && services) return UNCONFIGURED
    if (!KNOWN_COUNTRIES.has(buyer)) return null
    // A COM or a third country: exports and services outside French VAT, as for a metropolitan
    // seller (CGI 262 I; 259-1°, 259 B).
    return result("eu_export_non_eu", byKind(0, 0, 0))
  }
  // A metropolitan seller and a COM: a third territory, the general rules apply.
  return null
}

export function classify(input: ClassifyInput): ClassifyResult {
  const overseas = classifyOverseas(input)
  if (overseas) return overseas
  // Null-safe: a missing/empty country becomes "" which falls through to the unconfigured (issuer)
  // / ambiguous (counterparty) degradations below — issuance proceeds instead of throwing a
  // "cannot read property 'toUpperCase' of undefined" that aborts the whole gated approval (422).
  const issuer = (input.issuer_country ?? "").toUpperCase()
  // FR with an overseas postcode is that territory (FR 97133 is Saint-Barthélemy, a third
  // territory): the general rules read the resolved code.
  const counterparty = vatTerritoryOf(input.counterparty_country, input.counterparty_postcode)

  if (!SUPPORTED_ISSUER_REGIMES.has(issuer)) {
    return {
      treatment: "unconfigured",
      default_rate_bp: 0,
      legal_mention_key: "",
      requires_hs_code: false,
    }
  }

  if (!KNOWN_COUNTRIES.has(counterparty)) {
    // Safe default: over-collect at the issuer's domestic rate; operator
    // verifies via the attention-feed entry surfaced upstream.
    return {
      treatment: "ambiguous",
      default_rate_bp: DOMESTIC_RATE_BP[issuer] ?? 0,
      legal_mention_key: "ambiguous",
      requires_hs_code: false,
    }
  }

  // EU issuer (FR / DE)
  if (EU_COUNTRIES.has(issuer)) {
    if (issuer === counterparty) {
      return {
        treatment: "eu_domestic",
        default_rate_bp: DOMESTIC_RATE_BP[issuer] ?? 0,
        legal_mention_key: "eu_domestic",
        requires_hs_code: false,
      }
    }
    if (EU_COUNTRIES.has(counterparty)) {
      // Different EU countries — B2B (VAT ID) → reverse charge; B2C → OSS.
      if (input.has_vat_id) {
        return {
          treatment: "eu_reverse_charge",
          default_rate_bp: 0,
          legal_mention_key: "eu_reverse_charge",
          requires_hs_code: false,
        }
      }
      return {
        treatment: "eu_b2c_oss",
        // OSS: the DESTINATION member state's standard rate (an Italian consumer pays Italian VAT).
        // Every EU code is in the table, so the issuer's rate is never a stand-in for it.
        default_rate_bp: EU_STANDARD_RATE_BP[counterparty] ?? 0,
        legal_mention_key: "eu_b2c_oss",
        requires_hs_code: false,
      }
    }
    return {
      treatment: "eu_export_non_eu",
      default_rate_bp: 0,
      legal_mention_key: "eu_export_non_eu",
      requires_hs_code: true,
    }
  }

  // UK issuer
  if (issuer === "GB") {
    if (counterparty === "GB") {
      return {
        treatment: "uk_domestic",
        default_rate_bp: DOMESTIC_RATE_BP.GB ?? 2000,
        legal_mention_key: "uk_domestic",
        requires_hs_code: false,
      }
    }
    if (EU_COUNTRIES.has(counterparty)) {
      return {
        treatment: "uk_export_eu",
        default_rate_bp: 0,
        legal_mention_key: "uk_export_eu",
        requires_hs_code: true,
      }
    }
    return {
      treatment: "uk_export_non_eu",
      default_rate_bp: 0,
      legal_mention_key: "uk_export_non_eu",
      requires_hs_code: true,
    }
  }

  // US issuer
  if (issuer === "US") {
    if (counterparty === "US") {
      return {
        treatment: "us_domestic",
        default_rate_bp: 0,
        legal_mention_key: "us_domestic",
        requires_hs_code: false,
      }
    }
    return {
      treatment: "us_export",
      default_rate_bp: 0,
      legal_mention_key: "us_export",
      requires_hs_code: true,
    }
  }

  // Unreachable — `SUPPORTED_ISSUER_REGIMES` membership is checked above.
  return {
    treatment: "unconfigured",
    default_rate_bp: 0,
    legal_mention_key: "",
    requires_hs_code: false,
  }
}

/** `classify` with the line kinds read from the lines (unless the input names its own). */
export function classifyLines(
  input: ClassifyInput,
  lines: ReadonlyArray<{ line_kind?: string | null }>,
): ClassifyResult {
  return classify({ ...input, line_kinds: input.line_kinds ?? lines.map((l) => l.line_kind) })
}

/** A line's rate: its override, else its kind's rate (French overseas rules), else the
 *  document's default. */
export function lineRateBp(
  c: Pick<ClassifyResult, "default_rate_bp" | "rate_bp_by_kind">,
  line: { line_kind?: string | null; tax_rate_bp_override?: unknown },
): number {
  if (typeof line.tax_rate_bp_override === "number") return line.tax_rate_bp_override
  const kind = (line.line_kind ?? "goods") as ClassifyLineKind
  return c.rate_bp_by_kind?.[kind] ?? c.default_rate_bp
}

export type MentionLanguage = "en" | "fr" | "de"

/** Date from which the CIBS (Code des impositions sur les biens et services) numbering applies;
 *  the org can move it through `einvoicing_settings.cibs_switch_date`. */
export const DEFAULT_CIBS_SWITCH_DATE = "2027-01-01"

/** The literal French mention printed when the seller opted to pay VAT on debits. */
export const VAT_ON_DEBITS_TEXT = "Option pour le paiement de la taxe d'après les débits"

type MentionEntry = { en: string; fr: string; de: string }

const DOMESTIC_NONE: MentionEntry = { en: "", fr: "", de: "" }

const GOODS_EXEMPTION: MentionEntry = {
  en: "Intra-Community supply of goods exempt from VAT (Article 262 ter I of the French Tax Code, CGI).",
  fr: "Exonération de TVA, article 262 ter I du CGI",
  de: "Innergemeinschaftliche Lieferung, steuerfrei nach Art. 262 ter I CGI.",
}

const SERVICES_REVERSE_CHARGE: MentionEntry = {
  en: "Reverse charge: VAT to be accounted for by the recipient (Article 196, Directive 2006/112/EC).",
  fr: "Autoliquidation : TVA due par le preneur (article 283-2 du CGI)",
  de: "Steuerschuldnerschaft des Leistungsempfaengers (Reverse Charge, Art. 196 MwStSystRL).",
}

/**
 * Services supplied to a customer established outside the EU are not an export of goods: their
 * place of supply is outside France, so French VAT does not apply (B2B: Directive 2006/112/EC
 * art. 44, CGI art. 259-1°; electronic services to a consumer: Directive art. 58, CGI art. 259 D).
 * OPEN: the exact wording, and the CGI article for consumers outside the EU, wait for the
 * accountant's confirmation.
 */
const SERVICES_OUTSIDE_EU: MentionEntry = {
  en: "VAT not applicable: place of supply of the services outside France (Articles 44 and 58 of Directive 2006/112/EC).",
  fr: "TVA non applicable : lieu de la prestation de services situé hors de France (articles 259-1° et 259 D du CGI)",
  de: "Nicht steuerbar in Frankreich: Ort der Dienstleistung ausserhalb Frankreichs (Art. 44 und 58 MwStSystRL).",
}

/** The first issue date that prints SERVICES_OUTSIDE_EU on services outside the EU. Documents
 *  issued before keep the export wording they were issued with, on every re-render. */
export const SERVICES_OUTSIDE_EU_FROM = "2026-11-28"

/**
 * Electronically supplied services to a CONSUMER established outside the EU: supplied outside
 * France, so French VAT does not apply (CGI art. 259 B; Directive 2006/112/EC art. 59). A business
 * buyer keeps SERVICES_OUTSIDE_EU (CGI art. 259-1°).
 */
const CONSUMER_SERVICES_OUTSIDE_EU: MentionEntry = {
  en: "VAT not applicable, art. 259 B of the French Tax Code",
  fr: "TVA non applicable, art. 259 B du CGI",
  de: "Nicht steuerbar in Frankreich, Art. 259 B CGI",
}

/** The first issue date that prints CONSUMER_SERVICES_OUTSIDE_EU. Documents issued before keep
 *  the wording they were issued with, on every re-render. */
export const CONSUMER_SERVICES_OUTSIDE_EU_FROM = "2026-11-28"

/**
 * French overseas departments (BOI-TVA-GEO-20 § 10 and 40; BOI-TVA-GEO-20-40 § 60). Goods sent
 * between metropolitan France and a department, or between La Réunion and the Antilles, are an
 * export (CGI art. 262 I and 294-2). Services are not applicable in Guyane and Mayotte (art. 294-1).
 * OPEN: the exact wording waits for the accountant; the articles are the legal basis.
 */
const OVERSEAS_GOODS_EXPORT: MentionEntry = {
  en: "Export to a French overseas department: VAT-exempt (Articles 262 I and 294-2 of the French Tax Code, CGI).",
  fr: "Exportation : exonération de TVA (articles 262 I et 294-2 du CGI)",
  de: "Ausfuhr in ein franzoesisches Ueberseedepartement, steuerfrei nach Art. 262 I und 294-2 CGI.",
}
const OVERSEAS_GOODS_EXEMPT: MentionEntry = {
  en: "Supply of goods exempt from VAT (Articles 262 I and 294-2 of the French Tax Code, CGI)",
  fr: "Livraison de biens exonérée (articles 262 I et 294-2 du CGI)",
  de: "Warenlieferung steuerfrei nach Art. 262 I und 294-2 CGI",
}
const OVERSEAS_NO_VAT_SERVICES: MentionEntry = {
  en: "VAT not applicable, art. 294-1 of the French Tax Code",
  fr: "TVA non applicable, art. 294-1 du CGI",
  de: "Nicht steuerbar, Art. 294-1 CGI",
}

/** The first issue date that prints the overseas mentions. Documents issued before keep the
 *  wording they were issued with, on every re-render. */
export const OVERSEAS_MENTIONS_FROM = "2026-11-28"

/** The overseas mention of a document, or null when the general wording applies. */
function overseasMention(
  treatment: TaxTreatment,
  language: MentionLanguage,
  opts: LegalMentionOptions,
): string | null {
  const issued = wordingDateOf(opts)
  if (!opts.taxTerritory || issued < OVERSEAS_MENTIONS_FROM) return null
  const buyer = opts.taxTerritory.trim().toUpperCase()
  const sellerZone = frVatZone(opts.issuerTerritory ?? "FR")
  const buyerZone = frVatZone(buyer)
  const noVat = territoryKind(buyer) === "dom_no_vat"
  // Goods leave the seller's French VAT territory for another one, or for Guyane / Mayotte.
  const withinFrance =
    sellerZone !== null && ((buyerZone !== null && buyerZone !== sellerZone) || noVat)
  if (!withinFrance) return null
  const text = (e: MentionEntry) => e[language] ?? e.en
  const category = opts.category ?? "goods"
  if (treatment === "eu_export_non_eu") {
    const goods = text(OVERSEAS_GOODS_EXPORT)
    if (category === "goods") return goods
    if (!noVat) return null
    const services = text(OVERSEAS_NO_VAT_SERVICES)
    return category === "services" ? services : `${goods.replace(/\.\s*$/, "")}. ${services}`
  }
  if (treatment === "eu_domestic") {
    // Services taxed in the buyer's territory are plain domestic VAT; goods on the same document
    // are exported, which the exemption names.
    return category === "mixed" ? text(OVERSEAS_GOODS_EXEMPT) : ""
  }
  return null
}

/**
 * The carriage of goods exported outside the EU, invoiced on the services invoice of a split
 * order (its goods travel on the other invoice): a transport service directly linked to the
 * export of goods, exempt under CGI art. 262 I 1° (the services of the list in art. 73 G of
 * annex III; BOFiP BOI-TVA-CHAMP-30-30-20-10; Directive 2006/112/EC art. 146 1 e). Its VAT is
 * the goods' (zero), and the art. 146 export of goods mention is never printed for it.
 */
const TRANSPORT_LINKED_TO_EXPORT: MentionEntry = {
  en: "VAT-exempt transport linked to the export of goods (art. 262 I 1° of the French Tax Code)",
  fr: "Exonération de TVA, transport lié à l'exportation (article 262 I 1° du CGI)",
  de: "Steuerfreie Beförderung im Zusammenhang mit der Ausfuhr (Art. 262 I 1° CGI)",
}

/** The first issue date that words a services invoice per line (download, carriage). Documents
 *  issued before keep the wording they were issued with, on every re-render. */
export const CARRIAGE_LINKED_TO_EXPORT_FROM = "2026-11-28"

/**
 * The shipped legal-mention texts per (key, language), dated by legal period: `cgi` applies before
 * the CIBS switch date, `cibs` from it. The accountant's exact CIBS wording is still open, so until
 * it arrives the `cibs` period repeats the CGI text; a new wording is one edit to that period.
 * `eu_reverse_charge` is resolved per operation category (goods, services, both) by
 * `resolveLegalMention`: `eu_reverse_charge` is its services text, `eu_reverse_charge_goods` its
 * goods exemption text, and a mixed operation prints both.
 */
const CGI_MENTIONS: Record<string, MentionEntry> = {
  eu_domestic: DOMESTIC_NONE,
  eu_reverse_charge: SERVICES_REVERSE_CHARGE,
  eu_reverse_charge_goods: GOODS_EXEMPTION,
  eu_b2c_oss: {
    en: "VAT collected under the EU One-Stop-Shop (OSS) scheme.",
    fr: "TVA collectée dans le cadre du guichet unique OSS de l'Union européenne.",
    de: "Mehrwertsteuer im Rahmen des EU-Verfahrens 'One-Stop-Shop' (OSS) eingezogen.",
  },
  eu_export_non_eu: {
    en: "Export of goods outside the European Union: VAT-exempt under Article 146 of Directive 2006/112/EC.",
    fr: "Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)",
    de: "Ausfuhrlieferung ausserhalb der EU, steuerfrei nach Paragraph 6 UStG.",
  },
  uk_domestic: DOMESTIC_NONE,
  uk_export_eu: {
    en: "Export from the United Kingdom: zero-rated under VATA 1994 s30.",
    fr: "Exportation depuis le Royaume-Uni : TVA à taux zéro.",
    de: "Ausfuhr aus dem Vereinigten Koenigreich, Nullsatz nach VATA 1994.",
  },
  uk_export_non_eu: {
    en: "Export from the United Kingdom: zero-rated under VATA 1994 s30.",
    fr: "Exportation depuis le Royaume-Uni : TVA à taux zéro.",
    de: "Ausfuhr aus dem Vereinigten Koenigreich, Nullsatz nach VATA 1994.",
  },
  us_domestic: {
    en: "Sales tax applied per state; see line items for breakdown.",
    fr: "Taxe de vente applicable par État ; voir les lignes pour le détail.",
    de: "Umsatzsteuer je Bundesstaat; siehe einzelne Posten.",
  },
  us_export: {
    en: "Export from the United States: no US sales tax.",
    fr: "Exportation depuis les États-Unis : non soumis à la taxe de vente américaine.",
    de: "Ausfuhr aus den Vereinigten Staaten, keine US-Umsatzsteuer.",
  },
  ambiguous: {
    en: "VAT treatment under review: please verify with your accountant.",
    fr: "Traitement TVA en cours de vérification : consultez votre comptable.",
    de: "Mehrwertsteuer-Behandlung wird geprueft, bitte mit Buchhalter abklaeren.",
  },
}

export const FR_LEGAL_MENTIONS: Record<"cgi" | "cibs", Record<string, MentionEntry>> = {
  cgi: CGI_MENTIONS,
  // OPEN: CIBS wording pending the accountant's answer; the CGI text is repeated meanwhile.
  cibs: CGI_MENTIONS,
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/

/** The date (YYYY-MM-DD, or "" when unreadable) the dated wordings compare with their start. */
function wordingDateOf(opts: LegalMentionOptions): string {
  return ISO_DATE.exec(String(opts.mentionDate ?? opts.issueDate ?? ""))?.[1] ?? ""
}

/** Which legal period an issue date falls in. A missing or unreadable date is the earlier period. */
export function legalMentionPeriod(
  issueDate: string | null | undefined,
  cibsSwitchDate: string | null | undefined = DEFAULT_CIBS_SWITCH_DATE,
): "cgi" | "cibs" {
  const issued = ISO_DATE.exec(String(issueDate ?? ""))?.[1]
  const switchOn = ISO_DATE.exec(String(cibsSwitchDate ?? ""))?.[1] ?? DEFAULT_CIBS_SWITCH_DATE
  if (!issued) return "cgi"
  return issued >= switchOn ? "cibs" : "cgi"
}

export interface LegalMentionOptions {
  /** Goods, services or both: picks the reverse-charge wording. Unknown reads as services. */
  category?: OperationCategory | null
  /** The document's issue date (YYYY-MM-DD or a timestamp); selects the legal period. */
  issueDate?: string | null
  /** The date the dated wordings read (the services, carriage and overseas mentions). Absent, the
   *  issue date. A document corrected in place passes its correction's date, so the correction
   *  prints the current wording while the document keeps its issue date and legal period. */
  mentionDate?: string | null
  cibsSwitchDate?: string | null
  /** The buyer's kind as the document stored it (`documents.customer_kind`): `individual` picks
   *  the consumer wording of services outside the EU. Unknown reads as a business. */
  customerKind?: string | null
  /** The buyer's tax territory (`vatTerritoryOf`, RE for FR 97411): picks the French overseas
   *  wording. Absent, the general wording applies. */
  taxTerritory?: string | null
  /** The issuer's tax territory (FR, or a department for a seller established there). */
  issuerTerritory?: string | null
  /** The kind of each line (`goods`, `software`, `service`, `shipping`; missing is goods). A
   *  document without goods that carries a shipping line (the services invoice of a split order)
   *  is worded per line: the carriage of an export gets its transport exemption. */
  lineKinds?: ReadonlyArray<string | null | undefined> | null
}

/**
 * Resolve a legal-mention string for the given classification + language.
 * Returns an empty string for domestic treatments (no statutory text required)
 * and the rendered text for export / reverse-charge / OSS / ambiguous.
 * An intra-EU reverse charge is worded by operation category: goods are an exemption (CGI 262 ter I),
 * services a reverse charge (CGI 283-2), a mixed operation prints both.
 */
export function resolveLegalMention(
  treatment: TaxTreatment,
  language: MentionLanguage = "en",
  opts: LegalMentionOptions = {},
): string {
  const table = FR_LEGAL_MENTIONS[legalMentionPeriod(opts.issueDate, opts.cibsSwitchDate)]
  const overseas = overseasMention(treatment, language, opts)
  if (overseas !== null) return overseas
  if (treatment === "eu_reverse_charge") {
    const g = table.eu_reverse_charge_goods ?? GOODS_EXEMPTION
    const goods = g[language] ?? g.en
    const rc = table.eu_reverse_charge ?? SERVICES_REVERSE_CHARGE
    const services = rc[language] ?? rc.en
    if (opts.category === "goods") return goods
    // One sentence each, one period between them, whether or not the goods text ends with one.
    if (opts.category === "mixed") return `${goods.replace(/\.\s*$/, "")}. ${services}`
    return services
  }
  const issuedOn = wordingDateOf(opts)
  const kinds = (opts.lineKinds ?? []).map((k) => k ?? "goods")
  if (
    treatment === "eu_export_non_eu" &&
    issuedOn >= CARRIAGE_LINKED_TO_EXPORT_FROM &&
    kinds.includes("shipping") &&
    !kinds.includes("goods")
  ) {
    // The services invoice of a split order: each line its own wording, the download its place of
    // supply outside France, the carriage its exemption as a transport linked to the export.
    const parts: string[] = []
    if (kinds.some((k) => k === "software" || k === "service")) {
      const wording =
        opts.customerKind === "individual" ? CONSUMER_SERVICES_OUTSIDE_EU : SERVICES_OUTSIDE_EU
      parts.push(wording[language] ?? wording.en)
    }
    parts.push(TRANSPORT_LINKED_TO_EXPORT[language] ?? TRANSPORT_LINKED_TO_EXPORT.en)
    return parts.map((p, i) => (i < parts.length - 1 ? p.replace(/\.\s*$/, "") : p)).join(". ")
  }
  if (
    treatment === "eu_export_non_eu" &&
    (opts.category === "services" || opts.category === "mixed") &&
    issuedOn >= SERVICES_OUTSIDE_EU_FROM
  ) {
    const wording =
      opts.customerKind === "individual" && issuedOn >= CONSUMER_SERVICES_OUTSIDE_EU_FROM
        ? CONSUMER_SERVICES_OUTSIDE_EU
        : SERVICES_OUTSIDE_EU
    const services = wording[language] ?? wording.en
    if (opts.category === "services") return services
    const g = table.eu_export_non_eu ?? SERVICES_OUTSIDE_EU
    const goods = g[language] ?? g.en
    return `${goods.replace(/\.\s*$/, "")}. ${services}`
  }
  const entry = table[treatment]
  if (!entry) return ""
  return entry[language] ?? entry.en ?? ""
}

const OPERATION_LABELS: Record<OperationCategory, MentionEntry> = {
  goods: { en: "Delivery of goods", fr: "Livraison de biens", de: "Lieferung von Waren" },
  services: {
    en: "Provision of services",
    fr: "Prestation de services",
    de: "Erbringung von Dienstleistungen",
  },
  mixed: {
    en: "Delivery of goods and provision of services",
    fr: "Livraison de biens et prestation de services",
    de: "Lieferung von Waren und Erbringung von Dienstleistungen",
  },
}

/** The operation label printed in the document header; empty when no category is recorded. */
export function operationLabel(
  category: OperationCategory | null | undefined,
  language: MentionLanguage = "en",
): string {
  if (!category) return ""
  return OPERATION_LABELS[category]?.[language] ?? ""
}
