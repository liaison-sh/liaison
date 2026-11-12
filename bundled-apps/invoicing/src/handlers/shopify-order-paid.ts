// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E2 — `onShopifyOrderPaid` handler (the killer auto-flow).
//
// Composes the 13-step flow from spec §6 ("Order-paid flow"):
//   1. Idempotency: an existing billing document for the order short-circuits
//      (see fetchOrderDocuments).
//   3. Look up shop's mapped issuer profile via issuer_profiles.shopify_shop_id.
//      Missing → park awaiting_config.
//   4. Skip if order.total_price == 0 (no-op, debug log).
//   5. Resolve contact via existing kernel contact (Phase 16 created it on
//      customer create). Missing email → park awaiting_data.
//   6. Classify tax via the in-app regime engine. Ambiguous → safe default;
//      unconfigured → park awaiting_config.
//   7. Snapshot lines via issueDocument helper (D7); customs overlay
//      lookup happens inline in that helper.
//   8. Build draft.
//   9. Threshold: if !ctx.approval && amount > issuer.invoice_approval_threshold,
//      file an approval and return {status: 'pending_approval'}. On approve,
//      the kernel re-invokes the same handler with ctx.approval populated
//      (deliverable K6) — skip the threshold check on re-entry.
//   10. Issue inside ambient tx (delegates to issueDocument helper from D7).
//   11. Render PDF (inside issueDocument); failure → render_failed deferred
//       row + lifecycle log.
//   12. Post into contact thread (inside issueDocument); failure → attention,
//       not retried inline.
//   13. If issuer.auto_email_enabled, call mail:composeForApp (no Mail-side
//       approval; the invoicing-side gate already covered approval). Failure
//       → email_failed deferred row.

import type { CrossAppExecuteTool } from "../cross-app"
import { deliveryFileId } from "../legal-originals/delivery"
import { park, resolveOpenParks } from "../deferred"
import {
  CustomsFetchError,
  counterpartyCompletenessError,
  issueDocument,
  type IssueCtx,
  type IssueInput,
  type LineKind,
} from "../issue"
import { EINVOICE_IDENTITY_PARK_KIND, raiseIdentityAttention } from "../einvoicing/gate"
import { ensureDerivedIdentity } from "../einvoicing/identity-derive"
import { type FxFetchCtx, FxRateUnavailableError, fxIssueDate, warmFxRate } from "../einvoicing/fx"
import { checkEinvoiceGate } from "../einvoicing/issue-gate"
import { formatMoneyMinor, lineSubtotal, lineTax, majorDecimalToMinor, netOfTax } from "../money"
import { civilDateOf, type IssueDateParts, issueDateParts } from "../issue-date"
import { isFullyCredited } from "../mutations"
import { isUniqueViolation } from "../mutations/quote-proforma-po"
import { classify, EXEMPT_TREATMENTS, isUntaxedIntraEuSaleWithoutVat } from "../tax"

export interface OrderPaidPayload {
  id: string // Shopify order ID (external_id)
  /**
   * The order's HUMAN name ("#1149") -- what the customer quotes, what the
   * store's order list shows, and what support searches for. Carried alongside
   * the numeric id so the invoice can be found BY order number and can print it
   * on its face. Optional: an older shopify-app event shape carries no `name`,
   * and the enrichment fetch fills it in when the webhook did not.
   */
  order_number?: string | null
  shop_id: string // Shopify shop GID
  createdAt?: string
  /**
   * Shopify's order-level payment state (lowercase REST value: "paid",
   * "pending", "authorized", "partially_paid", "refunded", …). Threaded from the
   * `orders/create` webhook so the auto-issued invoice can record settlement: a
   * checkout that is already "paid" reconciles the invoice's `payment_status` to
   * "paid" (it stays `status: "issued"` so it remains shippable by boxtal — only
   * the payment side is settled). Absent/any-other value leaves it unpaid.
   */
  financial_status?: string | null
  /**
   * The customer's purchase order number, when Shopify carries one on the order (a custom
   * field or note attribute the shop captures at checkout/B2B ordering). Contract shared with
   * the shopify app's `order:created` event payload (`ShopifyOrderCreatedEvent.poNumber`
   * below): a plain string or null, never fabricated when the order carries none. Persisted
   * onto `external_refs.po_number` (mirrored to the top-level `po_number` column at issue) and
   * printed as a "PO number" line on the invoice PDF.
   */
  po_number?: string | null
  // Integer minor units. Crosses the JSON bridge (stored as event_payload_json /
  // replayed as approval current_payload), so the adapter emits a STRING — a raw
  // bigint here makes JSON.stringify throw. `toBigIntMinor` parses any form.
  total_price_minor: bigint | number | string
  currency: string
  customer?: {
    id: string | null
    email: string | null
    contact_id: string | null
    /** The BILLING country: printed under the Bill-to address. Older payloads (adapted before
     *  `tax_country` existed, still replayable from a park or an approval) carry the DESTINATION
     *  here; with no `tax_country` it then keeps serving as the tax input, exactly as before. */
    country?: string
    /** The tax destination country (where the goods are delivered), the classifier's input.
     *  Kept apart from `country` so a billing address in one country and a delivery in another
     *  never print a street from the first under the country line of the second. */
    tax_country?: string
    legal_name?: string
    vat_id?: string | null
    address?: string | null
    /** Ship to, captured as its OWN field. It used to be read and then discarded (or used AS the
     *  billing address), so an order shipped to a different consignee printed one address only.
     *  RENDER ONLY: the tax treatment still derives from `country` (the billing country). */
    shipping_address?: string | null
    /** Consignee name when the parcel is addressed to someone other than the billing customer. */
    shipping_name?: string | null
    /** The structured billing address (and its company), as the event carries it. Absent on a
     *  payload adapted before it existed. */
    billing?: OrderAddress | null
    /** The structured delivery address (the ship to). */
    delivery?: OrderDeliveryAddress | null
  }
  line_items: Array<{
    id: string // shopify product/variant id (external_id)
    description: string
    quantity: string
    // NET (tax-exclusive) unit price. The adapter de-taxes gross Shopify prices
    // (taxes_included shops) before building this payload.
    unit_price_minor: bigint | number | string
    /** NET per-line discount (minor units), subtracted from qty x unit price and
     *  rendered explicitly on the invoice. */
    discount_minor?: bigint | number | string
    /** Tax rate Shopify actually charged on this line, in basis points. When
     *  present it overrides the classifier's document-level default so the
     *  invoice reproduces exactly what the customer paid. */
    tax_rate_bp?: number
    /** The tax Shopify reported for this WHOLE line (minor units, the seller's own share:
     *  marketplace collected tax excluded), when the event carried per tax line amounts. Checked
     *  against our own computation before anything is issued (see `shopifyTaxMismatches`). */
    shopify_tax_minor?: string
    /** How many seller tax lines Shopify summed into `shopify_tax_minor`: each jurisdiction rounds
     *  on its own, so the tolerance of the check is one minor unit per tax line. */
    shopify_tax_line_count?: number
    /** Tax a marketplace facilitator collected and remits itself (Shopify `channel_liable`), minor
     *  units. A pass through: never on our documents, carried only for the audit trail. */
    marketplace_tax_minor?: string
    /** goods (default) / software / shipping — drives customs + PDF grouping. */
    line_kind?: LineKind
  }>
  market?: { country?: string }
  /**
   * A person's decision on a tax review park (set only by `deferred_tax_override`, after its
   * approval): which source of truth the lines take, and which park it resolves. With it, the tax
   * guards do not run again: the decision IS the review.
   *  - `shopify_reported`: each Shopify rated line takes the rate that reproduces the tax amount
   *    Shopify reported for it (a line Shopify reported at zero is zero).
   *  - `as_computed`: every line takes the tax treatment's own rate; Shopify's rates are ignored.
   */
  tax_override?: { mode: TaxOverrideMode; deferred_id: string }
}

export type TaxOverrideMode = "shopify_reported" | "as_computed"

/** The lines an operator's tax override issues (see OrderPaidPayload.tax_override). */
export function applyTaxOverride(
  lineItems: OrderPaidPayload["line_items"],
  mode: TaxOverrideMode,
): OrderPaidPayload["line_items"] {
  return lineItems.map((li) => {
    const { tax_rate_bp: _rate, ...rest } = li
    if (mode === "as_computed") return rest
    if (li.shopify_tax_minor == null || li.shopify_tax_minor === "") return li
    const subtotal =
      lineSubtotal({ quantity: li.quantity, unit_price_minor: toBigIntMinor(li.unit_price_minor) }) -
      toBigIntMinor(li.discount_minor)
    const reported = toBigIntMinor(li.shopify_tax_minor)
    const rate = subtotal > 0n ? Number((reported * 10000n * 2n + subtotal) / (subtotal * 2n)) : 0
    return { ...rest, tax_rate_bp: rate }
  })
}

/** A structured order address (billing), with the company it names. */
export interface OrderAddress {
  company: string | null
  line1: string | null
  line2: string | null
  postcode: string | null
  city: string | null
  country_code: string | null
}

/** A structured delivery address, with the consignee name. */
export interface OrderDeliveryAddress {
  name: string | null
  line1: string | null
  line2: string | null
  postcode: string | null
  city: string | null
  country_code: string | null
}

function addrStr(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

export interface IssuerProfileRow {
  id: string
  legal_name: string
  country: string
  vat_id: string | null
  address: string | null
  iban: string | null
  swift_bic: string | null
  bank_name: string | null
  default_language: "en" | "fr" | "de"
  prefix_invoice?: string
  prefix_quote?: string
  prefix_proforma?: string
  prefix_po?: string
  invoice_approval_threshold_minor?: bigint | number | string | null
  auto_email_enabled?: boolean
  /** Typed unit prices are GROSS (tax included) under this profile, mirroring the Shopify
   *  shop's "include tax in prices" setting. See `netLinesForIssuer` in mutations.ts. */
  prices_include_tax?: boolean
  mail_account_id?: string | null
  timezone?: string | null
  email_templates?: Record<string, { subject?: string; body?: string }>
  logo_file_id?: string | null
  /** Seller identity (printed mentions, VAT-on-debits default, Factur-X seller). */
  vat_on_debits_default?: boolean | null
  siren?: string | null
  siret?: string | null
  legal_form?: string | null
  share_capital?: string | null
  rcs_city?: string | null
  routing_address?: string | null
  address_line1?: string | null
  address_line2?: string | null
  postcode?: string | null
  city?: string | null
  country_code?: string | null
}

export interface DeferredEventInsert {
  event_id: string
  event_payload_json: unknown
  status:
    | "awaiting_config"
    | "awaiting_data"
    | "awaiting_dependency"
    | "render_failed"
    | "email_failed"
  reason: string | null
  blocked_on: Record<string, unknown>
}

export interface OrderPaidCtx extends IssueCtx {
  // K6 — kernel injects `{ approvalRequestId, approvalDeciderId, toolName }`
  // (see `@liaison/app-sdk` AppContext.approval); not snake_case.
  approval: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  executeTool: CrossAppExecuteTool
  requestApproval(input: {
    tool_name: string
    summary: string
    /** Optional structured detail rendered on the approval card — see
     *  MutationsCtx.requestApproval in ../mutations.ts for the full contract. */
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
    editable_fields?: string[]
  }): Promise<{ approval_id: string; auto_approved?: undefined } | { approval_id: string | null; auto_approved: true }>
  // Kernel contact resolution (resolve-or-create by external id / email). Used
  // by the `order:created` adapter to link the Shopify customer to its kernel
  // contact. Shopify is an OPTIONAL dependency — this is only ever reached when
  // a Shopify event is delivered, so it adds no standalone coupling.
  resolveContact(params: {
    email?: string
    name?: string
    externalId?: string
  }): Promise<unknown>
}

export interface IssuedDocumentRef {
  document_id: string
  number: string
  scope: "goods" | "software"
  pdf_file_id: string | null
}

export type OrderPaidResult =
  | {
      status: "ok"
      // Primary document (the goods invoice when the order has physical lines,
      // else the software invoice) — kept flat for existing callers/tests.
      document_id: string
      number: string
      pdf_file_id: string | null
      /** Every document issued for the order — a mixed physical+digital order
       *  is deliberately SPLIT into a goods invoice and a software invoice so
       *  customs values the physical shipment only. */
      documents: IssuedDocumentRef[]
    }
  | {
      status: "skipped"
      reason:
        | "zero_total"
        | "duplicate_document"
        | "not_paid"
        | "already_parked"
        | "order_cancelled"
    }
  | { status: "deferred"; deferred_id: string; reason: string }
  | { status: "pending_approval"; approval_id: string }

/** Slice an ISO-8601 date/date-time value to its `YYYY-MM-DD` calendar date for a reviewer-
 *  legible approval-card line. Degrades to null on anything malformed/absent. */
function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

function toBigIntMinor(v: bigint | number | string | null | undefined): bigint {
  if (v == null) return 0n
  if (typeof v === "bigint") return v
  if (typeof v === "number") return BigInt(Math.round(v))
  if (typeof v === "string" && v.length > 0) return BigInt(v)
  return 0n
}

/**
 * Compute the grand total that `issueDocument` will persist for the given
 * line items and classified tax rate. Using this (not the Shopify gross
 * total) for the threshold gate ensures both sides compare the same number.
 */
function computeInvoiceTotal(
  lineItems: OrderPaidPayload["line_items"],
  defaultTaxRateBp: number,
): bigint {
  let grand = 0n
  for (const li of lineItems) {
    const subtotal =
      lineSubtotal({
        quantity: li.quantity,
        unit_price_minor: toBigIntMinor(li.unit_price_minor),
      }) - toBigIntMinor(li.discount_minor)
    const rate = typeof li.tax_rate_bp === "number" ? li.tax_rate_bp : defaultTaxRateBp
    grand += subtotal + lineTax({ subtotal_minor: subtotal, tax_rate_bp: rate })
  }
  return grand
}

export interface ShopifyTaxMismatch {
  position: number
  description: string
  tax_rate_bp: number
  computed_minor: string
  shopify_minor: string
}

/**
 * The per line check run before an order's documents are created: for every line whose rate came
 * from Shopify AND whose tax amount Shopify reported, the tax we are about to put on the document
 * must equal Shopify's figure within one minor unit per Shopify tax line (each jurisdiction rounds
 * on its own). A rate read from the wrong field, an exempt line reported with its jurisdiction rate,
 * a rate our basis points cannot represent: all of them surface here, at the moment the wrong number
 * would be invented, instead of on an issued invoice. Lines without a Shopify figure are not judged.
 *
 * Deliberately per LINE and not "sum of documents equals order total": a correct split, credited or
 * reissued document set does not sum to the order total, and a guard that refuses correct work is
 * worse than none.
 */
export function shopifyTaxMismatches(
  lineItems: OrderPaidPayload["line_items"],
): ShopifyTaxMismatch[] {
  const out: ShopifyTaxMismatch[] = []
  for (const [idx, li] of lineItems.entries()) {
    if (typeof li.tax_rate_bp !== "number") continue
    if (li.shopify_tax_minor == null || li.shopify_tax_minor === "") continue
    const subtotal =
      lineSubtotal({ quantity: li.quantity, unit_price_minor: toBigIntMinor(li.unit_price_minor) }) -
      toBigIntMinor(li.discount_minor)
    const computed = lineTax({ subtotal_minor: subtotal, tax_rate_bp: li.tax_rate_bp })
    const reported = toBigIntMinor(li.shopify_tax_minor)
    const tolerance = BigInt(Math.max(1, li.shopify_tax_line_count ?? 1))
    const diff = computed > reported ? computed - reported : reported - computed
    if (diff > tolerance) {
      out.push({
        position: idx + 1,
        description: li.description,
        tax_rate_bp: li.tax_rate_bp,
        computed_minor: computed.toString(),
        shopify_minor: reported.toString(),
      })
    }
  }
  return out
}

function marketplaceTaxRef(items: OrderPaidPayload["line_items"]): { marketplace_tax_minor?: string } {
  let sum = 0n
  for (const li of items) sum += toBigIntMinor(li.marketplace_tax_minor)
  return sum > 0n ? { marketplace_tax_minor: sum.toString() } : {}
}

function toIssuerProfileRow(row: unknown): IssuerProfileRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    legal_name: String(r.legal_name ?? ""),
    country: String(r.country ?? ""),
    vat_id: (r.vat_id as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    iban: (r.iban as string | null) ?? null,
    swift_bic: (r.swift_bic as string | null) ?? null,
    bank_name: (r.bank_name as string | null) ?? null,
    default_language: (r.default_language as "en" | "fr" | "de") ?? "en",
    prefix_invoice: (r.prefix_invoice as string | undefined) ?? undefined,
    prefix_quote: (r.prefix_quote as string | undefined) ?? undefined,
    prefix_proforma: (r.prefix_proforma as string | undefined) ?? undefined,
    prefix_po: (r.prefix_po as string | undefined) ?? undefined,
    invoice_approval_threshold_minor:
      (r.invoice_approval_threshold_minor as bigint | number | string | null | undefined) ??
      null,
    auto_email_enabled: !!r.auto_email_enabled,
    prices_include_tax: !!r.prices_include_tax,
    mail_account_id: (r.mail_account_id as string | null | undefined) ?? null,
    timezone: (r.timezone as string | null | undefined) ?? null,
    email_templates:
      (r.email_templates as
        | Record<string, { subject?: string; body?: string }>
        | undefined) ?? undefined,
    // The seller identity the PDF mentions and a Factur-X carries (dropped here before, so an
    // order-paid invoice lost the seller SIREN mentions the manual path printed).
    logo_file_id: (r.logo_file_id as string | null | undefined) ?? null,
    vat_on_debits_default: typeof r.vat_on_debits_default === "boolean" ? r.vat_on_debits_default : null,
    siren: (r.siren as string | null | undefined) ?? null,
    siret: (r.siret as string | null | undefined) ?? null,
    legal_form: (r.legal_form as string | null | undefined) ?? null,
    share_capital: (r.share_capital as string | null | undefined) ?? null,
    rcs_city: (r.rcs_city as string | null | undefined) ?? null,
    routing_address: (r.routing_address as string | null | undefined) ?? null,
    address_line1: (r.address_line1 as string | null | undefined) ?? null,
    address_line2: (r.address_line2 as string | null | undefined) ?? null,
    postcode: (r.postcode as string | null | undefined) ?? null,
    city: (r.city as string | null | undefined) ?? null,
    country_code: (r.country_code as string | null | undefined) ?? null,
  }
}

export async function findIssuerByShopId(
  db: IssueCtx["db"],
  shopId: string,
): Promise<IssuerProfileRow | null> {
  const rows = await db.findMany("issuer_profiles", {
    where: { shopify_shop_id: shopId },
    limit: 1,
  })
  return rows[0] ? toIssuerProfileRow(rows[0]) : null
}

// Indexed equality on the top-level shopify_order_id column, fetched ONCE and UNFILTERED (this
// set INCLUDES credit notes). Idempotency must hold regardless of how many documents the org
// has — an unordered bounded slice would miss the prior invoice and re-issue a duplicate.
//
// This single fetch backs two different consumers below: the billing-scoped idempotency check
// (which must EXCLUDE credit notes, same rule as findBillingDocumentsForOrder) and the
// fully-credited exemption's `candidateDocs` (which must INCLUDE them — isFullyCredited's durable
// back-link fallback scans this set for type: "credit_note" rows). Fetching once and deriving
// both views app-side keeps this at one query instead of one per document.
async function fetchOrderDocuments(
  db: IssueCtx["db"],
  shopifyOrderId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await db.findMany("documents", {
    where: { shopify_order_id: shopifyOrderId },
    limit: 50,
  })) as Array<Record<string, unknown>>
}

/**
 * The billing-scoped view of `allOrderDocs`: excludes credit notes (mirrors
 * findBillingDocumentsForOrder in billing-documents.ts — a credit note is a reversal, not an
 * invoice), quotes (a quote is an offer, never itself a bill -- and since
 * convertViaShopifyDraftOrder in mutations.ts writes shopify_order_id back onto the SOURCE
 * quote once its Shopify draft order completes, a Shopify-mapped quote row carries the same
 * order id the webhook it feeds is about to bill; counting it here would suppress that order's
 * only real invoice, permanently, since a quote never converts into a credit-noteable document
 * of its own), and per-shipment proformas (shipment_ref set — one proforma per physical
 * shipment batch). Only shipment_ref-NULL, non-credit-note, non-quote rows participate in the
 * webhook's "document already exists" check, so a batch proforma never suppresses the legal
 * invoice, a credit note never counts as a legacy pre-split "order fully invoiced" document,
 * and the quote a Shopify draft order converted from never blocks the invoice it produces.
 */
function billingDocumentsOf(
  allOrderDocs: Array<Record<string, unknown>>,
): Array<{ id: string; scope: string | null }> {
  return allOrderDocs
    .filter((r) => r.type !== "credit_note")
    .filter((r) => r.type !== "quote")
    .filter((r) => ((r.shipment_ref as string | null) ?? null) === null)
    .map((r) => ({
      id: String(r.id),
      scope: (r.scope as string | null) ?? null,
    }))
}

/**
 * The quote this paid order was converted from, when it carries a PO number the order itself
 * does not. PRIMARY link only: `convertViaShopifyDraftOrder` (mutations.ts) writes
 * `shopify_order_id` back onto the source quote once the Shopify draft order it mirrors
 * completes, so the quote is findable by the order id this handler already has. Several quotes
 * matching the same order id (unusual, but not impossible for a re-drafted order) resolve
 * deterministically to the MOST RECENTLY created quote that actually carries a PO -- ties (or a
 * quote with no PO at all) are skipped in favor of an older one that has it.
 */
async function findOriginatingQuotePo(
  db: IssueCtx["db"],
  shopifyOrderId: string,
): Promise<{ quote_id: string; quote_number: string | null; po_number: string } | null> {
  const rows = (await db.findMany("documents", {
    where: { type: "quote", shopify_order_id: shopifyOrderId },
    orderBy: { createdAt: "desc" },
    limit: 10,
  })) as Array<Record<string, unknown>>
  for (const row of rows) {
    const po =
      (row.po_number as string | null | undefined) ??
      ((row.external_refs as Record<string, unknown> | undefined)?.po_number as
        | string
        | undefined)
    if (typeof po === "string" && po.trim() !== "") {
      return {
        quote_id: String(row.id),
        quote_number: (row.number as string | null | undefined) ?? null,
        po_number: po.trim(),
      }
    }
  }
  return null
}

// Every park goes through the idempotent `park()`: a webhook redelivery, the order:updated
// catch-up or a deferred-retry re-drive of an order that is STILL blocked refreshes the one open
// row for (order, blocker) instead of inserting another one each time.
async function insertDeferred(
  db: IssueCtx["db"],
  row: DeferredEventInsert,
): Promise<{ id: string }> {
  return park({ db }, row)
}

/**
 * Park an order for a person's tax decision. A retry never clears these (see HUMAN_REVIEW_KINDS),
 * so the park raises ONE attention row when it is first created (not on a redelivery that
 * refreshes it) for the invoicing writers, pointing at the deferred list where it is resolved.
 */
async function parkForTaxReview(
  ctx: OrderPaidCtx,
  parkPayload: OrderPaidPayload,
  orderNumber: string | null,
  park_: { status: DeferredEventInsert["status"]; reason: string; blocked_on: Record<string, unknown> },
): Promise<OrderPaidResult> {
  const def = await park({ db: ctx.db }, { event_id: parkPayload.id, event_payload_json: parkPayload, ...park_ })
  if (def.created && ctx.emit) {
    await ctx.emit({
      entity: "deferred",
      action: "tax_review",
      entityId: def.id,
      data: {
        deferred_id: def.id,
        order_id: parkPayload.id,
        order_label: orderNumber ?? parkPayload.id,
        reason: park_.reason,
        resolved: false,
      },
    })
  }
  return { status: "deferred", deferred_id: def.id, reason: park_.status }
}

/**
 * The database key of the invoice this handler issues for one scope of one order
 * (`documents.external_ref`, unique). The read-then-issue check above is not atomic: an order
 * event delivered twice (a webhook re-emitted after a failed ledger write) can run twice at once,
 * both read "no document", and both issue. The unique key makes the second issuing commit fail
 * (its number is not consumed: the number commits in the same batch), and that run skips the
 * scope. Invoices for the same order issued another way (a re-issue after an order edit, a
 * manual invoice) carry no such key, so they are never blocked by it.
 */
export function orderInvoiceRef(shopifyOrderId: string, scope: "goods" | "software"): string {
  return `shopify-order:${shopifyOrderId}:${scope}`
}

/** True when the live Shopify order was cancelled or its payment voided: there is nothing to
 *  invoice, so the order must neither park nor stay parked. */
function isCancelledOrder(order: ShopifyOrderFetch | null): boolean {
  if (!order) return false
  const cancelledAt = order.cancelledAt ?? order.attributes?.cancelledAt
  if (typeof cancelledAt === "string" && cancelledAt.trim() !== "") return true
  const fin = order.financialStatus ?? order.attributes?.financialStatus
  return typeof fin === "string" && fin.trim().toUpperCase() === "VOIDED"
}

export async function onShopifyOrderPaid(
  incoming: OrderPaidPayload,
  ctx: OrderPaidCtx,
): Promise<OrderPaidResult> {
  const payload: OrderPaidPayload = incoming.tax_override
    ? { ...incoming, line_items: applyTaxOverride(incoming.line_items, incoming.tax_override.mode) }
    : incoming
  // Step 3 — issuer mapping (by shop id)
  const issuer = await findIssuerByShopId(ctx.db, payload.shop_id)
  if (!issuer) {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: payload,
      status: "awaiting_config",
      reason: "issuer_mapping_missing",
      blocked_on: { kind: "issuer_mapping", shop_id: payload.shop_id },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }

  // Step 4 — zero-total no-op (warranty replacements, freebies)
  const total = toBigIntMinor(payload.total_price_minor)
  if (total === 0n) {
    return { status: "skipped", reason: "zero_total" }
  }

  // Idempotency at the document level, per scope. A legacy (pre-split,
  // scope-null) document counts as "order fully invoiced" -- UNLESS it has
  // since been fully credit noted: the correct flow for a modified/cancelled
  // order is credit note the original, then let the webhook reissue with the
  // updated items, and a raw scope-null check blocked exactly that (the
  // fully-credited invoice going right on suppressing its own replacement).
  // After a partial issuance (e.g. the goods invoice deferred on a customs
  // throttle while the software invoice went through), the retry issues ONLY
  // the missing scope.
  const allOrderDocs = await fetchOrderDocuments(ctx.db, payload.id)
  const existingDocs = billingDocumentsOf(allOrderDocs)
  const liveScopeNullDocs: Array<{ id: string; scope: string | null }> = []
  for (const d of existingDocs) {
    if (d.scope !== null) continue
    const row = allOrderDocs.find((r) => String(r.id) === d.id)
    // A document with no (or zero) grand_total_minor has nothing to credit -- never exempt it.
    // Without this guard, isFullyCredited's `credited >= invoiceTotal` trivially reads 0 >= 0 as
    // "fully credited" for a row that never recorded a total at all, wrongly waving through a
    // legacy scope-null document that is not credited, just unamounted.
    const invoiceTotalMinor = row
      ? toBigIntMinor(row.grand_total_minor as bigint | number | string | null)
      : 0n
    const fullyCredited =
      row != null &&
      invoiceTotalMinor !== 0n &&
      (await isFullyCredited(
        ctx.db,
        {
          id: d.id,
          lifecycle_log: (row.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
          grand_total_minor: invoiceTotalMinor,
        },
        allOrderDocs,
      ))
    if (!fullyCredited) liveScopeNullDocs.push(d)
  }
  if (liveScopeNullDocs.length > 0) {
    return { status: "skipped", reason: "duplicate_document" }
  }
  const existingScopes = new Set(existingDocs.map((d) => d.scope))

  // Step 5 — fetch full order details from Shopify to enrich the payload.
  const enrichedOrder = await tryFetchShopifyOrder(ctx, payload.id)
  const customer = mergeCustomer(payload.customer, enrichedOrder)
  // The human order reference to stamp on the invoice. The webhook carries it
  // (`name`), but a payload adapted by an OLDER shopify-app build -- or replayed
  // from a deferred row written before this field existed -- does not, so the
  // enrichment fetch fills it in. Never synthesised from the numeric id: an
  // invented "#12768069779622" would be worse than no order line at all.
  const orderNumber = normalizeOrderNumber(payload.order_number ?? enrichedOrder?.name)
  // What a park stores: the payload with the order's human number filled in from the enrichment
  // when the event carried none, so deferred_list can name the order (and a replay has it).
  const parkPayload: OrderPaidPayload =
    orderNumber && payload.order_number !== orderNumber
      ? { ...payload, order_number: orderNumber }
      : payload
  // A cancelled (or voided) order has nothing to invoice: never park it, and close any park it
  // already has (a webhook replay or the deferred-retry re-drive lands here).
  if (isCancelledOrder(enrichedOrder)) {
    await resolveOpenParks({ db: ctx.db, emit: ctx.emit }, payload.id, "order_cancelled", {
      event_payload_json: parkPayload,
    })
    return { status: "skipped", reason: "order_cancelled" }
  }
  if (!customer || !customer.email) {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: parkPayload,
      status: "awaiting_data",
      reason: "customer_email_missing",
      blocked_on: {
        kind: "customer_email",
        customer_id: customer?.id ?? null,
      },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }
  if (!customer.contact_id) {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: parkPayload,
      status: "awaiting_data",
      reason: "contact_missing",
      blocked_on: { kind: "contact", customer_id: customer.id },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // Step 6 — tax classification. When neither the event nor the enrichment
  // fetch carries a destination country, default to the issuer's country
  // (domestic) — most store orders are domestic and exports carry an explicit
  // shipping country; this is safer than the old "ZZ" which mis-classified
  // unknown-country orders as non-EU exports (and demanded customs data).
  // The TAX country is the delivery destination; the PRINTED country is the billing address's.
  // A payload adapted before the two were split carries only `country` (the destination then), so
  // it keeps classifying and printing exactly as it did.
  const counterpartyCountry =
    customer.tax_country ?? customer.country ?? payload.market?.country ?? issuer.country
  const billingCountry = customer.country ?? counterpartyCountry
  const classification = classify({
    issuer_country: issuer.country,
    counterparty_country: counterpartyCountry,
    has_vat_id: !!customer.vat_id,
  })
  if (classification.treatment === "unconfigured") {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: parkPayload,
      status: "awaiting_config",
      reason: "tax_regime_unconfigured",
      blocked_on: {
        kind: "tax_regime",
        issuer_country: issuer.country,
        counterparty_country: counterpartyCountry,
      },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }

  // Tax guards. Each one parks the order with a named reason instead of issuing a document that
  // would carry a wrong or self-contradicting tax figure; an operator reads it in deferred_list.
  // They run before the approval threshold so nobody is asked to approve a document that cannot
  // be issued.
  //
  // (1) Our computed tax must reproduce what Shopify reported, line by line.
  const taxMismatches = payload.tax_override ? [] : shopifyTaxMismatches(payload.line_items)
  if (taxMismatches.length > 0) {
    return parkForTaxReview(ctx, parkPayload, orderNumber, {
      status: "awaiting_data",
      reason: "shopify_tax_mismatch",
      blocked_on: { kind: "tax_check", lines: taxMismatches },
    })
  }
  // (2) An exempt treatment (export, reverse charge) prints an exemption mention: a line that
  // nonetheless carries the seller's tax would contradict it on the same page. Which one is wrong
  // (the classification, or a tax Shopify should not have charged) is a human call.
  const taxedOnExempt = payload.tax_override
    ? []
    : payload.line_items.filter((li) => typeof li.tax_rate_bp === "number" && li.tax_rate_bp > 0)
  if (EXEMPT_TREATMENTS.has(classification.treatment) && taxedOnExempt.length > 0) {
    return parkForTaxReview(ctx, parkPayload, orderNumber, {
      status: "awaiting_data",
      reason: "tax_on_exempt_treatment",
      blocked_on: {
        kind: "tax_treatment",
        treatment: classification.treatment,
        counterparty_country: counterpartyCountry,
        lines: taxedOnExempt.map((li) => ({ description: li.description, tax_rate_bp: li.tax_rate_bp })),
      },
    })
  }
  // (3) An EU B2C (OSS) line Shopify charged no rate for is never given one silently: a Shopify
  // order to another member state with no tax is as likely a business buyer (reverse charge) as a
  // consumer, so a person decides. Lines that carry Shopify's own rate do not stop here.
  const placeholderLines =
    classification.treatment === "eu_b2c_oss" && !payload.tax_override
      ? payload.line_items.filter((li) => typeof li.tax_rate_bp !== "number")
      : []
  if (placeholderLines.length > 0) {
    return parkForTaxReview(ctx, parkPayload, orderNumber, {
      status: "awaiting_config",
      reason: "tax_rate_placeholder",
      blocked_on: {
        kind: "tax_rate",
        treatment: classification.treatment,
        counterparty_country: counterpartyCountry,
        lines: placeholderLines.map((li) => li.description),
      },
    })
  }
  // (4) An order to another member state on which Shopify charged NO tax at all (a tax exempt
  // order, or one at 0%) and that carries no VAT number would issue as a consumer invoice at 0%,
  // which no one can owe: a consumer there owes that country's VAT, a business the reverse
  // charge with its VAT number. A person decides; a lone 0% line next to taxed ones is not this.
  const chargesNoTax =
    payload.line_items.length > 0 && payload.line_items.every((li) => li.tax_rate_bp === 0)
  if (!payload.tax_override && isUntaxedIntraEuSaleWithoutVat(classification.treatment, chargesNoTax)) {
    return parkForTaxReview(ctx, parkPayload, orderNumber, {
      status: "awaiting_data",
      reason: "buyer_vat_missing",
      blocked_on: {
        kind: "tax_rate",
        treatment: classification.treatment,
        counterparty_country: counterpartyCountry,
        lines: payload.line_items.map((li) => li.description),
        detail:
          `the buyer is in ${counterpartyCountry}, another EU member state, the order charges no VAT ` +
          "and carries no VAT number, so it is neither a consumer invoice nor a reverse charge. For a " +
          "business buyer, add its VAT number to the Shopify order as a custom attribute " +
          '(shopify order_update customAttributes [{key: "VAT number", value: "<number>"}]), then ' +
          "deferred_tax_override mode shopify_reported: it re-reads the order and issues the reverse " +
          `charge invoice. For a consumer, deferred_tax_override mode as_computed charges ${counterpartyCountry} VAT.`,
      },
    })
  }


  // Steps 7+8+10+11+12 — build drafts, snapshot lines, issue + PDF + thread post.
  //
  // SPLIT BY SCOPE: physical goods on one document, EVERYTHING non-merchandise
  // (software/digital lines AND carriage) on another. Customs values a shipment
  // from the commercial invoice's total — a mixed invoice makes them tariff the
  // software and the freight too. The goods invoice accompanies the parcel and
  // contains ONLY merchandise value; the services invoice never reaches customs.
  const goodsItems = payload.line_items.filter((li) => (li.line_kind ?? "goods") === "goods")
  const softwareItems = payload.line_items.filter(
    (li) => li.line_kind === "software" || li.line_kind === "shipping",
  )

  const issuerInput: IssueInput["issuer"] = {
    id: issuer.id,
    legal_name: issuer.legal_name,
    country: issuer.country,
    vat_id: issuer.vat_id,
    address: issuer.address,
    iban: issuer.iban,
    swift_bic: issuer.swift_bic,
    bank_name: issuer.bank_name,
    default_language: issuer.default_language,
    prefix_invoice: issuer.prefix_invoice,
    prefix_quote: issuer.prefix_quote,
    prefix_proforma: issuer.prefix_proforma,
    prefix_po: issuer.prefix_po,
    logo_file_id: issuer.logo_file_id ?? null,
    // Seller identity: printed mentions, the VAT-on-debits default, and the Factur-X seller.
    vat_on_debits_default: issuer.vat_on_debits_default ?? null,
    siren: issuer.siren ?? null,
    siret: issuer.siret ?? null,
    legal_form: issuer.legal_form ?? null,
    share_capital: issuer.share_capital ?? null,
    rcs_city: issuer.rcs_city ?? null,
    routing_address: issuer.routing_address ?? null,
    address_line1: issuer.address_line1 ?? null,
    address_line2: issuer.address_line2 ?? null,
    postcode: issuer.postcode ?? null,
    city: issuer.city ?? null,
    country_code: issuer.country_code ?? null,
  }
  const counterpartyInput: IssueInput["counterparty"] = {
    contact_id: customer.contact_id,
    legal_name: customer.legal_name ?? customer.email,
    // Printed under the Bill-to address: the billing country, never the destination.
    country: billingCountry,
    // The classifier's input (issueDocument), persisted on external_refs.tax_country so a re-render,
    // a credit note or a reissue classifies the same way.
    tax_country: counterpartyCountry,
    vat_id: customer.vat_id ?? null,
    address: customer.address ?? null,
    // Render only: counterpartyCountry above remains the sole tax-classification input.
    shipping_address: customer.shipping_address ?? null,
    shipping_name: customer.shipping_name ?? null,
    email: customer.email,
    // Structured billing / delivery for the e-invoicing snapshot (the printed Bill-to stays
    // `address`). The billing country code falls back to the printed billing country.
    billing_line1: customer.billing?.line1 ?? null,
    billing_line2: customer.billing?.line2 ?? null,
    billing_postcode: customer.billing?.postcode ?? null,
    billing_city: customer.billing?.city ?? null,
    billing_country_code: customer.billing?.country_code ?? billingCountry,
    delivery: customer.delivery ?? null,
  }
  // Recipient completeness (same shared rule the agent/UI paths enforce). An order whose customer
  // record has no postal address cannot be invoiced legally, so DEFER it as awaiting_data — the
  // operator fills the contact in and replays — rather than either issuing an unaddressed invoice
  // or letting issueDocument's backstop throw the whole handler run. Mirrors the
  // customer_email_missing / contact_missing guards above.
  const counterpartyIncomplete = counterpartyCompletenessError(counterpartyInput)
  if (counterpartyIncomplete) {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: parkPayload,
      status: "awaiting_data",
      reason: "counterparty_incomplete",
      blocked_on: {
        kind: "counterparty",
        customer_id: customer.id,
        detail: counterpartyIncomplete.message,
      },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }
  // Settlement — a Shopify checkout that is already PAID means the invoice is born settled, so it
  // renders "Amount paid" (no banking box) from its FIRST render and the operator never has to mark
  // each synced invoice paid by hand (nearly every store order is paid on checkout). This threads
  // ONLY payment_status/paid_at through issuance — the document stays status: "issued" so it remains
  // a live, shippable invoice (boxtal's to-prepare queue searches issued invoices; flipping status
  // to "paid" would silently drop paid physical orders from shipping). A non-"paid" financial_status
  // (pending/authorized/…) issues unpaid.
  const settled = isPaidFinancialStatus(payload.financial_status)
  // PO inheritance -- the order's own PO always wins. Only when Shopify carries none do we
  // look for the quote this order was converted from (mutations.ts convertViaShopifyDraftOrder
  // writes shopify_order_id back onto that quote once its draft order completes) and borrow
  // its PO number. No fallback lookup on shopify_draft_order_id: neither OrderPaidPayload nor
  // the shopify-app order:created event carries a draft order id to key one on.
  const inheritedPo = payload.po_number ? null : await findOriginatingQuotePo(ctx.db, payload.id)
  const effectivePoNumber = payload.po_number ?? inheritedPo?.po_number ?? null
  const buildIssueInput = (
    scope: "goods" | "software",
    items: OrderPaidPayload["line_items"],
    when: IssueDateParts,
    paidAt: string,
  ): IssueInput => ({
    type: "invoice",
    scope,
    external_ref: orderInvoiceRef(payload.id, scope),
    issuer: issuerInput,
    counterparty: counterpartyInput,
    settlement: settled ? { paid_at: paidAt, source: "shopify_order_paid" } : null,
    // The PO number (when present) came straight off the Shopify webhook payload, no
    // human step in between -- the po_number_changed audit entry issueDocument appends
    // should say so plainly rather than default to "person". (The inherited case gets its
    // OWN dedicated lifecycle_log entry below, naming the source quote.)
    po_number_source: "shopify_sync",
    // E-invoicing: a checkout buyer, line kinds set by the store (authoritative), paid or due.
    origin: "shopify",
    operation_source: "lines_authoritative",
    payment_state: settled ? "paid" : "due",
    draft: {
      currency: payload.currency,
      incoterm: "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: null,
      // `shopify_shop_domain` (the store's myshopify domain, carried as
      // `payload.shop_id`) is persisted alongside the order id so the invoice
      // detail view can build a deep link back to the Shopify admin order page
      // WITHOUT a cross-app round-trip to resolve the connected store's domain.
      external_refs: {
        shopify_order_id: payload.id,
        // The human order reference ("#1149") -- mirrored to the top-level
        // shopify_order_number column at issue and printed in the PDF header.
        ...(orderNumber ? { shopify_order_number: orderNumber } : {}),
        ...(effectivePoNumber ? { po_number: effectivePoNumber } : {}),
        scope,
        shopify_shop_domain: payload.shop_id,
        // Tax a marketplace collected and remits itself on this document's lines: never invoiced
        // by us (it is not on any line), recorded here so accounting can reconcile the payout.
        ...marketplaceTaxRef(items),
      },
      lines: items.map((li, idx) => ({
        position: idx + 1,
        description: li.description,
        quantity: li.quantity,
        unit_price_minor: toBigIntMinor(li.unit_price_minor),
        discount_minor: toBigIntMinor(li.discount_minor),
        line_kind: li.line_kind ?? "goods",
        ...(typeof li.tax_rate_bp === "number" ? { tax_rate_bp_override: li.tax_rate_bp } : {}),
        // Shipping lines carry no product reference — never a shippable product
        // for boxtal, never a customs overlay key.
        product_source: li.line_kind === "shipping" ? null : "shopify",
        external_id: li.line_kind === "shipping" ? null : li.id,
      })),
    },
  })

  // Goods first: it is the only split that can bail on a retryable customs
  // fetch (CustomsFetchError below), and bailing BEFORE anything persisted
  // keeps the deferred retry clean. The per-scope dedup above makes a retry
  // after a partial issuance converge on the missing scope only.
  const splits: Array<{ scope: "goods" | "software"; items: OrderPaidPayload["line_items"] }> = []
  if (goodsItems.length > 0 && !existingScopes.has("goods")) {
    splits.push({ scope: "goods", items: goodsItems })
  }
  if (softwareItems.length > 0 && !existingScopes.has("software")) {
    splits.push({ scope: "software", items: softwareItems })
  }
  if (splits.length === 0) {
    return { status: "skipped", reason: "duplicate_document" }
  }

  // An issuer whose zone the host does not know issues nothing and takes no number: the order waits
  // for the setting, and the deferred retry re-runs this handler once it is fixed.
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) {
    const def = await insertDeferred(ctx.db, {
      event_id: payload.id,
      event_payload_json: parkPayload,
      status: "awaiting_config",
      reason: when.error.error.code,
      blocked_on: { kind: "issuer_timezone", issuer_profile_id: issuer.id },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }
  // The date the order states is an instant: it reads as the issuer's date, like the issue date.
  const paid = settled ? await civilDateOf(ctx, issuer, payload.createdAt) : null
  const paidAt = paid?.ok ? paid.date : when.issued_at

  // E-invoicing gate, per document, before anything is issued. The kind is derived from the
  // checkout signals (VAT id or billing company -> business, neither -> consumer) and recorded
  // on the contact as a derived identity; a SIREN read off a VAT id stays unconfirmed until a
  // registry check. Enforce: a refusal parks the order on the buyer's identity and raises one
  // attention item per contact. Warn: the document issues and records the warning.
  let derivedRecorded = false
  for (const split of splits) {
    const input = buildIssueInput(split.scope, split.items, when, paidAt)
    const check = await checkEinvoiceGate(ctx, {
      type: input.type,
      issuer: input.issuer,
      counterparty: input.counterparty,
      lines: input.draft.lines,
      operation_source: input.operation_source ?? null,
      payment_state: input.payment_state ?? null,
      origin: "shopify",
      company: customer.billing?.company ?? null,
    })
    const derivedKind = check.ok ? check.prepared.derivedKind : check.derivedKind
    if (derivedKind && !derivedRecorded) {
      derivedRecorded = true
      await ensureDerivedIdentity(ctx.db, {
        contact_id: customer.contact_id,
        customer_kind: derivedKind,
        vat_id: customer.vat_id ?? null,
        billing_country: counterpartyInput.billing_country_code ?? billingCountry,
      })
    }
    if (!check.ok) {
      const code = check.error.error.code
      const def = await park(
        { db: ctx.db },
        {
          event_id: payload.id,
          event_payload_json: parkPayload,
          status: "awaiting_data",
          reason: code,
          blocked_on: { kind: EINVOICE_IDENTITY_PARK_KIND, contact_id: customer.contact_id, code },
        },
      )
      await raiseIdentityAttention(ctx, {
        park: def,
        contact_id: customer.contact_id,
        code,
        data: {
          order_id: payload.id,
          order_label: orderNumber ?? payload.id,
          contact_label: customer.legal_name ?? customer.email,
        },
      })
      return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
    }
  }

  // Step 9 — threshold-gating. Runs after every refusal the order could still meet (tax guards,
  // completeness, the e-invoicing gate), so nobody approves a document that can only park.
  // Gate on the computed invoice total (sum of lines + classified tax), not
  // the Shopify gross total, so the threshold check and the persisted
  // grand_total_minor compare the same number.
  const invoiceTotal = computeInvoiceTotal(payload.line_items, classification.default_rate_bp)
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigIntMinor(issuer.invoice_approval_threshold_minor)
      : null
  if (!ctx.approval && threshold != null && invoiceTotal > threshold) {
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:onShopifyOrderPaid",
      summary: `Issue invoice for ${customer.legal_name ?? customer.email}, ${formatMoneyMinor(invoiceTotal, payload.currency)}${orderNumber ? `, order ${String(orderNumber).startsWith("#") ? "" : "#"}${orderNumber}` : ""}`,
      summary_detail: {
        subtitle: `Issue and send to ${customer.legal_name ?? customer.email}`,
        lines: [
          `Document: new invoice from Shopify order ${orderNumber ? `${String(orderNumber).startsWith("#") ? "" : "#"}${orderNumber}` : "(no order number)"}`,
          `Customer: ${customer.legal_name ?? customer.email}`,
          ...(dateOnly(payload.createdAt) ? [`Order placed: ${dateOnly(payload.createdAt)}`] : []),
          ...payload.line_items
            .slice(0, 3)
            .map(
              (li) =>
                `Line: ${li.description} x ${li.quantity} @ ${formatMoneyMinor(toBigIntMinor(li.unit_price_minor), payload.currency)}`,
            ),
          ...(payload.line_items.length > 3
            ? [`and ${payload.line_items.length - 3} more lines`]
            : []),
          `Total: ${formatMoneyMinor(invoiceTotal, payload.currency)}`,
        ],
      },
      current_payload: payload,
      editable_fields: [],
    })
    // Granted inline (a person's own call holding the deciding scope): issue now.
    if (!approval.auto_approved) {
      return { status: "pending_approval", approval_id: approval.approval_id }
    }
  }

  const issued: IssuedDocumentRef[] = []
  // The ECB rate of a foreign-currency order, fetched once here (issueDocument only reads the
  // cache); every split and every other order issued today reuses it.
  await warmFxRate(ctx as OrderPaidCtx & FxFetchCtx, payload.currency, fxIssueDate(when.issued_at))
  for (const split of splits) {
    let issueResult: Awaited<ReturnType<typeof issueDocument>>
    const issueInput = buildIssueInput(split.scope, split.items, when, paidAt)
    try {
      issueResult = await issueDocument(ctx, issueInput)
    } catch (err) {
      // A foreign-currency e-invoice the ECB could not price is refused before numbering (its
      // Factur-X needs the EUR VAT total). Defer it: the deferred retry re-runs this handler,
      // which warms the rate again. Nothing of this split was persisted.
      if (err instanceof FxRateUnavailableError) {
        const def = await insertDeferred(ctx.db, {
          event_id: payload.id,
          event_payload_json: parkPayload,
          status: "awaiting_dependency",
          reason: "awaiting_fx_rate",
          blocked_on: { kind: "fx_rate", code: err.code },
        })
        return { status: "deferred", deferred_id: def.id, reason: "awaiting_dependency" }
      }
      // A customs-required export whose live customs fetch hit a retryable Shopify
      // throttle bails out of issueDocument BEFORE this document is persisted. Defer
      // it (same machinery as a missing dependency) so the deferred-retry cron
      // re-issues once the rate-limit clears — never issuing a customs-incomplete
      // export invoice. Only the goods split can throw this, and it issues first,
      // so nothing is lost: the retry re-enters with no scopes issued yet.
      if (err instanceof CustomsFetchError) {
        const def = await insertDeferred(ctx.db, {
          event_id: payload.id,
          event_payload_json: parkPayload,
          status: "awaiting_dependency",
          reason: "awaiting_customs_dependency",
          blocked_on: { kind: "customs", code: err.code },
        })
        return { status: "deferred", deferred_id: def.id, reason: "awaiting_dependency" }
      }
      // Another run of the same order event issued this scope between our check and our commit
      // (orderInvoiceRef): nothing of ours was persisted, and that run delivers its own invoice.
      if (isUniqueViolation(err)) {
        const held = issueInput.external_ref
          ? await ctx.db.findMany("documents", { where: { external_ref: issueInput.external_ref }, limit: 1 })
          : []
        if (held.length > 0) continue
      }
      throw err
    }
    issued.push({
      document_id: issueResult.document_id,
      number: issueResult.number,
      scope: split.scope,
      pdf_file_id: issueResult.pdf_file_id,
    })
    // Audit trail for the inherited PO: a dedicated entry naming the source quote, distinct
    // from issueDocument's generic po_number_changed entry (which only records source:
    // "shopify_sync" -- accurate for where the VALUE flowed from at issue time, but silent on
    // the quote it was actually borrowed from). Read-modify-write: issueDocument already
    // persisted this document's own lifecycle_log, so append rather than clobber it.
    if (inheritedPo) {
      const row = (await ctx.db.findOne("documents", issueResult.document_id)) as
        | { lifecycle_log?: Array<Record<string, unknown>> }
        | null
      const currentLog = row?.lifecycle_log ?? []
      await ctx.db.update("documents", issueResult.document_id, {
        lifecycle_log: [
          ...currentLog,
          {
            event: "po_number_inherited",
            actor: await ctx.getUserId(),
            ts: new Date().toISOString(),
            po_number: inheritedPo.po_number,
            from_quote_id: inheritedPo.quote_id,
            from_quote_number: inheritedPo.quote_number,
          },
        ],
      })
    }
  }

  // Every split was issued by a concurrent run of the same event: that run finishes the order.
  if (issued.length === 0) {
    return { status: "skipped", reason: "duplicate_document" }
  }

  // Payment settlement is threaded through issuance (see `settled`/`buildIssueInput` above): a paid
  // checkout issues each document already `payment_status: "paid"` + `paid_at` with a "marked_paid"
  // lifecycle entry, so its FIRST render is "Amount paid" (no stale "Total due" PDF and no second
  // render pass). No post-issue reconciliation loop is needed here.

  // Step 11 follow-up — render failure (per document)
  for (const doc of issued) {
    if (!doc.pdf_file_id) {
      await insertDeferred(ctx.db, {
        event_id: payload.id,
        event_payload_json: parkPayload,
        status: "render_failed",
        reason: "pdf_render_failed",
        blocked_on: { kind: "pdf_render", document_id: doc.document_id },
      })
    }
  }

  const primary = issued.find((d) => d.scope === "goods") ?? issued[0]!
  // Each invoice's legal original (its first render, fixed at issue) is what the customer receives.
  const pdfFileIds: string[] = []
  for (const d of issued) {
    if (!d.pdf_file_id) continue
    const row = ((await ctx.db.findMany("documents", { where: { id: d.document_id }, limit: 1 })) as Array<Record<string, unknown>>)[0]
    const delivery = await deliveryFileId(ctx.db, { ...(row ?? {}), pdf_file_id: d.pdf_file_id })
    pdfFileIds.push(delivery.file_id ?? d.pdf_file_id)
  }

  // Step 13 — auto-email via mail:composeForApp (no Mail-side approval).
  // One email for the order, every rendered invoice attached.
  if (issuer.auto_email_enabled && pdfFileIds.length === issued.length) {
    if (!issuer.mail_account_id) {
      await insertDeferred(ctx.db, {
        event_id: payload.id,
        event_payload_json: parkPayload,
        status: "awaiting_config",
        reason: "issuer_mail_account_missing",
        blocked_on: {
          kind: "issuer_mail_account",
          issuer_profile_id: issuer.id,
        },
      })
    } else {
      const templates = issuer.email_templates ?? {}
      const tpl = templates.invoice_paid ?? {}
      const numbers = issued.map((d) => d.number).join(", ")
      const subject = (tpl.subject ?? "Invoice {{number}}").replace("{{number}}", numbers)
      const textBody = (tpl.body ?? "Please find your invoice attached.").replace(
        "{{number}}",
        numbers,
      )
      const composeResult = await ctx.executeTool("mail:composeForApp", {
        accountId: issuer.mail_account_id,
        to: [customer.email],
        subject,
        textBody,
        attachments: pdfFileIds,
        originating_approval_id: ctx.approval?.approvalRequestId ?? null,
      })
      if (composeResult.status === "error") {
        // Defensive: the cross-app envelope CONTRACT carries `error.code` on an
        // error status, but a malformed/empty error envelope (e.g. mail uninstalled
        // / an unexpected dispatch shape) would otherwise make `.code` throw —
        // crashing this handler AFTER the invoice was issued and rolling the whole
        // ambient transaction back (the issued invoice + its number vanish). The
        // invoice is the primary artifact; a failed auto-email must only DEFER, never
        // destroy it. Optional-chain the code and treat an absent one as a plain
        // email failure (retryable via the deferred-retry cron).
        const code = composeResult.error?.code
        const isDependency = code === "target_app_unavailable"
        await insertDeferred(ctx.db, {
          event_id: payload.id,
          event_payload_json: parkPayload,
          status: isDependency ? "awaiting_dependency" : "email_failed",
          reason: isDependency ? "awaiting_email_dependency" : "email_failed",
          blocked_on: { kind: "email_send", document_id: primary.document_id },
        })
      }
    }
  }

  return {
    status: "ok",
    document_id: primary.document_id,
    number: primary.number,
    pdf_file_id: primary.pdf_file_id,
    documents: issued,
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  order:created adapter (the cross-app seam)
//
//  The Shopify app publishes order events with its OWN normalized shape (see
//  `bundled-apps/shopify/src/webhooks.ts` `normalizeOrder`). Invoicing is a
//  loosely-coupled consumer — `shopify` is an OPTIONAL dependency, and this
//  code only runs when a Shopify `order:created` event is actually delivered
//  (so invoicing still installs + runs fully standalone). This adapter maps the
//  published event shape into the `OrderPaidPayload` the issue flow consumes,
//  deriving everything from the event so the flow does not depend on the
//  best-effort `shopify:orders_get` enrichment.
//
//  We subscribe to `order:created` (not `order:paid`) because the Shopify app
//  emits `order:created` — a paid checkout's `orders/create` webhook already
//  carries `financial_status: "paid"`. Issuing on order-created is the wiring
//  the Shopify bundle's event surface supports today.
// ───────────────────────────────────────────────────────────────────────────

interface ShopifyEventMoney {
  amount?: string
  currencyCode?: string
}

interface ShopifyEventTaxLine {
  title?: string | null
  rate?: number | null
  amount?: string
  currencyCode?: string
  /** Shopify `channel_liable`: true when the sales channel (a marketplace facilitator such as the
   *  Shop app) collects and remits this tax itself. Null or absent means the seller is liable. */
  channelLiable?: boolean | null
}

interface ShopifyEventAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  country_code?: string | null
  phone?: string | null
}

interface ShopifyOrderCreatedEvent {
  orderId?: string
  /** The order's human name ("#1149"), from the webhook's `name` field. */
  name?: string | null
  shopDomain?: string | null
  createdAt?: string
  /** Shopify order-level payment state ("paid" | "pending" | …) — see OrderPaidPayload.financial_status. */
  financialStatus?: string | null
  /** The customer's PO number, when the order carries one — see OrderPaidPayload.po_number. */
  poNumber?: string | null
  /** The buyer's VAT / tax registration number, when the order carries one (the shopify app reads
   *  it from the order's checkout attributes). Null or absent when the buyer gave none. */
  buyerTaxId?: string | null
  totalPrice?: ShopifyEventMoney | null
  /** True when line/shipping prices already CONTAIN tax (EU-style gross pricing). */
  taxesIncluded?: boolean
  billingAddress?: ShopifyEventAddress | null
  shippingAddress?: ShopifyEventAddress | null
  customer?: {
    id?: string | null
    email?: string | null
    first_name?: string | null
    last_name?: string | null
    country?: string
  } | null
  lineItems?: Array<{
    id?: string | null
    title?: string | null
    quantity?: number | string
    priceSet?: ShopifyEventMoney | null
    requiresShipping?: boolean
    taxLines?: ShopifyEventTaxLine[]
    discountAllocations?: ShopifyEventMoney[]
    variant?: { id?: string | null } | null
  }>
  shippingLines?: Array<{
    title?: string | null
    priceSet?: ShopifyEventMoney | null
    taxLines?: ShopifyEventTaxLine[]
  }>
  market?: { country?: string }
}

// Shopify amounts are decimal strings in the currency's MAJOR unit ("120.00"); the issue flow
// works in integer minor units (exponent per ISO 4217, see money.ts currencyExponent).

/**
 * True when the Shopify order's financial state means the money is settled, so
 * the auto-issued invoice should be recorded PAID. Only an exact "paid" counts:
 * "pending" / "authorized" / "partially_paid" are NOT settled, and "refunded" /
 * "voided" are handled by the refund/cancel webhooks — not the order-created
 * issue path. Case/whitespace tolerant (webhook value is lowercase "paid").
 */
export function isPaidFinancialStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "paid"
}

/** Trim a Shopify order name to the reference we persist, or null when absent
 *  or blank (a blank column would match a bare search and print an empty
 *  "Order:" line on the PDF). */
export function normalizeOrderNumber(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null
  const trimmed = name.trim()
  return trimmed === "" ? null : trimmed
}

// Returns the integer minor amount as a STRING (not bigint). The adapted payload
// is stored verbatim as `deferred_events.event_payload_json` and replayed as the
// approval `current_payload`, both of which cross the JSON bridge — and
// `JSON.stringify(BigInt)` throws. Money crosses Liaison bridges as strings;
// `toBigIntMinor` parses the string back for arithmetic.
function majorAmountToMinor(amount: string | undefined | null, currency: string): string {
  return majorDecimalToMinor(amount, currency).toString()
}

/**
 * Normalize a Shopify variant id to its Admin GraphQL gid. The `orders/create`
 * webhook carries a NUMERIC `variant_id`, but the customs overlay (synced from
 * `products_get`) and `shopify:variants_get` are both keyed by the gid
 * (`gid://shopify/ProductVariant/<n>`). Without this, the issue-time customs
 * lookup/fetch would never match — export invoices would carry blank customs.
 */
function toVariantGid(id: string): string {
  if (id === "" || id.startsWith("gid://")) return id
  if (/^\d+$/.test(id)) return `gid://shopify/ProductVariant/${id}`
  return id
}

/**
 * The tax facts Shopify reported for one line, read from its tax lines (multi jurisdiction lines,
 * e.g. GST+PST, stack).
 *
 * - `chargedRateBp`: everything the customer paid on the line, used ONLY to separate the included
 *   tax from a tax inclusive price.
 * - `sellerRateBp`: the part that is ours to invoice, the per line rate override on our document.
 *   Tax a marketplace facilitator collects and remits itself (`channelLiable`) is a pass through
 *   and never part of it.
 * - `sellerAmountMinor`: Shopify's own figure for that seller tax, the reference our computation
 *   is checked against before anything is issued.
 *
 * A tax line whose reported AMOUNT is zero contributes a zero rate whatever its `rate` says:
 * Shopify reports the jurisdiction rate on an exempt line (a California shipping charge arrives as
 * rate 7.25 percent, amount 0.00), and reading the rate alone invented a tax nobody charged.
 *
 * Rates are null when the event carries no usable tax facts (an older shopify-app event shape):
 * the classifier's default applies. An EMPTY array means Shopify saw the line and charged nothing.
 */
export function shopifyLineTaxFacts(
  taxLines: ShopifyEventTaxLine[] | undefined,
  currency: string,
): {
  chargedRateBp: number | null
  sellerRateBp: number | null
  sellerAmountMinor: string | null
  sellerTaxLineCount: number
  marketplaceAmountMinor: string
} {
  if (!taxLines) {
    return {
      chargedRateBp: null,
      sellerRateBp: null,
      sellerAmountMinor: null,
      sellerTaxLineCount: 0,
      marketplaceAmountMinor: "0",
    }
  }
  let charged = 0
  let seller = 0
  let sawRate = false
  let sellerAmount = 0n
  let sellerAmountKnown = true
  let sellerLines = 0
  let marketplace = 0n
  for (const t of taxLines) {
    const hasAmount = typeof t.amount === "string" && t.amount.trim() !== ""
    const amount = hasAmount ? BigInt(majorAmountToMinor(t.amount, currency)) : null
    const marketplaceLiable = t.channelLiable === true
    if (marketplaceLiable) {
      marketplace += amount ?? 0n
    } else {
      sellerLines += 1
      if (amount == null) sellerAmountKnown = false
      else sellerAmount += amount
    }
    if (amount === 0n) {
      // Exempt line: the jurisdiction rate is reported, nothing was charged.
      sawRate = true
      continue
    }
    if (typeof t.rate === "number" && Number.isFinite(t.rate)) {
      sawRate = true
      charged += t.rate
      if (!marketplaceLiable) seller += t.rate
    }
  }
  if (taxLines.length === 0) sawRate = true
  return {
    chargedRateBp: sawRate ? Math.round(charged * 10000) : null,
    sellerRateBp: sawRate ? Math.round(seller * 10000) : null,
    sellerAmountMinor: sellerAmountKnown ? sellerAmount.toString() : null,
    sellerTaxLineCount: sellerLines,
    marketplaceAmountMinor: marketplace.toString(),
  }
}

/**
 * NET money facts (minor units, as bridge-safe strings) for a line whose
 * Shopify pricing may be tax-inclusive and may carry allocated discounts.
 *
 * The discount stays EXPLICIT (a legal requirement on the invoice — never
 * folded into the unit price): the unit price is the FULL net shelf price and
 * `discount_minor` the net reduction. `discount` is derived as
 * `qty x unit_net - net(line total after discount)` so the persisted line
 * reproduces exactly what the customer paid, with no rounding drift.
 */
function toNetLineMoney(params: {
  unitAmount: string | undefined | null
  quantity: number
  discountTotals: Array<string | undefined>
  rateBp: number | null
  taxesIncluded: boolean
  currency: string
}): { unit_price_minor: string; discount_minor: string } {
  const { unitAmount, quantity, discountTotals, rateBp, taxesIncluded, currency } = params
  const qty = BigInt(Math.max(1, Math.round(quantity)))
  const unitGross = BigInt(majorAmountToMinor(unitAmount, currency))
  let discountGross = 0n
  for (const d of discountTotals) {
    if (d) discountGross += BigInt(majorAmountToMinor(d, currency))
  }
  let lineGrossAfter = unitGross * qty - discountGross
  if (lineGrossAfter < 0n) lineGrossAfter = 0n
  // De-tax only when prices are gross AND we know the rate Shopify applied —
  // without a rate we cannot separate the included tax, so prices pass
  // through unchanged rather than guessing.
  const deTax = (v: bigint): bigint =>
    taxesIncluded && rateBp != null ? netOfTax({ gross_minor: v, tax_rate_bp: rateBp }) : v
  const unitNet = deTax(unitGross)
  const netAfter = deTax(lineGrossAfter)
  let discountNet = unitNet * qty - netAfter
  if (discountNet < 0n) discountNet = 0n
  return { unit_price_minor: unitNet.toString(), discount_minor: discountNet.toString() }
}

/** Render a structured event address into the multiline Bill-to string the
 *  document snapshot stores. The contact's legal name AND the country render
 *  as their own lines on the PDF, so the address block carries only
 *  company + street + locality — including the country here doubled it. */
export function formatEventAddress(a: ShopifyEventAddress | null | undefined): string | null {
  if (!a) return null
  const locality = [a.zip, a.city].filter(Boolean).join(" ")
  const localityWithProvince = a.province ? [locality, a.province].filter(Boolean).join(", ") : locality
  const lines = [
    a.company ?? null,
    a.address1 ?? null,
    a.address2 ?? null,
    localityWithProvince || null,
  ].filter((l): l is string => !!l && l.trim() !== "")
  return lines.length > 0 ? lines.join("\n") : null
}

/** The SHIP TO snapshot for an event address. The ship to block prints no separate country line
 *  (counterparty_country identifies the BILLED party), so the consignee country is folded in. */
export function formatEventShippingAddress(
  a: ShopifyEventAddress | null | undefined,
): string | null {
  const base = formatEventAddress(a)
  if (!base) return null
  const country = a?.country_code?.trim()
  return country ? `${base}\n${country}` : base
}

/** The payload line fields carried from a line's Shopify tax facts. */
function taxFactsFields(tax: ReturnType<typeof shopifyLineTaxFacts>): {
  tax_rate_bp?: number
  shopify_tax_minor?: string
  shopify_tax_line_count?: number
  marketplace_tax_minor?: string
} {
  if (tax.sellerRateBp == null) return {}
  return {
    tax_rate_bp: tax.sellerRateBp,
    ...(tax.sellerAmountMinor != null
      ? { shopify_tax_minor: tax.sellerAmountMinor, shopify_tax_line_count: tax.sellerTaxLineCount }
      : {}),
    ...(tax.marketplaceAmountMinor !== "0" ? { marketplace_tax_minor: tax.marketplaceAmountMinor } : {}),
  }
}

export function adaptShopifyOrderCreatedEvent(event: ShopifyOrderCreatedEvent): OrderPaidPayload {
  const currency = event.totalPrice?.currencyCode ?? "EUR"
  const taxesIncluded = event.taxesIncluded === true
  const legalName =
    [event.customer?.first_name, event.customer?.last_name].filter(Boolean).join(" ") ||
    event.customer?.email ||
    undefined
  // Billing address is the invoice address; ship-to is the fallback.
  const invoiceAddress = formatEventAddress(event.billingAddress ?? event.shippingAddress)
  // ...and the ship to is ALSO kept in its own right, not discarded once it has served as the
  // billing fallback: when the two differ the invoice must print both.
  const shippingAddress = formatEventShippingAddress(event.shippingAddress)
  const shippingName = event.shippingAddress?.name ?? event.shippingAddress?.company ?? undefined
  // Two countries, two jobs. The BILLING country prints under the Bill-to address, so it must be
  // the country of the address printed there (the billing address, else the ship to used as its
  // fallback). The TAX country is where the goods go: the ship to, else what the shopify app
  // resolved as the destination (`customer.country`), else billing. One field serving both is what
  // printed a Sicilian street under a US country line.
  const billingCountry =
    (event.billingAddress
      ? event.billingAddress.country_code
      : event.shippingAddress?.country_code) ??
    event.customer?.country ??
    undefined
  const taxCountry =
    event.shippingAddress?.country_code ?? event.customer?.country ?? billingCountry ?? undefined
  const billingSource = event.billingAddress ?? event.shippingAddress ?? null
  const billing: OrderAddress | null = billingSource
    ? {
        company: addrStr(billingSource.company),
        line1: addrStr(billingSource.address1),
        line2: addrStr(billingSource.address2),
        postcode: addrStr(billingSource.zip),
        city: addrStr(billingSource.city),
        country_code: addrStr(billingSource.country_code)?.toUpperCase() ?? null,
      }
    : null
  const delivery: OrderDeliveryAddress | null = event.shippingAddress
    ? {
        name: addrStr(event.shippingAddress.name) ?? addrStr(event.shippingAddress.company),
        line1: addrStr(event.shippingAddress.address1),
        line2: addrStr(event.shippingAddress.address2),
        postcode: addrStr(event.shippingAddress.zip),
        city: addrStr(event.shippingAddress.city),
        country_code: addrStr(event.shippingAddress.country_code)?.toUpperCase() ?? null,
      }
    : null
  const buyerTaxId =
    typeof event.buyerTaxId === "string" && event.buyerTaxId.trim() !== ""
      ? event.buyerTaxId.trim()
      : null

  const productLines = (event.lineItems ?? []).map((li) => {
    const tax = shopifyLineTaxFacts(li.taxLines, currency)
    const money = toNetLineMoney({
      unitAmount: li.priceSet?.amount,
      quantity: Number(li.quantity ?? 1),
      discountTotals: (li.discountAllocations ?? []).map((d) => d?.amount),
      rateBp: tax.chargedRateBp,
      taxesIncluded,
      currency,
    })
    return {
      // gid form so the line's external_id matches the gid-keyed customs overlay
      // and resolves via shopify:variants_get at issue time.
      id: toVariantGid(String(li.variant?.id ?? li.id ?? "")),
      description: li.title ?? "",
      quantity: String(li.quantity ?? 1),
      unit_price_minor: money.unit_price_minor,
      discount_minor: money.discount_minor,
      ...taxFactsFields(tax),
      // Shopify flags digital goods (license keys, downloads) as not requiring
      // shipping — the invoice separates those from physical goods.
      line_kind: (li.requiresShipping === false ? "software" : "goods") as LineKind,
    }
  })

  // Carriage is part of what the customer paid — invoice it as its own line.
  const shippingLines = (event.shippingLines ?? [])
    .filter((s) => BigInt(majorAmountToMinor(s.priceSet?.amount, currency)) > 0n)
    .map((s) => {
      const tax = shopifyLineTaxFacts(s.taxLines, currency)
      const money = toNetLineMoney({
        unitAmount: s.priceSet?.amount,
        quantity: 1,
        discountTotals: [],
        rateBp: tax.chargedRateBp,
        taxesIncluded,
        currency,
      })
      return {
        id: "",
        description: s.title ? `Shipping (${s.title})` : "Shipping",
        quantity: "1",
        unit_price_minor: money.unit_price_minor,
        discount_minor: money.discount_minor,
        ...taxFactsFields(tax),
        line_kind: "shipping" as LineKind,
      }
    })

  return {
    id: String(event.orderId ?? ""),
    order_number: typeof event.name === "string" && event.name.trim() !== "" ? event.name.trim() : null,
    shop_id: String(event.shopDomain ?? ""),
    createdAt: event.createdAt,
    financial_status: event.financialStatus ?? null,
    po_number:
      typeof event.poNumber === "string" && event.poNumber.trim() !== ""
        ? event.poNumber.trim()
        : null,
    total_price_minor: majorAmountToMinor(event.totalPrice?.amount, currency),
    currency,
    customer: event.customer
      ? {
          id: event.customer.id ?? null,
          email: event.customer.email ?? null,
          contact_id: null, // resolved in onShopifyOrderCreated via ctx.resolveContact
          country: billingCountry,
          tax_country: taxCountry,
          legal_name: legalName,
          vat_id: buyerTaxId,
          address: invoiceAddress,
          shipping_address: shippingAddress,
          shipping_name: shippingName ?? null,
          billing,
          delivery,
        }
      : undefined,
    line_items: [...productLines, ...shippingLines],
    market: event.market,
  }
}

/**
 * Event entry point for `shopify/order:created` (declared in the manifest's
 * `events.subscribes`). Adapts the Shopify event into `OrderPaidPayload`,
 * resolves the kernel contact for the Shopify customer, then delegates to the
 * issue flow (`onShopifyOrderPaid`).
 */
export async function onShopifyOrderCreated(
  event: ShopifyOrderCreatedEvent & { data?: ShopifyOrderCreatedEvent },
  ctx: OrderPaidCtx,
): Promise<OrderPaidResult> {
  // The kernel delivers the FULL event envelope ({ entity, action, entityId,
  // data, metadata, orgId, ... }); the shopify-normalized order lives in
  // `event.data`. Unwrap it (fall back to the bare event for direct/unit calls).
  const eventData: ShopifyOrderCreatedEvent = event?.data ?? event
  const payload = adaptShopifyOrderCreatedEvent(eventData)
  // Link the Shopify customer to its kernel contact (the Shopify app's
  // customers/create handler materialized it under external_ids.shopify).
  // resolveContact is resolve-or-create, so this also covers the case where the
  // contact has not synced yet.
  if (
    payload.customer &&
    !payload.customer.contact_id &&
    (payload.customer.email || payload.customer.id)
  ) {
    try {
      const resolved = (await ctx.resolveContact({
        email: payload.customer.email ?? undefined,
        name: payload.customer.legal_name ?? undefined,
        externalId: payload.customer.id ?? undefined,
      })) as { id?: string } | null
      payload.customer.contact_id = resolved?.id ?? null
    } catch {
      // Leave contact_id null → onShopifyOrderPaid parks awaiting_data.
    }
  }
  return onShopifyOrderPaid(payload, ctx)
}

/**
 * Catch-up for a PAID order that never got its invoice. The auto-issue flow runs once, on
 * shopify/order:created; if that dispatch is dropped (a handler defect, an outage, a subscriber
 * that threw), nothing re-runs it and the order sits in the shipping worklist with no document.
 * The order:updated subscriber (see src/handlers.ts) lands here whenever it finds NO billing
 * document for the order: a paid order then goes through the ordinary created flow (same
 * idempotency, same threshold gate, same deferral rules), an unpaid one is left alone, and an
 * order already parked in deferred_events is left to the deferred-retry cron so it is never
 * parked twice.
 */
export async function catchUpMissedPaidOrder(
  event: ShopifyOrderCreatedEvent & { entityId?: string; data?: ShopifyOrderCreatedEvent },
  ctx: OrderPaidCtx,
): Promise<OrderPaidResult> {
  const eventData: ShopifyOrderCreatedEvent = event?.data ?? event
  if (!isPaidFinancialStatus(eventData.financialStatus)) {
    return { status: "skipped", reason: "not_paid" }
  }
  const payload = adaptShopifyOrderCreatedEvent(eventData)
  const parked = (await ctx.db.findMany("deferred_events", {
    where: { event_id: payload.id },
    limit: 10,
  })) as Array<Record<string, unknown>>
  if (parked.some((r) => String(r.status ?? "").startsWith("awaiting_"))) {
    return { status: "skipped", reason: "already_parked" }
  }
  return onShopifyOrderCreated(event, ctx)
}

async function tryFetchShopifyOrder(
  ctx: OrderPaidCtx,
  orderId: string,
): Promise<ShopifyOrderFetch | null> {
  try {
    // `shopify:orders_get` expects a Shopify GID; the webhook/event carries the
    // bare numeric order id (`String(p.id)`). Passing the numeric id verbatim made
    // Shopify reject every enrichment fetch ("Variable $id of type ID! was provided
    // invalid value") — the error was swallowed (→ null, webhook customer used) but
    // it (a) spammed server-error logs (tripping the chaos server_error_rate probe)
    // and (b) silently DISABLED customer enrichment (vat_id / address / b2b) for
    // every reconciled invoice. Normalize to a GID so the fetch actually works.
    const id = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`
    const envelope = await ctx.executeTool("shopify:orders_get", { id })
    if (envelope.status !== "completed") return null
    return (envelope.result as ShopifyOrderFetch) ?? null
  } catch {
    return null
  }
}

// The shape `shopify:orders_get` ACTUALLY returns (see the shopify app's
// reads.ts): a flat customer name/email plus normalized ship-to and canonical
// customer addresses. (The previous fiction here expected legal_name / vat_id /
// address on the customer — fields orders_get never carried, so enrichment
// silently contributed nothing.)
interface ShopifyFetchedAddress {
  name?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  zip?: string | null
  country?: string | null
  countryCode?: string | null
}

interface ShopifyOrderFetch {
  /** The order's human name ("#1149") -- `orders_get` returns it as `name`. */
  name?: string | null
  /** Set when the order was cancelled (orders_get carries it in `attributes`). */
  cancelledAt?: string | null
  /** Shopify display financial status ("PAID", "VOIDED", ...). */
  financialStatus?: string | null
  attributes?: { cancelledAt?: string | null; financialStatus?: string | null } | null
  customer?: {
    email?: string | null
    first_name?: string | null
    last_name?: string | null
  } | null
  shippingAddress?: ShopifyFetchedAddress | null
  customerAddress?: ShopifyFetchedAddress | null
  /** The order's billing address as it reads now, with its company. */
  billingAddress?: (ShopifyFetchedAddress & { company?: string | null }) | null
  /** The buyer's VAT number from the order's CURRENT custom attributes (same keys as the
   *  order:created event), so a number added after checkout reaches a re-drive. */
  buyerTaxId?: string | null
  /** The B2B company buying (the shopify app's `NormalizedPurchasingCompany`), null for a
   *  consumer order, absent from an older shopify-app build. */
  purchasingCompany?: {
    companyName?: string | null
    taxRegistrationId?: string | null
    taxExempt?: boolean
    contactEmail?: string | null
    billingAddress?: ShopifyCompanyLocationAddress | null
    shippingAddress?: ShopifyCompanyLocationAddress | null
  } | null
}

/** A company location address as the shopify app normalises it. */
interface ShopifyCompanyLocationAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  countryCode?: string | null
}

function formatFetchedAddress(a: ShopifyFetchedAddress | null | undefined): string | null {
  if (!a) return null
  const locality = [a.zip, a.city].filter(Boolean).join(" ")
  const localityWithProvince = a.province ? [locality, a.province].filter(Boolean).join(", ") : locality
  // No country line — the document snapshot's counterparty_country renders as
  // its own line on the PDF; carrying it here doubled it.
  const lines = [
    a.address1 ?? null,
    a.address2 ?? null,
    localityWithProvince || null,
  ].filter((l): l is string => !!l && l.trim() !== "")
  return lines.length > 0 ? lines.join("\n") : null
}

/** SHIP TO snapshot from the enrichment fetch. Country folded in, same reason as the event path. */
function formatFetchedShippingAddress(a: ShopifyFetchedAddress | null | undefined): string | null {
  const base = formatFetchedAddress(a)
  if (!base) return null
  const country = (a?.countryCode ?? a?.country)?.trim()
  return country ? `${base}\n${country}` : base
}

// Webhook facts win — they are order-scoped (the billing address of THIS
// order). The live fetch only FILLS fields the webhook path left blank.
// Exported for einvoicing_classify (the invoice an order would get).
export function mergeCustomer(
  fromWebhook: OrderPaidPayload["customer"] | undefined,
  fromFetch: ShopifyOrderFetch | null,
): OrderPaidPayload["customer"] | undefined {
  if (!fromFetch) return fromWebhook
  const pc = fromFetch.purchasingCompany ?? null
  if (pc && addrStr(pc.companyName)) return mergeCompanyBuyer(fromWebhook, fromFetch, pc)
  const fetched = fromFetch.customer
  const fetchedName =
    [fetched?.first_name, fetched?.last_name].filter(Boolean).join(" ") || undefined
  const fetchedAddress = fromFetch.shippingAddress ?? fromFetch.customerAddress ?? null
  // A re-drive replays the payload stored when the order was parked: a VAT number or a billing
  // company added to the order since then is only on the live order.
  const vatId = addrStr(fromWebhook?.vat_id) ?? addrStr(fromFetch.buyerTaxId) ?? null
  const company =
    addrStr(fromWebhook?.billing?.company) ?? addrStr(fromFetch.billingAddress?.company) ?? null
  const webhookBilling = fromWebhook?.billing ?? null
  const billing: OrderAddress | null = webhookBilling
    ? { ...webhookBilling, company }
    : fetchedStructured(fromFetch.billingAddress ?? fetchedAddress, company)
  const personName = fromWebhook?.legal_name ?? fetchedName
  // A buyer with a VAT number is the business: the invoice names the company, not the person
  // who checked out (whose name the event's legal_name carries).
  const legalName = vatId && company ? company : personName
  const address = fromWebhook?.address ?? formatFetchedAddress(fromFetch.billingAddress ?? fetchedAddress)
  return {
    id: fromWebhook?.id ?? null,
    email: fromWebhook?.email ?? fetched?.email ?? null,
    contact_id: fromWebhook?.contact_id ?? null,
    country:
      fromWebhook?.country ?? fetchedAddress?.countryCode?.toUpperCase() ?? undefined,
    // Only an event that already split the two carries a tax country; the fetch fills it from the
    // ship to. An older payload (no tax_country) keeps classifying on `country`, as before.
    tax_country:
      fromWebhook?.tax_country ??
      (fromWebhook?.country == null
        ? (fromFetch.shippingAddress?.countryCode?.toUpperCase() ?? undefined)
        : undefined),
    legal_name: legalName,
    vat_id: vatId,
    address: legalName === company ? withoutLeadingLine(address, company) : address,
    // This path used the SHIPPING address AS the billing address and kept no ship to of its own.
    // Keep the billing fallback exactly as it was, and carry the ship to separately so a
    // different consignee survives enrichment instead of being swallowed.
    shipping_address:
      fromWebhook?.shipping_address ?? formatFetchedShippingAddress(fromFetch.shippingAddress),
    shipping_name:
      fromWebhook?.shipping_name ?? fromFetch.shippingAddress?.name ?? null,
    // Structured addresses: the webhook's, else the fetched ones (same fallback as `address`).
    billing,
    delivery:
      fromWebhook?.delivery ??
      (fromFetch.shippingAddress
        ? (() => {
            const a = fetchedStructured(fromFetch.shippingAddress)!
            return {
              name: addrStr(fromFetch.shippingAddress?.name),
              line1: a.line1,
              line2: a.line2,
              postcode: a.postcode,
              city: a.city,
              country_code: a.country_code,
            }
          })()
        : null),
  }
}

/**
 * The counterparty of an order placed for a B2B company (`purchasingEntity` is a company). The
 * invoice names the COMPANY, not the contact who placed it: its name is the legal name, its
 * location's tax registration id the VAT number, and its location's billing address (else its
 * shipping address) the Bill-to when the order carries none of its own. Order-scoped webhook
 * facts still win field by field.
 */
function mergeCompanyBuyer(
  fromWebhook: OrderPaidPayload["customer"] | undefined,
  fromFetch: ShopifyOrderFetch,
  pc: NonNullable<ShopifyOrderFetch["purchasingCompany"]>,
): OrderPaidPayload["customer"] {
  const companyName = addrStr(pc.companyName)!
  const locationBilling = pc.billingAddress ?? pc.shippingAddress ?? null
  const orderBilling = fromFetch.billingAddress ?? null
  const billingSource: ShopifyFetchedAddress | null = orderBilling ?? locationBilling
  const shippingSource: ShopifyFetchedAddress | null =
    fromFetch.shippingAddress ?? pc.shippingAddress ?? null
  const vatId =
    addrStr(fromWebhook?.vat_id) ?? addrStr(pc.taxRegistrationId) ?? addrStr(fromFetch.buyerTaxId) ?? null
  const fetchedAddress = formatFetchedAddress(billingSource)
  const address = withoutLeadingLine(fromWebhook?.address ?? fetchedAddress, companyName)
  const billingCountry =
    fromWebhook?.country ??
    addrStr(billingSource?.countryCode)?.toUpperCase() ??
    addrStr(shippingSource?.countryCode)?.toUpperCase() ??
    undefined
  const fetchedShipping = shippingSource ? fetchedStructured(shippingSource) : null
  return {
    id: fromWebhook?.id ?? null,
    email: fromWebhook?.email || fromFetch.customer?.email || addrStr(pc.contactEmail) || null,
    contact_id: fromWebhook?.contact_id ?? null,
    country: billingCountry,
    tax_country:
      fromWebhook?.tax_country ??
      addrStr(shippingSource?.countryCode)?.toUpperCase() ??
      billingCountry,
    legal_name: companyName,
    vat_id: vatId,
    address,
    shipping_address:
      fromWebhook?.shipping_address ?? formatFetchedShippingAddress(shippingSource),
    shipping_name: fromWebhook?.shipping_name ?? addrStr(shippingSource?.name) ?? null,
    billing: fromWebhook?.billing
      ? { ...fromWebhook.billing, company: companyName }
      : fetchedStructured(billingSource, companyName),
    delivery:
      fromWebhook?.delivery ??
      (fetchedShipping
        ? {
            name: addrStr(shippingSource?.name),
            line1: fetchedShipping.line1,
            line2: fetchedShipping.line2,
            postcode: fetchedShipping.postcode,
            city: fetchedShipping.city,
            country_code: fetchedShipping.country_code,
          }
        : null),
  }
}

/** The Bill-to block prints the legal name on its own line: drop the same name heading the address. */
function withoutLeadingLine(address: string | null, line: string | null): string | null {
  if (!address || !line) return address
  const lines = address.split("\n")
  if (lines[0]?.trim().toLowerCase() !== line.trim().toLowerCase()) return address
  const rest = lines.slice(1).join("\n")
  return rest.trim() !== "" ? rest : address
}

function fetchedStructured(
  a: ShopifyFetchedAddress | null | undefined,
  company: string | null = null,
): OrderAddress | null {
  if (!a) return null
  return {
    company,
    line1: addrStr(a.address1),
    line2: addrStr(a.address2),
    postcode: addrStr(a.zip),
    city: addrStr(a.city),
    country_code: addrStr(a.countryCode)?.toUpperCase() ?? null,
  }
}
