// SPDX-License-Identifier: FSL-1.1-ALv2
// Tax regime classifier — pure function consumed by the issuance pipeline (D7)
// and PDF templates (D6). Covers the four v1 issuer regimes (FR / DE / GB / US)
// per spec §2; other EU countries return `unconfigured` until org admins seed
// the `tax_regimes` config table.

import type { OperationCategory } from "./einvoicing/classify-operation"

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
}

export interface ClassifyResult {
  treatment: TaxTreatment
  default_rate_bp: number
  legal_mention_key: string
  requires_hs_code: boolean
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
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT",
  "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI",
  "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY",
  "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK",
  "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL",
  "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR",
  "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS",
  "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW",
  "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP",
  "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM",
  "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF",
  "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW",
  "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
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
  AT: 2000, BE: 2100, BG: 2000, HR: 2500, CY: 1900, CZ: 2100, DK: 2500, EE: 2400, FI: 2550,
  FR: 2000, DE: 1900, GR: 2400, HU: 2700, IE: 2300, IT: 2200, LV: 2100, LT: 2100, LU: 1700,
  MT: 1800, NL: 2100, PL: 2300, PT: 2300, RO: 2100, SK: 2300, SI: 2200, ES: 2100, SE: 2500,
}

/** True for an EU member-state code (case-insensitive). */
export function isEuCountry(code: string | null | undefined): boolean {
  return EU_COUNTRIES.has((code ?? "").trim().toUpperCase())
}

export function classify(input: ClassifyInput): ClassifyResult {
  // Null-safe: a missing/empty country becomes "" which falls through to the unconfigured (issuer)
  // / ambiguous (counterparty) degradations below — issuance proceeds instead of throwing a
  // "cannot read property 'toUpperCase' of undefined" that aborts the whole gated approval (422).
  const issuer = (input.issuer_country ?? "").toUpperCase()
  const counterparty = (input.counterparty_country ?? "").toUpperCase()

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
  cibsSwitchDate?: string | null
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
  const entry = table[treatment]
  if (!entry) return ""
  return entry[language] ?? entry.en ?? ""
}

const OPERATION_LABELS: Record<OperationCategory, MentionEntry> = {
  goods: { en: "Delivery of goods", fr: "Livraison de biens", de: "Lieferung von Waren" },
  services: { en: "Provision of services", fr: "Prestation de services", de: "Erbringung von Dienstleistungen" },
  mixed: {
    en: "Delivery of goods and provision of services",
    fr: "Livraison de biens et prestation de services",
    de: "Lieferung von Waren und Erbringung von Dienstleistungen",
  },
}

/** The operation label printed in the document header; empty when no category is recorded. */
export function operationLabel(category: OperationCategory | null | undefined, language: MentionLanguage = "en"): string {
  if (!category) return ""
  return OPERATION_LABELS[category]?.[language] ?? ""
}
