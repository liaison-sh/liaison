// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quotes ARE Shopify draft orders.
//
// When an issuer profile is mapped to a Shopify shop, a quote and a draft order are one
// object seen from two sides. Whoever creates the draft order (the Shopify admin UI, an
// agent calling `shopify:draft_orders_create`, or invoicing's own `quote_create_and_issue`)
// makes the quote appear here, and every later edit in Shopify keeps it in step.
//
// This file is the mirror. It subscribes to the four `shopify/draft_order:*` events and
// funnels all of them into one `syncQuoteFromDraftOrder`, so there is a single description
// of what a draft order means as a quote:
//
//   created / updated -> issue the quote, or refresh an existing `sent` one
//   completed         -> the draft order became a real order: the quote is `invoiced`
//                        (the invoice itself arrives via `shopify/order:created`)
//   deleted           -> the offer is off the table: the quote is `rejected`
//
// **Two producers, one trusted field.** The webhook handlers publish the full normalized
// draft order in `event.data`; the TOOL path (`runMutation`) publishes the raw GraphQL
// mutation result instead, which carries little more than the gid. So `entityId` is the only
// field trusted unconditionally, and any event without line items is re-fetched through
// `shopify:draft_orders_get`. That keeps a tool-created draft order and a webhook-delivered
// one producing byte-identical quotes.
//
// **No approval is ever parked here.** These events REPORT a decision a human already made in
// Shopify. Parking an approval card would leave the quote invisible behind a request nobody
// is expecting, so the create path runs with gatingKind "none".

import { type DeferredRow, park, resolveOpenParks } from "../deferred"
import { counterpartyCompletenessError, type DraftLineInput } from "../issue"
import { majorDecimalToMinor, netOfIncludedTax } from "../money"
import {
  documentsUpdate,
  quoteCreateAndIssue,
  type MutationsCtx,
} from "../mutations"
import { findIssuerByShopId, type IssuerProfileRow } from "./shopify-order-paid"

// ── The normalized draft order the shopify app produces ────────────────────
// Mirrors `NormalizedDraftOrder` in bundled-apps/shopify (both webhook handlers and the
// `draft_orders_get` read emit exactly this). Kept as its own declaration because invoicing
// consumes shopify as an OPTIONAL dependency: there is no shared package to import from.

export interface NormalizedAddress {
  name: string | null
  company: string | null
  address1: string | null
  address2: string | null
  zip: string | null
  city: string | null
  province: string | null
  countryCode: string | null
  phone: string | null
}

export interface NormalizedDraftOrderLine {
  id: string | null
  title: string
  sku: string | null
  variantId: string | null
  productId: string | null
  quantity: number
  unitPrice: string
  discountedTotal: string | null
  appliedDiscount: {
    valueType: "PERCENTAGE" | "FIXED_AMOUNT" | null
    value: string | null
    amount: string | null
  } | null
  taxable: boolean
  requiresShipping: boolean
  custom: boolean
  /** A staff-set price for the line. The producer already put it in `unitPrice`; it is the
   *  line's price, never a discount off the variant's list price. */
  priceOverride?: string | null
}

/**
 * The B2B company buying (`purchasingEntity` is a PurchasingCompany). Mirrors
 * `NormalizedPurchasingCompany` in bundled-apps/shopify. A company draft often has no draft-level
 * address: the buyer is the company, billed at its location.
 */
export interface NormalizedPurchasingCompany {
  companyName: string | null
  locationName: string | null
  /** The location's tax registration id: the buyer's VAT number. */
  taxRegistrationId: string | null
  taxExempt: boolean
  contactEmail: string | null
  billingAddress: NormalizedAddress | null
  shippingAddress: NormalizedAddress | null
}

export interface NormalizedDraftOrder {
  draftOrderId: string
  name: string | null
  status: "open" | "invoice_sent" | "completed" | string | null
  orderId: string | null
  orderName: string | null
  shopDomain: string | null
  createdAt: string | null
  updatedAt: string | null
  currency: string | null
  /** True when `currency` is the PRESENTMENT currency. False means the producer
   *  could only resolve the SHOP's currency, which mislabels these amounts
   *  rather than converting them — re-fetch instead of trusting it. */
  currencyIsPresentment?: boolean
  totalPrice: string | null
  subtotalPrice: string | null
  totalTax: string | null
  /** Whether THIS draft's prices include tax. A B2B catalog draft is commonly net on a shop whose
   *  retail prices are gross, so this flag, never the issuer profile, decides the split. */
  taxesIncluded: boolean
  taxExempt: boolean
  email: string | null
  note: string | null
  tags: string[]
  customer: {
    id: string | null
    email: string | null
    firstName: string | null
    lastName: string | null
    company: string | null
  } | null
  billingAddress: NormalizedAddress | null
  shippingAddress: NormalizedAddress | null
  appliedDiscount: {
    title: string | null
    description: string | null
    valueType: "PERCENTAGE" | "FIXED_AMOUNT" | null
    value: string | null
    amount: string | null
  } | null
  shippingLine: { title: string | null; price: string | null } | null
  taxLines: Array<{ title: string | null; rate: number | null; price: string | null }>
  lineItems: NormalizedDraftOrderLine[]
  /** The customer's purchase order number, when Shopify carries one on the draft order (a
   *  custom field or note attribute a salesperson types in the admin, or a B2B buyer's PO on
   *  the storefront). Contract shared with the shopify app's `draft_order:*` event payloads
   *  and `draft_orders_get` read (both emit `poNumber`, camelCase — event/normalized-shape
   *  convention; the invoicing side's own `po_number` column/param stay snake_case). Carried
   *  onto the quote at create AND kept in sync on every later update (Shopify is authoritative
   *  for an order-linked document's PO number, same as shopify_order_number). */
  poNumber?: string | null
  /** The B2B company buying, null for a consumer draft. Only `draft_orders_get` fills it: absent
   *  (`undefined`) means the producer did not look, and the sync re-fetches. */
  purchasingCompany?: NormalizedPurchasingCompany | null
}

export interface DraftOrderCtx extends MutationsCtx {
  /** Kernel resolve-or-create for the Shopify customer, exactly as the order flow uses it. */
  resolveContact(params: {
    email?: string
    name?: string
    externalId?: string
  }): Promise<unknown>
}

/** The event envelope the kernel delivers, plus the two shapes its `data` can take. */
interface DraftOrderEvent {
  entityId?: string
  data?: {
    draftOrderId?: string
    draftOrder?: { id?: string }
  } & Partial<NormalizedDraftOrder>
  draftOrderId?: string
  draftOrder?: { id?: string }
}

export type SyncResult =
  | {
      status: "created" | "updated"
      document_id: string
      number: string | null
      shopify_draft_order_id: string
      shopify_draft_order_name: string | null
    }
  | { status: "invoiced" | "rejected" | "noop"; document_id: string }
  | { status: "deferred"; deferred_id: string; reason: string }
  | {
      status: "skipped"
      reason:
        | "draft_order_id_missing"
        | "issuer_mapping_missing"
        | "counterparty_incomplete"
        | "no_quote"
    }
  | { status: "error"; error: { code: string; message: string } }

// ── Money ──────────────────────────────────────────────────────────────────
// Shopify hands amounts as major-unit decimal strings ("419.40"); documents store integer
// minor units. Zero-decimal currencies have no fractional unit at all.

export function majorAmountToMinor(
  amount: string | number | undefined | null,
  currency: string,
): bigint {
  return majorDecimalToMinor(amount, currency)
}

/**
 * The quote lines for a draft order.
 *
 * Line-level discounts stay EXPLICIT (a discount is a legal item on the document, never
 * folded into the unit price). The ORDER-level discount has no per-line home in Shopify, so
 * it is spread across the lines in proportion to their value, with the rounding remainder
 * landing on the last line: the quote's discount total then equals Shopify's to the cent.
 * Carriage becomes its own `shipping` line so the split-invoice classifier keeps it out of
 * the customs value.
 */
/**
 * The tax rate Shopify baked INTO the draft order's prices, as basis points, or null when
 * prices are net. An EU shop prices tax-inclusive (`taxesIncluded`), so a 120.00 line is
 * 100.00 + 20% VAT; the document stores NET unit prices and adds its own tax line, so the
 * included tax has to be divided out or the quote would charge VAT twice. Shopify reports the
 * rate it applied on `taxLines`; a draft it charged no tax on (reverse charge, export) is
 * already net whatever the shop setting says.
 */
export function includedTaxRateBp(
  draft: NormalizedDraftOrder,
  fallbackPricesIncludeTax = false,
): number | null {
  if (!draftTaxesIncluded(draft, fallbackPricesIncludeTax)) return null
  const rate = (draft.taxLines ?? []).find((t) => typeof t.rate === "number" && t.rate > 0)?.rate
  return rate != null ? Math.round(rate * 10_000) : null
}

/** This draft's own tax inclusivity. The issuer profile's `prices_include_tax` is only the
 *  fallback for a producer that stated none. */
export function draftTaxesIncluded(
  draft: Pick<NormalizedDraftOrder, "taxesIncluded">,
  fallbackPricesIncludeTax = false,
): boolean {
  return typeof draft.taxesIncluded === "boolean" ? draft.taxesIncluded : fallbackPricesIncludeTax
}

/** True when Shopify charges this draft no tax: the draft itself, or its company location, is
 *  tax exempt. */
export function draftIsTaxExempt(draft: NormalizedDraftOrder): boolean {
  return draft.taxExempt === true || draft.purchasingCompany?.taxExempt === true
}

/** Strip an included tax rate (basis points) off a gross minor amount, rounded half up.
 *  The implementation lives in `money.ts` so the hand-typed path (`netLinesForIssuer`, for an
 *  issuer profile with `prices_include_tax` on) and the editor's preview totals divide tax out
 *  exactly the way this sync does. Re-exported here because this is where it was born. */
export { netOfIncludedTax } from "../money"

export function draftOrderLinesToItems(
  draft: NormalizedDraftOrder,
  fallbackPricesIncludeTax = false,
): DraftLineInput[] {
  const currency = draft.currency ?? "EUR"
  const lines = draft.lineItems ?? []
  const rateBp = includedTaxRateBp(draft, fallbackPricesIncludeTax)
  // An exempt buyer (a tax-exempt company location) is charged no tax by Shopify, so the quote
  // charges none either, whatever the classifier would default to for its country.
  const exempt = draftIsTaxExempt(draft)
  const taxOverride = exempt ? { tax_rate_bp_override: 0 } : {}
  const netUnit = (li: NormalizedDraftOrderLine): bigint =>
    li.taxable === false
      ? majorAmountToMinor(li.unitPrice, currency)
      : netOfIncludedTax(majorAmountToMinor(li.unitPrice, currency), rateBp)
  const lineDiscounts = lines.map((li) =>
    li.appliedDiscount?.amount != null
      ? li.taxable === false
        ? majorAmountToMinor(li.appliedDiscount.amount, currency)
        : netOfIncludedTax(majorAmountToMinor(li.appliedDiscount.amount, currency), rateBp)
      : 0n,
  )
  const grossPerLine = lines.map(
    (li) => netUnit(li) * BigInt(Math.max(0, Math.round(li.quantity))),
  )

  // Proportional share of the order-level discount.
  const orderDiscount =
    draft.appliedDiscount?.amount != null
      ? netOfIncludedTax(majorAmountToMinor(draft.appliedDiscount.amount, currency), rateBp)
      : 0n
  const orderShare = lines.map(() => 0n)
  if (orderDiscount > 0n) {
    const totalGross = grossPerLine.reduce((a, b) => a + b, 0n)
    if (totalGross > 0n) {
      let allocated = 0n
      for (let i = 0; i < lines.length; i++) {
        const share = (orderDiscount * grossPerLine[i]!) / totalGross
        orderShare[i] = share
        allocated += share
      }
      // Remainder to the LAST line so the parts sum exactly to the whole.
      if (lines.length > 0) orderShare[lines.length - 1]! += orderDiscount - allocated
    }
  }

  // The unit price is the line's own price as Shopify states it (`originalUnitPrice`: a B2B
  // catalog price or a price override arrive there), and the discount is ONLY what Shopify
  // applied. Nothing here compares against the variant's retail price.
  const items: DraftLineInput[] = lines.map((li, idx) => ({
    position: idx + 1,
    description: li.title,
    quantity: String(li.quantity ?? 1),
    unit_price_minor: netUnit(li),
    discount_minor: lineDiscounts[idx]! + orderShare[idx]!,
    ...taxOverride,
    // A line Shopify says needs no shipping is a digital good: the split-invoice classifier
    // keeps software off the goods (customs) document.
    line_kind: li.requiresShipping === false ? ("software" as const) : ("goods" as const),
    product_source: li.custom ? null : "shopify",
    external_id: li.custom ? null : li.variantId,
  }))

  const shippingPrice = draft.shippingLine
    ? netOfIncludedTax(majorAmountToMinor(draft.shippingLine.price, currency), rateBp)
    : 0n
  if (shippingPrice > 0n) {
    items.push({
      position: items.length + 1,
      description: draft.shippingLine?.title
        ? `Shipping (${draft.shippingLine.title})`
        : "Shipping",
      quantity: "1",
      unit_price_minor: shippingPrice,
      discount_minor: 0n,
      ...taxOverride,
      line_kind: "shipping",
      product_source: null,
      external_id: null,
    })
  }
  return items
}

/** The multiline Bill-to snapshot a document stores. Country and legal name render as their
 *  own lines on the PDF, so neither belongs in this block. */
export function formatDraftOrderAddress(a: NormalizedAddress | null | undefined): string | null {
  if (!a) return null
  const locality = [a.zip, a.city].filter(Boolean).join(" ")
  const withProvince = a.province
    ? [locality, a.province].filter(Boolean).join(", ")
    : locality
  const lines = [a.company, a.address1, a.address2, withProvince || null].filter(
    (l): l is string => typeof l === "string" && l.trim() !== "",
  )
  return lines.length > 0 ? lines.join("\n") : null
}

/** The multiline SHIP TO snapshot. Unlike the Bill-to block, the ship to prints with NO separate
 *  country line (counterparty_country identifies the BILLED party), so the consignee country is
 *  folded into the address itself: on an export parcel, where the goods land must be readable. */
export function formatDraftOrderShippingAddress(
  a: NormalizedAddress | null | undefined,
): string | null {
  const base = formatDraftOrderAddress(a)
  if (!base) return null
  const country = a?.countryCode?.trim()
  return country ? `${base}\n${country}` : base
}

/** Strip the numeric tail off a Shopify gid ("gid://shopify/Customer/42" -> "42"). */
function numericIdFromGid(gid: string | null | undefined): string | undefined {
  if (typeof gid !== "string" || gid === "") return undefined
  const m = gid.match(/(\d+)\s*$/)
  return m ? m[1]! : gid
}

/**
 * The order handle a document stores in `shopify_order_id` is the NUMERIC id (the order:created
 * flow writes `String(order.id)`), never the gid the GraphQL draft-order read returns. Normalise
 * here so the quote and the invoice(s) it produced share one handle and `documents_for_orders`
 * joins them.
 */
export function shopifyOrderIdFromGid(gid: string | null | undefined): string | null {
  return numericIdFromGid(gid) ?? null
}

function fullName(draft: NormalizedDraftOrder): string | null {
  const parts = [draft.customer?.firstName, draft.customer?.lastName].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  )
  return parts.length > 0 ? parts.join(" ") : null
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A company location address without its company line when that line repeats the legal name
 *  (the Bill-to prints the legal name on its own line). */
function withoutRepeatedCompany(
  a: NormalizedAddress | null | undefined,
  legalName: string | null,
): NormalizedAddress | null {
  if (!a) return null
  return sameText(a.company, legalName) ? { ...a, company: null } : a
}

/**
 * Who the quote is addressed to. A consumer draft names its buyer through its own addresses and
 * customer. A B2B draft (`purchasingCompany`) names a COMPANY: its name is the legal name, the
 * location's billing address (else its shipping address) is the Bill-to whenever the draft has
 * no address of its own, the location's tax registration id is the VAT number, and the company
 * contact's email reaches the buyer.
 */
export function resolveDraftCounterparty(
  draft: NormalizedDraftOrder,
  fb: Parameters<typeof syncQuoteFromDraftOrder>[1]["counterpartyFallback"],
): {
  billing: NormalizedAddress | null
  shipping: NormalizedAddress | null
  email: string | null
  legalName: string
  country: string | null
  vatId: string | null
} {
  const pc = draft.purchasingCompany ?? null
  const companyName = pc?.companyName ?? null
  const draftBilling = draft.billingAddress ?? draft.shippingAddress ?? null
  const billing =
    draftBilling ??
    withoutRepeatedCompany(pc?.billingAddress ?? pc?.shippingAddress ?? null, companyName)
  // Captured separately from `billing`, never as a substitute for it.
  const shipping = draft.shippingAddress ?? pc?.shippingAddress ?? null
  // `||`, not `??`: Shopify returns an EMPTY string for a buyer email it dropped, and an
  // empty email must fall through to the customer's, the company contact's, then the caller's.
  const email = draft.email || draft.customer?.email || pc?.contactEmail || fb?.email || null
  const name = fullName(draft)
  const legalName =
    companyName ??
    billing?.company ??
    draft.customer?.company ??
    name ??
    billing?.name ??
    fb?.legal_name ??
    email ??
    ""
  const country =
    draft.billingAddress?.countryCode ??
    draft.shippingAddress?.countryCode ??
    pc?.billingAddress?.countryCode ??
    pc?.shippingAddress?.countryCode ??
    fb?.country ??
    null
  const vatId = pc?.taxRegistrationId ?? fb?.vat_id ?? null
  return { billing, shipping, email, legalName, country, vatId }
}

/** The gid, from the only field both event producers agree on, then the payload fallbacks. */
function draftOrderIdFromEvent(event: DraftOrderEvent): string | null {
  const data = event?.data ?? event
  const candidates = [
    event?.entityId,
    (data as { draftOrderId?: string })?.draftOrderId,
    (data as { draftOrder?: { id?: string } })?.draftOrder?.id,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim()
  }
  return null
}

/** The normalized draft order carried by a webhook event, or null when the event is the
 *  thin tool-shaped one (no line items) and a re-fetch is required. */
function normalizedFromEvent(event: DraftOrderEvent): NormalizedDraftOrder | null {
  const data = event?.data ?? event
  const candidate = data as unknown as NormalizedDraftOrder | undefined
  if (candidate && Array.isArray(candidate.lineItems)) return candidate
  return null
}

async function fetchDraftOrder(
  ctx: DraftOrderCtx,
  draftOrderId: string,
): Promise<{ ok: true; draft: NormalizedDraftOrder } | { ok: false; code: string; message: string }> {
  let envelope
  try {
    envelope = await ctx.executeTool("shopify:draft_orders_get", { id: draftOrderId })
  } catch (err) {
    return {
      ok: false,
      code: "draft_order_fetch_failed",
      message: `shopify:draft_orders_get threw for ${draftOrderId}: ${String(err)}`,
    }
  }
  if (envelope.status !== "completed") {
    return {
      ok: false,
      code:
        envelope.status === "error"
          ? envelope.error?.code ?? "draft_order_fetch_failed"
          : "draft_order_fetch_pending_approval",
      message:
        envelope.status === "error"
          ? envelope.error?.message ?? "shopify:draft_orders_get returned an error"
          : `shopify:draft_orders_get parked an approval for ${draftOrderId}`,
    }
  }
  const draft = (envelope.result as { draftOrder?: NormalizedDraftOrder } | null)?.draftOrder
  if (!draft || !Array.isArray(draft.lineItems)) {
    return {
      ok: false,
      code: "draft_order_not_found",
      message: `shopify:draft_orders_get returned no draft order for ${draftOrderId}`,
    }
  }
  return { ok: true, draft }
}

async function findQuoteByDraftOrderId(
  ctx: DraftOrderCtx,
  draftOrderId: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await ctx.db.findMany("documents", {
    where: { shopify_draft_order_id: draftOrderId },
    limit: 1,
  })) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

function warn(ctx: DraftOrderCtx, message: string): void {
  const logger = (ctx as unknown as { log?: { warn?: (m: string) => void } }).log
  if (logger?.warn) logger.warn(message)
  else console.warn(message)
}

// ── A quote waiting for its issuer's time zone ─────────────────────────────

const ISSUER_TIMEZONE_INVALID = "issuer_timezone_invalid"
const PARKED_DRAFT_ORDER_QUOTE_KIND = "parked_draft_order_quote"

/** The arguments of a sync refused for its zone: everything needed to make the quote later. */
interface ParkedDraftOrderQuote {
  kind: typeof PARKED_DRAFT_ORDER_QUOTE_KIND
  /** What `deferred_list` shows, as it does for an order. */
  order_number: string | null
  draft_order_id: string
  draft: NormalizedDraftOrder
  counterparty_fallback: Parameters<typeof syncQuoteFromDraftOrder>[1]["counterpartyFallback"]
  customer_reference: string | null
}

export function isParkedDraftOrderQuote(payload: unknown): payload is ParkedDraftOrderQuote {
  return (payload as { kind?: unknown } | null | undefined)?.kind === PARKED_DRAFT_ORDER_QUOTE_KIND
}

/**
 * Make the quote a park was waiting for. A quote that exists by now settles it, and is never
 * rewritten from the stored arguments: only a later Shopify event moves an open quote.
 */
export async function retryParkedDraftOrderQuote(
  ctx: MutationsCtx,
  row: Pick<DeferredRow, "event_payload_json">,
): Promise<{ status: "ok" } | { status: "still_blocked"; reason: string }> {
  if (!isParkedDraftOrderQuote(row.event_payload_json)) {
    return { status: "still_blocked", reason: "parked_draft_order_unreadable" }
  }
  const parked = row.event_payload_json
  if (await findQuoteByDraftOrderId(ctx as DraftOrderCtx, parked.draft_order_id)) return { status: "ok" }
  const synced = await syncQuoteFromDraftOrder(ctx, {
    draftOrderId: parked.draft_order_id,
    draft: parked.draft,
    counterpartyFallback: parked.counterparty_fallback,
    customerReference: parked.customer_reference,
  })
  if (synced.status === "deferred") return { status: "still_blocked", reason: synced.reason }
  if (synced.status === "error") return { status: "still_blocked", reason: synced.error.code }
  return { status: "ok" }
}

// ── The sync ───────────────────────────────────────────────────────────────

export async function syncQuoteFromDraftOrder(
  ctx: MutationsCtx,
  input: {
    draftOrderId: string | null
    draft?: NormalizedDraftOrder | null
    deleted?: boolean
    /** The recipient the CALLER already knows (the invoicing quote tool's own counterparty).
     *  Fills what the draft order lacks: Shopify keeps the buyer email only on digital-goods
     *  drafts and a draft made without a linked customer carries no VAT id or contact. */
    counterpartyFallback?: {
      contact_id?: string | null
      legal_name?: string | null
      address?: string | null
      country?: string | null
      email?: string | null
      vat_id?: string | null
    } | null
    /** The caller's own reference for this customer (quote_create_and_issue's
     *  `customer_reference`), already normalised. Shopify has no field for it, so the CALLER
     *  carries it onto the quote: on create, or onto the quote a racing webhook created first. */
    customerReference?: string | null
  },
): Promise<SyncResult> {
  const c = ctx as DraftOrderCtx
  const draftOrderId = input.draftOrderId
  if (!draftOrderId) {
    return { status: "skipped", reason: "draft_order_id_missing" }
  }

  // A delete carries no usable body: act on the quote we already have.
  if (input.deleted) {
    // The offer is off the table, so a quote still waiting for its issuer's zone is not owed.
    await resolveOpenParks(c, draftOrderId, "draft_order_deleted")
    const existing = await findQuoteByDraftOrderId(c, draftOrderId)
    if (!existing) return { status: "skipped", reason: "no_quote" }
    const status = String(existing.status ?? "")
    if (status !== "sent" && status !== "accepted") {
      return { status: "noop", document_id: String(existing.id) }
    }
    await c.db.update("documents", String(existing.id), {
      status: "rejected",
      lifecycle_log: [
        ...((existing.lifecycle_log as Array<Record<string, unknown>>) ?? []),
        {
          event: "draft_order_deleted",
          actor: await c.getUserId(),
          ts: new Date().toISOString(),
          draft_order_id: draftOrderId,
        },
      ],
    })
    return { status: "rejected", document_id: String(existing.id) }
  }

  // 1) Body. The tool-shaped event carries only the gid, so re-fetch whenever line items
  //    are absent -- that is what makes both producers converge on one quote.
  //
  //    ALSO re-fetch when the event's currency is not known to be the PRESENTMENT
  //    currency. Every amount on the normalized shape is presentment, so a
  //    shop-currency label mislabels the money instead of converting it (draft
  //    #D332: 149.00 USD became a 149.00 EUR quote). `draft_orders_get` reads the
  //    currency off the same money bag as the amounts, so it is authoritative;
  //    a webhook that could not state a presentment currency is not. Drafts are
  //    human-created and low-volume, so the extra read is cheap next to issuing a
  //    document in the wrong currency.
  let draft = input.draft ?? null
  //
  //    And re-fetch when the event did not say who the B2B buyer is (`purchasingCompany`
  //    absent): a company draft names its buyer only on `purchasingEntity`, which the webhook
  //    payload does not carry, and it often has no draft-level address at all.
  if (
    !draft ||
    !Array.isArray(draft.lineItems) ||
    draft.currencyIsPresentment !== true ||
    draft.purchasingCompany === undefined
  ) {
    const fetched = await fetchDraftOrder(c, draftOrderId)
    if (!fetched.ok) {
      warn(c, `[invoicing] draft order sync: ${fetched.message}`)
      return { status: "error", error: { code: fetched.code, message: fetched.message } }
    }
    draft = fetched.draft
  }

  // 2) Issuer. No shop mapping means this org does not bill for that store; a standalone
  //    install never receives these events at all.
  const issuer: IssuerProfileRow | null = draft.shopDomain
    ? await findIssuerByShopId(c.db, draft.shopDomain)
    : null
  if (!issuer) {
    warn(
      c,
      `[invoicing] draft order ${draftOrderId}: no issuer profile mapped to shop ${draft.shopDomain ?? "(unknown)"}`,
    )
    return { status: "skipped", reason: "issuer_mapping_missing" }
  }

  // Net or gross is decided PER DRAFT: one shop prices retail gross and B2B catalogs net, so no
  // single issuer setting can be right for both. The draft's own `taxesIncluded` splits net and
  // tax; the issuer profile's `prices_include_tax` is only the fallback when Shopify stated none.
  const fallbackPricesIncludeTax = !!issuer.prices_include_tax

  const existing = await findQuoteByDraftOrderId(c, draftOrderId)

  // 3) Completed -> the draft order became a real order. The quote is invoiced; the INVOICE
  //    is issued by the existing shopify/order:created auto-flow, never here.
  const completed = draft.status === "completed" || !!draft.orderId
  if (completed) {
    await resolveOpenParks(c, draftOrderId, "draft_order_completed")
    if (!existing) return { status: "skipped", reason: "no_quote" }
    const status = String(existing.status ?? "")
    if (status !== "sent" && status !== "accepted") {
      return { status: "noop", document_id: String(existing.id) }
    }
    // Settle on the draft's FINAL lines, not on whatever was last synced.
    // Completion is where the quote stops tracking Shopify, so an edit landing
    // between the last update and the completion used to be lost forever: draft
    // #D332 had a 25.48 line discount added shortly before it was completed, and
    // quote QUO-2026-0006 froze at the undiscounted price. Re-sync first, THEN
    // mark it invoiced, so the settled record is the one the customer was
    // actually charged. Best-effort: a failure here must not block the status
    // transition, which is the part that keeps the quote out of the open pile.
    await resyncLinesBeforeSettling(c, draft, existing, fallbackPricesIncludeTax)
    const orderId = shopifyOrderIdFromGid(draft.orderId)
    const refs = {
      ...((existing.external_refs as Record<string, unknown> | undefined) ?? {}),
      ...(orderId ? { shopify_order_id: orderId } : {}),
      ...(draft.orderName ? { shopify_order_number: draft.orderName } : {}),
    }
    await c.db.update("documents", String(existing.id), {
      status: "invoiced",
      external_refs: refs,
      ...(orderId ? { shopify_order_id: orderId } : {}),
      ...(draft.orderName ? { shopify_order_number: draft.orderName } : {}),
      lifecycle_log: [
        ...((existing.lifecycle_log as Array<Record<string, unknown>>) ?? []),
        {
          event: "draft_order_completed",
          actor: await c.getUserId(),
          ts: new Date().toISOString(),
          draft_order_id: draftOrderId,
          ...(orderId ? { shopify_order_id: orderId } : {}),
        },
      ],
    })
    return { status: "invoiced", document_id: String(existing.id) }
  }

  // 4) Open draft: build the counterparty snapshot the quote prints.
  const fb = input.counterpartyFallback ?? null
  const cp = resolveDraftCounterparty(draft, fb)
  const { billing, shipping, email, legalName, country, vatId } = cp
  let contactId: string | null = null
  if (email || draft.customer?.id) {
    try {
      const resolved = (await c.resolveContact({
        email: email ?? undefined,
        name: legalName || undefined,
        externalId: numericIdFromGid(draft.customer?.id),
      })) as { id?: string } | null
      contactId = resolved?.id ?? null
    } catch {
      contactId = null
    }
  }
  const counterparty = {
    contact_id: contactId ?? fb?.contact_id ?? null,
    legal_name: legalName,
    country: country ?? "",
    vat_id: vatId,
    address: formatDraftOrderAddress(billing) ?? fb?.address ?? null,
    // The ship to is kept as its OWN field rather than collapsed into the billing address: a
    // draft order routinely ships somewhere the invoice is not billed to, and the quote has to
    // print both. Render only: `country` above (the BILLING country) still drives the tax
    // classification, exactly as before.
    shipping_address: formatDraftOrderShippingAddress(shipping),
    shipping_name: shipping?.name ?? shipping?.company ?? null,
    email,
  }
  // A draft order started in Shopify commonly has no address yet (staff type the customer
  // in first). That is not an error: skip, and the next draft_orders/update -- the one where
  // the address lands -- creates the quote.
  const incomplete = counterpartyCompletenessError(counterparty)
  if (incomplete) {
    warn(
      c,
      `[invoicing] draft order ${draftOrderId}: counterparty incomplete (${incomplete.message}); waiting for the next update`,
    )
    return { status: "skipped", reason: "counterparty_incomplete" }
  }

  const items = draftOrderLinesToItems(draft, fallbackPricesIncludeTax)
  const currency = draft.currency ?? "EUR"
  // The customer's PO number, when the draft order carries one -- a salesperson typing it
  // into the Shopify admin is the flow this is FOR, so it must reach the quote whether the
  // draft order arrives at create or at a later update.
  const poNumber =
    typeof draft.poNumber === "string" && draft.poNumber.trim() !== "" ? draft.poNumber.trim() : null

  if (!existing) {
    const created = await quoteCreateAndIssue(c, {
      counterparty,
      issuer_profile_id: issuer.id,
      currency,
      items,
      shopify_draft_order_id: draftOrderId,
      shopify_draft_order_name: draft.name,
      ...(poNumber ? { po_number: poNumber, po_number_source: "shopify_sync" } : {}),
      ...(input.customerReference ? { customer_reference: input.customerReference } : {}),
    })
    // Nobody is waiting on this event, so a quote refused for its issuer's zone must not be lost:
    // it waits for the setting with its arguments, and the deferred retry makes it. No number
    // was taken.
    if (created.status === "error" && created.error.code === ISSUER_TIMEZONE_INVALID) {
      const parked: ParkedDraftOrderQuote = {
        kind: PARKED_DRAFT_ORDER_QUOTE_KIND,
        order_number: draft.name,
        draft_order_id: draftOrderId,
        draft,
        counterparty_fallback: input.counterpartyFallback ?? null,
        customer_reference: input.customerReference ?? null,
      }
      const def = await park(c, {
        event_id: draftOrderId,
        event_payload_json: parked,
        status: "awaiting_config",
        reason: ISSUER_TIMEZONE_INVALID,
        blocked_on: { kind: "issuer_timezone", issuer_profile_id: issuer.id },
      })
      warn(c, `[invoicing] draft order ${draftOrderId}: quote waits for the issuer's time zone`)
      return { status: "deferred", deferred_id: def.id, reason: ISSUER_TIMEZONE_INVALID }
    }
    if (created.status !== "completed") {
      const message =
        created.status === "error"
          ? created.error.message
          : `quote_create_and_issue parked approval ${created.approval_id}`
      warn(c, `[invoicing] draft order ${draftOrderId}: quote not created (${message})`)
      return {
        status: "error",
        error: {
          code: created.status === "error" ? created.error.code : "unexpected_approval",
          message,
        },
      }
    }
    await warnOnTotalDrift(c, draft, created.document_id, currency)
    // An update that arrived after the zone was fixed: the sweep has nothing left to make.
    await resolveOpenParks(c, draftOrderId, "quote_created")
    return {
      status: "created",
      document_id: created.document_id,
      number: created.number,
      shopify_draft_order_id: draftOrderId,
      shopify_draft_order_name: draft.name,
    }
  }

  // 5) The quote exists. Only a still-open offer tracks Shopify: an accepted / rejected /
  //    expired / invoiced quote is a settled record and must not be rewritten under the
  //    customer's feet.
  const status = String(existing.status ?? "")
  if (status !== "sent") {
    return { status: "noop", document_id: String(existing.id) }
  }
  const updated = await documentsUpdate(c, {
    id: String(existing.id),
    counterparty_contact_id: counterparty.contact_id,
    counterparty_name: counterparty.legal_name,
    counterparty_address: counterparty.address,
    counterparty_shipping_address: counterparty.shipping_address,
    counterparty_shipping_name: counterparty.shipping_name,
    counterparty_email: counterparty.email,
    counterparty_country: counterparty.country,
    // Only when the draft names one: an update never erases a VAT number recorded another way.
    ...(counterparty.vat_id ? { counterparty_vat_id: counterparty.vat_id } : {}),
    lines: items,
    // CALLER scoped, not document scoped (see DocumentsUpdateInput's doc comment on
    // lines_are_net): `items` came from draftOrderLinesToItems above, which already netted them
    // via netOfIncludedTax, so documentsUpdate must not net them again. Only WE know that about
    // our own `items` here — an Editor save on this same open quote sends genuinely gross lines
    // and must still be netted, so this can never be decided from the document row alone.
    lines_are_net: true,
    // Keep the quote's PO number in step with a LATER edit of the draft order, not just its
    // creation -- Shopify is authoritative here (same rule as shopify_order_number), so a PO
    // number present on this update OVERWRITES whatever the quote already carries, including a
    // value typed directly on the quote. Absent/blank on THIS payload does not clear an
    // existing value: a webhook that carries no PO field at all (e.g. a quantity-only edit)
    // must not silently erase a PO number recorded another way.
    ...(poNumber ? { po_number: poNumber, po_number_source: "shopify_sync" } : {}),
    // Only the quote tool's own call carries it (a webhook never does), so a webhook update
    // leaves a reference already on the quote untouched.
    ...(input.customerReference ? { customer_reference: input.customerReference } : {}),
  })
  if (updated.status !== "completed") {
    const message =
      updated.status === "error"
        ? updated.error.message
        : `documents_update parked approval ${updated.approval_id}`
    warn(c, `[invoicing] draft order ${draftOrderId}: quote not updated (${message})`)
    return {
      status: "error",
      error: {
        code: updated.status === "error" ? updated.error.code : "unexpected_approval",
        message,
      },
    }
  }
  await warnOnTotalDrift(c, draft, String(existing.id), currency)
  return {
    status: "updated",
    document_id: String(existing.id),
    number: (existing.number as string | null) ?? updated.number ?? null,
    shopify_draft_order_id: draftOrderId,
    shopify_draft_order_name: draft.name,
  }
}

/**
 * Shopify's own total and the quote's computed total can legitimately differ: invoicing
 * derives tax from its regime classifier while Shopify applies the store's tax setup. Shopify
 * stays authoritative for the ORDER, so a difference is a warning to look at, never a failure
 * that would block the quote.
 */
/**
 * Push the draft order's FINAL lines onto a quote that is about to stop tracking
 * Shopify. Same shape as the open-quote update path, minus the PO handling: this
 * runs once, at completion, purely so the settled document matches what the
 * customer was actually charged.
 *
 * Deliberately best-effort. The caller's job is the status transition; a
 * documents_update that errors or parks must not leave the quote sitting in the
 * open pile forever, so a failure is warned about and swallowed.
 */
async function resyncLinesBeforeSettling(
  c: DraftOrderCtx,
  draft: NormalizedDraftOrder,
  existing: Record<string, unknown>,
  fallbackPricesIncludeTax: boolean,
): Promise<void> {
  try {
    const updated = await documentsUpdate(c, {
      id: String(existing.id),
      lines: draftOrderLinesToItems(draft, fallbackPricesIncludeTax),
      // Same caller-scoped contract as the open-quote path: these items are
      // already netted by draftOrderLinesToItems, so do not net them twice.
      lines_are_net: true,
    })
    if (updated.status !== "completed") {
      warn(
        c,
        `[invoicing] draft order ${draft.draftOrderId}: final line re-sync did not apply ` +
          `(${updated.status}); settling the quote on its last synced lines`,
      )
    }
  } catch (err) {
    warn(
      c,
      `[invoicing] draft order ${draft.draftOrderId}: final line re-sync threw ` +
        `(${err instanceof Error ? err.message : String(err)}); settling anyway`,
    )
  }
}

async function warnOnTotalDrift(
  ctx: DraftOrderCtx,
  draft: NormalizedDraftOrder,
  documentId: string,
  currency: string,
): Promise<void> {
  if (draft.totalPrice == null) return
  const shopifyTotal = majorAmountToMinor(draft.totalPrice, currency)
  try {
    const rows = (await ctx.db.findMany("documents", {
      where: { id: documentId },
      limit: 1,
    })) as Array<Record<string, unknown>>
    const row = rows[0]
    if (!row) return
    const ours = BigInt(String(row.grand_total_minor ?? "0"))
    if (ours !== shopifyTotal) {
      warn(
        ctx,
        `[invoicing] draft order ${draft.draftOrderId}: total differs from Shopify ` +
          `(quote ${ours} vs Shopify ${shopifyTotal} ${currency} minor units); ` +
          `tax is derived locally, Shopify stays authoritative for the order`,
      )
    }
  } catch {
    // A drift check must never be the reason a quote sync fails.
  }
}

// ── Kernel event entry points ──────────────────────────────────────────────

export async function onShopifyDraftOrderCreated(
  event: DraftOrderEvent,
  ctx: DraftOrderCtx,
): Promise<SyncResult> {
  return syncQuoteFromDraftOrder(ctx, {
    draftOrderId: draftOrderIdFromEvent(event),
    draft: normalizedFromEvent(event),
  })
}

export async function onShopifyDraftOrderUpdated(
  event: DraftOrderEvent,
  ctx: DraftOrderCtx,
): Promise<SyncResult> {
  return syncQuoteFromDraftOrder(ctx, {
    draftOrderId: draftOrderIdFromEvent(event),
    draft: normalizedFromEvent(event),
  })
}

export async function onShopifyDraftOrderCompleted(
  event: DraftOrderEvent,
  ctx: DraftOrderCtx,
): Promise<SyncResult> {
  return syncQuoteFromDraftOrder(ctx, {
    draftOrderId: draftOrderIdFromEvent(event),
    draft: normalizedFromEvent(event),
  })
}

export async function onShopifyDraftOrderDeleted(
  event: DraftOrderEvent,
  ctx: DraftOrderCtx,
): Promise<SyncResult> {
  return syncQuoteFromDraftOrder(ctx, {
    draftOrderId: draftOrderIdFromEvent(event),
    deleted: true,
  })
}
