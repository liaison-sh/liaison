// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared row + filter types for the dashboard layer. The DocumentRow shape
// is the kernel-flattened header form returned by
// `invoicing:documents.search` (E5 / reads.ts); per-dashboard accessors live
// in `columns.ts`. Filter shape lives here so Toolbar + each dashboard can
// share the same chip + date-range state.

export interface DocumentRow {
  id: string
  type: "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"
  status: string
  payment_status?: string
  number?: string | null
  number_int?: number | null
  year_of_issue?: number | null
  issuer_profile_id?: string
  counterparty_contact_id?: string | null
  counterparty_name?: string | null
  destination_country?: string | null
  channel?: "shopify" | "manual"
  /** The HUMAN store order reference ("#1149") this document bills, when it came
   *  from a Shopify order. Null/absent for manual documents. */
  shopify_order_number?: string | null
  /** The Shopify order this document bills (its numeric id or gid), when it came from one. */
  shopify_order_id?: string | null
  /** The customer's purchase order number, when they gave one. Null/absent otherwise. */
  po_number?: string | null
  /** Split-order half, when this document is one of a goods/software pair. */
  scope?: "goods" | "software" | null
  /** The id of the invoice this credit note credits
   *  (`external_refs.original_document_id`). Null/absent for anything that is
   *  not a credit note. */
  original_document_id?: string | null
  /** The visible number of the invoice this credit note credits, for the
   *  on-row "Credits INV-..." text. */
  original_document_number?: string | null
  /** Visible numbers of this document's own ISSUED credit notes (server-derived from
   *  lifecycle_log, see reads.ts). Powers the "Credited by ..." indicator on the invoice row
   *  even when the credit note itself is not in the current view. */
  credited_by_numbers?: string[]
  currency: string
  subtotal_minor?: bigint | number
  tax_total_minor?: bigint | number
  grand_total_minor: bigint | number
  tax_treatment?: string | null
  incoterm?: string | null
  issued_at?: string | null
  due_at?: string | null
  paid_at?: string | null
  hs_codes?: string[]
  /** Days since due_at; rendered on awaiting-payment. */
  days_overdue?: number
  /** Last lifecycle_log event label; rendered on awaiting-payment. */
  last_action?: string | null
  /** Group rollup count; rendered on B2B / By-market. */
  group_count?: number
  /** Customs documents under this group; rendered on By-market. */
  customs_documents_count?: number
}

export type StatusFilter = "all" | "issued" | "paid" | "overdue" | "refunded"
export type MarketFilter = "all" | "eu" | "non_eu" | string // country code for per-country drilldown
export type ChannelFilter = "all" | "shopify" | "manual"
export type BuyerTypeFilter = "all" | "b2b" | "b2c"
/** Issue-date order of the list. Applied server-side by documents_search. */
export type SortOrder = "newest" | "oldest"

export interface DashboardFilter {
  /** Free-text search — matches document number and counterparty name.
   *  Empty string = no search. Applied server-side by documents_search. */
  query: string
  /** ISO date (yyyy-mm-dd); null = unbounded. */
  date_from: string | null
  date_to: string | null
  status: StatusFilter
  market: MarketFilter
  channel: ChannelFilter
  buyer_type: BuyerTypeFilter
  sort: SortOrder
}

export const DEFAULT_FILTER: DashboardFilter = {
  query: "",
  date_from: null,
  date_to: null,
  status: "all",
  market: "all",
  channel: "all",
  buyer_type: "all",
  sort: "newest",
}

/**
 * Split rows by draft-ness for the tab they belong to. Drafts have their own
 * "Drafts" tab and must NOT bleed into the type tabs (invoices/quotes/...) or
 * the "all" tab — those show only issued-and-later documents. On the Drafts tab
 * we show ONLY status='draft'. Pure + unit-testable.
 */
export function filterRowsForTab<T extends { status: string }>(
  rows: T[],
  draftsOnly: boolean,
): T[] {
  return draftsOnly
    ? rows.filter((r) => r.status === "draft")
    : rows.filter((r) => r.status !== "draft")
}

/**
 * Apply the filter to a row list — pure function, no side-effects, fully
 * unit-testable. Date range comparisons use half-open semantics on issued_at
 * (issued_at >= date_from AND issued_at <= date_to), so the boundary day
 * is inclusive on both ends per spec §12 dashboard edge cases.
 */
export function applyFilter(rows: DocumentRow[], f: DashboardFilter): DocumentRow[] {
  return rows.filter((r) => {
    // `issued_at` arrives as a full timestamp ("2026-07-24 00:00:00+00") while
    // the bounds are bare "YYYY-MM-DD". Compare on the date portion only, or the
    // `date_to` bound wrongly excludes every row issued ON the boundary day
    // (the same-day timestamp sorts after the bare date string).
    const day = r.issued_at ? r.issued_at.slice(0, 10) : ""
    if (f.date_from && day < f.date_from) return false
    if (f.date_to && (day === "" || day > f.date_to)) return false
    if (f.status !== "all" && r.status !== f.status) return false
    if (f.channel !== "all" && (r.channel ?? "manual") !== f.channel) return false
    // B2B inferred from vat_id / relationship — DocumentRow exposes neither
    // directly, so we treat the field as a passthrough hint set by the
    // server-side search. When the row lacks the hint, both filters miss
    // and the row is excluded from the buyer-type-specific view.
    if (f.buyer_type !== "all") {
      const isB2B = (r as { is_b2b?: boolean }).is_b2b === true
      if (f.buyer_type === "b2b" && !isB2B) return false
      if (f.buyer_type === "b2c" && isB2B) return false
    }
    if (f.market !== "all") {
      const country = r.destination_country ?? ""
      if (f.market === "eu") {
        if (!EU_COUNTRIES.has(country)) return false
      } else if (f.market === "non_eu") {
        if (EU_COUNTRIES.has(country)) return false
      } else if (f.market.length === 2) {
        // Per-country drilldown — ISO 3166-1 alpha-2 codes are uppercase
        // strings; "eu" / "non_eu" already handled above, so anything else
        // 2-chars-long is a country code.
        if (country !== f.market) return false
      }
    }
    return true
  })
}

// EU-27 country codes. Source: spec §"Tax Treatment" — kept here in plain
// constant form so the dashboards don't reach into tax.ts (which the
// purity guard would let through, but keeping ui/dashboards self-contained
// keeps the bundle-tree shallow).
export const EU_COUNTRIES = new Set([
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
