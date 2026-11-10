// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quotes-are-draft-orders design contract — the shared `NormalizedDraftOrder`
// shape produced by BOTH producers of draft-order data:
//   - the `draft_orders/{create,update,delete}` webhook handlers (REST payload)
//   - the `draft_orders_get` read (GraphQL node)
// so invoicing's adapter consumes exactly one shape regardless of which path
// produced it. See the design contract for the full field-by-field mapping.
//
// Both normalizers are pure: no I/O, no ctx. `entityId`/gid construction and
// event emission live in the callers (webhooks.ts / reads.ts).

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

export interface NormalizedDraftOrderLineItem {
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
  /** The line's price override (a staff-set unit price), when it has one. `unitPrice` already
   *  carries it: an overridden line is invoiced at that price, never as a discount off the
   *  variant's list price. Absent on the webhook path. */
  priceOverride?: string | null
}

/**
 * The B2B buyer of a draft order or order placed for a company (`purchasingEntity` is a
 * PurchasingCompany). The document's counterparty is the COMPANY: its name, the location's billing
 * address (shipping as fallback), the location's tax registration id, and the contact's email.
 * Such a draft frequently carries no draft-level address of its own.
 */
export interface NormalizedPurchasingCompany {
  companyName: string | null
  locationName: string | null
  /** The company location's tax registration id (the buyer's VAT number). */
  taxRegistrationId: string | null
  /** True when the company location is tax exempt. */
  taxExempt: boolean
  /** The company contact's email (the person ordering for the company). */
  contactEmail: string | null
  billingAddress: NormalizedAddress | null
  shippingAddress: NormalizedAddress | null
}

export interface NormalizedDraftOrderDiscount {
  title: string | null
  description: string | null
  valueType: "PERCENTAGE" | "FIXED_AMOUNT" | null
  value: string | null
  amount: string | null
}

export interface NormalizedDraftOrderCustomer {
  id: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  company: string | null
}

export interface NormalizedDraftOrder {
  draftOrderId: string
  name: string | null
  status: string | null
  orderId: string | null
  orderName: string | null
  shopDomain: string | null
  createdAt: string | null
  updatedAt: string | null
  currency: string | null
  /** True when `currency` is the PRESENTMENT currency (what the buyer is quoted),
   *  false when it could only be resolved to the SHOP's currency.
   *
   *  Every amount on this shape is presentment, so a shop-currency label
   *  mislabels them rather than converting them: draft #D332 quoted 149.00 USD
   *  and the quote came out 149.00 EUR. A consumer that needs the money to be
   *  right (invoicing) re-fetches through `draft_orders_get` when this is false,
   *  instead of silently trusting a currency the producer had to guess. */
  currencyIsPresentment: boolean
  totalPrice: string | null
  subtotalPrice: string | null
  totalTax: string | null
  taxesIncluded: boolean
  taxExempt: boolean
  email: string | null
  note: string | null
  tags: string[]
  customer: NormalizedDraftOrderCustomer | null
  billingAddress: NormalizedAddress | null
  shippingAddress: NormalizedAddress | null
  appliedDiscount: NormalizedDraftOrderDiscount | null
  shippingLine: { title: string | null; price: string | null } | null
  taxLines: Array<{ title: string | null; rate: number | null; price: string | null }>
  lineItems: NormalizedDraftOrderLineItem[]
  // Buyer's PO reference (2026-01+), the draft's OWN value. This is an EVENT/normalized-shape
  // field, so it follows every other field on this interface: camelCase, always present,
  // `null` when there is none (NOT the `po_number`/absent-when-none convention used on TOOL
  // RESULT shapes like `OrderDetail.po_number` in reads.ts -- that is a different object with
  // a different, snake_case, surrounding convention; match the shape you are in, not a global
  // rule). A person typing a PO into a draft order in the Shopify admin (or editing one) must
  // reach the quote through this field via `draft_orders/create` and `draft_orders/update`,
  // since invoicing's draft-order sync learns of the draft ONLY from these events.
  poNumber: string | null
  /** The B2B company buying, or null for a consumer draft. Set by `draft_orders_get` only; the
   *  webhook path leaves it absent (`undefined`), which tells a consumer to re-fetch when it needs
   *  the buyer's company. */
  purchasingCompany?: NormalizedPurchasingCompany | null
}

// ─────────────────────────────────────────────────────────────────────────
//  REST webhook payload → NormalizedDraftOrder
// ─────────────────────────────────────────────────────────────────────────

export interface ShopifyDraftOrderAddressPayload {
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

export interface ShopifyDraftOrderAppliedDiscountPayload {
  title?: string | null
  description?: string | null
  value_type?: string | null
  value?: string | number | null
  amount?: string | number | null
}

export interface ShopifyDraftOrderLineItemPayload {
  id?: number | string | null
  title?: string
  sku?: string | null
  variant_id?: number | string | null
  product_id?: number | string | null
  quantity?: number
  price?: string
  applied_discount?: ShopifyDraftOrderAppliedDiscountPayload | null
  taxable?: boolean
  requires_shipping?: boolean
  custom?: boolean
}

export interface ShopifyDraftOrderWebhookPayload {
  id: number | string
  name?: string | null
  status?: string | null
  order_id?: number | string | null
  // Buyer's PO reference (2026-01+), as it appears on the REST
  // `draft_orders/{create,update}` webhook payload.
  po_number?: string | null
  created_at?: string | null
  updated_at?: string | null
  currency?: string | null
  presentment_currency?: string | null
  total_price?: string | null
  subtotal_price?: string | null
  total_tax?: string | null
  taxes_included?: boolean
  tax_exempt?: boolean
  email?: string | null
  note?: string | null
  tags?: string | null
  customer?: {
    id?: number | string | null
    email?: string | null
    first_name?: string | null
    last_name?: string | null
    default_address?: { company?: string | null } | null
  } | null
  billing_address?: ShopifyDraftOrderAddressPayload | null
  shipping_address?: ShopifyDraftOrderAddressPayload | null
  applied_discount?: ShopifyDraftOrderAppliedDiscountPayload | null
  shipping_line?: { title?: string | null; price?: string | null } | null
  tax_lines?: Array<{ title?: string | null; rate?: number | null; price?: string | null }> | null
  line_items?: ShopifyDraftOrderLineItemPayload[] | null
}

// ─────────────────────────────────────────────────────────────────────────
//  poNumber — shared normalization + order-then-draft fallback
// ─────────────────────────────────────────────────────────────────────────
//
// Cross-app contract with invoicing: the emitted field is `po_number`, a
// nullable string that is ABSENT from the object (not `""`) when there is no
// PO. `toPoNumber` is the single place that turns Shopify's various "no PO"
// shapes (missing key, `null`, `""`, whitespace) into `undefined` so every
// producer below (order webhooks, `orders_get`, `draft_orders_get`,
// `draft_orders_complete`) agrees on what "absent" means.
export function toPoNumber(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve the PO number for a completed order that may have originated from
 * a draft order (quote): the order's OWN `poNumber` wins when present; the
 * originating draft's `poNumber` is the fallback, used only when the order's
 * own field is empty. Correct regardless of whether Shopify's
 * `draftOrderComplete` actually carries `poNumber` through to the resulting
 * order.
 *
 * PRODUCTION FINDING (as of 2026-09-10, live-queried against the dogfood
 * development store (`SHOPIFY_DEV_STORE_DOMAIN`), API 2026-04 -- this is a
 * claim about live data and can go stale): paginated all 844 draft orders in
 * the store. Only 4 had ever carried a `poNumber`, and all 4 had already lost
 * their linked `order` (the completed order behind them had since been
 * deleted), so their resulting order's `poNumber` could not be inspected.
 * Every OTHER completed draft with a still-existing linked order had
 * `poNumber: null` on the draft, so it carried nothing to check either.
 * Net: no surviving production example proves or disproves carry-through.
 * Separately confirmed via GraphQL introspection against the same store that
 * `Order` has NO back-reference field to its originating `DraftOrder` in API
 * 2026-04 (no `draftOrder`, `sourceDraftOrder`, or similar) -- so this
 * fallback, and `draft_orders_get`'s (below), are the only two places in this
 * app that can resolve it at all: they are given the draft explicitly and
 * Shopify nests the resulting order on it, rather than the other way round.
 * If re-checking this claim, re-run the same live paginated query; do not
 * assume the answer without re-querying, since the date above is when it was
 * true, not a standing guarantee.
 */
export function resolveOrderPoNumber(
  orderPoNumber: string | null | undefined,
  draftPoNumber: string | null | undefined,
): string | undefined {
  return toPoNumber(orderPoNumber) ?? toPoNumber(draftPoNumber)
}

function gid(kind: string, id: number | string | null | undefined): string | null {
  if (id === null || id === undefined || id === "") return null
  return `gid://shopify/${kind}/${id}`
}

function toValueType(v: string | null | undefined): "PERCENTAGE" | "FIXED_AMOUNT" | null {
  if (v === "percentage" || v === "PERCENTAGE") return "PERCENTAGE"
  if (v === "fixed_amount" || v === "FIXED_AMOUNT") return "FIXED_AMOUNT"
  return null
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return []
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function normalizeRestAddress(a: ShopifyDraftOrderAddressPayload | null | undefined): NormalizedAddress | null {
  if (!a) return null
  const out: NormalizedAddress = {
    name: a.name ?? null,
    company: a.company ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    zip: a.zip ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    countryCode: a.country_code ? a.country_code.toUpperCase() : null,
    phone: a.phone ?? null,
  }
  const hasContent = Object.values(out).some((v) => v !== null && v !== "")
  return hasContent ? out : null
}

function normalizeRestAppliedDiscount(
  d: ShopifyDraftOrderAppliedDiscountPayload | null | undefined,
): NormalizedDraftOrderDiscount | null {
  if (!d) return null
  return {
    title: d.title ?? null,
    description: d.description ?? null,
    valueType: toValueType(d.value_type),
    value: d.value == null ? null : String(d.value),
    amount: d.amount == null ? null : String(d.amount),
  }
}

/** `quantity*price - discount.amount`, 2-decimal string; falls back to `quantity*price` with no line discount. */
function computeRestDiscountedTotal(
  quantity: number,
  price: string,
  discount: ShopifyDraftOrderAppliedDiscountPayload | null | undefined,
): string {
  const lineTotal = quantity * Number.parseFloat(price || "0")
  const discountAmount = discount?.amount == null ? 0 : Number.parseFloat(String(discount.amount))
  const total = lineTotal - discountAmount
  return (Number.isFinite(total) ? total : lineTotal).toFixed(2)
}

function normalizeRestLineItem(li: ShopifyDraftOrderLineItemPayload): NormalizedDraftOrderLineItem {
  const quantity = li.quantity ?? 1
  const unitPrice = li.price ?? "0.00"
  return {
    id: li.id == null ? null : String(li.id),
    title: li.title ?? "",
    sku: li.sku ?? null,
    variantId: gid("ProductVariant", li.variant_id),
    productId: gid("Product", li.product_id),
    quantity,
    unitPrice,
    discountedTotal: computeRestDiscountedTotal(quantity, unitPrice, li.applied_discount),
    appliedDiscount: li.applied_discount
      ? {
          valueType: toValueType(li.applied_discount.value_type),
          value: li.applied_discount.value == null ? null : String(li.applied_discount.value),
          amount: li.applied_discount.amount == null ? null : String(li.applied_discount.amount),
        }
      : null,
    taxable: li.taxable !== false,
    requiresShipping: li.requires_shipping !== false,
    custom: li.custom === true,
  }
}

/**
 * Normalize a `draft_orders/{create,update,delete}` REST webhook payload into
 * the shared `NormalizedDraftOrder` shape. `shopDomain` comes from the
 * `X-Shopify-Shop-Domain` webhook header (the caller resolves it — this
 * function stays pure). REST ids are numeric; gids are built here so
 * downstream consumers see the same `gid://shopify/...` identity as the
 * GraphQL path.
 *
 * A `draft_orders/delete` delivery carries only `{ id }` — every other field
 * on `ShopifyDraftOrderWebhookPayload` is optional so the same normalizer
 * covers that minimal payload, producing a `NormalizedDraftOrder` with nulls
 * everywhere but `draftOrderId`.
 */
export function normalizeDraftOrderWebhook(
  payload: ShopifyDraftOrderWebhookPayload,
  shopDomain: string | null,
): NormalizedDraftOrder {
  const presentmentCurrency = payload.presentment_currency ?? null
  const currency = presentmentCurrency ?? payload.currency ?? null
  const customer = payload.customer
    ? {
        id: gid("Customer", payload.customer.id),
        email: payload.customer.email ?? null,
        firstName: payload.customer.first_name ?? null,
        lastName: payload.customer.last_name ?? null,
        company: payload.customer.default_address?.company ?? null,
      }
    : null
  return {
    draftOrderId: gid("DraftOrder", payload.id) ?? "",
    name: payload.name ?? null,
    status: payload.status ? payload.status.toLowerCase() : null,
    // The REST webhook payload carries only `order_id` (no name) — the
    // GraphQL `draft_orders_get` read resolves `order { id name }` instead.
    orderId: gid("Order", payload.order_id),
    orderName: null,
    poNumber: toPoNumber(payload.po_number) ?? null,
    shopDomain,
    createdAt: payload.created_at ?? null,
    updatedAt: payload.updated_at ?? null,
    currency,
    currencyIsPresentment: presentmentCurrency != null,
    totalPrice: payload.total_price ?? null,
    subtotalPrice: payload.subtotal_price ?? null,
    totalTax: payload.total_tax ?? null,
    taxesIncluded: payload.taxes_included === true,
    taxExempt: payload.tax_exempt === true,
    email: payload.email ?? null,
    note: payload.note ?? null,
    tags: parseTags(payload.tags),
    customer,
    billingAddress: normalizeRestAddress(payload.billing_address),
    shippingAddress: normalizeRestAddress(payload.shipping_address),
    appliedDiscount: normalizeRestAppliedDiscount(payload.applied_discount),
    shippingLine: payload.shipping_line
      ? { title: payload.shipping_line.title ?? null, price: payload.shipping_line.price ?? null }
      : null,
    taxLines: (payload.tax_lines ?? []).map((t) => ({
      title: t.title ?? null,
      rate: typeof t.rate === "number" ? t.rate : null,
      price: t.price ?? null,
    })),
    lineItems: (payload.line_items ?? []).map(normalizeRestLineItem),
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  GraphQL draftOrder node (draft_orders_get) → NormalizedDraftOrder
// ─────────────────────────────────────────────────────────────────────────

interface MoneyBag {
  presentmentMoney?: { amount?: string | null; currencyCode?: string | null } | null
}

export interface ShopifyDraftOrderGraphQLAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  countryCodeV2?: string | null
  phone?: string | null
}

export interface ShopifyDraftOrderGraphQLLineItemNode {
  id?: string | null
  title?: string | null
  sku?: string | null
  custom?: boolean
  taxable?: boolean
  requiresShipping?: boolean
  quantity?: number
  variant?: { id?: string | null; product?: { id?: string | null } | null } | null
  originalUnitPriceSet?: MoneyBag | null
  priceOverride?: { amount?: string | null; currencyCode?: string | null } | null
  discountedTotalSet?: MoneyBag | null
  appliedDiscount?: {
    valueType?: string | null
    value?: string | number | null
    amountSet?: MoneyBag | null
  } | null
}

export interface ShopifyDraftOrderGraphQLNode {
  id: string
  name?: string | null
  status?: string | null
  tags?: string[] | null
  createdAt?: string | null
  updatedAt?: string | null
  email?: string | null
  note2?: string | null
  taxExempt?: boolean
  taxesIncluded?: boolean
  currencyCode?: string | null
  totalPriceSet?: MoneyBag | null
  subtotalPriceSet?: MoneyBag | null
  totalTaxSet?: MoneyBag | null
  // The draft's OWN PO reference (2026-01+).
  poNumber?: string | null
  // `order.poNumber` is the resulting ORDER's own PO reference, selected
  // alongside `order.id`/`order.name` so a caller holding the draft can
  // resolve the order-then-draft fallback in the same round trip.
  order?: { id?: string | null; name?: string | null; poNumber?: string | null } | null
  appliedDiscount?: {
    title?: string | null
    description?: string | null
    valueType?: string | null
    value?: string | number | null
    amountSet?: MoneyBag | null
  } | null
  shippingLine?: { title?: string | null; originalPriceSet?: MoneyBag | null } | null
  taxLines?: Array<{ title?: string | null; rate?: number | null; priceSet?: MoneyBag | null }> | null
  billingAddress?: ShopifyDraftOrderGraphQLAddress | null
  shippingAddress?: ShopifyDraftOrderGraphQLAddress | null
  customer?: {
    id?: string | null
    email?: string | null
    firstName?: string | null
    lastName?: string | null
    defaultAddress?: { company?: string | null } | null
  } | null
  lineItems?: { edges?: Array<{ node: ShopifyDraftOrderGraphQLLineItemNode }> } | null
  /** PurchasingCompany arm of the union; `{}` when the buyer is a plain Customer. */
  purchasingEntity?: ShopifyPurchasingCompanyGraphQL | null
}

export interface ShopifyCompanyAddressGraphQL {
  recipient?: string | null
  companyName?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  countryCode?: string | null
  phone?: string | null
}

export interface ShopifyPurchasingCompanyGraphQL {
  company?: { name?: string | null } | null
  contact?: { customer?: { email?: string | null } | null } | null
  location?: {
    name?: string | null
    billingAddress?: ShopifyCompanyAddressGraphQL | null
    shippingAddress?: ShopifyCompanyAddressGraphQL | null
    taxSettings?: { taxRegistrationId?: string | null; taxExempt?: boolean | null } | null
  } | null
}

/** The GraphQL selection that fills `ShopifyPurchasingCompanyGraphQL` (draft order or order). */
export const PURCHASING_COMPANY_SELECTION = `purchasingEntity { ... on PurchasingCompany {
        company { name }
        contact { customer { email } }
        location {
          name
          taxSettings { taxRegistrationId taxExempt }
          billingAddress { recipient companyName address1 address2 zip city province countryCode phone }
          shippingAddress { recipient companyName address1 address2 zip city province countryCode phone }
        }
      } }`

function normalizeCompanyAddress(
  a: ShopifyCompanyAddressGraphQL | null | undefined,
): NormalizedAddress | null {
  if (!a) return null
  const out: NormalizedAddress = {
    name: a.recipient ?? null,
    company: a.companyName ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    zip: a.zip ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    countryCode: a.countryCode ? a.countryCode.toUpperCase() : null,
    phone: a.phone ?? null,
  }
  return Object.values(out).some((v) => v !== null && v !== "") ? out : null
}

/** The B2B company behind a draft order or order, or null when the buyer is a plain customer. */
export function normalizePurchasingCompany(
  entity: ShopifyPurchasingCompanyGraphQL | null | undefined,
): NormalizedPurchasingCompany | null {
  if (!entity?.company && !entity?.location) return null
  const blank = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null
  return {
    companyName: blank(entity.company?.name),
    locationName: blank(entity.location?.name),
    taxRegistrationId: blank(entity.location?.taxSettings?.taxRegistrationId),
    taxExempt: entity.location?.taxSettings?.taxExempt === true,
    contactEmail: blank(entity.contact?.customer?.email),
    billingAddress: normalizeCompanyAddress(entity.location?.billingAddress),
    shippingAddress: normalizeCompanyAddress(entity.location?.shippingAddress),
  }
}

function moneyAmount(bag: MoneyBag | null | undefined): string | null {
  return bag?.presentmentMoney?.amount ?? null
}

/** The currency of the SAME money bag the amounts are read from.
 *
 *  Every amount here comes from `presentmentMoney` (what the buyer is quoted),
 *  but the currency used to be taken from the DraftOrder's `currencyCode`,
 *  which is the SHOP's currency. On any draft sold in another currency the two
 *  disagree and the amounts get relabelled rather than converted: draft #D332
 *  quoted 149.00 USD to a customer in Yerevan and invoicing built the quote as
 *  149.00 EUR, ~15% over. Amount and currency must come from one source or
 *  they will drift apart again. `currencyCode` remains the fallback for a
 *  caller whose selection omits it (the webhook path prefers
 *  `presentment_currency` for the same reason). */
function moneyCurrency(bag: MoneyBag | null | undefined): string | null {
  return bag?.presentmentMoney?.currencyCode ?? null
}

function normalizeGraphQLAddress(
  a: ShopifyDraftOrderGraphQLAddress | null | undefined,
): NormalizedAddress | null {
  if (!a) return null
  const out: NormalizedAddress = {
    name: a.name ?? null,
    company: a.company ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    zip: a.zip ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    countryCode: a.countryCodeV2 ? a.countryCodeV2.toUpperCase() : null,
    phone: a.phone ?? null,
  }
  const hasContent = Object.values(out).some((v) => v !== null && v !== "")
  return hasContent ? out : null
}

function normalizeGraphQLLineItem(node: ShopifyDraftOrderGraphQLLineItemNode): NormalizedDraftOrderLineItem {
  return {
    id: node.id ?? null,
    title: node.title ?? "",
    sku: node.sku ?? null,
    variantId: node.variant?.id ?? null,
    productId: node.variant?.product?.id ?? null,
    quantity: node.quantity ?? 1,
    // A price override IS the line's unit price (a B2B catalog price arrives the same way, as
    // the original unit price): never a discount off the variant's list price.
    unitPrice: node.priceOverride?.amount ?? moneyAmount(node.originalUnitPriceSet) ?? "0.00",
    priceOverride: node.priceOverride?.amount ?? null,
    discountedTotal: moneyAmount(node.discountedTotalSet),
    appliedDiscount: node.appliedDiscount
      ? {
          valueType: toValueType(node.appliedDiscount.valueType),
          value: node.appliedDiscount.value == null ? null : String(node.appliedDiscount.value),
          amount: moneyAmount(node.appliedDiscount.amountSet),
        }
      : null,
    taxable: node.taxable !== false,
    requiresShipping: node.requiresShipping !== false,
    custom: node.custom === true,
  }
}

/**
 * Normalize the GraphQL `draftOrder(id:)` node returned by
 * `DRAFT_ORDER_GET_QUERY` into the shared `NormalizedDraftOrder` shape.
 * `shopDomain` is not on the GraphQL node — the caller resolves it from
 * install metadata and passes it through, or `null` when unavailable.
 * GraphQL status is upper-case (`OPEN`/`INVOICE_SENT`/`COMPLETED`); lower-cased
 * here to match the webhook path.
 */
export function normalizeDraftOrderNode(
  node: ShopifyDraftOrderGraphQLNode,
  shopDomain: string | null,
): NormalizedDraftOrder {
  const customer = node.customer
    ? {
        id: node.customer.id ?? null,
        email: node.customer.email ?? null,
        firstName: node.customer.firstName ?? null,
        lastName: node.customer.lastName ?? null,
        company: node.customer.defaultAddress?.company ?? null,
      }
    : null
  const lineItemNodes = node.lineItems?.edges?.map((e) => e.node) ?? []
  return {
    draftOrderId: node.id,
    name: node.name ?? null,
    status: node.status ? node.status.toLowerCase() : null,
    orderId: node.order?.id ?? null,
    orderName: node.order?.name ?? null,
    poNumber: toPoNumber(node.poNumber) ?? null,
    shopDomain,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    currency: moneyCurrency(node.totalPriceSet) ?? node.currencyCode ?? null,
    currencyIsPresentment: moneyCurrency(node.totalPriceSet) != null,
    totalPrice: moneyAmount(node.totalPriceSet),
    subtotalPrice: moneyAmount(node.subtotalPriceSet),
    totalTax: moneyAmount(node.totalTaxSet),
    taxesIncluded: node.taxesIncluded === true,
    taxExempt: node.taxExempt === true,
    email: node.email ?? null,
    note: node.note2 ?? null,
    tags: node.tags ?? [],
    customer,
    billingAddress: normalizeGraphQLAddress(node.billingAddress),
    shippingAddress: normalizeGraphQLAddress(node.shippingAddress),
    appliedDiscount: node.appliedDiscount
      ? {
          title: node.appliedDiscount.title ?? null,
          description: node.appliedDiscount.description ?? null,
          valueType: toValueType(node.appliedDiscount.valueType),
          value: node.appliedDiscount.value == null ? null : String(node.appliedDiscount.value),
          amount: moneyAmount(node.appliedDiscount.amountSet),
        }
      : null,
    shippingLine: node.shippingLine
      ? { title: node.shippingLine.title ?? null, price: moneyAmount(node.shippingLine.originalPriceSet) }
      : null,
    taxLines: (node.taxLines ?? []).map((t) => ({
      title: t.title ?? null,
      rate: typeof t.rate === "number" ? t.rate : null,
      price: moneyAmount(t.priceSet),
    })),
    lineItems: lineItemNodes.map(normalizeGraphQLLineItem),
    purchasingCompany: normalizePurchasingCompany(node.purchasingEntity),
  }
}
