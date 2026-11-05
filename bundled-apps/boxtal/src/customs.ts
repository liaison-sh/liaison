// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Customs assembly. Maps the invoice customs snapshot (Task 0's extended
// documents_get line projection) to v3 customs articles, with zero re-entry
// when every line's product is already profiled. Pure + deterministic; no
// DB/network.
//
// Join key: each line's `(product_source, external_id)` keys `profilesByRef`
// (which is `${product_source}:${product_id}` → profile). The unit weight comes
// from the matched shipping_profile (or an explicit override), NOT from the
// invoice — invoicing carries no weight.

import { DECLARED_CURRENCY, convertToDeclared, type FxConversion } from "./fx"
import { currencyExponent } from "./money"

const DESCRIPTION_MAX = 64

/** Static EU-member list for the intra-EU customs-omission rule. */
export const EU_MEMBERS = Object.freeze([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
])

export interface CustomsDocLine {
  id: string
  description: string
  quantity: number
  unit_price_minor: bigint
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  product_source: string | null
  external_id: string | null
}

export interface CustomsDoc {
  incoterm: string
  currency: string
}

export interface CustomsArticle {
  /** The source invoice line id — the stable key for persisted overrides. */
  line_id: string
  description: string
  quantity: number
  unitWeight: number | null
  unitValue: { value: number; currency: string }
  originCountry: string | null
  tariffNumber: string | null
  /** Mandatory-but-missing weight, or a non-EUR value we could not convert →
   *  cannot quote/create until resolved. */
  blocked?: boolean
  reason?: "missing_weight" | "fx_unavailable"
  /** hs_code / country_of_origin absent for a non-EU route → Boxtal may 422. */
  incomplete?: boolean
}

/**
 * A `shipment_draft_set_customs` patch as stored per line. The tool schema takes
 * `unitValue` as a plain number in the declared currency; older rows (and direct
 * callers) may carry the article shape `{ value, currency }`. Both are read by
 * `overrideUnitValue`.
 */
export type CustomsPatch = Omit<Partial<CustomsArticle>, "unitValue"> & {
  unitValue?: number | { value: number; currency?: string }
}

/** The declared unit value a persisted patch carries, in either accepted shape. */
export function overrideUnitValue(unitValue: unknown): number | undefined {
  if (typeof unitValue === "number") return Number.isFinite(unitValue) ? unitValue : undefined
  if (unitValue && typeof unitValue === "object") {
    const v = (unitValue as { value?: unknown }).value
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

export interface ArticleOverride {
  description?: string
  unitWeight?: number
  unitValue?: number
  /** Corrected HS/tariff code (e.g. a mis-classified line fixed via set_customs). */
  tariffNumber?: string
  /** Corrected country of origin. */
  originCountry?: string
}

function truncate(s: string): string {
  return s.length > DESCRIPTION_MAX ? s.slice(0, DESCRIPTION_MAX) : s
}

function refKey(source: string | null, id: string | null): string | null {
  if (source == null || id == null) return null
  return `${source}:${id}`
}

/**
 * Build v3 customs articles from the invoice line snapshot. `profilesByRef` is
 * keyed by `${product_source}:${product_id}` → `{ unit_weight }`. `overrides`
 * is keyed by line id and wins over the snapshot/profile without mutating the
 * source `docLines`.
 *
 * DECLARED CURRENCY: every article leaves here in EUR, because that is what
 * Boxtal declares in regardless of the `currency` we send (see fx.ts). A
 * non-EUR invoice is converted with `opts.fx`; without a rate the line is
 * flagged `blocked`/`fx_unavailable` rather than declared at face value in the
 * wrong unit (ticket-10154: a 1000 USD invoice declared as 1000 EUR). Operator
 * overrides are NOT converted — `set_customs` values are entered against the
 * displayed article, which is already the declared (EUR) figure.
 */
export function buildCustomsArticles(
  docLines: CustomsDocLine[],
  doc: CustomsDoc,
  profilesByRef: Record<string, { unit_weight: number }>,
  opts?: { overrides?: Record<string, ArticleOverride>; fx?: FxConversion | null },
): CustomsArticle[] {
  const needsConversion = String(doc.currency ?? "").toUpperCase() !== DECLARED_CURRENCY
  const fx = opts?.fx ?? null
  return docLines.map((line) => {
    const override = opts?.overrides?.[line.id]
    const ref = refKey(line.product_source, line.external_id)
    const profile = ref ? profilesByRef[ref] : undefined

    const unitWeight =
      override?.unitWeight ?? (profile?.unit_weight && profile.unit_weight > 0 ? profile.unit_weight : null)

    const baseDescription = line.customs_description ?? line.description
    const description = truncate(override?.description ?? baseDescription)

    // Minor → major must be exponent-aware: a hardcoded /100 inflates every
    // zero-decimal currency (JPY, KRW …) a hundredfold. Same rule as money.ts.
    const invoiceMajor =
      Number(line.unit_price_minor) / 10 ** currencyExponent(doc.currency)
    // An override is already expressed in the declared currency; only the
    // invoice-derived figure gets converted.
    const converted = needsConversion && fx ? convertToDeclared(invoiceMajor, fx) : invoiceMajor
    const unitValueNumber = override?.unitValue ?? converted
    // Blocked only when we would otherwise declare an unconverted foreign
    // amount: an operator-entered override is authoritative and unblocks it.
    const fxUnresolved = needsConversion && !fx && override?.unitValue == null

    const tariffNumber = override?.tariffNumber ?? line.hs_code ?? null
    const originCountry = override?.originCountry ?? line.country_of_origin ?? null

    const article: CustomsArticle = {
      line_id: line.id,
      description,
      // Invoicing quantities arrive as decimal STRINGS ("1.000") despite the
      // number type — passed through, they reach Boxtal's shipping-order JSON
      // as a string quantity and the whole create 400s (opaque BAD_REQUEST,
      // prod 2026-07-20; only exports carry customs, so EU labels never hit it).
      quantity: Number(line.quantity),
      unitWeight,
      // Always the DECLARED currency: either the invoice was already EUR, or
      // the value above is the converted one, or the line is blocked below.
      unitValue: { value: unitValueNumber, currency: DECLARED_CURRENCY },
      originCountry,
      tariffNumber,
    }
    // Weight first: it is the more actionable defect when a line has both.
    if (unitWeight == null) {
      article.blocked = true
      article.reason = "missing_weight"
    } else if (fxUnresolved) {
      article.blocked = true
      article.reason = "fx_unavailable"
    }
    if (tariffNumber == null || originCountry == null) {
      article.incomplete = true
    }
    return article
  })
}

/**
 * Count articles whose mandatory fields are empty (the zero-re-entry metric).
 * `blocked` (missing weight) always counts — weight is mandatory on every route.
 * `incomplete` (missing hs_code/origin) counts ONLY when the route requires a
 * customs declaration; on an intra-EU route no customs data is needed, so an
 * `incomplete` article is not a re-entry burden (M1). Defaults to counting
 * `incomplete` (customs-required) for backwards compatibility.
 */
export function countMandatoryEmpty(
  articles: CustomsArticle[],
  customsRequired = true,
): number {
  return articles.filter(
    (a) => a.blocked || (customsRequired && a.incomplete),
  ).length
}

/**
 * Decide whether a route needs a customs declaration. Intra-EU → false.
 * An explicit invoice flag (`requires_hs_code`-style) wins when set.
 */
export function requiresCustoms(
  fromCountry: string,
  toCountry: string,
  invoiceFlag?: boolean,
): boolean {
  if (invoiceFlag !== undefined) return invoiceFlag
  const fromEu = EU_MEMBERS.includes(fromCountry.toUpperCase())
  const toEu = EU_MEMBERS.includes(toCountry.toUpperCase())
  return !(fromEu && toEu)
}

/** The row-level shipment category (prep_state.category / the order-prep grid's editable field). */
export type PrepCategory = "sale" | "repair" | "gift" | "return"

/**
 * Resolve a row's prep-grid category from a loaded `prep_state` row, defaulting to "sale" when no
 * row exists yet (the invoice was never touched via prep_set_category) or the stored value is
 * unset. The single source of truth for this default — shared by prep.ts's buildRow/prepSync and
 * shipment.ts's shipmentDraftCreate, which previously each re-implemented the same
 * `(state?.category as PrepCategory | undefined) ?? "sale"` fallback independently.
 */
export function resolvePrepCategory(state: { category?: string | null } | null | undefined): PrepCategory {
  return (state?.category as PrepCategory | undefined) ?? "sale"
}

/** Boxtal v3 customs-declaration `reason` enum values this app ever selects. */
export type CustomsBasis = "SALE" | "REPAIR" | "GIFT" | "RETURN"

/**
 * Map a prep-grid category to the Boxtal customs-declaration `reason` (the customs BASIS a
 * customs officer reads to decide duty treatment — a repair return, a gift, or a commercial
 * sale are declared differently even on the same physical parcel). Deterministic 1:1 mapping:
 * sale -> SALE (merchandise, dutiable), gift -> GIFT (often duty-exempt under a threshold),
 * repair/return -> REPAIR/RETURN (no new sale, typically duty-exempt on re-entry). Unknown/
 * missing category defaults to SALE (the safe default: a real transaction, dutiable).
 */
export function categoryToCustomsBasis(category: PrepCategory | string | null | undefined): CustomsBasis {
  switch (category) {
    case "repair":
      return "REPAIR"
    case "gift":
      return "GIFT"
    case "return":
      return "RETURN"
    case "sale":
    default:
      return "SALE"
  }
}

/** v3 content-category string → v1 numeric `code_contenu`. */
export function contentCategoryNumeric(v3: string): string {
  const m = v3.match(/(\d+)\s*$/)
  return m ? m[1]! : v3
}

/** v1 numeric `code_contenu` → v3 content-category string. */
export function contentCategoryV3(numeric: string): string {
  return `content:v1:${numeric}`
}
