// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Order Prep Dashboard backend — replaces the to_prepare_list-only worklist with a rich,
// editable per-invoice worklist (prep_list) plus a refresh pass (prep_sync) that pulls Shopify
// order metadata and quotes/re-quotes each row's shipping cost, caching the result (prep_quote,
// TTL 12h) keyed by a hash of the route+parcels+category so an unedited row is never re-quoted
// needlessly. Category (prep_state.category) and exclusion (prep_state.excluded) are per-row
// operator edits, persisted independently of the virtual draft.
//
// prep_list is a FREE READ: never calls a live Shopify or Boxtal API — only local tables + the
// existing to_prepare selection + the virtual draft resolver (shipmentDraftCreate, which itself
// only makes same-org invoicing/kernel reads, never a live carrier/store call). prep_sync is the
// only tool here that talks to a live Shopify / Boxtal API.

import { isUniqueViolation } from "./db-errors"
import { generateOrderDocuments } from "./customs-documents"
import { shipmentDraftCreate } from "./shipment"
import { quote } from "./shipment"
import {
  liveShipmentsByAnchor,
  worklistCandidates,
  noAnchorReason,
  type ShipmentCoverage,
} from "./queues"
import {
  coverageMovedSince,
  isDraftCacheStale,
  loadDraftCache,
  mapWithConcurrency,
  resolveDrafts,
  RESOLVE_LIMIT,
  type DraftCacheRow,
} from "./draft-cache"
import { lookupOrderForPrefill, openOrdersScan, type AnchorKind, type OrderCandidate } from "./orders"
import type { BoxtalToolCtx } from "./ctx"
import type { Parcel } from "./resolver"
import { resolvePrepCategory, type PrepCategory } from "./customs"
import { toMinor } from "./money"
import { businessDaysBetween } from "./quote-batch"
import { postalCodeRequired, stateRequired, validateRecipientPhone } from "./address"
import { isPickupPointOffer } from "./carriers"
import { pickSelectedOffer } from "./prep-selection"
import { EMPTY_PRODUCT_CODE_CONFIG, orderProductsSummary, type ProductCodeConfig, shortProductCode } from "./product-codes"
import { loadProductCodeConfig } from "./settings"
// prep_meta lives in its own module (both this file and shipment.ts write it); `fetchShopifyOrderMeta`
// is re-exported below because it was always part of this module's surface.
import {
  backfillContactShippingAddress,
  cacheShipToIfStale,
  SHIP_TO_REFRESHES_PER_SYNC,
  type ShipToRefreshBudget,
  fetchShopifyOrderMeta,
  upsertPrepMeta,
} from "./prep-meta"
import {
  numericOrderId,
  orderKeyForDocument,
  orderKeyForDocumentRef,
  orderKeyForPendingProforma,
  orderKeyForShopifyOrder,
  parseOrderKey,
  upsertPrepOrderState,
  type PrepOrderItem,
  type PrepOrderStateRow,
  type PrepRecipient,
  type PrepStatus,
} from "./order-state"
import {
  ensureNominalProforma,
  type NominalCategory,
  type ProformaCounterparty,
  type ProformaItem,
} from "./proforma"
import { ToolError } from "@liaison/app-sdk"
import type { AddressCheck } from "./address-check"

// The per-ORDER state surface (status, exclusion, category, proforma refs) lives in order-state.ts;
// re-exported here so the handler barrel and every existing importer keep one import site.
export { prepExclude, prepRestore, prepSetStatus, prepSetValidated } from "./order-state"
export type {
  PrepExcludeInput,
  PrepOrderItem,
  PrepOrderStateRow,
  PrepRecipient,
  PrepSetStatusInput,
  PrepSetValidatedInput,
  PrepStatus,
} from "./order-state"

const LAST_SYNC_KEY = "prep_last_sync_at"
const QUOTE_TTL_MS = 12 * 60 * 60 * 1000 // 12h
const META_TTL_MS = 12 * 60 * 60 * 1000 // 12h, order tags can change after import
const DEFAULT_SYNC_LIMIT = 25

// ── row shapes ───────────────────────────────────────────────────────────────

export interface PrepOffer {
  carrier: string
  /** Carrier service name (e.g. "Chrono 13", "UPS Access Point") — shown in the offer dropdown. */
  service: string
  offer_code: string
  price_ht_minor: number
  /** TTC price in minor units — carried so staging can pass quoted_price_ttc without a re-quote. */
  price_ttc_minor: number
  currency: string
  delivery_date: string | null
  eta_business_days: number | null
  /** True when this offer delivers to a relay / pickup point (badge relais vs domicile). With the
   *  org pickup-point policy ON, relay offers are filtered out before caching, so this is normally
   *  false; it can be true only when the policy is off or a relay offer was included deliberately. */
  is_pickup_point: boolean
}

export interface PrepQuoteView {
  cheapest: PrepOffer | null
  alternates: PrepOffer[]
  /** Every cached offer for this row, cheapest-first — the source list for the row's offer dropdown. */
  offers: PrepOffer[]
  /** The operator's persisted offer choice (raw code), or null when none chosen. */
  selected_offer_code: string | null
  /** The chosen offer resolved against the current cached offers — null when no choice, the choice
   *  no longer matches a cached offer, or the quote is stale (the choice is invalidated with the
   *  quote). The offer staging uses is `selected ?? cheapest`. */
  selected: PrepOffer | null
  quoted_at: string | null
  /** True when the cached quote's input_hash no longer matches the row's current route/parcels/
   *  category (an edit happened since the last quote) — the UI should invite a re-sync. */
  stale: boolean
}

export type PrepRowState = "ready" | "needs_fix" | "quote_missing" | "not_synced" | "needs_document"

/** What the row's Invoice control shows.
 *
 *  `generating` is deliberately NOT emitted by this backend: deciding it for a whole worklist would
 *  cost one `documents_download_pdf` per row, the O(rows) cost this rework exists to remove. It is
 *  entered by the UI, by the download interaction that actually needs the file, when
 *  `prep_document_pdf` answers `generating: true` (see PrepGrid's downloadInvoice + pollPlan's
 *  `invoice_pdf` cadence). Keep both halves in mind before "cleaning up" the state as unused. */
export type PrepInvoiceState =
  | "issued"
  | "pending_approval"
  | "generating"
  | "missing"
  | "not_available"

export interface PrepInvoiceView {
  state: PrepInvoiceState
  document_id: string | null
  number: string | null
  /** The approval the app itself parked when it issued the proforma. NEVER guessed for a sale
   *  invoice: the auto-issue flow parks its own approval without creating a document row, so the
   *  app cannot see it and must say "no invoice yet" rather than invent a pending state. */
  approval_id: string | null
  kind: AnchorKind | null
}

export interface PrepShipmentView {
  id: string
  has_label: boolean
  tracking_number: string | null
  order_status: string | null
  created_at: string | null
}

export interface PrepRecipientView extends PrepRecipient {
  /** True when every field a label buy needs is on file. */
  complete: boolean
  /** Names of the fields a label buy still needs, e.g. ["email", "phone"]. Empty when complete. */
  missing_fields: string[]
}

export interface PrepRow {
  /** Row identity. `so:<shopify order id>`, or `doc:`/`pending:` for an order-less row. */
  order_key: string
  /** The ANCHOR document: what the draft, parcels, customs articles and quote derive from. NULL
   *  while nothing is issued; every consumer must handle that. */
  document_ref: string | null
  anchor_kind: AnchorKind | null
  invoice_ref: string
  order_name: string | null
  order_created_at: string | null
  customer: string
  destination: string
  order_tags: string[]
  /** e.g. "1xES, 1xET2" — from the cached draft resolution, or from the order's line items when
   *  the row has no document yet. */
  products: string
  grand_total_minor: number | null
  currency: string | null
  /** What the customer paid for shipping on the Shopify order, in minor units of
   *  `customer_shipping_currency` (the order's currency). Null when not known. */
  customer_shipping_minor: number | null
  customer_shipping_currency: string | null
  parcels: Parcel[]
  package_count: number
  category: PrepCategory
  /** The row's single status: to_prepare / validated / on_hold. The whole row is tinted from it. */
  status: PrepStatus
  status_note: string | null
  /** The Shopify order's internal staff note, editable inline from the grid (prep_set_note). */
  staff_note: string | null
  quote: PrepQuoteView
  state: PrepRowState
  reason?: string
  excluded: boolean
  /** Back-compat mirror of `status === "validated"` for anything still reading the old flag. */
  validated: boolean
  invoice: PrepInvoiceView
  /** The live outbound shipment covering this row's anchor, or null when nothing is bought yet. */
  shipment: PrepShipmentView | null
  recipient: PrepRecipientView | null
  /** A person typed or corrected this row's recipient place (street, city or postal code). Only
   *  then does a Ship click send the recipient; otherwise the server resolves the address. */
  recipient_edited?: true
  partially_shipped?: boolean
  remaining_units?: number
  recipient_phone_issue?: string
  /** Present only once the customer has a VERIFIED delivery address (address-check.ts): whether
   *  the order's address matches it. `differs` with no `choice` holds the row until a person picks
   *  (prep_set_address_choice). Absent for a customer with none, whose row is as it always was. */
  address_check?: AddressCheck
}

export interface PrepListInput {
  search?: string
  country?: string
  tag?: string
  product?: string
  include_excluded?: boolean
  /** Restrict to validated (true) or not-yet-validated (false) rows. Omit for both. */
  validated?: boolean
  /** Restrict to one status. */
  status?: PrepStatus
  /**
   * ROW-SCOPED READ. When present the whole-worklist scan is skipped and ONLY these rows are read
   * (one orders_get each plus one documents_for_orders), with their drafts resolved. This is what
   * a row action calls to patch its own row instead of re-listing the grid.
   */
  order_keys?: string[]
}

export interface PrepListResult {
  rows: PrepRow[]
  total: number
  last_sync_at: string | null
  /** True when the order scan hit its cap, so this is a prefix of the backlog. Disclosed in the UI. */
  truncated: boolean
  /** Readable reason Shopify or invoicing could not be read; the rows are then cached data. */
  last_sync_error: string | null
  /** False when the invoicing app is not installed: no row can carry an invoice. */
  invoicing_available: boolean
}

// ── local row shapes (mirror the schema tables) ───────────────────────────────

interface PrepMetaRow {
  document_ref: string
  shopify_order_id?: string | null
  order_name?: string | null
  order_tags?: string[] | null
  order_created_at?: string | null
  /** Refund/cancel facts. A refunded or cancelled order is never shippable
   *  and must never reach the queue. See order-shippability.ts. */
  financial_status?: string | null
  cancelled_at?: string | null
  fetched_at?: string | null
}

interface PrepQuoteRow {
  document_ref: string
  input_hash?: string | null
  offers?: PrepOffer[] | null
  quoted_at?: string | null
  /** Why the last quote attempt produced no offers (Boxtal's error, or "no offers returned").
   *  Cleared by the next successful quote; read by buildRow so `quote_missing` explains itself. */
  quote_error?: string | null
}

interface PrepStateRow {
  document_ref: string
  category?: PrepCategory | null
  excluded?: boolean | null
  /** The operator has checked this row and cleared it to be prepared/shipped.
   *  A deliberate human act, so "prepare docs for all validated shipments" can
   *  be answered from a fact instead of a guess. Parallel to `excluded`. */
  validated?: boolean | null
  validated_at?: string | null
  /** The operator's persisted offer choice for this row (an offer_code from the cached quote), or
   *  null/absent when they have not chosen one (staging then defaults to the cheapest). */
  selected_offer_code?: string | null
}

// NOTE: this ideally would scope the read to the candidate document_refs (an IN-list) rather than
// pulling up to 1000 rows and filtering client-side in memory. The generic DbClient bridge
// (packages/app-sdk/src/types.ts) only supports EXACT-match `where` (no IN/array support) — every
// other caller of `findMany` in this app that filters by a set (e.g. queues.ts's
// liveShipmentCoverage)
// does the same full-scan-then-filter, so this is the established pattern here, not a regression.
// Kept at `limit: 1000` (the existing bound) until the bridge grows IN support.
async function loadByDocumentRef<T extends { document_ref: string }>(
  ctx: BoxtalToolCtx,
  entity: string,
): Promise<Map<string, T>> {
  const rows = (await ctx.db.findMany(entity, { limit: 1000 })) as T[]
  const out = new Map<string, T>()
  for (const r of rows) out.set(r.document_ref, r)
  return out
}

/** The hash input for a row's quote cache: route (destination country) + parcels (dims/weight) +
 *  category — anything that changes the carrier price. Order-independent over parcels would be
 *  more robust to a resort, but parcels are always derived deterministically (resolver/override),
 *  so a straight JSON stringify of the sorted dims is stable across calls with the same inputs. */
export function computePrepInputHash(input: {
  destination_country: string | null
  parcels: Parcel[]
  category: PrepCategory
}): string {
  const parcelsKey = input.parcels
    .map((p) => `${p.length}x${p.width}x${p.height}x${p.weight}`)
    .sort()
    .join("|")
  const raw = `${input.destination_country ?? ""}::${parcelsKey}::${input.category}`
  // Small deterministic FNV-1a hash — no crypto needed for a cache key.
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Whether a cached quote is STALE (an input-hash mismatch — an edit happened since the row was
 * last quoted). Strictly this and nothing else: a missing quote (`offers.length === 0`) is a
 * DIFFERENT state (`quote_missing`, not "stale") and must not be folded in here — the caller
 * decides how to render "no quote yet" vs "quote is out of date" separately. The TTL check is
 * NOT part of this predicate (only prepSync's refresh decision cares about wall-clock age);
 * `stale` on the row view is purely the hash comparison. Shared by buildRow (the row view) and
 * prepSync (the re-quote decision, which additionally checks the TTL).
 */
export function isQuoteStale(cachedQuote: PrepQuoteRow | undefined, currentHash: string): boolean {
  return cachedQuote?.input_hash != null && cachedQuote.input_hash !== currentHash
}

// ── prep_list (free read) ─────────────────────────────────────────────────────

function blankField(v: string | null | undefined): boolean {
  return v == null || v.trim() === ""
}

/** Names of the fields a label buy needs that this recipient is missing, in the order they are
 *  checked, plus state/province when the destination requires one (US/CA -- address.ts's
 *  `stateRequired`, the same rule `validateParty` enforces at buy time). Empty when the recipient
 *  is complete. This is the SINGLE source of truth `isRecipientComplete` and Ship's disabled
 *  tooltip both read, so the queue can never call a row ready while leaving the operator to guess
 *  which field is missing. */
export function missingRecipientFields(r: PrepRecipient | null | undefined): string[] {
  if (!r) return ["name and address"]
  const missing: string[] = []
  if (blankField(r.name)) missing.push("name")
  if (blankField(r.street)) missing.push("street")
  if (blankField(r.city)) missing.push("city")
  // A country with no postal codes (UAE, Qatar, Hong Kong...) has none to give.
  if (blankField(r.postalCode) && postalCodeRequired(r.countryIsoCode)) missing.push("postal code")
  if (blankField(r.countryIsoCode)) missing.push("country")
  if (blankField(r.email)) missing.push("email")
  if (blankField(r.phone)) missing.push("phone")
  if (stateRequired(r.countryIsoCode) && blankField(r.state)) missing.push("state or province")
  return missing
}

/** Every field a label buy needs on the recipient. Missing any of them is what Ship's disabled
 *  tooltip names, instead of failing at the carrier. Mirrors `validateParty`'s REQUIRED_FIELDS
 *  in address.ts (email, phone, and a state/province on a US/CA destination included): a row
 *  this marks "complete" must be one `shipmentCreate` can actually stage, not just one with a
 *  postal address. */
export function isRecipientComplete(r: PrepRecipient | null | undefined): boolean {
  return missingRecipientFields(r).length === 0
}

/** Every field of a recipient, in the order `mergeRecipients` fills them. */
const RECIPIENT_FIELDS = [
  "name",
  "company",
  "email",
  "phone",
  "street",
  "city",
  "postalCode",
  "countryIsoCode",
  "state",
] as const

/**
 * Merge recipients PER FIELD, first non-blank wins, in the order the sources are given.
 *
 * Field level, not object level -- the same rule `fetchShopifyOrderMeta` already applies to the
 * shipping-address/customer-address pair, and for the same reason: each source is partially
 * populated, so taking one wholesale throws away a value we already hold. A row whose stored
 * recipient carries the phone while the order-derived one does not was reported as missing a phone
 * and refused a label, for a value the row itself was storing.
 */
export function mergeRecipients(
  ...sources: Array<PrepRecipient | null | undefined>
): PrepRecipient | null {
  const present = sources.filter((s): s is PrepRecipient => s != null)
  if (present.length === 0) return null
  const out: PrepRecipient = {}
  for (const field of RECIPIENT_FIELDS) {
    const source = present.find((s) => !blankField(s[field]))
    if (source) out[field] = source[field]
  }
  return out
}

function toRecipientView(r: PrepRecipient | null | undefined): PrepRecipientView | null {
  if (!r) return null
  return { ...r, complete: isRecipientComplete(r), missing_fields: missingRecipientFields(r) }
}

/** The products summary for a row that has NO document yet: the order's own line items. */
/** A document-less row's products, read off the order's line items. Each sku goes through the
 *  org's product-code mapping (empty by default: the sku as it is), so a wholesale variant with no
 *  shipping profile reads under the same short code as its retail twin. */
function productsFromOrderLines(items: OrderCandidate["line_items"], productCodes: ProductCodeConfig): string {
  if (items.length === 0) return "-"
  return items
    .map((l) => `${l.quantity || 1}x${shortProductCode(l.sku ?? l.title ?? "item", productCodes)}`)
    .join(", ")
}

function invoiceView(c: OrderCandidate, invoicingAvailable: boolean): PrepInvoiceView {
  if (!invoicingAvailable) {
    return { state: "not_available", document_id: null, number: null, approval_id: null, kind: null }
  }
  if (c.anchor_ref) {
    return {
      state: "issued",
      document_id: c.anchor_ref,
      number: c.anchor_number,
      approval_id: null,
      kind: c.anchor_kind,
    }
  }
  if (c.proforma_pending_approval_id && !c.proforma_approval_expired) {
    return {
      state: "pending_approval",
      document_id: null,
      number: null,
      approval_id: c.proforma_pending_approval_id,
      kind: "proforma",
    }
  }
  return { state: "missing", document_id: null, number: null, approval_id: null, kind: null }
}

/**
 * Build ONE row from a candidate plus CACHED data only.
 *
 * No external call and, above all, NO DRAFT RESOLUTION: that is the whole point of the rework. A
 * row whose anchor has nothing in `prep_draft_cache` is honestly `not_synced` rather than silently
 * carrying an empty parcel list that reads as "no packages".
 */
export function buildRow(args: {
  candidate: OrderCandidate
  cached: DraftCacheRow | undefined
  cachedQuote: PrepQuoteRow | undefined
  legacyState: PrepStateRow | undefined
  shipment: PrepShipmentView | null
  coverage: ShipmentCoverage | undefined
  invoicingAvailable: boolean
  /** The org's sku to short-code mapping; omitted means the empty default. */
  productCodes?: ProductCodeConfig
}): PrepRow {
  const { candidate: c, cached, cachedQuote, legacyState, shipment, coverage, invoicingAvailable } = args
  const parcels = cached?.parcels ?? []
  const destinationCountry = cached?.destination_country ?? c.destination ?? null
  const currentHash = computePrepInputHash({
    destination_country: destinationCountry,
    parcels,
    category: c.category,
  })
  const offers = cachedQuote?.offers ?? []
  const stale = isQuoteStale(cachedQuote, currentHash)
  const selectedCode = legacyState?.selected_offer_code ?? null
  const quoteView: PrepQuoteView = {
    cheapest: offers[0] ?? null,
    alternates: offers.slice(1, 3),
    offers,
    selected_offer_code: selectedCode,
    selected: pickSelectedOffer(offers, selectedCode, stale),
    quoted_at: cachedQuote?.quoted_at ?? null,
    stale,
  }

  const anchorMissing = noAnchorReason(c)
  let state: PrepRowState
  let reason: string | undefined
  if (anchorMissing) {
    state = "needs_document"
    reason = anchorMissing
  } else if (!cached) {
    state = "not_synced"
  } else if (cached.needs_fix_reason) {
    state = "needs_fix"
    reason = cached.needs_fix_reason
  } else if (offers.length === 0) {
    state = "quote_missing"
    if (cachedQuote?.quote_error) reason = `Quote failed: ${cachedQuote.quote_error}`
  } else {
    state = "ready"
  }

  const remaining = cached?.partial_remaining ?? null
  const remainingUnits = remaining ? remaining.reduce((sum, l) => sum + l.quantity, 0) : null
  const partial = remaining != null || (coverage != null && coverage.shippedByLine.size > 0 && !coverage.full)
  // Precedence: what the row itself stores (prep_add_shipment's prefill, and every operator
  // correction) beats the last sync cache, which beats the order/document-derived recipient. Merged
  // per field so a partially populated source cannot blank a value another one holds.
  const recipient = toRecipientView(mergeRecipients(c.state?.recipient, cached?.recipient, c.recipient))

  return {
    order_key: c.order_key,
    document_ref: c.anchor_ref,
    anchor_kind: c.anchor_kind,
    invoice_ref: c.anchor_number ?? c.order_name ?? c.order_key,
    order_name: c.order_name,
    order_created_at: c.order_created_at,
    // The order hit is the customer's name when Shopify answered. When it did not (a failed scoped
    // read, or a row read from the cache during an outage) the resolved draft's recipient is the
    // best name we hold, and it beats blanking the column to "-" in place.
    customer: c.customer !== "-" ? c.customer : (recipient?.name || "-"),
    destination: destinationCountry ?? "-",
    order_tags: c.order_tags,
    // Ordered by the org's display rank (none set: the order the lines came in).
    products: orderProductsSummary(
      cached?.products ?? productsFromOrderLines(c.line_items, args.productCodes ?? EMPTY_PRODUCT_CODE_CONFIG),
      args.productCodes ?? EMPTY_PRODUCT_CODE_CONFIG,
    ),
    grand_total_minor: cached?.grand_total_minor ?? c.order_total_minor,
    currency: cached?.currency ?? c.currency,
    customer_shipping_minor: c.customer_shipping_minor,
    customer_shipping_currency: c.customer_shipping_currency,
    parcels,
    package_count: parcels.length,
    category: c.category,
    status: c.status,
    status_note: c.status_note,
    staff_note: c.staff_note,
    quote: quoteView,
    state,
    ...(reason ? { reason } : {}),
    excluded: c.excluded,
    validated: c.status === "validated",
    invoice: invoiceView(c, invoicingAvailable),
    shipment,
    recipient,
    ...(recipientEdited(c.state?.recipient) ? { recipient_edited: true as const } : {}),
    ...(partial ? { partially_shipped: true, ...(remainingUnits != null ? { remaining_units: remainingUnits } : {}) } : {}),
    ...(cached?.recipient_phone_issue ? { recipient_phone_issue: cached.recipient_phone_issue } : {}),
    ...(cached?.address_check && cached.address_check.state !== "no_verified" ? { address_check: cached.address_check } : {}),
  }
}

/** Whether the row's own stored recipient names a place: a person's prefill or correction. */
function recipientEdited(r: PrepRecipient | null | undefined): boolean {
  return Boolean(r && [r.street, r.city, r.postalCode].some((v) => typeof v === "string" && v.trim() !== ""))
}

/** Exported as a test seam: the filter predicate is pure and worth pinning directly. */
export function matchesFilters(row: PrepRow, input: PrepListInput): boolean {
  if (!input.include_excluded && row.excluded) return false
  if (typeof input.validated === "boolean" && row.validated !== input.validated) return false
  if (input.status && row.status !== input.status) return false
  if (input.country && row.destination.trim().toUpperCase() !== input.country.trim().toUpperCase()) return false
  if (input.tag && !row.order_tags.some((t) => t.toLowerCase() === input.tag!.toLowerCase())) return false
  if (input.product && !row.products.toLowerCase().includes(input.product.toLowerCase())) return false
  if (input.search) {
    const q = input.search.toLowerCase()
    const haystack = `${row.invoice_ref} ${row.order_name ?? ""} ${row.customer} ${row.destination}`.toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

/**
 * The order-prep worklist: EVERY open unfulfilled Shopify order, joined with its documents, its
 * cached draft resolution, its cached quote and its per-order state.
 *
 * FREE READ, and specifically a read that resolves NO shipment drafts. The pre-rework version
 * resolved one per candidate, which is the O(rows) cost that made every row action feel like a page
 * reload (each ended in a whole-list refetch). Rows the operator has not synced say `not_synced`.
 *
 * With `order_keys` this is instead a ROW-SCOPED read: the scan is skipped, those rows are read
 * live and their drafts ARE resolved (a handful, on purpose), so a row action can patch one row.
 */
export async function prepList(ctx: BoxtalToolCtx, input: PrepListInput = {}): Promise<PrepListResult> {
  const scoped = Array.isArray(input.order_keys) && input.order_keys.length > 0
  // UNSCOPED read: LIVE for now. Cache mode (`source: "cache"`) exists and is exercised in tests,
  // but nothing warms `prep_meta` for an order that was never prep_synced, so a cache-only scan
  // returns an empty queue for it -- flipping the default here is a product decision, not yet made.
  // SCOPED (`order_keys`) is unchanged and stays live on purpose: it deliberately refreshes exactly
  // the named handful of rows via `shopify:orders_get`, a different, bounded, deliberate behaviour.
  // A read: what it writes back (a settled proforma, a resolved draft) is Boxtal's and the
  // invoicing app's own state, never the caller's, so those writes are best effort.
  const scan = await openOrdersScan(
    ctx,
    scoped ? { order_keys: input.order_keys, bestEffortWrites: true } : { bestEffortWrites: true },
  )
  const [{ candidates, coverage }, cache, quoteByRef, stateByRef, shipmentsByAnchor, lastSyncAt, productCodes] =
    await Promise.all([
      // A scoped read returns the rows it was asked for, excluded or not: the caller named them.
      worklistCandidates(ctx, { includeExcluded: input.include_excluded || scoped, scan }),
      loadDraftCache(ctx),
      loadByDocumentRef<PrepQuoteRow>(ctx, "prep_quote"),
      loadByDocumentRef<PrepStateRow>(ctx, "prep_state"),
      liveShipmentsByAnchor(ctx),
      getLastSyncAt(ctx),
      loadProductCodeConfig(ctx),
    ])

  if (scoped) {
    // The point of the scoped read: refresh exactly these anchors, nothing else.
    const refs = candidates
      .map((c) => c.anchor_ref)
      .filter((ref): ref is string => ref != null)
    if (refs.length > 0) {
      const fresh = await resolveDrafts(ctx, refs, {
        limit: refs.length,
        coverage,
        bestEffortWrites: true,
      })
      for (const [ref, row] of fresh) cache.set(ref, row)
    }
  }

  const rows = candidates.map((c) =>
    buildRow({
      candidate: c,
      cached: c.anchor_ref ? cache.get(c.anchor_ref) : undefined,
      cachedQuote: c.anchor_ref ? quoteByRef.get(c.anchor_ref) : undefined,
      legacyState: c.anchor_ref ? stateByRef.get(c.anchor_ref) : undefined,
      shipment: c.anchor_ref ? (shipmentsByAnchor.get(c.anchor_ref) ?? null) : null,
      coverage: c.anchor_ref ? coverage.get(c.anchor_ref) : undefined,
      invoicingAvailable: scan.invoicing_available,
      productCodes,
    }),
  )
  // A scoped read returns the rows it was asked for even when they are excluded (the caller named
  // them), but every other filter still applies so a scoped read and a list read agree.
  const filtered = rows.filter((r) => matchesFilters(r, scoped ? { ...input, include_excluded: true } : input))

  return {
    rows: filtered,
    total: filtered.length,
    last_sync_at: lastSyncAt,
    truncated: scan.truncated,
    last_sync_error: scan.last_sync_error,
    invoicing_available: scan.invoicing_available,
  }
}

async function getLastSyncAt(ctx: BoxtalToolCtx): Promise<string | null> {
  const rows = (await ctx.db.findMany("app_config", { where: { key: LAST_SYNC_KEY }, limit: 1 })) as Array<{
    value: unknown
  }>
  return typeof rows[0]?.value === "string" ? rows[0].value : null
}

// ── prep_sync (gated: writes + external calls) ────────────────────────────────

export interface PrepSyncInput {
  /** Scope the refresh to these document_refs (e.g. after a single-row edit); omit to refresh
   *  the whole worklist (bounded by `limit`). */
  document_refs?: string[]
  /** Scope by ROW instead (the grid's own identity). */
  order_keys?: string[]
  /** Max rows refreshed in one call (default 40); honestly bounded via covered/total. */
  limit?: number
}

export interface PrepSyncRowResult {
  document_ref: string
  order_key?: string
  synced_meta: boolean
  requoted: boolean
  error?: string
  /** Set when synced_meta stayed false for a reason OTHER than "already fresh" — e.g. the invoice
   *  has no linked shopify_order_id to resolve (never came from a Shopify order), so the meta
   *  fetch was structurally skipped, not merely deferred by the TTL. Absent when meta is fresh
   *  (no skip happened) or was actually synced. */
  reason?: string
}

export interface PrepSyncResult {
  rows: PrepSyncRowResult[]
  covered_count: number
  total_count: number
  last_sync_at: string
  /** Rows whose sync or quote failed: how many, and the first few with their reason. */
  errors: { count: number; first: Array<{ order_key: string; error: string }> }
  notice: string
}

/** The reason stored when Boxtal answers a quote with no error and no offer either. */
export const NO_OFFERS_RETURNED = "no offers returned"
/** How many failed rows the prep_sync result names one by one. */
const SYNC_ERRORS_SHOWN = 3

export { fetchShopifyOrderMeta } from "./prep-meta"
export type { ShopifyOrderAddress } from "./prep-meta"

// `backfillContactShippingAddress` lives in prep-meta.ts: the shipment draft
// (shipment.ts) heals the contact from its Shopify order too, and shipment.ts
// and prep.ts import each other.
export { backfillContactShippingAddress }

async function upsertPrepQuote(
  ctx: BoxtalToolCtx,
  documentRef: string,
  data: { input_hash: string; offers: PrepOffer[] },
): Promise<void> {
  const rows = (await ctx.db.findMany("prep_quote", { where: { document_ref: documentRef }, limit: 1 })) as Array<{
    id: string
  }>
  const patch = { ...data, quote_error: null, quoted_at: new Date().toISOString() }
  if (rows[0]) {
    await ctx.db.update("prep_quote", rows[0].id, patch)
  } else {
    await ctx.db.insert("prep_quote", { document_ref: documentRef, ...patch })
  }
}

/** Record why a quote attempt gave no offers. Leaves the hash, the offers and `quoted_at` alone,
 *  so the next sync retries (a row never quoted has no `quoted_at` and reads as expired). */
async function recordPrepQuoteError(ctx: BoxtalToolCtx, documentRef: string, quoteError: string): Promise<void> {
  const rows = (await ctx.db.findMany("prep_quote", { where: { document_ref: documentRef }, limit: 1 })) as Array<{
    id: string
  }>
  if (rows[0]) {
    await ctx.db.update("prep_quote", rows[0].id, { quote_error: quoteError })
  } else {
    await ctx.db.insert("prep_quote", { document_ref: documentRef, offers: [], quote_error: quoteError })
  }
}

/** How many offers a row caches. Enough to populate the offer dropdown ("toutes les offres du
 *  dernier quote") without the cached JSON growing unbounded on a route with many carriers. The
 *  first three still feed the compact cheapest + 2-alternate view. */
const STORED_OFFER_CAP = 12

function offersFromQuoteResult(offers: Array<{
  carrier: string
  service?: string
  service_code?: string
  offer_code: string
  price_ht: number
  price_ttc?: number
  currency: string
  collection_date?: string | null
  delivery_date: string | null
  needs_relay_point?: boolean
}>): PrepOffer[] {
  // Cheapest-first (the quote tool's own ranking), with business-days ETA when computable from the
  // offer's collection_date -> delivery_date span (the same helper quote-batch.ts uses — one shared
  // business-day count, not a re-derivation). The full list (capped) is cached so the row's offer
  // dropdown can list every offer; the relay flag (from the shared isPickupPointOffer chokepoint)
  // drives the relais/domicile badge and the create_shipment include_pickup_point pass-through.
  return [...offers]
    .sort((a, b) => a.price_ht - b.price_ht)
    .slice(0, STORED_OFFER_CAP)
    .map((o) => ({
      carrier: o.carrier,
      service: o.service ?? "",
      offer_code: o.offer_code,
      price_ht_minor: toMinor(o.price_ht, o.currency),
      price_ttc_minor: toMinor(typeof o.price_ttc === "number" ? o.price_ttc : o.price_ht, o.currency),
      currency: o.currency,
      delivery_date: o.delivery_date ?? null,
      eta_business_days: businessDaysBetween(o.collection_date ?? null, o.delivery_date ?? null),
      is_pickup_point: isPickupPointOffer({
        needs_relay_point: o.needs_relay_point ?? false,
        service: o.service ?? "",
        service_code: o.service_code ?? "",
        offer_code: o.offer_code,
      }),
    }))
}

/**
 * Refresh pass: pulls Shopify order meta (when missing) and re-quotes each row (when the
 * route/parcels/category hash changed, or the cached quote is older than the 12h TTL), storing
 * the top 3 offers. Bounded by `limit` (default 25); reports covered/total honestly. GATED —
 * writes local rows + makes external calls (Shopify + Boxtal), unlike the free prep_list read.
 */
// Bounded concurrency for the per-row sync loop: rows are independent (each resolves its own
// draft + meta + quote), so serial awaiting left the whole pass needlessly latency-bound on the
// slowest row's round-trips. Chunks of 5 cap the concurrent external-call fan-out (Shopify +
// Boxtal) so a large worklist doesn't burst-fire dozens of simultaneous live calls.
const SYNC_CONCURRENCY = 5


export async function prepSync(ctx: BoxtalToolCtx, input: PrepSyncInput = {}): Promise<PrepSyncResult> {
  const limit = Math.max(1, input.limit ?? RESOLVE_LIMIT)
  const wantRefs = input.document_refs && input.document_refs.length > 0 ? new Set(input.document_refs) : null
  const askedKeys = input.order_keys && input.order_keys.length > 0 ? input.order_keys : null

  // SCOPE THE SCAN, not just its result. A per-row Quote, a package edit and a category change all
  // call prep_sync for ONE row; running the unscoped worklist scan first made each of them pay a
  // full paged `shopify:orders_search` walk (up to 250 orders) plus the documents_for_orders
  // batches, which is exactly the O(worklist) latency the rework exists to remove.
  const scopeKeys = askedKeys ? [...new Set(askedKeys)] : wantRefs ? await orderKeysForDocumentRefs(ctx, [...wantRefs]) : null
  const scanScoped = scopeKeys != null && scopeKeys.length > 0
  const scan = await openOrdersScan(ctx, scanScoped ? { order_keys: scopeKeys } : {})
  // A named row is synced whether it is excluded or not: the caller asked for it by name.
  const { candidates, coverage } = await worklistCandidates(ctx, { scan, includeExcluded: scanScoped })
  // A key the scan answered under another name (an order named by its number, a settled proforma)
  // is the same row: match it by the key the row carries.
  const wantKeys = askedKeys ? new Set(askedKeys.map((k) => scan.key_aliases?.get(k) ?? k)) : null

  const scoped = candidates.filter((c) => {
    if (wantRefs) return c.anchor_ref != null && wantRefs.has(c.anchor_ref)
    if (wantKeys) return wantKeys.has(c.order_key)
    return true
  })
  // Anchored rows only: a row with no document has nothing to resolve or quote yet.
  const anchored = scoped.filter((c) => c.anchor_ref != null)
  const totalCount = anchored.length

  const [cache, quoteByRef, stateByRef] = await Promise.all([
    loadDraftCache(ctx),
    loadByDocumentRef<PrepQuoteRow>(ctx, "prep_quote"),
    loadByDocumentRef<PrepStateRow>(ctx, "prep_state"),
  ])

  // Oldest first: an order placed three weeks ago matters more than one placed this morning, and a
  // never-resolved anchor matters more than a merely stale one.
  const ordered = [...anchored].sort((a, b) => {
    const aStale = isDraftCacheStale(cache.get(a.anchor_ref!)) ? 0 : 1
    const bStale = isDraftCacheStale(cache.get(b.anchor_ref!)) ? 0 : 1
    if (aStale !== bStale) return aStale - bStale
    return (a.order_created_at ?? "").localeCompare(b.order_created_at ?? "")
  })
  const toSync = ordered.slice(0, limit)

  // Resolution happens HERE (and in the row-scoped read), never in the list read.
  const resolved = await resolveDrafts(
    ctx,
    toSync.map((c) => c.anchor_ref!),
    { limit: toSync.length || 1, coverage },
  )

  // Expired ship-tos refreshed this run, capped so a big worklist whose entries expire together
  // does not read every order in one burst (prep-meta.ts SHIP_TO_REFRESHES_PER_SYNC).
  const shipToBudget: ShipToRefreshBudget = { remaining: SHIP_TO_REFRESHES_PER_SYNC }
  const rows = await mapWithConcurrency(toSync, SYNC_CONCURRENCY, async (c): Promise<PrepSyncRowResult> => {
    const ref = c.anchor_ref!
    let syncedMeta = false
    let requoted = false
    let error: string | undefined
    let reason: string | undefined
    try {
      // 1. Order meta. The scan already read the order, so this is a local write, not a round trip.
      if (c.shopify_order_id) {
        await upsertPrepMeta(ctx, ref, {
          shopify_order_id: c.shopify_order_id,
          order_name: c.order_name,
          order_tags: c.order_tags,
          order_created_at: c.order_created_at,
          financial_status: c.financial_status,
          cancelled_at: c.cancelled_at,
          staff_note: c.staff_note,
        })
        syncedMeta = true
        // The contact's structured shipping address is what a label buy needs; write it once
        // from the order's ship-to when the contact has none, and heal an existing address that
        // is missing `state` by filling that one field in. Never overwrites a non-blank field.
        // One order read per row at most, shared by the contact backfill and the ship-to cache
        // (worklist drafts read the cached ship-to so the order's own address wins there too).
        let metaRead: ReturnType<typeof fetchShopifyOrderMeta> | null = null
        const getMeta = () => {
          metaRead ??= fetchShopifyOrderMeta(ctx, c.shopify_order_id!)
          return metaRead
        }
        const contactId = await recipientContactIdFor(ctx, ref)
        await backfillContactShippingAddress(ctx, contactId, async () => (await getMeta())?.address ?? null)
        // A detail read in the scan already holds the ship-to: cache it without another read
        // (and without spending the refresh budget).
        const shipToCached =
          c.ship_to !== undefined
            ? await cacheShipToIfStale(ctx, ref, async () => c.ship_to)
            : await cacheShipToIfStale(ctx, ref, async () => (await getMeta())?.ship_to, shipToBudget)
        // The draft above was resolved before this ship-to was cached (on a first sync the meta
        // row did not even exist yet), so it compared the verified address with no order address
        // and the row looked ready instead of held "Address differs" until the NEXT sync. A
        // ship-to just written re-resolves this one draft from the cache; no order read.
        if (shipToCached) {
          const again = await resolveDrafts(ctx, [ref], { limit: 1, coverage })
          const fresh = again.get(ref)
          if (fresh) resolved.set(ref, fresh)
        }
      } else {
        reason = "No linked Shopify order to sync meta from"
      }

      // 2. Quote, only when the hash changed or the cached quote is past its TTL.
      const facts = resolved.get(ref) ?? cache.get(ref)
      const category = c.category
      const cached = quoteByRef.get(ref)
      const currentHash = computePrepInputHash({
        destination_country: facts?.destination_country ?? null,
        parcels: facts?.parcels ?? [],
        category,
      })
      const quotedAtMs = cached?.quoted_at ? Date.parse(cached.quoted_at) : NaN
      const isExpired = Number.isNaN(quotedAtMs) || Date.now() - quotedAtMs > QUOTE_TTL_MS
      if ((facts?.parcels.length ?? 0) > 0 && (isQuoteStale(cached, currentHash) || isExpired)) {
        let quoteError: string | null = null
        try {
          const quoted = await quote(ctx, { draft_id: ref })
          if (quoted.error) quoteError = quoted.error.message
          else if (quoted.offers.length === 0) quoteError = NO_OFFERS_RETURNED
          else {
            await upsertPrepQuote(ctx, ref, { input_hash: currentHash, offers: offersFromQuoteResult(quoted.offers) })
            requoted = true
          }
        } catch (err) {
          quoteError = err instanceof Error ? err.message : String(err)
        }
        if (quoteError != null) {
          error = quoteError
          ctx.logger?.warn?.("prep_sync: quote failed", { order_key: c.order_key, document_ref: ref, error: quoteError })
          await recordPrepQuoteError(ctx, ref, quoteError)
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.("prep_sync: row sync failed", { order_key: c.order_key, document_ref: ref, error })
    }
    return {
      document_ref: ref,
      order_key: c.order_key,
      synced_meta: syncedMeta,
      requoted,
      ...(error ? { error } : {}),
      ...(reason ? { reason } : {}),
    }
  })

  const lastSyncAt = new Date().toISOString()
  await setLastSyncAt(ctx, lastSyncAt)

  // The papers the document rules ask for, generated as the orders enter To prepare (and brought
  // up to date when their facts change). The worklist refresh only: a row-scoped sync (the grid's
  // Quote button, an edit) stays as cheap as it was, and the scheduled pass covers the rest. Best
  // effort: never fails the sync.
  const rowScoped = (input.document_refs?.length ?? 0) > 0 || (input.order_keys?.length ?? 0) > 0
  if (!rowScoped) try {
    await generateOrderDocuments(
      ctx,
      rows.flatMap((r) => (r.error || !r.document_ref ? [] : [r.document_ref])),
    )
  } catch (err) {
    ctx.logger?.warn?.("prep_sync: order documents failed", { err: String(err) })
  }

  const failed = rows.filter((r) => r.error)
  const errors = {
    count: failed.length,
    first: failed.slice(0, SYNC_ERRORS_SHOWN).map((r) => ({ order_key: r.order_key ?? r.document_ref, error: r.error! })),
  }
  const synced =
    toSync.length < totalCount
      ? `Synced ${toSync.length} of ${totalCount} rows in scope; ${totalCount - toSync.length} remain to sync in another pass.`
      : `Synced ${toSync.length} of ${totalCount} rows.`
  const failedNote =
    errors.count > 0
      ? ` ${errors.count} row${errors.count === 1 ? "" : "s"} failed: ${errors.first.map((e) => `${e.order_key}: ${e.error}`).join("; ")}${errors.count > errors.first.length ? "; ..." : ""}`
      : ""
  return {
    rows,
    covered_count: toSync.length,
    total_count: totalCount,
    last_sync_at: lastSyncAt,
    errors,
    notice: synced + failedNote,
  }
}

/**
 * The order keys the given anchor documents belong to, from LOCAL tables only.
 *
 * Read from the cache on purpose: this runs to decide how wide the Shopify scan has to be, so it
 * must not itself make a cross-app call (and must not fail a sync when invoicing is briefly down).
 * A ref no local table can map returns null for the whole set, which falls back to the full scan --
 * correct, merely not cheap, and rare (a document the worklist has never listed).
 */
async function orderKeysForDocumentRefs(ctx: BoxtalToolCtx, refs: string[]): Promise<string[] | null> {
  const keys: string[] = []
  for (const ref of refs) {
    const metas = (await ctx.db.findMany("prep_meta", { where: { document_ref: ref }, limit: 1 })) as Array<{
      shopify_order_id?: string | null
    }>
    const orderId = numericOrderId(metas[0]?.shopify_order_id)
    if (orderId) {
      keys.push(orderKeyForShopifyOrder(orderId))
      continue
    }
    // An order-less row is anchored on its own proforma, and the state row records which.
    const states = (await ctx.db.findMany("prep_order_state", {
      where: { proforma_document_ref: ref },
      limit: 1,
    })) as Array<{ order_key?: string | null }>
    const key = states[0]?.order_key
    if (typeof key === "string" && key) {
      keys.push(key)
      continue
    }
    return null
  }
  return [...new Set(keys)]
}

/** The invoice's counterparty contact, for the shipping-address backfill. Read from the resolved
 *  draft rather than re-derived, and null (skip the backfill) when the draft cannot resolve. */
async function recipientContactIdFor(ctx: BoxtalToolCtx, documentRef: string): Promise<string | null> {
  try {
    const draft = await shipmentDraftCreate(ctx, { document_ref: documentRef, orderShipTo: false })
    return draft.recipient_contact_id ?? null
  } catch (err) {
    ctx.logger?.warn?.("prep: contact lookup skipped, the draft did not resolve", {
      document_ref: documentRef,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function setLastSyncAt(ctx: BoxtalToolCtx, at: string): Promise<void> {
  const rows = (await ctx.db.findMany("app_config", { where: { key: LAST_SYNC_KEY }, limit: 1 })) as Array<{
    id: string
  }>
  if (rows[0]) {
    await ctx.db.update("app_config", rows[0].id, { value: at })
    return
  }
  // No row seen → insert. But `app_config` is UNIQUE on (org_id, key), and a concurrent prep_sync
  // call (two operators pulling orders at once, or a routine tick racing a manual Pull orders
  // click) can both see no row and both INSERT the same `prep_last_sync_at` key — the second loses
  // the unique race with a 23505 violation. That is a recoverable concurrent-insert race, not a
  // real failure (mirrors draft-store.ts's saveDraftOverride): catch it, re-read the row the
  // racing writer committed, and UPDATE it to our timestamp instead (the later prepSync call's
  // completion time is still the correct "last synced" marker to show).
  try {
    await ctx.db.insert("app_config", { key: LAST_SYNC_KEY, value: at })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const winner = (await ctx.db.findMany("app_config", { where: { key: LAST_SYNC_KEY }, limit: 1 })) as Array<{
      id: string
    }>
    if (!winner[0]) throw err // genuinely gone — not a recoverable race; surface the original error
    await ctx.db.update("app_config", winner[0].id, { value: at })
  }
}

// ── prep_set_category ──────────────────────────────────────────────────────

export interface PrepSetCategoryInput {
  order_key?: string
  /** Legacy alternative: the anchor document id, resolved to its order_key. */
  document_ref?: string
  category: PrepCategory
}

export interface PrepSetCategoryResult {
  /** The fresh row, read back through the row-scoped read so the UI patches one row in place. */
  row: PrepRow | null
  order_state: PrepOrderStateRow
  /** Set when the category was accepted but the shipping document could not be issued. */
  error?: { code: string; message: string }
}

async function upsertPrepState(
  ctx: BoxtalToolCtx,
  documentRef: string,
  patch: Partial<PrepStateRow>,
): Promise<PrepStateRow> {
  const rows = (await ctx.db.findMany("prep_state", { where: { document_ref: documentRef }, limit: 1 })) as Array<
    PrepStateRow & { id: string }
  >
  if (rows[0]) {
    const merged = { ...rows[0], ...patch }
    await ctx.db.update("prep_state", rows[0].id, { ...patch })
    return merged
  }
  const base: PrepStateRow = { document_ref: documentRef, category: "sale", excluded: false, ...patch }
  await ctx.db.insert("prep_state", { ...base })
  return base
}

interface InvoiceLine {
  description?: string | null
  quantity?: number | string | null
  line_kind?: string | null
  hs_code?: string | null
  country_of_origin?: string | null
  customs_description?: string | null
  product_source?: string | null
  external_id?: string | null
}

/**
 * What is physically in the parcel, as proforma items.
 *
 * The GOODS INVOICE's lines are the first choice and the reason the parcel resolution stays
 * faithful: `buildDraftFromDoc` derives parcels by joining each line's (product_source, external_id)
 * to a shipping profile, so a proforma built from the same references resolves to the SAME parcels
 * as the invoice would. Falling back to the order's line items (SKU) or to the row's stored items
 * keeps an order-less or un-invoiced row workable.
 */
async function proformaItemsForCandidate(
  ctx: BoxtalToolCtx,
  c: OrderCandidate,
): Promise<ProformaItem[]> {
  if (c.goods_invoice) {
    try {
      const env = await ctx.executeTool("invoicing:documents_get", { id: c.goods_invoice.id })
      if (env.status === "completed" && env.result != null) {
        const lines = ((env.result as { lines?: InvoiceLine[] }).lines ?? []).filter(
          (l) => (l.line_kind ?? "goods") === "goods" && l.product_source,
        )
        if (lines.length > 0) {
          return lines.map((l) => ({
            name: l.customs_description || l.description || "Item",
            quantity: Math.max(1, Math.floor(Number(l.quantity ?? 1)) || 1),
            external_id: l.external_id ?? null,
            product_source: l.product_source ?? "shopify",
            hs_code: l.hs_code ?? null,
            country_of_origin: l.country_of_origin ?? null,
            customs_description: l.customs_description ?? null,
          }))
        }
      }
    } catch (err) {
      ctx.logger?.warn?.("prep: invoice lines read failed, falling back to the order lines", {
        document_ref: c.goods_invoice.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (c.line_items.length > 0) {
    return c.line_items.map((l) => ({
      name: l.title ?? l.sku ?? "Item",
      quantity: Math.max(1, l.quantity || 1),
      // VARIANT first, SKU only as a fallback. Both the packing profiles and invoicing's customs
      // overlay key on the Shopify variant gid (invoicing's auto-invoice writes its lines with
      // `toVariantGid(...)` for exactly that reason), so a SKU-first ref resolves to no profile:
      // the parcels come back unresolved, the row reads "Unresolved pack" and Ship stays disabled.
      external_id: l.variant_id ?? l.sku ?? null,
      product_source: "shopify",
    }))
  }
  const stored = c.state?.items ?? []
  return stored.map((i) => ({
    name: i.name,
    quantity: Math.max(1, i.quantity || 1),
    external_id: i.external_id ?? null,
    product_source: i.product_source ?? "shopify",
    hs_code: i.hs_code ?? null,
    country_of_origin: i.country_of_origin ?? null,
    customs_description: i.customs_description ?? null,
  }))
}

/**
 * The recipient the nominal proforma is issued TO, taken from the row's own resolved data.
 *
 * No invented values: the name is NOT defaulted to a literal "Customer" and the country is NOT
 * defaulted to "FR" (a wrong country silently changes the tax treatment). A field the row does not
 * have stays empty, and `ensureNominalProforma` refuses the issuance naming it, rather than issuing
 * a legal document to a recipient nobody named. `email` is carried through -- invoicing requires it.
 */
function counterpartyFor(c: OrderCandidate): ProformaCounterparty {
  const r = c.recipient
  const address = [r?.street, r?.postalCode, r?.city].filter(Boolean).join(", ")
  return {
    legal_name: r?.name || c.customer || "",
    country: r?.countryIsoCode || c.destination || "",
    address: address || null,
    email: r?.email ?? null,
  }
}

/**
 * Set a row's category, and with it the SHIPPING DOCUMENT the row is anchored on.
 *
 * `sale` ships on the issued commercial invoice. `repair` and `gift` do not: there is no sale, so
 * the app issues a proforma at the org's nominal value (one line per physical item, see proforma.ts) and the
 * row's draft, parcels, customs articles and quote re-derive from it.
 *
 * LOCKED when a live outbound shipment already covers the current anchor (the parcel is bought
 * against that document; changing what it declares afterwards is a lie) or while a proforma
 * approval is pending (the answer is not in yet). Deliberately NOT locked by a merely issued sale
 * invoice: the invoice is not what the category changes, documents are never deleted, and switching
 * back to `sale` simply re-anchors on it.
 */
export async function prepSetCategory(
  ctx: BoxtalToolCtx,
  input: PrepSetCategoryInput,
): Promise<PrepSetCategoryResult> {
  const orderKey =
    input.order_key && parseOrderKey(input.order_key)
      ? input.order_key
      : input.document_ref
        ? await orderKeyForDocumentRef(ctx, input.document_ref)
        : null
  if (!orderKey) {
    throw new ToolError("Pass the row's order_key (so:<order id> / doc:<document id>).", {
      code: "invalid_order_key",
      retryable: false,
    })
  }
  const scan = await openOrdersScan(ctx, { order_keys: [orderKey] })
  const candidate = scan.candidates[0]
  if (!candidate) {
    throw new ToolError(`No prep row for ${orderKey}.`, { code: "row_not_found", retryable: false })
  }

  if (candidate.proforma_pending_approval_id && !candidate.proforma_approval_expired) {
    throw new ToolError(
      "This row's proforma is still waiting for approval, so its category cannot change yet. Approve or reject the proforma first.",
      { code: "row_locked", retryable: false },
    )
  }
  if (candidate.anchor_ref) {
    const shipments = await liveShipmentsByAnchor(ctx)
    if (shipments.has(candidate.anchor_ref)) {
      throw new ToolError(
        "A shipment has already been bought against this row's document, so its category cannot change. Cancel the shipment first if the document is wrong.",
        { code: "row_locked", retryable: false },
      )
    }
  }

  const previousCategory = candidate.category
  let orderState = await upsertPrepOrderState(
    ctx,
    orderKey,
    { category: input.category },
    { anchorRef: candidate.anchor_ref, shopifyOrderId: candidate.shopify_order_id },
  )
  let error: { code: string; message: string } | undefined

  const keyKind = parseOrderKey(orderKey)?.kind
  if (input.category === "repair" || input.category === "gift") {
    if (keyKind === "document" && !orderState.proforma_document_ref) {
      // An order-less row IS its proforma: adopt the document in its key instead of issuing a second one.
      orderState = await upsertPrepOrderState(ctx, orderKey, {
        proforma_document_ref: parseOrderKey(orderKey)!.id,
      })
    } else if (!orderState.proforma_document_ref) {
      const items = await proformaItemsForCandidate(ctx, candidate)
      const issued = await ensureNominalProforma(ctx, {
        order_key: orderKey,
        category: input.category,
        counterparty: counterpartyFor(candidate),
        items,
        ...(candidate.shopify_order_id ? { shopify_order_id: candidate.shopify_order_id } : {}),
        ...(candidate.order_name ? { shopify_order_number: candidate.order_name } : {}),
      })
      if (issued.status === "completed") {
        orderState = await upsertPrepOrderState(ctx, orderKey, {
          proforma_document_ref: issued.document_id,
          proforma_number: issued.number,
          proforma_pending_approval_id: null,
        } as Partial<PrepOrderStateRow>)
      } else if (issued.status === "pending_approval") {
        orderState = await upsertPrepOrderState(ctx, orderKey, {
          proforma_pending_approval_id: issued.approval_id,
          proforma_requested_at: new Date().toISOString(),
        })
      } else {
        // The document could not be issued, so the category must not stand: a repair row with no
        // proforma would offer a Ship button anchored on the SALE invoice, which is the wrong
        // customs basis for a return. Put the category back and say why.
        orderState = await upsertPrepOrderState(ctx, orderKey, { category: previousCategory })
        error =
          issued.code === "forbidden"
            ? {
                code: "forbidden",
                message: `The proforma for this category could not be issued: ${issued.message}`,
              }
            : { code: issued.code, message: issued.message }
      }
    }
  }

  // Mirror onto the anchor's prep_state so customs.ts's categoryToCustomsBasis keeps working: the
  // customs basis is a property of the DOCUMENT being declared, and that is what it reads.
  const effectiveCategory = (orderState.category ?? input.category) as PrepCategory
  const anchorForMirror =
    effectiveCategory === "repair" || effectiveCategory === "gift"
      ? (orderState.proforma_document_ref ?? null)
      : (candidate.goods_invoice?.id ?? null)
  if (anchorForMirror) {
    await upsertPrepState(ctx, anchorForMirror, { category: effectiveCategory })
  }

  // Re-quote the NEW anchor (the route and the customs basis both changed) and read the row back.
  if (anchorForMirror && !error) {
    try {
      await prepSync(ctx, { document_refs: [anchorForMirror], limit: 1 })
    } catch {
      // A failed re-quote is not a failed category change: the row comes back `quote_missing`.
    }
  }
  const fresh = await prepList(ctx, { order_keys: [orderKey], include_excluded: true })
  return {
    row: fresh.rows[0] ?? null,
    order_state: orderState,
    ...(error ? { error } : {}),
  }
}

// ── prep_add_shipment (order-less rows) ──────────────────────────────────────

export interface PrepAddShipmentInput {
  /** `repair` or `gift`: an order-less parcel is never a sale, so it always ships on a proforma. */
  category: NominalCategory
  /** Prefill the recipient and the items from an existing Shopify order, by its number (`#1042`). */
  from_order_number?: string
  /** Typed recipient, or the fields to override on top of the prefilled one. */
  recipient?: PrepRecipient
  /** What is physically in the parcel. Defaults to the source order's physical lines. */
  items?: PrepOrderItem[]
  status_note?: string
}

export interface PrepAddShipmentResult {
  order_key: string
  row: PrepRow | null
  order_state: PrepOrderStateRow
}

/** Every field a label buy needs on a recipient, in the order the operator would fill them in.
 *  `email` is required here too (not just address/name/etc): the row's proforma is issued through
 *  invoicing, which refuses to issue any document without a non-blank recipient email
 *  (counterpartyCompletenessError). Refusing up front with `invalid_recipient` names exactly what
 *  is missing, instead of reaching ensureNominalProforma and unwinding a half-created row. */
const REQUIRED_RECIPIENT_FIELDS: Array<[keyof PrepRecipient, string]> = [
  ["name", "name"],
  ["street", "street"],
  ["city", "city"],
  ["postalCode", "postal code"],
  ["countryIsoCode", "country"],
  ["email", "email"],
]

function mergeRecipient(base: PrepRecipient | null, over: PrepRecipient | undefined): PrepRecipient {
  const out: PrepRecipient = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(over ?? {}) as Array<[keyof PrepRecipient, unknown]>) {
    if (v != null && String(v).trim() !== "") (out as Record<string, unknown>)[k] = v
  }
  return out
}

/**
 * `prep_add_shipment`: a row for a parcel that has NO Shopify order behind it.
 *
 * A repaired unit going back to its owner and a sample going to a dealer are real shipping work and
 * were invisible to a queue built from orders. The row is created here, the app issues its nominal
 * proforma (proforma.ts), and from then on it behaves like any other row: same anchor, same draft,
 * same quote, same Ship button.
 *
 * Row identity follows the document: `pending:<token>` while the proforma awaits approval, rewritten
 * to `doc:<document id>` the moment the document exists (either here, or by the scan's token match).
 */
export async function prepAddShipment(
  ctx: BoxtalToolCtx,
  input: PrepAddShipmentInput,
): Promise<PrepAddShipmentResult> {
  if (input.category !== "repair" && input.category !== "gift") {
    throw new ToolError(
      "An order-less shipment is a return after repair or a sample, never a sale: it has no commercial invoice to ship on.",
      { code: "invalid_category", retryable: false },
    )
  }

  let prefillRecipient: PrepRecipient | null = null
  let prefillItems: PrepOrderItem[] = []
  let shopifyOrderId: string | null = null
  let orderName: string | null = null
  if (input.from_order_number) {
    const found = await lookupOrderForPrefill(ctx, input.from_order_number)
    if (!found) {
      throw new ToolError(`No Shopify order matches ${input.from_order_number}.`, {
        code: "order_not_found",
        retryable: false,
      })
    }
    prefillRecipient = found.recipient
    shopifyOrderId = found.shopify_order_id
    orderName = found.order_name
    prefillItems = found.items
      .filter((l) => (l.quantity || 0) > 0)
      .map((l) => ({
        name: l.title ?? l.sku ?? "Item",
        quantity: Math.max(1, l.quantity || 1),
        // Variant gid first: that is what the packing profiles and the customs overlay are keyed on.
        external_id: l.variant_id ?? l.sku ?? null,
        product_source: "shopify",
      }))
  }

  const recipient = mergeRecipient(prefillRecipient, input.recipient)
  const missing = REQUIRED_RECIPIENT_FIELDS.filter(
    ([field]) =>
      !String(recipient[field] ?? "").trim() &&
      !(field === "postalCode" && !postalCodeRequired(recipient.countryIsoCode)),
  ).map(([, label]) => label)
  if (missing.length > 0) {
    throw new ToolError(`The recipient is missing its ${missing.join(", ")}.`, {
      code: "invalid_recipient",
      retryable: false,
    })
  }

  const items = (input.items && input.items.length > 0 ? input.items : prefillItems)
    .filter((i) => i.name && (i.quantity ?? 0) > 0)
    .map((i) => ({ ...i, quantity: Math.max(1, Math.floor(i.quantity)) }))
  if (items.length === 0) {
    throw new ToolError("List what is physically in the parcel: an empty shipment has nothing to declare.", {
      code: "no_items",
      retryable: false,
    })
  }

  // A pending key first, so the row exists (and is recoverable) even if the issue call never
  // returns. The token is the correlation key the scan matches the approved document back on.
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let orderKey = orderKeyForPendingProforma(token)
  let orderState = await upsertPrepOrderState(
    ctx,
    orderKey,
    {
      category: input.category,
      recipient,
      items,
      proforma_requested_at: new Date().toISOString(),
      ...(shopifyOrderId ? { shopify_order_id: shopifyOrderId } : {}),
      ...(input.status_note ? { status_note: input.status_note } : {}),
    },
    { shopifyOrderId },
  )

  const address = [recipient.street, recipient.postalCode, recipient.city].filter(Boolean).join(", ")
  const issued = await ensureNominalProforma(ctx, {
    order_key: orderKey,
    category: input.category,
    // Same rule as counterpartyFor: no invented name, no invented country. The panel collects the
    // recipient, so a missing field is the operator's to fill; ensureNominalProforma names it.
    counterparty: {
      legal_name: recipient.name ?? "",
      country: recipient.countryIsoCode ?? "",
      address: address || null,
      email: recipient.email ?? null,
    },
    items: items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      external_id: i.external_id ?? null,
      product_source: i.product_source ?? "shopify",
      hs_code: i.hs_code ?? null,
      customs_description: i.customs_description ?? null,
      country_of_origin: i.country_of_origin ?? null,
    })),
    ...(shopifyOrderId ? { shopify_order_id: shopifyOrderId } : {}),
    ...(orderName ? { shopify_order_number: orderName } : {}),
  })

  if (issued.status === "error") {
    // Nothing to ship on and nothing to anchor: leaving the row would strand a permanently
    // document-less row nobody can act on. Remove it and say why, so the operator can retry.
    const rows = (await ctx.db.findMany("prep_order_state", { where: { order_key: orderKey }, limit: 1 })) as Array<{
      id: string
    }>
    if (rows[0]) await ctx.db.delete("prep_order_state", rows[0].id)
    throw new ToolError(
      // Never rewrite the underlying reason: a forbidden here has been a missing
      // thread for a nested gated call, not missing rights, and the rewrite hid
      // that for months. Pass the real message through and name the context.
      `The proforma this shipment ships on could not be issued: ${issued.message}`,
      { code: issued.code, retryable: false },
    )
  }

  if (issued.status === "completed") {
    const newKey = orderKeyForDocument(issued.document_id)
    orderState = await upsertPrepOrderState(ctx, orderKey, {
      order_key: newKey,
      proforma_document_ref: issued.document_id,
      proforma_number: issued.number,
      proforma_pending_approval_id: null,
    } as Partial<PrepOrderStateRow>)
    orderKey = newKey
    // The proforma IS the anchor, so the customs basis has to be mirrored onto it like any anchor.
    await upsertPrepState(ctx, issued.document_id, { category: input.category })
    try {
      await prepSync(ctx, { document_refs: [issued.document_id], limit: 1 })
    } catch {
      // A failed first quote leaves the row `quote_missing`, which the grid offers to re-quote.
    }
  } else {
    orderState = await upsertPrepOrderState(ctx, orderKey, {
      proforma_pending_approval_id: issued.approval_id,
    })
  }

  const fresh = await prepList(ctx, { order_keys: [orderKey], include_excluded: true })
  return { order_key: orderKey, row: fresh.rows[0] ?? null, order_state: orderState }
}

export interface PrepOrderPrefillInput {
  order_number: string
}

export interface PrepOrderPrefillResult {
  shopify_order_id: string | null
  order_name: string | null
  recipient: PrepRecipient | null
  items: PrepOrderItem[]
}

/**
 * Read an existing order's ship-to address and physical lines, so the Add shipment panel can show
 * them to the operator BEFORE the shipment is created rather than after.
 *
 * Read only: it creates nothing. `prep_add_shipment` does the same lookup itself when it is handed
 * `from_order_number`, so this is a convenience for the panel, never a required step.
 */
export async function prepOrderPrefill(
  ctx: BoxtalToolCtx,
  input: PrepOrderPrefillInput,
): Promise<PrepOrderPrefillResult> {
  const found = await lookupOrderForPrefill(ctx, input.order_number)
  if (!found) {
    throw new ToolError(`No Shopify order matches ${input.order_number}.`, {
      code: "order_not_found",
      retryable: false,
    })
  }
  return {
    shopify_order_id: found.shopify_order_id,
    order_name: found.order_name,
    recipient: found.recipient,
    items: found.items
      .filter((l) => (l.quantity || 0) > 0)
      .map((l) => ({
        name: l.title ?? l.sku ?? "Item",
        quantity: Math.max(1, l.quantity || 1),
        // Variant gid first: that is what the packing profiles and the customs overlay are keyed on.
        external_id: l.variant_id ?? l.sku ?? null,
        product_source: "shopify",
      })),
  }
}


export interface PrepDocumentPdfInput {
  /** The row whose ANCHOR document to render, or pass document_ref directly. */
  order_key?: string
  document_ref?: string
}

export interface PrepDocumentPdfResult {
  file_id: string | null
  /** True when the document exists but its PDF has not rendered yet (worth retrying shortly). */
  generating: boolean
  error?: string
}

/**
 * The row's shipping document as a downloadable file.
 *
 * The UI can only invoke THIS app's tools, so the cross-app read is made here rather than from the
 * browser. Returns `generating` rather than an error when the document exists but the PDF has not
 * rendered: that is a wait, not a failure, and the row says so and polls.
 */
export async function prepDocumentPdf(
  ctx: BoxtalToolCtx,
  input: PrepDocumentPdfInput,
): Promise<PrepDocumentPdfResult> {
  let ref = input.document_ref ?? null
  if (!ref && input.order_key) {
    const scan = await openOrdersScan(ctx, { order_keys: [input.order_key] })
    ref = scan.candidates[0]?.anchor_ref ?? null
  }
  if (!ref) {
    return { file_id: null, generating: false, error: "This row has no shipping document yet." }
  }
  const env = await ctx.executeTool("invoicing:documents_download_pdf", { id: ref })
  if (env.status === "error") {
    return { file_id: null, generating: false, error: env.error.message }
  }
  if (env.status !== "completed") {
    return { file_id: null, generating: true }
  }
  const res = env.result as { file_id?: string | null; url?: string | null } | null
  if (res?.file_id) return { file_id: res.file_id, generating: false }
  // invoicing answers with a null url while the PDF is still rendering.
  return { file_id: null, generating: true }
}


// ── prep_select_offer ──────────────────────────────────────────────────────

export interface PrepSelectOfferInput {
  document_ref: string
  /** The offer_code to select (MUST be one of the row's cached quote offers), or null/empty to
   *  clear the choice (staging then falls back to the cheapest). */
  offer_code: string | null
}

/**
 * Persist the operator's chosen shipping offer for a prep-dashboard row. The chosen offer_code is
 * what the eventual create_shipment stages instead of the cheapest (see resolveStageOffer). The
 * code is validated against the row's CURRENT cached quote so a selection can never name an offer
 * the route does not actually return; passing null clears the choice. The selection is invalidated
 * with the quote: once the row's route/parcels/category change (the quote goes stale), prep_list
 * surfaces `selected: null` until a re-sync re-establishes the offer.
 */
export async function prepSelectOffer(ctx: BoxtalToolCtx, input: PrepSelectOfferInput): Promise<PrepStateRow> {
  const code = input.offer_code
  if (code != null && code !== "") {
    const quoteRows = (await ctx.db.findMany("prep_quote", {
      where: { document_ref: input.document_ref },
      limit: 1,
    })) as Array<{ offers?: PrepOffer[] | null }>
    const offers = quoteRows[0]?.offers ?? []
    if (!offers.some((o) => o.offer_code === code)) {
      const listed = offers.length > 0 ? offers.map((o) => o.offer_code).join(", ") : "no cached quote, run prep_sync first"
      throw new Error(`Offer "${code}" is not among this row's cached quote offers (${listed}). Re-sync and pick a listed offer.`)
    }
  }
  return upsertPrepState(ctx, input.document_ref, { selected_offer_code: code && code !== "" ? code : null })
}
