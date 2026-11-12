// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — Shopify webhook handlers (topics + dedup ledger + event emission).
//
// Each per-topic handler is wired into `app.manifest.json#webhooks` with
//   { handler: "<topicHandler>", verify: "shopifyWebhookVerifier", bodyLimitBytes: 5_242_880 }
//
// The kernel webhook router enforces bodyLimit (413 oversized → handler never
// invoked) and replay dedup via the verifier's `replayKey`. The per-handler
// `webhook_deliveries` ledger here is defense-in-depth so the app survives a
// kernel cache reset and exposes per-topic retry diagnostics in the Settings
// panel. A run holds no transaction (each ctx call commits on its own), so the
// ledger is written once, when a delivery ends (`recordOutcome`): no claim is
// taken up front that a killed run could leave behind.
//
// Handler contract (matches mail/tickets convention):
//   async function <topic>Handler(payload, ctx, headers?) → { status, body? }
//
// The kernel sandbox bridge passes (payload, ctx, headers); when headers are
// missing (e.g. legacy host-side test path) the handler falls back to
// payload-embedded ids.
import type { AppContext, WebhookResult } from "@liaison/app-sdk"
import {
  normalizeDraftOrderWebhook,
  toPoNumber,
  type ShopifyDraftOrderWebhookPayload,
} from "./lib/draft-order"
import { emitEvent } from "./lib/emit"
import { connectedShopDomains, ensureInstallMetadata } from "./lib/get-client"
import { shopifyWebhookVerifier } from "./lib/hmac"
import { loadInstallMetadata } from "./lib/install-metadata"

export { shopifyWebhookVerifier }

interface WebhookHeaders {
  "x-shopify-webhook-id"?: string
  "x-shopify-shop-domain"?: string
  "x-shopify-topic"?: string
  [k: string]: string | undefined
}

interface DedupRow {
  id: string
  webhookId: string
  topic: string
  shopDomain: string
  status: "processing" | "processed" | "failed"
  failureCount: number
  receivedAt: Date
  processedAt?: Date | null
}

const OK: WebhookResult = { status: 200 }
const RETRY_5XX: WebhookResult = { status: 503, body: "downstream emit failed" }

function header(headers: WebhookHeaders | undefined, key: string): string | undefined {
  if (!headers) return undefined
  return headers[key] ?? headers[key.toLowerCase()]
}

/**
 * The ledger row of a delivery id, if any. `webhookId` is unique, so at most
 * one row matches; a deterministic order keeps the read reproducible.
 */
async function ledgerRow(ctx: AppContext, webhookId: string): Promise<DedupRow | null> {
  const rows = (await ctx.db.findMany("webhook_deliveries", {
    where: { webhookId },
    orderBy: { receivedAt: "asc" },
    limit: 1,
  })) as DedupRow[]
  return rows[0] ?? null
}

/**
 * Record how a delivery ended, in ONE write that is safe to repeat: the row's
 * first write inserts it, a later one (a retried delivery, a lost race on the
 * unique `webhookId`) updates it. Nothing is written before the work is done,
 * so a run killed half way leaves no claim behind: Shopify's redelivery (or the
 * kernel's retry) simply runs the delivery again.
 */
async function recordOutcome(
  ctx: AppContext,
  existing: DedupRow | null,
  delivery: { webhookId: string; topic: string; shopDomain: string },
  outcome: "processed" | "failed",
): Promise<void> {
  const fields =
    outcome === "processed"
      ? { status: "processed" as const, processedAt: new Date() }
      : { status: "failed" as const, failureCount: (existing?.failureCount ?? 0) + 1 }
  if (existing) {
    await ctx.db.update("webhook_deliveries", existing.id, fields)
    return
  }
  try {
    await ctx.db.insert("webhook_deliveries", {
      ...delivery,
      failureCount: 0,
      receivedAt: new Date(),
      ...fields,
    })
  } catch (err) {
    // A concurrent delivery of the same id wrote the row first: update it.
    const row = await ledgerRow(ctx, delivery.webhookId)
    if (!row) throw err
    await ctx.db.update("webhook_deliveries", row.id, fields)
  }
}

/**
 * Build a normalized event envelope. Per-topic handlers shape `data` to match
 * Phase 17 contract (orderId, customer.external_ids.shopify, line items, etc.).
 *
 * Cluster-1: emit the canonical `{ entity, action }` VERBATIM via the shared
 * `emitEvent` helper. The kernel bridge keys the event as `${entity}:${action}`
 * (validated against `manifest.events.emits`) and composes the channel as
 * `events:shopify:${entity}:${action}`. (Previously this helper collapsed
 * `(entity, action)` into `{ entity: "shopify", action: "<entity>_<action>" }`,
 * producing the wrong channel `events:shopify:shopify:<entity>_<action>`.)
 */
async function emit(
  ctx: AppContext,
  entity: string,
  action: string,
  entityId: string,
  data: unknown,
  metadata: Record<string, unknown>,
): Promise<void> {
  await emitEvent(ctx, { entity, action, entityId, data, metadata })
}

// ─────────────────────────────────────────────────────────────────────────
//  Payload normalization helpers
// ─────────────────────────────────────────────────────────────────────────

interface ShopifyMoneyBag {
  shop_money?: { amount?: string; currency_code?: string }
  presentment_money?: { amount?: string; currency_code?: string }
}

interface ShopifyAddressPayload {
  country_code?: string | null
  country?: string | null
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  phone?: string | null
}

interface ShopifyTaxLinePayload {
  title?: string | null
  price?: string | null
  price_set?: ShopifyMoneyBag
  rate?: number | null
  /** True when the sales channel (a marketplace facilitator, e.g. the Shop app) is liable for
   *  remitting this tax, not the merchant. Null means unknown liability. */
  channel_liable?: boolean | null
}

interface ShopifyOrderPayload {
  id: number | string
  name?: string
  email?: string | null
  // Internal staff note (the staff's Boxtal "To prepare" contract). Same field as
  // the GraphQL Order node's `note` selected in reads.ts.
  note?: string | null
  currency?: string
  total_price?: string
  total_price_set?: ShopifyMoneyBag
  presentment_currency?: string
  shipping_address?: ShopifyAddressPayload | null
  billing_address?: ShopifyAddressPayload | null
  customer?: {
    id: number | string
    email?: string
    first_name?: string
    last_name?: string
    default_address?: ShopifyAddressPayload | null
  } | null
  taxes_included?: boolean
  line_items?: Array<{
    id?: number | string
    variant_id?: number | string | null
    variant_title?: string | null
    sku?: string | null
    title?: string
    quantity?: number
    price?: string
    price_set?: ShopifyMoneyBag
    requires_shipping?: boolean
    tax_lines?: ShopifyTaxLinePayload[]
    discount_allocations?: Array<{ amount?: string; amount_set?: ShopifyMoneyBag }>
  }>
  shipping_lines?: Array<{
    title?: string | null
    price?: string
    price_set?: ShopifyMoneyBag
    discounted_price?: string
    discounted_price_set?: ShopifyMoneyBag
    tax_lines?: ShopifyTaxLinePayload[]
  }>
  fulfillment_status?: string | null
  financial_status?: string | null
  market?: { id?: string; name?: string } | null
  market_id?: string | null
  presentment_currency_code?: string
  // Checkout attributes ("additional details" the buyer typed at checkout). The only place a
  // classic D2C checkout carries a buyer VAT / tax registration number.
  note_attributes?: Array<{ name?: string | null; value?: string | null }> | null
  // Buyer's purchase-order reference (API 2026-01+, same field on the GraphQL
  // Order node). UNVERIFIED against a live captured `orders/create` payload,
  // and here is exactly why: this app's webhook subscriptions are created
  // with `format: "JSON"` (connection.ts's WEBHOOK_SUBSCRIPTION_CREATE),
  // which is the classic REST-shaped delivery, so in principle the payload
  // should mirror the REST Admin API Order resource's `po_number` field. But
  // the REST Admin API Order GET endpoints (`orders.json`, `orders/<id>.json`)
  // 404 on the dogfood store even with `read_orders` granted (checked
  // 2026-09-10; `customers.json`/`products.json` on the SAME token work
  // fine), so there was no way to fetch a real REST order representation to
  // compare against, and the `orders-create`/`orders-updated` topics are not
  // among this store's currently-registered webhooks either (only
  // orders/fulfilled and orders/cancelled are), so no live delivery could be
  // inspected. No captured orders-webhook fixture exists anywhere in this
  // repo (`src/__fixtures__/shopify/` holds only GraphQL captures). If this
  // field is silently absent on a real delivery, the order webhook path
  // yields nothing for po_number and only the polled reads (`orders_get`)
  // carry it — that gap would be invisible until a real PO-bearing order
  // webhook is captured and inspected.
  po_number?: string | null
}

interface ShopifyCustomerPayload {
  id: number | string
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  tags?: string
}

interface ShopifyRefundPayload {
  id: number | string
  order_id?: number | string
  transactions?: Array<{ amount?: string; currency?: string }>
  // Shopify's refunds/create payload gives each refunded line its own net
  // (`subtotal`) and tax (`total_tax`) as major-unit decimal strings (plus the
  // equivalent money-bag form), and nests the ORDER line item — which carries
  // the numeric `variant_id` — under `line_item`. There is no variant id or
  // gid at the top level of a refund_line_items entry.
  refund_line_items?: Array<{
    line_item_id?: number | string
    subtotal?: string
    subtotal_set?: ShopifyMoneyBag
    total_tax?: string
    total_tax_set?: ShopifyMoneyBag
    line_item?: { variant_id?: number | string | null }
  }>
  // Shipping refunded by this refund. Newer API versions list it per shipping line; older ones
  // carry it as an order adjustment of kind "shipping_refund" (amounts NEGATIVE there).
  refund_shipping_lines?: Array<{
    subtotal_amount_set?: ShopifyMoneyBag
    total_tax_amount_set?: ShopifyMoneyBag
  }>
  order_adjustments?: Array<{
    kind?: string | null
    amount?: string | null
    amount_set?: ShopifyMoneyBag
    tax_amount?: string | null
    tax_amount_set?: ShopifyMoneyBag
  }>
}

interface ShopifyReturnPayload {
  id: number | string
  order_id?: number | string
  name?: string
  status?: string
  return_line_items?: Array<{ line_item_id?: number | string; quantity?: number }>
}

interface ShopifyInventoryLevelPayload {
  inventory_item_id: number | string
  location_id: number | string
  available?: number
}

function pickMoneyBag(set: ShopifyMoneyBag | undefined, fallbackAmount: string, fallbackCurrency: string): { amount: string; currencyCode: string } {
  const money = set?.presentment_money ?? set?.shop_money
  return {
    amount: money?.amount ?? fallbackAmount,
    currencyCode: money?.currency_code ?? fallbackCurrency,
  }
}

// Currencies with zero minor digits — everything else assumed 2 (EUR/USD/GBP…).
// Mirrors invoicing's own ZERO_DECIMAL_CURRENCIES: the two conversions must agree
// on the exponent, and a bundled app cannot import another app's internals
// (purity boundary), so this is kept in lock-step here rather than imported.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"])

/**
 * Convert a Shopify major-unit decimal string ("12.50") to an integer minor-unit
 * string, digit-by-digit — no float division, matching invoicing's own
 * `majorToMinor` so a refund line's amount_minor lands on the exact integer
 * invoicing expects.
 */
function majorToMinorString(amount: string, currency: string): string {
  const exp = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
  const raw = String(amount ?? "0").trim()
  const negative = raw.startsWith("-")
  const [intRaw = "0", fracRaw = ""] = raw.replace(/^[-+]/, "").split(".")
  const intPart = intRaw.replace(/[^0-9]/g, "") || "0"
  const frac = `${fracRaw.replace(/[^0-9]/g, "")}${"0".repeat(exp)}`.slice(0, exp)
  const digits = `${intPart}${frac}`.replace(/^0+(?=\d)/, "")
  return negative && digits !== "0" && digits !== "" ? `-${digits}` : digits || "0"
}

/** Add two integer minor-unit decimal strings without going through a float. */
function addMinorStrings(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString()
}

/**
 * A refund_line_items entry carries no variant id or gid directly — only the
 * nested order line item does, as a bare numeric `variant_id`. Build the same
 * `gid://shopify/ProductVariant/<n>` form invoicing's `toVariantGid` derives
 * from that same numeric id at issue time, so `external_id` matches
 * `document_lines.external_id` exactly. `null` when the line carries no
 * variant (e.g. a custom line item) — invoicing then correctly refuses to
 * attribute it rather than guessing.
 */
function refundLineVariantGid(variantId: number | string | null | undefined): string | null {
  if (variantId == null || variantId === "") return null
  return `gid://shopify/ProductVariant/${variantId}`
}

// Full structured postal address for downstream consumers (invoicing renders the
// Bill-to block from it). Kept as discrete fields — the consumer decides layout.
function normalizeOrderAddress(a: ShopifyAddressPayload | null | undefined) {
  if (!a) return null
  const fields = {
    name: a.name ?? null,
    company: a.company ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    zip: a.zip ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    country_code: a.country_code ? a.country_code.toUpperCase() : null,
    phone: a.phone ?? null,
  }
  const hasContent = Object.values(fields).some((v) => v !== null && v !== "")
  return hasContent ? fields : null
}

// Per-line tax facts as Shopify computed them at checkout. `rate` is a fraction
// (0.2 = 20%); `amount` is the tax charged on the WHOLE line in the order
// currency. Together with `taxesIncluded` this lets the invoicing consumer
// reproduce exactly what the customer paid instead of re-deriving tax.
// `channelLiable` passes through Shopify's own flag: a marketplace facilitator's tax is collected
// and remitted by the channel, so invoicing keeps it off the merchant's documents.
function normalizeTaxLines(taxLines: ShopifyTaxLinePayload[] | undefined, currency: string) {
  return (taxLines ?? []).map((t) => ({
    title: t.title ?? null,
    rate: typeof t.rate === "number" ? t.rate : null,
    ...pickMoneyBag(t.price_set, t.price ?? "0", currency),
    channelLiable: typeof t.channel_liable === "boolean" ? t.channel_liable : null,
  }))
}

// Checkout attribute names a store uses for the buyer's VAT / tax registration number (EN, FR, DE,
// IT, ES spellings), compared after lowercasing and dropping accents, spaces and punctuation.
// Matched on the attribute NAME only, never guessed from a value.
const BUYER_TAX_ID_ATTRIBUTE_KEYS = new Set([
  "vat",
  "vatid",
  "vatnumber",
  "vatno",
  "vatnr",
  "vatregistrationnumber",
  "vattaxid",
  "taxid",
  "taxnumber",
  "tva",
  "ntva",
  "numerotva",
  "numerodetva",
  "ustid",
  "ustidnr",
  "partitaiva",
  "piva",
  "nif",
  "cif",
  "nifcif",
])

function attributeKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/** The buyer's VAT / tax id from the order's checkout attributes, or null when none is named so. */
export function buyerTaxIdFromNoteAttributes(
  attrs: Array<{ name?: string | null; value?: string | null }> | null | undefined,
): string | null {
  for (const a of attrs ?? []) {
    const name = (a?.name ?? "").trim()
    const value = (a?.value ?? "").trim()
    if (name !== "" && value !== "" && BUYER_TAX_ID_ATTRIBUTE_KEYS.has(attributeKey(name))) return value
  }
  return null
}

/** Gross shipping (net + tax) refunded by a refund, in integer minor units; "0" when none. */
export function shippingRefundMinor(p: ShopifyRefundPayload, currency: string): string {
  const lines = p.refund_shipping_lines ?? []
  if (lines.length > 0) {
    let total = "0"
    for (const l of lines) {
      const sub = pickMoneyBag(l.subtotal_amount_set, "0", currency)
      const tax = pickMoneyBag(l.total_tax_amount_set, "0", currency)
      total = addMinorStrings(
        total,
        addMinorStrings(
          majorToMinorString(sub.amount, sub.currencyCode),
          majorToMinorString(tax.amount, tax.currencyCode),
        ),
      )
    }
    return total
  }
  let total = 0n
  for (const adj of p.order_adjustments ?? []) {
    if (adj?.kind !== "shipping_refund") continue
    const amt = pickMoneyBag(adj.amount_set, adj.amount ?? "0", currency)
    const tax = pickMoneyBag(adj.tax_amount_set, adj.tax_amount ?? "0", currency)
    total +=
      BigInt(majorToMinorString(amt.amount, amt.currencyCode)) +
      BigInt(majorToMinorString(tax.amount, tax.currencyCode))
  }
  // Adjustments record the refunded shipping as a NEGATIVE amount.
  const abs = total < 0n ? -total : total
  return abs.toString()
}

function normalizeOrder(p: ShopifyOrderPayload, headers: WebhookHeaders | undefined) {
  const currency = p.presentment_currency_code ?? p.currency ?? "USD"
  // Destination country (ISO-2) — the tax-classification input downstream
  // (invoicing's order-paid auto-flow reads `event.customer.country`; without
  // it every webhook order falls back to the issuer's country and classifies
  // DOMESTIC, so a US/JP export gets standard VAT and no customs enrichment).
  // Ship-to wins, then the customer's canonical address, then billing.
  const countryOf = (a: ShopifyAddressPayload | null | undefined): string | null =>
    a?.country_code ? a.country_code.toUpperCase() : null
  const country =
    countryOf(p.shipping_address) ??
    countryOf(p.customer?.default_address) ??
    countryOf(p.billing_address)
  const customer = p.customer
    ? {
        id: String(p.customer.id),
        email: p.customer.email ?? null,
        first_name: p.customer.first_name ?? null,
        last_name: p.customer.last_name ?? null,
        country,
        external_ids: { shopify: String(p.customer.id) },
      }
    : null
  // Buyer's PO reference (2026-01+). This is an EVENT payload, camelCase like every sibling
  // here (orderId, customerId, totalPrice, taxesIncluded, ...), always present with `null`
  // when there is none -- NOT the `po_number`/absent-when-none convention, which is for TOOL
  // RESULT shapes (e.g. `OrderDetail.po_number` in reads.ts). Invoicing's consumer
  // (shopify-order-paid.ts's `ShopifyOrderCreatedEvent.poNumber`) reads this exact key.
  // No fallback to an originating draft order here: the REST webhook payload carries no
  // back-reference to a draft order (confirmed against the live Admin API 2026-04 schema --
  // Order has no `draftOrder`/reverse field), so there is nothing to fall back TO from this
  // producer. The fallback lives in `draft_orders_complete` and `draft_orders_get`, the two
  // places that hold both sides of the pair.
  const poNumber = toPoNumber(p.po_number) ?? null
  return {
    orderId: String(p.id),
    name: p.name ?? null,
    customer,
    customerId: customer?.id ?? null,
    poNumber,
    // The buyer's VAT / tax registration number, from a checkout attribute named for it. Null when
    // the buyer gave none (invoicing then prints no VAT id and never treats the sale as B2B).
    buyerTaxId: buyerTaxIdFromNoteAttributes(p.note_attributes),
    note: p.note ?? null,
    totalPrice: pickMoneyBag(p.total_price_set, p.total_price ?? "0", currency),
    // Whether the line/shipping prices above already CONTAIN tax (EU-style
    // gross pricing). Invoicing must not add tax on top when this is true.
    taxesIncluded: p.taxes_included === true,
    billingAddress: normalizeOrderAddress(p.billing_address),
    shippingAddress: normalizeOrderAddress(p.shipping_address),
    lineItems: (p.line_items ?? []).map((li) => ({
      id: li.id == null ? null : String(li.id),
      title: li.title ?? null,
      quantity: li.quantity ?? 1,
      priceSet: pickMoneyBag(li.price_set, li.price ?? "0", currency),
      // False for digital goods (license keys, downloads) — the seam consumers
      // use to separate software lines from physical goods.
      requiresShipping: li.requires_shipping !== false,
      taxLines: normalizeTaxLines(li.tax_lines, currency),
      // Order+line discounts allocated to this line (order currency, whole line).
      discountAllocations: (li.discount_allocations ?? []).map((d) =>
        pickMoneyBag(d.amount_set, d.amount ?? "0", currency),
      ),
      variant: {
        id: li.variant_id == null ? null : String(li.variant_id),
        title: li.variant_title ?? null,
        sku: li.sku ?? null,
      },
    })),
    shippingLines: (p.shipping_lines ?? []).map((s) => ({
      title: s.title ?? null,
      priceSet: pickMoneyBag(
        s.discounted_price_set ?? s.price_set,
        s.discounted_price ?? s.price ?? "0",
        currency,
      ),
      taxLines: normalizeTaxLines(s.tax_lines, currency),
    })),
    fulfillmentStatus: p.fulfillment_status ?? null,
    // Order-level payment state ("paid" | "pending" | …). Threaded onto the
    // emitted order:created event so invoicing's auto-issue flow can record a
    // paid checkout's invoice as PAID at issue time (rather than leaving every
    // synced invoice unpaid for the operator to reconcile by hand).
    financialStatus: p.financial_status ?? null,
    marketId: p.market_id ?? p.market?.id ?? null,
    shopDomain: header(headers, "x-shopify-shop-domain") ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Topic handlers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pin a delivery to a shop this organization has connected.
 *
 * The HMAC proves the sender holds the app's secret, and an app the instance
 * provides signs every organization's deliveries with the same secret. So the
 * signature alone cannot tell which organization a store belongs to: a store
 * disconnected here and connected elsewhere, or a captured delivery replayed
 * to another organization's URL, would verify. The delivery is accepted only when:
 *   - it names its shop (`X-Shopify-Shop-Domain`; a stripped header is refused),
 *   - this organization has a CONNECTED `shop` account for that domain,
 *   - and the install is not recorded as uninstalled or disconnected.
 * A missing install record is not a refusal: the connect event that writes it is
 * best-effort and can be lost in a boot or redeploy race, so it is recovered here
 * from the connected account (`ensureInstallMetadata`, as the read path does) and
 * the delivery accepted. Refusing would drop a live store's orders.
 */
async function validateShopDomain(
  ctx: AppContext,
  claimedShopDomain: string | undefined,
): Promise<{ ok: true; installedShop: string } | { ok: false; reason: string; installedShop: string | null }> {
  if (!claimedShopDomain) {
    return { ok: false, reason: "missing shop domain", installedShop: null }
  }
  const connected = await connectedShopDomains(ctx)
  if (!connected.includes(claimedShopDomain)) {
    return { ok: false, reason: "no connected account for this shop", installedShop: null }
  }
  const meta = await ensureInstallMetadata(ctx)
  if (meta?.shopDomain === claimedShopDomain && meta.connectionStatus === "disconnected") {
    return { ok: false, reason: "shop disconnected", installedShop: claimedShopDomain }
  }
  return { ok: true, installedShop: claimedShopDomain }
}

async function runTopic<P>(
  ctx: AppContext,
  topic: string,
  payload: P,
  headers: WebhookHeaders | undefined,
  fn: () => Promise<{ entity: string; action: string; entityId: string; data: unknown; metadata: Record<string, unknown> } | null>,
): Promise<WebhookResult> {
  const webhookId = header(headers, "x-shopify-webhook-id")
  const claimedShopDomain = header(headers, "x-shopify-shop-domain")
  if (!webhookId) {
    // No id ⇒ no ledger key. Trust the kernel verifier already filtered; emit
    // is best-effort. (In practice the verifier rejects deliveries with no id.)
    ctx.logger.warn("webhook received without X-Shopify-Webhook-Id", { topic })
    return { status: 400, body: "missing webhook id" }
  }
  // Reject deliveries whose shop-domain label does not match the installed shop
  // (spoofable header — do not let it into the ledger or downstream events).
  const shopCheck = await validateShopDomain(ctx, claimedShopDomain)
  if (!shopCheck.ok) {
    ctx.logger.warn("webhook refused: not a connected shop of this organization", {
      topic,
      reason: shopCheck.reason,
      claimedShopDomain,
      installedShop: shopCheck.installedShop,
    })
    return { status: 401, body: shopCheck.reason }
  }
  // The installed, connected shop (authoritative) keys the ledger.
  const shopDomain = shopCheck.installedShop
  // Only a PROCESSED delivery is a duplicate. A `failed` row (and a legacy
  // `processing` row, left by a run that was killed) is run again.
  const existing = await ledgerRow(ctx, webhookId)
  if (existing?.status === "processed") return OK
  const delivery = { webhookId, topic, shopDomain }
  try {
    const ev = await fn()
    // Emit BEFORE recording the delivery processed: a run killed between the
    // two is run again by the redelivery and emits again (at least once; every
    // event carries `shopify_webhook_id` for a consumer that dedups). The
    // other order could drop the event for good.
    if (ev) {
      await emit(ctx, ev.entity, ev.action, ev.entityId, ev.data, ev.metadata)
    }
    await recordOutcome(ctx, existing, delivery, "processed")
    return OK
  } catch (err) {
    ctx.logger.error("webhook handler failed", { topic, webhookId, err: String(err) })
    try {
      await recordOutcome(ctx, existing, delivery, "failed")
    } catch {
      // The ledger is diagnostics here; the 5xx below makes Shopify redeliver.
    }
    return RETRY_5XX
  }
}

/** orders/create — emit shopify:order_created with the Phase-17 contract fields. */
export async function ordersCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "orders/create", payload, headers, async () => {
    const p = payload as ShopifyOrderPayload
    const norm = normalizeOrder(p, headers)
    // Resolve customer into kernel.contacts when not a guest checkout.
    if (p.customer) {
      await ctx.resolveContact({
        email: p.customer.email ?? undefined,
        name: [p.customer.first_name, p.customer.last_name].filter(Boolean).join(" ") || undefined,
        externalId: String(p.customer.id),
      })
    }
    return {
      entity: "order",
      action: "created",
      entityId: norm.orderId,
      data: norm,
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        market: p.market?.name ?? p.market?.id ?? "default",
        currency: norm.totalPrice.currencyCode,
      },
    }
  })
}

/** orders/updated — emit shopify:order_updated (downstream may filter). */
export async function ordersUpdatedHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "orders/updated", payload, headers, async () => {
    const p = payload as ShopifyOrderPayload
    const norm = normalizeOrder(p, headers)
    return {
      entity: "order",
      action: "updated",
      entityId: norm.orderId,
      data: norm,
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        market: p.market?.name ?? p.market?.id ?? "default",
      },
    }
  })
}

/** orders/fulfilled — emit shopify:order_fulfilled. */
export async function ordersFulfilledHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "orders/fulfilled", payload, headers, async () => {
    const p = payload as ShopifyOrderPayload
    const norm = normalizeOrder(p, headers)
    return {
      entity: "order",
      action: "fulfilled",
      entityId: norm.orderId,
      data: norm,
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/** orders/cancelled — emit shopify:order_cancelled. */
export async function ordersCancelledHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "orders/cancelled", payload, headers, async () => {
    const p = payload as ShopifyOrderPayload
    const norm = normalizeOrder(p, headers)
    return {
      entity: "order",
      action: "cancelled",
      entityId: norm.orderId,
      data: norm,
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/** customers/create — resolve into kernel.contacts + emit shopify:customer_created. */
export async function customersCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "customers/create", payload, headers, async () => {
    const p = payload as ShopifyCustomerPayload
    await ctx.resolveContact({
      email: p.email ?? undefined,
      name: [p.first_name, p.last_name].filter(Boolean).join(" ") || undefined,
      externalId: String(p.id),
    })
    return {
      entity: "customer",
      action: "created",
      entityId: String(p.id),
      data: {
        id: String(p.id),
        email: p.email ?? null,
        first_name: p.first_name ?? null,
        last_name: p.last_name ?? null,
        external_ids: { shopify: String(p.id) },
      },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/** customers/update — re-resolve + emit shopify:customer_updated. */
export async function customersUpdateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "customers/update", payload, headers, async () => {
    const p = payload as ShopifyCustomerPayload
    await ctx.resolveContact({
      email: p.email ?? undefined,
      name: [p.first_name, p.last_name].filter(Boolean).join(" ") || undefined,
      externalId: String(p.id),
    })
    return {
      entity: "customer",
      action: "updated",
      entityId: String(p.id),
      data: {
        id: String(p.id),
        email: p.email ?? null,
        external_ids: { shopify: String(p.id) },
      },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/** customers/delete — clear kernel.contacts.external_ids.shopify + emit shopify:customer_deleted (I11). */
export async function customersDeleteHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "customers/delete", payload, headers, async () => {
    const p = payload as { id: number | string }
    const externalId = String(p.id)
    // I11 — clear this app's entry from kernel.contacts.external_ids for any
    // contact carrying the deleted Shopify customer id. The contact row is
    // preserved per spec §7 — only the Shopify linkage is dropped.
    try {
      // The SDK `resolveContact` declares `clear?: boolean` (I11) — call it
      // directly; no cast needed.
      await ctx.resolveContact({ externalId, clear: true })
    } catch (err) {
      ctx.logger.warn("customersDeleteHandler: clearContactExternalId failed", {
        externalId,
        err: String(err),
      })
    }
    return {
      entity: "customer",
      action: "deleted",
      entityId: externalId,
      data: { id: externalId },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/**
 * refunds/create — a MANUAL refund taken in the Shopify admin.
 *
 * Emits TWO events from the single delivery (both are deduped together by the
 * webhook-id ledger in `runTopic`):
 *   1. `refund:created_manual` — drives the manual-refund attention card
 *      (spec §4.5). Unchanged shape so the attention translation keeps working.
 *   2. `refund:created` — reconciles the issued invoice. A manual refund must
 *      flip the invoice's payment_status (refunded/partial), not merely raise a
 *      card; invoicing subscribes to `refund:created`. (Previously this webhook
 *      emitted only `_manual`, so admin refunds left invoices marked paid.)
 *
 * The `refund:created` data is shaped so invoicing's `onShopifyRefundCreated`
 * adapter can build its `RefundPayload` (order id + amount + currency + shop);
 * the order-level amount stays a major-unit decimal string + currency so that
 * minor-unit conversion lives in one place (the invoicing adapter), matching
 * the order-created adapter's convention. Per-line `refund_line_items`,
 * however, are converted to integer minor units HERE (not left for invoicing
 * to guess), because they carry a variant identity invoicing must match
 * exactly against `document_lines.external_id` — see `refundLineVariantGid`
 * and `majorToMinorString` below.
 */
export async function refundsCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "refunds/create", payload, headers, async () => {
    const p = payload as ShopifyRefundPayload
    const txn = (p.transactions ?? [])[0]
    const refundId = String(p.id)
    const orderId = p.order_id == null ? null : String(p.order_id)
    const amount = txn?.amount ?? "0"
    const currency = txn?.currency ?? "USD"
    const shopDomain = header(headers, "x-shopify-shop-domain") ?? null
    const webhookId = header(headers, "x-shopify-webhook-id")

    // 1) Manual-refund attention card.
    await emit(
      ctx,
      "refund",
      "created_manual",
      refundId,
      {
        id: refundId,
        orderId,
        totalPrice: txn ? { amount, currencyCode: currency } : null,
      },
      // Attention axis metadata: the manual-refund card filters on
      // market/currency. Currency comes from the refund transaction; market is
      // not on the refunds/create payload, so default it.
      { shopify_webhook_id: webhookId, market: "default", currency },
    )

    // Per-line attribution for a split order (goods invoice + software invoice):
    // each entry names the Shopify variant gid the line was issued under, plus
    // that line's own gross share of the refund in integer minor units, so
    // invoicing can credit the document that actually carries the refunded
    // line instead of always defaulting to goods. Omitted entirely for a
    // shipping-only refund (no refund_line_items) so the field stays optional
    // and every pre-existing consumer keeps working unchanged.
    const rawLineItems = p.refund_line_items ?? []
    const refundLineItems =
      rawLineItems.length > 0
        ? rawLineItems.map((li) => {
            const subtotalMoney = pickMoneyBag(li.subtotal_set, li.subtotal ?? "0", currency)
            const taxMoney = pickMoneyBag(li.total_tax_set, li.total_tax ?? "0", currency)
            const amountMinor = addMinorStrings(
              majorToMinorString(subtotalMoney.amount, subtotalMoney.currencyCode),
              majorToMinorString(taxMoney.amount, taxMoney.currencyCode),
            )
            return {
              external_id: refundLineVariantGid(li.line_item?.variant_id),
              amount_minor: amountMinor,
            }
          })
        : undefined

    const shippingRefund = shippingRefundMinor(p, currency)

    // 2) Invoice reconciliation (payment_status → refunded/partial).
    await emit(
      ctx,
      "refund",
      "created",
      refundId,
      {
        id: refundId,
        order_id: orderId,
        amount,
        currency,
        shop_id: shopDomain,
        ...(refundLineItems ? { refund_line_items: refundLineItems } : {}),
        // Gross shipping refunded (minor units), so invoicing credits the document that carried
        // the shipping line, at the shipping line's own rate. Omitted when none was refunded.
        ...(shippingRefund !== "0" ? { shipping_refund_minor: shippingRefund } : {}),
      },
      { shopify_webhook_id: webhookId },
    )

    // Both events already emitted above; nothing further for runTopic to emit.
    return null
  })
}

/** returns/request_created — drive attention via shopify:return_requested. */
export async function returnsRequestedHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "returns/request_created", payload, headers, async () => {
    const p = payload as ShopifyReturnPayload
    return {
      entity: "return",
      action: "requested",
      entityId: String(p.id),
      data: {
        id: String(p.id),
        orderId: p.order_id == null ? null : String(p.order_id),
        orderName: p.name ?? null,
        itemSummary: (p.return_line_items ?? []).map((li) => `${li.quantity ?? 1}×${li.line_item_id ?? ""}`).join(", "),
      },
      // Attention axis metadata: the return-requested card filters on
      // market/currency. The returns/request_created payload carries neither,
      // so default both — the kernel filter only rejects when a user rule names
      // an axis the event lacks.
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        market: "default",
        currency: "USD",
      },
    }
  })
}

/** fulfillments/create — emit shopify:fulfillment_created. */
export async function fulfillmentsCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "fulfillments/create", payload, headers, async () => {
    const p = payload as { id: number | string; order_id?: number | string }
    return {
      entity: "fulfillment",
      action: "created",
      entityId: String(p.id),
      data: { id: String(p.id), orderId: p.order_id == null ? null : String(p.order_id) },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/**
 * inventory_levels/update — short-circuit when location is not in the
 * admin-configured allowlist (per Task B9 implement note + spec §14 item 8).
 */
export async function inventoryLevelsUpdateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "inventory_levels/update", payload, headers, async () => {
    const p = payload as ShopifyInventoryLevelPayload
    // Read allowlist from install_metadata.
    const meta = await loadInstallMetadata(ctx)
    const allowlist = Array.isArray(meta?.inventoryLocationAllowlist)
      ? (meta.inventoryLocationAllowlist as string[])
      : null
    if (allowlist && !allowlist.includes(String(p.location_id))) {
      // Skip — not in allowlist. Still mark row processed so the ledger stays clean.
      return null
    }
    return {
      entity: "inventory",
      action: "level_updated",
      entityId: String(p.inventory_item_id),
      data: {
        inventoryItemId: String(p.inventory_item_id),
        locationId: String(p.location_id),
        available: p.available ?? 0,
      },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/** app/uninstalled — flip connectionStatus to disconnected, then emit shopify:app_uninstalled. */
export async function appUninstalledHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "app/uninstalled", payload, headers, async () => {
    const shopDomain = header(headers, "x-shopify-shop-domain") ?? "unknown"
    // Heal first: a connected shop with no row (the connect event was lost)
    // must still get a row to flip — otherwise this silently no-ops and the
    // shop stays "connected" in the app's own state after Shopify uninstalled it.
    await ensureInstallMetadata(ctx)
    // Flip the install_metadata row to disconnected so settings_load and
    // any sync job that gates on connection status see the uninstalled state
    // immediately — without waiting for a manual disconnect or reconcile.
    const metaRows = (await ctx.db.findMany("install_metadata", { limit: 1 })) as Array<{
      id?: string
    }>
    if (metaRows[0]?.id) {
      await ctx.db.update("install_metadata", String(metaRows[0].id), {
        connectionStatus: "disconnected",
      })
    }
    return {
      entity: "app",
      action: "uninstalled",
      entityId: shopDomain,
      data: { shopDomain },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

interface ShopifyProductPayload {
  id: number | string
  admin_graphql_api_id?: string
  title?: string
  status?: string
}

/**
 * Resolve a product webhook payload to its Admin GraphQL gid. Shopify REST
 * webhooks carry a numeric `id` plus `admin_graphql_api_id` (the gid); we emit
 * the gid as the entityId because downstream consumers (invoicing's
 * `onShopifyProductChanged`) feed it straight into `shopify:products_get`,
 * which expects an `ID!` gid.
 */
function productGid(p: ShopifyProductPayload): string {
  return p.admin_graphql_api_id ?? `gid://shopify/Product/${p.id}`
}

/**
 * products/create — emit shopify:product_created so invoicing syncs the
 * product's customs data (HS code / country of origin / goods description)
 * into its `product_customs_overlay`. Without this webhook, customs set in the
 * Shopify admin never reached export invoices (overlay stayed empty).
 */
export async function productsCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "products/create", payload, headers, async () => {
    const p = payload as ShopifyProductPayload
    const gid = productGid(p)
    return {
      entity: "product",
      action: "created",
      entityId: gid,
      data: { id: gid, title: p.title ?? null, status: p.status ?? null },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/**
 * products/update — emit shopify:product_updated so invoicing re-syncs the
 * product's customs overlay when a merchant edits HS code / country of origin /
 * the customs-description metafield in the Shopify admin.
 */
export async function productsUpdateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "products/update", payload, headers, async () => {
    const p = payload as ShopifyProductPayload
    const gid = productGid(p)
    return {
      entity: "product",
      action: "updated",
      entityId: gid,
      data: { id: gid, title: p.title ?? null, status: p.status ?? null },
      metadata: { shopify_webhook_id: header(headers, "x-shopify-webhook-id") },
    }
  })
}

/**
 * draft_orders/create — a quote (as a Shopify draft order) was created, either
 * in the Shopify admin, by an agent via `draft_orders_create`, or by
 * invoicing's own `quote_create_and_issue`. Emits `draft_order:created` with
 * the shared `NormalizedDraftOrder` shape so invoicing's adapter (quotes-are-
 * draft-orders design) can sync a local quote from it without re-fetching.
 */
export async function draftOrdersCreateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "draft_orders/create", payload, headers, async () => {
    const p = payload as ShopifyDraftOrderWebhookPayload
    const shopDomain = header(headers, "x-shopify-shop-domain") ?? null
    const norm = normalizeDraftOrderWebhook(p, shopDomain)
    if (p.customer) {
      await ctx.resolveContact({
        email: p.customer.email ?? undefined,
        name: [p.customer.first_name, p.customer.last_name].filter(Boolean).join(" ") || undefined,
        externalId: p.customer.id == null ? undefined : String(p.customer.id),
      })
    }
    return {
      entity: "draft_order",
      action: "created",
      entityId: norm.draftOrderId,
      data: norm,
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        currency: norm.currency,
      },
    }
  })
}

/** draft_orders/update — emit shopify:draft_order_updated (invoicing re-syncs an open quote's
 *  lines), or draft_order:completed once the draft has become an order.
 *
 *  Shopify has no `draft_orders/completed` topic: completing a draft delivers
 *  `draft_orders/update` with a completed status plus an `orders/create`. The
 *  manifest has always DECLARED `draft_order:completed` and invoicing has always
 *  SUBSCRIBED to it, but nothing ever emitted it, so that half of the contract was
 *  dead code on both sides. Deriving it here makes the declared event real, and
 *  emitting exactly one of the two keeps a single event per webhook. */
export async function draftOrdersUpdateHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "draft_orders/update", payload, headers, async () => {
    const p = payload as ShopifyDraftOrderWebhookPayload
    const shopDomain = header(headers, "x-shopify-shop-domain") ?? null
    const norm = normalizeDraftOrderWebhook(p, shopDomain)
    if (p.customer) {
      await ctx.resolveContact({
        email: p.customer.email ?? undefined,
        name: [p.customer.first_name, p.customer.last_name].filter(Boolean).join(" ") || undefined,
        externalId: p.customer.id == null ? undefined : String(p.customer.id),
      })
    }
    const completed = norm.status === "completed" || !!norm.orderId
    return {
      entity: "draft_order",
      action: completed ? "completed" : "updated",
      entityId: norm.draftOrderId,
      data: norm,
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        currency: norm.currency,
      },
    }
  })
}

/**
 * draft_orders/delete — Shopify sends only `{ id }` on this topic (no line
 * items, customer, or money fields). The same normalizer covers the minimal
 * payload, producing a `NormalizedDraftOrder` with nulls everywhere but
 * `draftOrderId` — invoicing's adapter transitions the matching local quote
 * (if any) to rejected and does not depend on any other field being present.
 */
export async function draftOrdersDeleteHandler(
  payload: unknown,
  ctx: AppContext,
  headers?: WebhookHeaders,
): Promise<WebhookResult> {
  return runTopic(ctx, "draft_orders/delete", payload, headers, async () => {
    const p = payload as ShopifyDraftOrderWebhookPayload
    const shopDomain = header(headers, "x-shopify-shop-domain") ?? null
    const norm = normalizeDraftOrderWebhook(p, shopDomain)
    return {
      entity: "draft_order",
      action: "deleted",
      entityId: norm.draftOrderId,
      data: norm,
      metadata: {
        shopify_webhook_id: header(headers, "x-shopify-webhook-id"),
        currency: norm.currency,
      },
    }
  })
}
