// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WORKLIST SCAN: which orders are shipping work.
//
// The pre-rework worklist enumerated ISSUED GOODS INVOICES. That made an order with no invoice
// structurally invisible (ticket-10224: a B2B order on payment terms never reaches PAID, so
// auto-invoicing never fires and the order simply was not in the queue, with no counter and no
// reason). The row source is now the ORDER: every unfulfilled, open, non-cancelled, non-refunded
// Shopify order is a row, with or without a document behind it.
//
// The DOCUMENT is what the row is ANCHORED on, separately from what the row IS:
//   category `sale`            -> the issued goods invoice
//   category `repair` / `gift` -> the app-issued nominal proforma (proforma.ts)
//   neither issued yet         -> no anchor; the row says so and offers no Ship
//
// Cost. One `orders_search` page walk (bounded at 250 orders, 100 per page because that is the
// tool's own maximum) plus at most three `documents_for_orders` calls plus local table reads. The
// scan NEVER resolves a shipment draft: draft resolution is `prep_sync`'s job and the row-scoped
// read's, because resolving one per candidate is what made the old list read approach the sandbox
// timeout at ~26 rows (queues.ts's own comment) and is the latency the operator felt on every
// checkbox click.

import type { BoxtalToolCtx } from "./ctx"
import type { PrepCategory } from "./customs"
import { currencyExponent } from "./money"
import { isOrderShippable, type OrderShippabilityFacts } from "./order-shippability"
import {
  effectiveStatus,
  isExcluded,
  loadOrderStates,
  numericOrderId,
  orderKeyForDocument,
  orderKeyForShopifyOrder,
  parseOrderKey,
  type LegacyPrepStateRow,
  type PrepOrderStateRow,
  type PrepRecipient,
  type PrepStatus,
} from "./order-state"
import { isProformaApprovalExpired, resolvePendingProformas } from "./proforma"
import { type CachedShipTo, shopifyOrderMetaOf } from "./prep-meta"
import { toShopifyOrderGid } from "./shopify-ref"

/**
 * The fulfillment states that are still SHIPPING WORK, as Shopify's order search spells them.
 *
 * `fulfillment_status` is a DISTINCT-VALUE filter over `displayFulfillmentStatus`, not a "not
 * fulfilled" predicate: the documented values are `unshipped`, `shipped`, `fulfilled`, `partial`,
 * `scheduled`, `on_hold`, `unfulfilled` and `request_declined` (shopify.dev, Admin GraphQL `orders`
 * query). So the pre-rework `fulfillment_status:unfulfilled` provably returned ONLY orders whose
 * display status is UNFULFILLED and silently dropped three states that still have units to pack:
 * ON_HOLD (a Shopify fulfillment hold: payment risk, manual hold), SCHEDULED, and
 * PARTIALLY_FULFILLED -- the last one being the state this app's own partial-batch flow puts an
 * order into the moment the first batch ships, so a half-packed order left the queue.
 *
 * `unshipped` is Shopify's own "not yet shipped" term and is kept in the list so a state with no
 * term of its own (IN_PROGRESS, PENDING_FULFILLMENT) is not dropped either.
 */
export const OPEN_ORDER_FULFILLMENT_VALUES = [
  "unfulfilled",
  "unshipped",
  "partial",
  "on_hold",
  "scheduled",
  "request_declined",
] as const

/**
 * The Shopify search query the worklist is defined by.
 *
 * Provably returns: every OPEN order (so no closed/archived and no cancelled order, and never a
 * draft order, which `orders_search` does not return at all) whose display fulfillment status is
 * UNFULFILLED, PARTIALLY_FULFILLED, ON_HOLD, SCHEDULED, REQUEST_DECLINED or one of the in-progress
 * states `unshipped` covers. Never a FULFILLED order. Refunded and cancelled orders that slip
 * through `status:open` are dropped afterwards by `isOrderShippable`.
 *
 * The `AND` + parenthesised `OR` grouping is Shopify's documented search syntax
 * (shopify.dev/docs/api/usage/search-syntax: `Connective = "AND" | "OR"`, subqueries in
 * parentheses).
 */
export const OPEN_ORDERS_QUERY = `status:open AND (${OPEN_ORDER_FULFILLMENT_VALUES.map(
  (v) => `fulfillment_status:${v}`,
).join(" OR ")})`

/** Hard cap on the order scan. Well above any realistic unfulfilled backlog; a hit means the queue
 *  says so out loud rather than quietly showing a prefix.
 *
 *  WHICH END IS DROPPED: `shopify:orders_search` sorts `CREATED_AT` with `reverse: true` (bundled
 *  shopify reads.ts) and takes no sort argument, so the scan walks NEWEST FIRST. A truncated scan
 *  therefore holds the 250 most RECENT open orders and drops the oldest tail, which is the half
 *  most overdue to ship. Anything that words the truncation for the operator has to say that. */
export const ORDER_SCAN_LIMIT = 250

/** orders_search's own per-page maximum (shopify app manifest). */
const ORDERS_PAGE_SIZE = 100

/** documents_for_orders' own per-call maximum (invoicing reads.ts). */
const DOCUMENTS_BATCH_SIZE = 100

// ── shapes ───────────────────────────────────────────────────────────────────

export interface OrderLineItemFact {
  title: string | null
  sku: string | null
  quantity: number
  variant_id?: string | null
}

export interface OrderDocumentLink {
  shopify_order_id: string
  id: string
  number: string | null
  type: string
  scope: string | null
  status: string
  payment_status: string
}

export type AnchorKind = "invoice" | "proforma"

export interface OrderCandidate {
  order_key: string
  shopify_order_id: string | null
  order_name: string | null
  order_created_at: string | null
  customer: string
  destination: string | null
  order_tags: string[]
  financial_status: string | null
  cancelled_at: string | null
  line_items: OrderLineItemFact[]
  order_total_minor: number | null
  currency: string | null
  /** What the customer paid for shipping on the order (its shipping line, after shipping discounts),
   *  in minor units of `customer_shipping_currency`. Null when unknown (no live hit) or no line. */
  customer_shipping_minor: number | null
  customer_shipping_currency: string | null
  recipient: PrepRecipient | null
  documents: OrderDocumentLink[]
  /** The issued GOODS invoice for the order, whatever the row's category is. */
  goods_invoice: OrderDocumentLink | null
  anchor_ref: string | null
  anchor_kind: AnchorKind | null
  anchor_number: string | null
  /** Why there is no anchor, when that is a fact worth showing (not merely "not issued yet"). */
  no_anchor_reason: string | null
  category: PrepCategory
  status: PrepStatus
  status_note: string | null
  /** The Shopify order's internal staff note (the staff's instructions), null when none. From the
   *  live hit when there is one, else what the last sync cached; never for an order-less row. */
  staff_note: string | null
  /** The order's ship-to when the hit is a detail read (orders_get carries the full addresses),
   *  undefined for a search hit (it carries only a summary). prep_sync caches it on prep_meta. */
  ship_to?: CachedShipTo | null
  excluded: boolean
  proforma_pending_approval_id: string | null
  proforma_approval_expired: boolean
  state: PrepOrderStateRow | undefined
}

export interface OpenOrdersScan {
  candidates: OrderCandidate[]
  /** True when the order scan hit its cap, so the worklist is a prefix, not the whole backlog. */
  truncated: boolean
  /** Readable reason the scan could not read Shopify or invoicing, or null. */
  last_sync_error: string | null
  /** False when the invoicing app is not installed or unreachable: no row can show an invoice. */
  invoicing_available: boolean
  /** Whether the candidate set came from a live Shopify search ("live") or was rebuilt from the
   *  local cache with no Shopify call at all ("cache"). Downstream code (worklistCandidates' live
   *  shipment drop) needs to know which signal it is holding: a cache-mode scan carries no live
   *  fulfillment fact, so it cannot rely on Shopify to say an order is done. */
  source: "live" | "cache"
  /** A scoped read's asked key -> the key its row answers under, for every key that is not the
   *  row's own: a proforma that settled during the scan (`pending:<token>` -> `doc:<id>`), or an
   *  order named by its number or gid (`so:#1097`, `so:gid://shopify/Order/<id>`) -> `so:<id>`. */
  key_aliases?: Map<string, string>
}

export interface OpenOrdersScanInput {
  /** Row-scoped read: skip the order scan entirely and read exactly these rows. */
  order_keys?: string[]
  /** "live" (default) pages `shopify:orders_search` for the unscoped read. "cache" skips that call
   *  entirely and rebuilds the candidate set from `prep_meta` + order-state rows only, the same
   *  rebuild the fail-soft branch already does when a live search errors. A scoped read
   *  (`order_keys`) always reads live regardless of this flag: it is a deliberate, bounded
   *  exception, not the list path this flag controls. */
  source?: "live" | "cache"
  /** A READ's scan (prep_list): settling a pending proforma onto its document is written back
   *  best effort, so a write that fails, or a run that may not write, never fails the read. The
   *  settled view is returned either way and the next scan writes it. */
  bestEffortWrites?: boolean
}

// ── shopify hit mapping ──────────────────────────────────────────────────────

interface ShopifyOrderHit {
  id?: string
  title?: string
  name?: string
  currency?: string | null
  /** orders_get carries the internal staff note at the top level. */
  note?: string | null
  attributes?: {
    email?: string | null
    /** orders_search carries the internal staff note here. */
    note?: string | null
    tags?: string[] | null
    financialStatus?: string | null
    fulfillmentStatus?: string | null
    createdAt?: string | null
    cancelledAt?: string | null
    totalAmount?: string | number | null
    /** The order's shipping line price after shipping discounts (buyer-facing currency). */
    shippingAmount?: string | number | null
    shippingCurrency?: string | null
    shippingCountryCode?: string | null
    shippingCountry?: string | null
    shippingAddress1?: string | null
    shippingCity?: string | null
    shippingZip?: string | null
    customer?: {
      displayName?: string | null
      firstName?: string | null
      lastName?: string | null
      email?: string | null
      phone?: string | null
      defaultAddress?: Record<string, string | null> | null
    } | null
    lineItems?: Array<{ sku?: string | null; title?: string | null; quantity?: number | null }> | null
  } | null
  // orders_get adds these at the top level.
  shippingAddress?: Record<string, string | null> | null
  customerAddress?: Record<string, string | null> | null
  lineItems?: Array<{
    id?: string
    title?: string
    quantity?: number
    variant?: { id?: string | null; sku?: string | null } | null
  }> | null
}

/**
 * The shippability facts, mapped EXPLICITLY from the hit's camelCase attributes onto the snake_case
 * shape `order-shippability.ts` declares.
 *
 * This mapping is the whole point of the function. The module treats ABSENT facts as shippable by
 * design (a transient read failure must not empty the queue), so handing it the camelCase object
 * directly reads every order as "no facts, therefore shippable" and puts refunded and cancelled
 * orders back on the worklist. That is the exact bug order-shippability.ts exists to prevent.
 */
export function shippabilityFactsFromHit(hit: ShopifyOrderHit): OrderShippabilityFacts {
  const a = hit.attributes ?? {}
  return {
    financial_status: a.financialStatus ?? null,
    cancelled_at: a.cancelledAt ?? null,
  }
}

function customerName(hit: ShopifyOrderHit): string {
  const c = hit.attributes?.customer
  const full = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim()
  return c?.displayName || full || c?.email || hit.attributes?.email || "-"
}

function recipientFromHit(hit: ShopifyOrderHit): PrepRecipient | null {
  const a = hit.attributes ?? {}
  const detailed = hit.shippingAddress ?? hit.customerAddress ?? null
  if (detailed) {
    const street = [detailed.address1, detailed.address2].filter((v) => v && String(v).trim()).join(", ")
    return {
      name: detailed.name ?? customerName(hit),
      company: detailed.company ?? null,
      email: a.customer?.email ?? a.email ?? null,
      phone: detailed.phone ?? a.customer?.phone ?? null,
      street: street || null,
      city: detailed.city ?? null,
      postalCode: detailed.zip ?? null,
      countryIsoCode: detailed.countryCode ?? null,
    }
  }
  if (!a.shippingAddress1 && !a.shippingCity && !a.shippingZip && !a.shippingCountryCode) return null
  return {
    name: customerName(hit),
    email: a.customer?.email ?? a.email ?? null,
    phone: a.customer?.phone ?? null,
    street: a.shippingAddress1 ?? null,
    city: a.shippingCity ?? null,
    postalCode: a.shippingZip ?? null,
    countryIsoCode: a.shippingCountryCode ?? null,
  }
}

function lineItemsFromHit(hit: ShopifyOrderHit): OrderLineItemFact[] {
  if (Array.isArray(hit.lineItems)) {
    return hit.lineItems.map((l) => ({
      title: l.title ?? null,
      sku: l.variant?.sku ?? null,
      quantity: Number(l.quantity ?? 0) || 0,
      variant_id: l.variant?.id ?? null,
    }))
  }
  const summary = hit.attributes?.lineItems
  if (!Array.isArray(summary)) return []
  return summary.map((l) => ({
    title: l.title ?? null,
    sku: l.sku ?? null,
    quantity: Number(l.quantity ?? 0) || 0,
  }))
}

function totalMinorFromHit(hit: ShopifyOrderHit): number | null {
  const raw = hit.attributes?.totalAmount
  if (raw == null) return null
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw)
  if (!Number.isFinite(n)) return null
  // Exponent-aware, never a hardcoded *100: the render path divides by `currencyExponent`, so
  // scaling a zero-decimal currency (JPY, KRW) by 100 here prints the total 100x too large.
  return Math.round(n * 10 ** currencyExponent(hit.currency ?? "EUR"))
}

/** The shipping the customer paid on the order, from the hit's shipping line. Absent hit or line
 *  reads as unknown (null), never as free. Exported as a test seam. */
export function customerShippingFromHit(
  hit: ShopifyOrderHit | null | undefined,
): { customer_shipping_minor: number | null; customer_shipping_currency: string | null } {
  const raw = hit?.attributes?.shippingAmount
  const n = raw == null ? Number.NaN : typeof raw === "number" ? raw : Number.parseFloat(raw)
  if (!Number.isFinite(n)) return { customer_shipping_minor: null, customer_shipping_currency: null }
  const currency = hit?.attributes?.shippingCurrency ?? hit?.currency ?? null
  return {
    customer_shipping_minor: Math.round(n * 10 ** currencyExponent(currency ?? "EUR")),
    customer_shipping_currency: currency,
  }
}

// ── document join ────────────────────────────────────────────────────────────

/**
 * The row's anchor document among the order's documents.
 *
 * ONLY the header fields `documents_for_orders` returns are consulted (`type`, `status`, `scope`) —
 * no per-document read in the scan. A `software` scoped invoice is not a parcel: an order with only
 * one has nothing to ship, which is a different thing from having no invoice at all.
 */
export function pickGoodsInvoice(docs: OrderDocumentLink[]): OrderDocumentLink | null {
  const issued = docs.filter((d) => d.type === "invoice" && d.status === "issued")
  const goods = issued.filter((d) => d.scope === "goods" || d.scope == null)
  if (goods.length <= 1) return goods[0] ?? null
  // Latest issued wins when several exist (a re-issue after a credit note, the order-split path).
  // NOT by array position: `invoicing:documents_for_orders` reads its rows with no `orderBy`, so
  // postgres row order is arbitrary and can flip between two reads, which would silently move the
  // row's anchor, customs basis, parcels and cached quote. The document NUMBER is the gap-free
  // per-year series, so the highest one is the most recent: compare numerically where both numbers
  // are numeric, and fall back to a string compare so the order is at least TOTAL and stable.
  return [...goods].sort((a, b) => compareDocumentNumbers(a.number, b.number))[goods.length - 1] ?? null
}

/** Total order over document numbers: numeric tail ascending, then the raw string. */
function compareDocumentNumbers(a: string | null, b: string | null): number {
  const na = Number(String(a ?? "").replace(/\D+/g, ""))
  const nb = Number(String(b ?? "").replace(/\D+/g, ""))
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return String(a ?? "").localeCompare(String(b ?? ""))
}

export function hasSoftwareOnlyInvoice(docs: OrderDocumentLink[]): boolean {
  const issued = docs.filter((d) => d.type === "invoice" && d.status === "issued")
  return issued.length > 0 && issued.every((d) => d.scope === "software")
}

const SOFTWARE_ONLY_REASON = "No physical goods to ship"

// ── the scan ─────────────────────────────────────────────────────────────────

async function searchOpenOrders(
  ctx: BoxtalToolCtx,
): Promise<{ hits: ShopifyOrderHit[]; truncated: boolean; error: string | null }> {
  const hits: ShopifyOrderHit[] = []
  let cursor: string | null = null
  let truncated = false
  while (hits.length < ORDER_SCAN_LIMIT) {
    let env: Awaited<ReturnType<BoxtalToolCtx["executeTool"]>>
    try {
      env = await ctx.executeTool("shopify:orders_search", {
        query: OPEN_ORDERS_QUERY,
        limit: Math.min(ORDERS_PAGE_SIZE, ORDER_SCAN_LIMIT - hits.length),
        ...(cursor ? { cursor } : {}),
      })
    } catch (err) {
      return { hits, truncated, error: err instanceof Error ? err.message : String(err) }
    }
    if (env.status !== "completed" || env.result == null) {
      const message =
        env.status === "error"
          ? env.error.message
          : "Shopify did not answer the open-order scan, so this list may be incomplete."
      return { hits, truncated, error: message }
    }
    const raw = env.result as { results?: ShopifyOrderHit[]; nextCursor?: string | null } | ShopifyOrderHit[]
    const page = Array.isArray(raw) ? raw : (raw.results ?? [])
    hits.push(...page)
    const next = Array.isArray(raw) ? null : (raw.nextCursor ?? null)
    if (!next || page.length === 0) return { hits, truncated: false, error: null }
    cursor = next
    truncated = true
  }
  return { hits: hits.slice(0, ORDER_SCAN_LIMIT), truncated, error: null }
}

/**
 * One order's detail read, with FAILURE distinguished from ABSENCE.
 *
 * The two mean opposite things for a row: an order Shopify says nothing about any more is gone from
 * the queue, whereas an order Shopify could not answer for is still there and merely un-refreshed.
 * Collapsing both into `null` is what let one Shopify hiccup blank a row's order number and
 * customer in place (the scoped read rebuilt the row from a missing hit).
 */
type OrderDetailRead =
  | { kind: "hit"; hit: ShopifyOrderHit }
  | { kind: "absent" }
  | { kind: "failed"; error: string }

async function fetchOrderDetail(ctx: BoxtalToolCtx, orderId: string): Promise<OrderDetailRead> {
  try {
    const env = await ctx.executeTool("shopify:orders_get", { id: toShopifyOrderGid(orderId) })
    if (env.status === "completed") {
      return env.result == null ? { kind: "absent" } : { kind: "hit", hit: env.result as ShopifyOrderHit }
    }
    const message =
      env.status === "error" ? env.error.message : "Shopify parked the order read for approval."
    ctx.logger?.warn?.("prep: order detail read did not complete", {
      shopify_order_id: orderId,
      status: env.status,
      err: message,
    })
    return { kind: "failed", error: message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn?.("prep: order detail read threw", { shopify_order_id: orderId, err: message })
    return { kind: "failed", error: message }
  }
}

async function fetchDocumentsForOrders(
  ctx: BoxtalToolCtx,
  orderIds: string[],
): Promise<{ byOrder: Map<string, OrderDocumentLink[]>; available: boolean }> {
  const byOrder = new Map<string, OrderDocumentLink[]>()
  if (orderIds.length === 0) return { byOrder, available: true }
  let available = true
  for (let i = 0; i < orderIds.length; i += DOCUMENTS_BATCH_SIZE) {
    const batch = orderIds.slice(i, i + DOCUMENTS_BATCH_SIZE)
    let env: Awaited<ReturnType<BoxtalToolCtx["executeTool"]>>
    try {
      env = await ctx.executeTool("invoicing:documents_for_orders", { shopify_order_ids: batch })
    } catch (err) {
      available = false
      ctx.logger?.warn?.("prep: documents_for_orders threw", {
        order_count: batch.length,
        err: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (env.status !== "completed" || env.result == null) {
      available = false
      ctx.logger?.warn?.("prep: documents_for_orders did not complete", {
        order_count: batch.length,
        status: env.status,
        err: env.status === "error" ? env.error.message : null,
      })
      continue
    }
    const res = env.result as { links?: OrderDocumentLink[] } | OrderDocumentLink[]
    const links = Array.isArray(res) ? res : (res.links ?? [])
    for (const l of links) {
      const id = numericOrderId(l.shopify_order_id) ?? String(l.shopify_order_id ?? "")
      if (!id) continue
      const list = byOrder.get(id) ?? []
      list.push(l)
      byOrder.set(id, list)
    }
  }
  return { byOrder, available }
}

/** Resolve every row whose proforma was pending, persist what came back, and re-key the order-less
 *  rows that were waiting under a `pending:` token onto their new `doc:` identity. */
async function settlePendingProformas(
  ctx: BoxtalToolCtx,
  states: Map<string, PrepOrderStateRow & { id: string }>,
  opts: { bestEffortWrites?: boolean } = {},
): Promise<Map<string, string>> {
  const renames = new Map<string, string>()
  const pending = [...states.values()].filter((s) => s.proforma_pending_approval_id && !s.proforma_document_ref)
  if (pending.length === 0) return renames
  const resolved = await resolvePendingProformas(
    ctx,
    pending.map((s) => ({
      order_key: s.order_key,
      proforma_pending_approval_id: s.proforma_pending_approval_id,
      proforma_requested_at: s.proforma_requested_at,
    })),
  )
  for (const row of pending) {
    const hit = resolved.get(row.order_key)
    if (!hit) continue
    const parsed = parseOrderKey(row.order_key)
    const newKey = parsed?.kind === "pending" ? orderKeyForDocument(hit.document_id) : row.order_key
    const patch: Partial<PrepOrderStateRow> & { proforma_number?: string | null } = {
      proforma_document_ref: hit.document_id,
      proforma_number: hit.number,
      proforma_pending_approval_id: null,
      ...(newKey !== row.order_key ? { order_key: newKey } : {}),
    }
    try {
      await ctx.db.update("prep_order_state", row.id, patch as Record<string, unknown>)
    } catch (err) {
      if (!opts.bestEffortWrites) throw err
      ctx.logger?.warn?.("boxtal: could not record a settled proforma", {
        order_key: row.order_key,
        err: String(err),
      })
    }
    states.delete(row.order_key)
    states.set(newKey, { ...row, ...patch, order_key: newKey })
    // The caller may have asked for the OLD key (a row-scoped read is what usually triggers the
    // settle), so the rename has to be reported back: reading `pending:<token>` after the document
    // landed must return the `doc:<id>` row, not a phantom key with no state behind it.
    if (newKey !== row.order_key) renames.set(row.order_key, newKey)
  }
  return renames
}

function buildCandidate(args: {
  orderKey: string
  hit: ShopifyOrderHit | null
  documents: OrderDocumentLink[]
  state: (PrepOrderStateRow & { id?: string }) | undefined
  legacy: LegacyPrepStateRow | undefined
  shopifyOrderId: string | null
  /** What the last successful sync knew about this order. Used ONLY when there is no live hit, so a
   *  row Shopify could not answer for keeps its order number, tags and date instead of blanking. */
  meta?: CachedOrderMeta | undefined
}): OrderCandidate {
  const { hit, documents, state, legacy, shopifyOrderId, meta } = args
  const category = (state?.category ?? legacy?.category ?? "sale") as PrepCategory
  const goodsInvoice = pickGoodsInvoice(documents)

  const proformaRef = state?.proforma_document_ref ?? null
  const proformaNumber = (state as { proforma_number?: string | null } | undefined)?.proforma_number ?? null

  let anchorRef: string | null = null
  let anchorKind: AnchorKind | null = null
  let anchorNumber: string | null = null
  const keyKind = parseOrderKey(args.orderKey)?.kind
  const pendingProforma = state?.proforma_pending_approval_id ?? null

  // ANCHOR RULE, in order:
  //   1. A PENDING proforma detaches the row. The operator asked for a nominal document and the
  //      answer is not in yet; anchoring on the sale invoice meanwhile would let them buy a label
  //      against a document that declares a commercial sale for a repair return.
  //   2. The app-issued proforma, once it exists AND the category still calls for it (repair /
  //      sample). Back on `sale` the proforma is not deleted, it simply stops anchoring the row.
  //   3. An order-less row IS its proforma: the document id is in its key.
  //   4. Otherwise the issued goods invoice. This also covers a row whose category was set to
  //      repair/gift BEFORE the rework (the flag lives on prep_state with no proforma behind it):
  //      it keeps the anchor it has always had rather than falling off the queue on upgrade.
  if (pendingProforma) {
    // anchorless on purpose
  } else if (proformaRef && (category === "repair" || category === "gift")) {
    anchorRef = proformaRef
    anchorKind = "proforma"
    anchorNumber = proformaNumber
  } else if (keyKind === "document") {
    anchorRef = parseOrderKey(args.orderKey)!.id
    anchorKind = "proforma"
    anchorNumber = proformaNumber
  } else if (goodsInvoice) {
    anchorRef = goodsInvoice.id
    anchorKind = "invoice"
    anchorNumber = goodsInvoice.number
  }

  let noAnchorReason: string | null = null
  if (!anchorRef && hasSoftwareOnlyInvoice(documents)) {
    noAnchorReason = SOFTWARE_ONLY_REASON
  }

  return {
    order_key: args.orderKey,
    shopify_order_id: shopifyOrderId,
    order_name: hit?.name ?? hit?.title ?? meta?.order_name ?? null,
    order_created_at: hit?.attributes?.createdAt ?? meta?.order_created_at ?? null,
    customer: hit ? customerName(hit) : (state?.recipient?.name || "-"),
    destination:
      hit?.attributes?.shippingCountryCode ??
      hit?.shippingAddress?.countryCode ??
      state?.recipient?.countryIsoCode ??
      null,
    order_tags: Array.isArray(hit?.attributes?.tags) ? hit!.attributes!.tags! : cachedTags(meta),
    financial_status: hit?.attributes?.financialStatus ?? (hit ? null : (meta?.financial_status ?? null)),
    cancelled_at: hit?.attributes?.cancelledAt ?? (hit ? null : (meta?.cancelled_at ?? null)),
    line_items: hit ? lineItemsFromHit(hit) : [],
    order_total_minor: hit ? totalMinorFromHit(hit) : null,
    currency: hit?.currency ?? null,
    ...customerShippingFromHit(hit),
    recipient: (hit ? recipientFromHit(hit) : null) ?? state?.recipient ?? null,
    documents,
    goods_invoice: goodsInvoice,
    anchor_ref: anchorRef,
    anchor_kind: anchorKind,
    anchor_number: anchorNumber,
    no_anchor_reason: noAnchorReason,
    category,
    status: effectiveStatus(state, legacy),
    status_note: state?.status_note ?? null,
    staff_note: hit ? (hit.attributes?.note ?? hit.note ?? null) : (meta?.staff_note ?? null),
    ...(hit && (hit.shippingAddress !== undefined || hit.customerAddress !== undefined)
      ? { ship_to: shopifyOrderMetaOf({ status: "completed", result: hit })?.ship_to ?? null }
      : {}),
    excluded: isExcluded(state, legacy),
    proforma_pending_approval_id: state?.proforma_pending_approval_id ?? null,
    proforma_approval_expired: isProformaApprovalExpired(state?.proforma_requested_at),
    state,
  }
}

/** The order facts the last successful sync persisted for a row (`prep_meta`), which is what a row
 *  falls back on when Shopify cannot be read. */
export interface CachedOrderMeta {
  document_ref: string
  shopify_order_id?: string | null
  order_name?: string | null
  order_tags?: unknown
  order_created_at?: string | null
  financial_status?: string | null
  cancelled_at?: string | null
  staff_note?: string | null
  fetched_at?: string | null
}

/** How stale a cached order row may be and still be shown during a Shopify outage. Beyond this the
 *  row is more likely long shipped than still shipping work, so an outage does not resurrect it. */
export const CACHED_ROW_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** Legacy per-document flags, indexed BOTH by the order key they belong to (via prep_meta, which
 *  the pre-rework worklist wrote) and by the document itself, so a row whose prep_meta was never
 *  written still finds its flags through its current anchor. Returns the cached order facts too:
 *  same read, and they are the fail-soft source for a row Shopify did not answer for. */
async function legacyStateIndex(ctx: BoxtalToolCtx): Promise<{
  byKey: Map<string, LegacyPrepStateRow>
  byDocument: Map<string, LegacyPrepStateRow>
  metaByOrderId: Map<string, CachedOrderMeta>
}> {
  const [legacy, metas] = await Promise.all([
    ctx.db.findMany("prep_state", { limit: 1000 }) as Promise<LegacyPrepStateRow[]>,
    ctx.db.findMany("prep_meta", { limit: 1000 }) as Promise<CachedOrderMeta[]>,
  ])
  const keyByDocument = new Map<string, string>()
  const metaByOrderId = new Map<string, CachedOrderMeta>()
  for (const m of metas) {
    const oid = numericOrderId(m.shopify_order_id)
    keyByDocument.set(
      m.document_ref,
      oid ? orderKeyForShopifyOrder(oid) : orderKeyForDocument(m.document_ref),
    )
    if (oid) {
      const seen = metaByOrderId.get(oid)
      // Several documents can point at one order (an invoice plus a proforma): keep the freshest.
      if (!seen || String(m.fetched_at ?? "") > String(seen.fetched_at ?? "")) metaByOrderId.set(oid, m)
    }
  }
  const byKey = new Map<string, LegacyPrepStateRow>()
  const byDocument = new Map<string, LegacyPrepStateRow>()
  for (const l of legacy) {
    byKey.set(keyByDocument.get(l.document_ref) ?? orderKeyForDocument(l.document_ref), l)
    byDocument.set(l.document_ref, l)
  }
  return { byKey, byDocument, metaByOrderId }
}

function cachedTags(meta: CachedOrderMeta | undefined): string[] {
  const raw = meta?.order_tags
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : []
}

/**
 * Rebuild the order-key set from the CACHE alone, no Shopify call: `prep_meta` (bounded by
 * `CACHED_ROW_MAX_AGE_MS`, filtered on the cached shippability facts) plus every order-state row.
 *
 * ONE implementation, used by both callers that need a cache-only key set: the fail-soft branch
 * (a live search errored) and the deliberate cache-mode read (`source: "cache"`, never calls
 * Shopify at all). Keeping this in one place is the point -- two copies of the same rebuild is how
 * they drift.
 */
function cachedOrderKeys(
  states: Map<string, PrepOrderStateRow & { id: string }>,
  legacyIndex: { metaByOrderId: Map<string, CachedOrderMeta> },
): Set<string> {
  const keys = new Set<string>()
  const cutoff = Date.now() - CACHED_ROW_MAX_AGE_MS
  for (const [orderId, meta] of legacyIndex.metaByOrderId) {
    const fetchedMs = meta.fetched_at ? Date.parse(String(meta.fetched_at)) : NaN
    if (Number.isFinite(fetchedMs) && fetchedMs < cutoff) continue
    if (
      !isOrderShippable({ financial_status: meta.financial_status ?? null, cancelled_at: meta.cancelled_at ?? null })
    ) {
      continue
    }
    keys.add(orderKeyForShopifyOrder(orderId))
  }
  for (const k of states.keys()) {
    if (parseOrderKey(k)?.kind === "order") keys.add(k)
  }
  return keys
}

/**
 * The candidate set behind every prep read.
 *
 * With `order_keys` it is a ROW-SCOPED read: the order scan is skipped entirely and only those rows
 * are re-read (one `orders_get` per order row plus one `documents_for_orders`). That is what lets a
 * row action patch ONE row instead of re-listing the whole grid.
 */
export async function openOrdersScan(
  ctx: BoxtalToolCtx,
  input: OpenOrdersScanInput = {},
): Promise<OpenOrdersScan> {
  const scoped = Array.isArray(input.order_keys) && input.order_keys.length > 0
  const cacheOnly = !scoped && input.source === "cache"
  const [states, legacyIndex] = await Promise.all([loadOrderStates(ctx), legacyStateIndex(ctx)])
  const renames = await settlePendingProformas(ctx, states, {
    bestEffortWrites: input.bestEffortWrites === true,
  })

  let hitsByOrderId = new Map<string, ShopifyOrderHit>()
  let truncated = false
  let lastSyncError: string | null = null
  let orderKeys: string[]
  const keyAliases = new Map<string, string>(renames)
  // Scoped reads are always live (a handful of named rows, refreshed on purpose). The unscoped
  // list read is live by default and cache-only when asked, per `input.source`.
  const source: "live" | "cache" = cacheOnly ? "cache" : "live"

  if (scoped) {
    // A proforma that settled during THIS call re-keyed its row (`pending:<token>` -> `doc:<id>`),
    // and the caller is holding the old key. Follow the rename instead of reading a key nothing
    // stands behind any more, which would answer with a phantom document-less sale row.
    orderKeys = [...new Set(input.order_keys!.map((k) => renames.get(k) ?? k))]
    const orderIds = orderKeys
      .map((k) => parseOrderKey(k))
      .filter((p): p is { kind: "order"; id: string } => p?.kind === "order")
      .map((p) => p.id)
    const details = await Promise.all(orderIds.map((id) => fetchOrderDetail(ctx, id)))
    const gone = new Set<string>()
    const unread: string[] = []
    // The order's own id, for a key that named it some other way: its number (`so:#1097`,
    // `so:1097`) or its gid. `shopify:orders_get` resolves all of them, but the invoice lookup
    // and every cached row (draft, quote, state) key on the numeric id, so a row kept under the
    // asked key read "No invoice issued", no parcels and no quote for an order that has all three.
    const canonical = new Map<string, string>()
    orderIds.forEach((id, i) => {
      const d = details[i]!
      if (d.kind === "hit") {
        const own = numericOrderId(d.hit.id) ?? id
        if (own !== id) canonical.set(id, own)
        // Every filter the list read applies, applies here too, or a scoped read and a list read
        // disagree: an order refunded or cancelled since the last list read leaves the queue.
        if (isOrderShippable(shippabilityFactsFromHit(d.hit))) hitsByOrderId.set(own, d.hit)
        else gone.add(id)
        return
      }
      if (d.kind === "absent") gone.add(id)
      else unread.push(id)
    })
    // A row Shopify ANSWERED about and no longer wants in the queue drops out. A row Shopify could
    // not answer about keeps its key and is rebuilt from `prep_meta`, so a transient failure leaves
    // the row standing (with the error said out loud) instead of blanking its number and customer.
    if (gone.size > 0) {
      orderKeys = orderKeys.filter((k) => {
        const p = parseOrderKey(k)
        return !(p?.kind === "order" && gone.has(p.id))
      })
    }
    if (unread.length > 0) {
      lastSyncError = "Shopify did not answer, so these rows were not refreshed."
    }
    if (canonical.size > 0) {
      const rekeyed = orderKeys.map((k) => {
        const p = parseOrderKey(k)
        const own = p?.kind === "order" ? canonical.get(p.id) : undefined
        if (!own) return k
        const key = orderKeyForShopifyOrder(own)
        keyAliases.set(k, key)
        return key
      })
      orderKeys = [...new Set(rekeyed)]
    }
  } else {
    // Order-less rows: every order-state row keyed on a document or a pending proforma. These do
    // not depend on the Shopify search either way, live or cache mode.
    const orderLess = [...states.keys()].filter((k) => {
      const p = parseOrderKey(k)
      return p?.kind === "document" || p?.kind === "pending"
    })
    const keys = new Set<string>(orderLess)

    if (cacheOnly) {
      // CACHE MODE: never calls `shopify:orders_search`. The manifest promises `prep_list`'s list
      // read is a FREE READ that never touches a live Shopify or Boxtal API, and prod logs showed
      // it doing so anyway (chained into `shopify:orders_search` 14 times in 72h) -- this branch is
      // what makes that sentence true. No live hits, so nothing is truncated and there is no sync
      // error to report; the cache is the whole signal.
      truncated = false
      lastSyncError = null
      for (const k of cachedOrderKeys(states, legacyIndex)) keys.add(k)
    } else {
      const search = await searchOpenOrders(ctx)
      truncated = search.truncated
      lastSyncError = search.error
      const live: Array<[string, ShopifyOrderHit]> = []
      for (const hit of search.hits) {
        if (!isOrderShippable(shippabilityFactsFromHit(hit))) continue
        const id = numericOrderId(hit.id)
        if (!id) continue
        live.push([id, hit])
      }
      hitsByOrderId = new Map(live)
      for (const [id] of live) keys.add(orderKeyForShopifyOrder(id))
      if (search.error != null) {
        // FAIL SOFT (blueprint 1.2 §9): a Shopify read failure returns the CACHED rows plus
        // `last_sync_error`, never an empty worklist. An empty list is indistinguishable from
        // "nothing to prepare" to the operator, and it also poisons the grid's own cache, so one
        // transient 5xx used to make the whole queue disappear until Shopify recovered.
        for (const k of cachedOrderKeys(states, legacyIndex)) keys.add(k)
      }
    }
    orderKeys = [...keys]
  }

  const orderIdsNeedingDocs = orderKeys
    .map((k) => parseOrderKey(k))
    .filter((p): p is { kind: "order"; id: string } => p?.kind === "order")
    .map((p) => p.id)
  const { byOrder, available } = await fetchDocumentsForOrders(ctx, orderIdsNeedingDocs)
  if (!available && lastSyncError == null && orderIdsNeedingDocs.length > 0) {
    lastSyncError = "The invoicing app did not answer, so invoice state may be out of date."
  }

  const candidates = orderKeys.map((key) => {
    const parsed = parseOrderKey(key)
    const shopifyOrderId = parsed?.kind === "order" ? parsed.id : (states.get(key)?.shopify_order_id ?? null)
    const documents = shopifyOrderId ? (byOrder.get(shopifyOrderId) ?? []) : []
    const state = states.get(key)
    // Prefer the flags indexed by key; fall back to the ones on the row's current anchor document.
    const anchorForLegacy =
      state?.proforma_document_ref ?? pickGoodsInvoice(documents)?.id ?? (parsed?.kind === "document" ? parsed.id : null)
    const legacy =
      legacyIndex.byKey.get(key) ?? (anchorForLegacy ? legacyIndex.byDocument.get(anchorForLegacy) : undefined)
    return buildCandidate({
      orderKey: key,
      hit: shopifyOrderId ? (hitsByOrderId.get(shopifyOrderId) ?? null) : null,
      documents,
      state,
      legacy,
      shopifyOrderId,
      meta: shopifyOrderId ? legacyIndex.metaByOrderId.get(shopifyOrderId) : undefined,
    })
  })

  return {
    candidates,
    truncated,
    last_sync_error: lastSyncError,
    invoicing_available: available,
    source,
    key_aliases: keyAliases,
  }
}

/** What an existing Shopify order contributes to an ORDER-LESS shipment: the recipient to ship to
 *  and the items that were in the original parcel. */
export interface OrderPrefill {
  shopify_order_id: string
  order_name: string | null
  recipient: PrepRecipient | null
  items: OrderLineItemFact[]
}

/**
 * Look an order up by its NUMBER (what the operator reads off a packing slip or an email), so the
 * Add shipment panel can prefill a return without retyping an address. Accepts `#1042`, `1042` or
 * the numeric order id itself.
 */
export async function lookupOrderForPrefill(
  ctx: BoxtalToolCtx,
  orderNumber: string,
): Promise<OrderPrefill | null> {
  const trimmed = String(orderNumber ?? "").trim()
  // The order number is UNTRUSTED text (a free-text panel field, or a raw tool param). Shopify's
  // search syntax treats `:` as a clause separator, so interpolating it raw let `1042 tag:vip`
  // execute a query nobody asked for. Accept only what an order number IS: digits, optionally
  // prefixed with `#`. Anything else is not a number to look up, it is a no-match.
  if (!/^#?\d{1,20}$/.test(trimmed)) return null
  const digits = trimmed.replace(/^#/, "")
  const name = `#${digits}`
  let hit: ShopifyOrderHit | null = null
  try {
    const env = await ctx.executeTool("shopify:orders_search", { query: `name:"${name}"`, limit: 5 })
    if (env.status === "completed" && env.result != null) {
      const raw = env.result as { results?: ShopifyOrderHit[] } | ShopifyOrderHit[]
      const page = Array.isArray(raw) ? raw : (raw.results ?? [])
      // EXACT name only. The old `?? page[0]` fallback meant a near miss silently prefilled a
      // DIFFERENT customer's address and items into a new shipment.
      hit = page.find((h) => (h.name ?? h.title) === name) ?? null
    } else if (env.status === "error") {
      ctx.logger?.warn?.("prep: order prefill search failed", { order_name: name, err: env.error.message })
    }
  } catch (err) {
    ctx.logger?.warn?.("prep: order prefill search threw", {
      order_name: name,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  if (!hit) return null
  const id = numericOrderId(hit.id)
  if (!id) return null
  // The search hit carries a summary; the detail read is what has the full shipping address.
  const read = await fetchOrderDetail(ctx, id)
  const detail = read.kind === "hit" ? read.hit : hit
  return {
    shopify_order_id: id,
    order_name: detail.name ?? detail.title ?? name,
    recipient: recipientFromHit(detail) ?? recipientFromHit(hit),
    items: lineItemsFromHit(detail),
  }
}
