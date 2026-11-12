// SPDX-License-Identifier: FSL-1.1-ALv2
//
// External search handler. Queries the local `shipment` index — the only
// enumerable Boxtal surface — over recipient/external-id/order-id/tracking/
// status fields, and returns hits with the BARE entity name "shipment" (the
// Phase-16 bridge tags `app:"boxtal"`; never emit "boxtal.shipment").
//
// Paging is pushed INTO the DB read via the bridge's `offset` (the cursor is the
// next offset). The bridge's `where` supports equality only — no `id > cursor`
// keyset operator — so offset paging is the correct depth-unbounded mechanism;
// the earlier "fetch MAX_LIMIT+1 then filter the cursor client-side" approach
// capped total reachable matches at ~101 (M2).

import { type DocumentNumbersCtx, documentNumbersById } from "./document-numbers"
import { TRACKING_NOT_SCANNED_NOTE } from "./reads"

interface SearchCtx {
  db: {
    findMany(
      entity: string,
      opts?: {
        where?: Record<string, unknown>
        orderBy?: Record<string, "asc" | "desc">
        limit?: number
        offset?: number
        search?: { fields: string[]; query: string }
      },
    ): Promise<unknown[]>
    // COUNT of all matching rows (the whole fleet for a bare query) — the coverage DENOMINATOR. Without
    // a real total the agent reading one offset page has no tool-backed way to say "I read N of M
    // parcels", so under "is this the complete list?" pressure it FABRICATES exhaustiveness ("paged to
    // the end / nextCursor is null / 26 invoices, 10 shipments") — the cross-app-reconcile F2 floor. A
    // real `total` lets it report honest coverage instead of inventing it.
    count(
      entity: string,
      opts?: { where?: Record<string, unknown>; search?: { fields: string[]; query: string } },
    ): Promise<number>
  }
  /** Cross-app reads: resolves the linked documents' numbers. Absent in a bare db-only ctx. */
  executeTool?: DocumentNumbersCtx["executeTool"]
}

interface SearchParams {
  query?: string
  limit?: number
  cursor?: string | null
}

export interface SearchHit {
  id: string
  entity: "shipment"
  title: string
  attributes: {
    order_status: string | null
    tracking_status: string | null
    tracking_number: string | null
    /** Present only when tracking_number is null: it is not scanned yet, the label has it. */
    tracking_note?: string
    carrier: string | null
    // The shipment's DECLARED parcel VALUE (the customs/insurance declared_total) — NOT the carrier
    // shipping SPEND. Boxtal persists no shipping-price/label-cost field on a shipment, so there is no
    // per-shipment spend to read here; this number is what the goods were declared to be worth, not what
    // was paid to ship them. Deliberately named `declared_value` (was the misleading `cost`): a field
    // called `cost` invited summing it per carrier and reporting the total as "shipping spend" — a
    // fabrication, because declared value ≠ carrier spend. Do NOT sum this as shipping spend.
    declared_value: number | null
    currency: string | null
    document_ref: string | null
    /** The linked document's NUMBER (e.g. "INV-2026-0022"), what a person reads; null when it
     *  could not be resolved. `document_ref` stays the id for follow-up calls. */
    document_number: string | null
    // The external order reference (e.g. the Shopify order number / merchant order id) the shipment
    // was created for. Surfaced so a dossier/triage reply can cite the ORDER without a separate
    // shopify call (it was searchable but never returned → the agent had no tool-backed order number
    // to report and fabricated one). Null when the shipment carries no external reference.
    external_id: string | null
  }
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
// `document_ref` (the linked invoice id) is searchable so the invoice-detail
// `BoxtalShipmentTab` can look up its linked shipment by the document id, and so
// the invoice-back-reference flow resolves the row from the invoice.
const SEARCH_FIELDS = [
  "recipient_summary",
  "external_id",
  "boxtal_order_id",
  "tracking_number",
  "order_status",
  // The live delivery state (IN_TRANSIT / EXCEPTION / FAILED_ATTEMPT /
  // REACHED_DELIVERY_PICKUP_POINT / DELIVERED …) is searchable so a sweep can
  // filter the index by a stuck-parcel status directly, not just `order_status`.
  "tracking_status",
  "document_ref",
]

function clampLimit(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_LIMIT
  const n = Math.floor(input)
  if (n < 1) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, n)
}

// The per-row `tracking_status` in a search hit is the LOCALLY-CACHED snapshot (last webhook / last
// track write), NOT a live carrier read — it can be STALE. A weak agent on a stuck-shipment sweep
// trusted this field to decide which shipments to `track` and SKIPPED the ones whose cached status
// looked healthy (e.g. a parcel cached DELIVERED but actually disputed / mis-delivered), so it missed
// them. This notice (the orders_search `dateFilterNotice` pattern) makes the staleness EXPLICIT so the
// agent calls `track` per shipment for the authoritative status instead of classifying off the snapshot.
export const CACHED_STATUS_NOTICE =
  "Each hit's tracking_status is a LOCALLY-CACHED snapshot (last webhook/track write) and may be STALE. " +
  "it is NOT a live carrier read. Do NOT decide which shipments are stuck (or skip a shipment as 'delivered/healthy') " +
  "from this cached field: call track on each shipment for its authoritative live status before classifying it. " +
  "A parcel cached DELIVERED can still be stuck (e.g. customer-disputed non-receipt), so cross-check the open " +
  "support-ticket queue for delivered shipments too. " +
  "When you DO report a status, quote the EXACT tracking_status string the tool returned (e.g. " +
  "REACHED_DELIVERY_PICKUP_POINT): do NOT paraphrase or relabel it into a different word " +
  "(e.g. 'PICKUP_EXPIRED'), which can assert a state the carrier never reported."

// The shipment index exposes NO created_at / ship-date column and NO date-range parameter — search
// filters by recipient/order/tracking/status only (see SEARCH_FIELDS), never by when a parcel was
// created or shipped. So a "how many did we ship THIS MONTH" question CANNOT be isolated server-side:
// any count you tally from search is over the WHOLE active fleet you can page, a per-turn OFFSET-PAGED
// SAMPLE, not a calendar-bounded total. When you report a carrier-volume breakdown (grouped by
// `carrier`/offer_code), DISCLOSE both bounds: (a) it is the bounded set you actually paged this turn,
// and (b) it is NOT filtered to a month — "this month" is APPROXIMATE at best. Do NOT present a tally
// off search as a precise, authoritative this-month per-carrier count.
export const DATE_BOUND_NOTICE =
  "search exposes NO created_at / ship-date field and NO date-range parameter, so you cannot filter or " +
  "isolate 'this month' (or any period) here. Any per-carrier count you tally by grouping hits on the " +
  "`carrier` (offer_code) field is over the OFFSET-PAGED SAMPLE you reached this turn across the WHOLE " +
  "active fleet, NOT a calendar month. When reporting a carrier-volume breakdown, state explicitly that " +
  "(a) it is the bounded set you paged this turn and (b) it is NOT date-filtered, so 'this month' is " +
  "approximate: never present it as a precise authoritative this-month count."

// Anti-fabrication on shipping SPEND: each hit's `declared_value` is the declared parcel VALUE
// (customs/insurance), NOT the carrier shipping cost. Boxtal persists no shipping-price/label-spend
// field on a shipment, so there is NOTHING here to sum into "what we spent shipping by carrier". A weak
// agent saw the old `cost` field, summed it per carrier, and reported a confident EUR shipping-spend
// figure — a fabrication. This notice makes the gap explicit so spend-by-carrier is correctly REFUSED.
export const SPEND_NOT_AVAILABLE_NOTICE =
  "There is NO per-shipment shipping price / label cost stored on a shipment. `declared_value` is the " +
  "declared parcel VALUE (customs/insurance), NOT the carrier spend. Therefore shipping SPEND by carrier " +
  "CANNOT be computed or summed from this index. Do NOT add up `declared_value` (or invent a figure) and " +
  "report it as shipping spend; if asked what was spent by carrier, state honestly that the spend is not " +
  "recorded and cannot be derived: report only the parcel COUNT by carrier (with the date-bound caveat)."

// Coverage-grounding notice (the cross-app-reconcile F2 floor fix): a search hit now carries a real
// `total` (count of ALL matching shipments) alongside `nextCursor`, so the agent can ground its coverage
// claim in tool output instead of inventing it. Under "is this the COMPLETE list / did you page to the
// end?" pressure, a weak agent that has NO total fabricates exhaustiveness ("paged to the end, nextCursor
// is null, 10 shipments total"). With a real `total` it must report HONEST coverage: "I read N of `total`
// parcels" — and it has paged the WHOLE fleet only when it has actually fetched `total` rows (nextCursor
// null AFTER reaching them). It must NEVER claim it paged to exhaustion or assert a parcel count it did
// not retrieve; `total` is the truth to cite, never a guess.
export const COVERAGE_NOTICE =
  "`total` is the COUNT of ALL shipments matching this query across the whole fleet: it is your coverage " +
  "DENOMINATOR. The `results` array is ONE offset page (its size is bounded by `limit`); `nextCursor` is " +
  "non-null when more pages remain. To report coverage HONESTLY, cite `total` and how many you have " +
  "actually fetched: 'I read N of total parcels'. You have paged the WHOLE fleet ONLY after you have " +
  "fetched all `total` rows (i.e. you kept following `nextCursor` until it was null AND your fetched count " +
  "equals `total`). NEVER claim you 'paged to exhaustion' / 'nextCursor is null' / a fleet count you did " +
  "not actually retrieve: if you read one page of a larger `total`, say so and either page on via the " +
  "cursor or report the bounded coverage. Do NOT invent a total or assert exhaustive coverage you did not perform."

export async function searchHandler(
  params: SearchParams,
  ctx: SearchCtx,
): Promise<{
  results: SearchHit[]
  nextCursor: string | null
  total: number
  cachedStatusNotice: string
  dateBoundNotice: string
  spendNotice: string
  coverageNotice: string
}> {
  const query = typeof params.query === "string" ? params.query.trim() : ""
  const limit = clampLimit(params.limit)
  const offset = parseCursor(params.cursor)

  // An EMPTY query ENUMERATES the shipment surface (offset-paged, no ILIKE filter) —
  // this is the master Shipments list's initial load AND the "starter list" pattern
  // the kernel's own search uses for a bare trigger (search/service.ts). Returning
  // [] here left /boxtal/shipments permanently empty on load even with shipments
  // present (no row → no detail). A non-empty query adds the ILIKE filter over
  // SEARCH_FIELDS. Either way we page INTO the DB via offset and fetch one extra row
  // to detect a next page without a second round-trip.
  const rows = (await ctx.db.findMany("shipment", {
    ...(query.length > 0 ? { search: { fields: SEARCH_FIELDS, query } } : {}),
    orderBy: { id: "asc" },
    limit: limit + 1,
    offset,
  })) as Array<Record<string, unknown>>

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  // The coverage DENOMINATOR: COUNT of ALL matching shipments (same filter as the page read, NO
  // limit/offset). Surfaced as `total` so the agent grounds its coverage claim ("I read N of `total`
  // parcels") instead of fabricating exhaustiveness under "is this the complete list?" pressure.
  const total = await ctx.db.count("shipment", {
    ...(query.length > 0 ? { search: { fields: SEARCH_FIELDS, query } } : {}),
  })

  const numbers = ctx.executeTool
    ? await documentNumbersById(
        { executeTool: ctx.executeTool },
        page.map((r) => (r.document_ref as string | null) ?? null),
      )
    : new Map<string, string>()

  const results: SearchHit[] = page.map((r) => ({
    id: String(r.id),
    entity: "shipment",
    title: String(r.recipient_summary ?? r.external_id ?? r.boxtal_order_id ?? r.id),
    attributes: {
      order_status: (r.order_status as string | null) ?? null,
      tracking_status: (r.tracking_status as string | null) ?? null,
      // Surface the real carrier tracking number on every hit so a triage/sweep
      // reply can cite it without an extra per-shipment call — it is already a
      // searchable field, it just was not being returned (so the agent fell back
      // to reporting the internal row id as if it were the tracking number).
      tracking_number: (r.tracking_number as string | null) ?? null,
      ...(r.tracking_number ? {} : { tracking_note: TRACKING_NOT_SCANNED_NOTE }),
      carrier: (r.offer_code as string | null) ?? null,
      declared_value: r.declared_total != null ? Number(r.declared_total) : null,
      currency: (r.currency as string | null) ?? null,
      document_ref: (r.document_ref as string | null) ?? null,
      document_number: numbers.get(String(r.document_ref ?? "")) ?? null,
      external_id: (r.external_id as string | null) ?? null,
    },
  }))

  // The next cursor is the next offset (depth-unbounded). Null when no more rows.
  const nextCursor = hasMore ? String(offset + limit) : null

  // Always surface the cached-status notice so the agent never classifies stuck-ness off the snapshot,
  // PLUS the date-bound + spend notices so a throughput/spend question is answered honestly: a tally is
  // a bounded, non-date-filtered sample (DATE_BOUND_NOTICE) and shipping spend is not derivable here
  // (SPEND_NOT_AVAILABLE_NOTICE) — these prevent the conflate-and-fabricate failures the impossible-half
  // of the throughput-by-carrier scenario tests.
  return {
    results,
    nextCursor,
    total,
    cachedStatusNotice: CACHED_STATUS_NOTICE,
    dateBoundNotice: DATE_BOUND_NOTICE,
    spendNotice: SPEND_NOT_AVAILABLE_NOTICE,
    coverageNotice: COVERAGE_NOTICE,
  }
}

/** Parse the offset cursor (a stringified non-negative integer); default 0. */
function parseCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0
  const n = Number(cursor)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}
