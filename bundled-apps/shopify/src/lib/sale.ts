// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shop's orders as `revenue-stream@1` sales. `saleFromOrder` maps the order the
// `orders/create` webhook delivered (normalized by webhooks.ts `normalizeOrder`, kept as a sale
// snapshot) to a `Sale`: net lines with the tax Shopify charged on each, the buyer's billing and
// delivery addresses as Shopify holds them, the order's name and PO number.
//
// The money arithmetic here (major decimal to minor units, de-taxing a gross price) mirrors the
// invoicing app's own (`invoicing/src/money.ts`): a bundled app cannot import another app's
// code, and the invoice must reproduce exactly what the buyer paid. A cross-app test pins the two
// (invoicing `src/sales/shopify-sale.golden.test.ts`).

import type { Sale, SaleAddress, SaleLine } from "@liaison/app-sdk/contracts"

/** One tax line of a line item or shipping line, as `normalizeOrder` emits it. */
export interface OrderTaxLine {
  title?: string | null
  rate?: number | null
  amount?: string
  currencyCode?: string
  channelLiable?: boolean | null
}

export interface OrderAddress {
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

interface Money {
  amount?: string
  currencyCode?: string
}

/** The normalized order (`normalizeOrder` in webhooks.ts), the `order:created` event's data. */
export interface NormalizedOrder {
  orderId?: string
  name?: string | null
  shopDomain?: string | null
  createdAt?: string
  financialStatus?: string | null
  poNumber?: string | null
  buyerTaxId?: string | null
  totalPrice?: Money | null
  taxesIncluded?: boolean
  billingAddress?: OrderAddress | null
  shippingAddress?: OrderAddress | null
  customer?: {
    id?: string | null
    email?: string | null
    first_name?: string | null
    last_name?: string | null
    country?: string | null
  } | null
  lineItems?: Array<{
    id?: string | null
    title?: string | null
    quantity?: number | string
    priceSet?: Money | null
    requiresShipping?: boolean
    taxLines?: OrderTaxLine[]
    discountAllocations?: Money[]
    variant?: { id?: string | null } | null
  }>
  shippingLines?: Array<{
    title?: string | null
    priceSet?: Money | null
    taxLines?: OrderTaxLine[]
  }>
  market?: { country?: string } | null
}

// ── money (mirror of invoicing/src/money.ts) ─────────────────────────────────────────────────

const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "HUF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"])
const FOUR_DECIMAL = new Set(["CLF", "UYW"])

function currencyExponent(currency: string): number {
  const c = currency.toUpperCase()
  if (ZERO_DECIMAL.has(c)) return 0
  if (THREE_DECIMAL.has(c)) return 3
  if (FOUR_DECIMAL.has(c)) return 4
  return 2
}

/** Major decimal string to integer minor units, digits beyond the exponent rounded half even. */
export function majorDecimalToMinor(
  amount: string | number | undefined | null,
  currency: string,
): bigint {
  const exp = currencyExponent(currency)
  const raw = String(amount ?? "0").trim()
  const negative = raw.startsWith("-")
  const [intRaw = "0", fracRaw = ""] = raw.replace(/^[-+]/, "").split(".")
  const intPart = intRaw.replace(/[^0-9]/g, "") || "0"
  const fracDigits = fracRaw.replace(/[^0-9]/g, "")
  const kept = fracDigits.slice(0, exp).padEnd(exp, "0")
  const rest = fracDigits.slice(exp)
  let value = BigInt(`${intPart}${kept}`)
  if (rest.length > 0) {
    const half = `5${"0".repeat(rest.length - 1)}`
    const cmp = rest === half ? 0 : rest > half ? 1 : -1
    if (cmp > 0 || (cmp === 0 && value % 2n === 1n)) value += 1n
  }
  return negative ? -value : value
}

function divRoundHalfEven(numerator: bigint, divisor: bigint): bigint {
  const negative = numerator < 0n !== divisor < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = divisor < 0n ? -divisor : divisor
  const quotient = n / d
  const doubled = (n - quotient * d) * 2n
  let rounded: bigint
  if (doubled < d) rounded = quotient
  else if (doubled > d) rounded = quotient + 1n
  else rounded = quotient % 2n === 0n ? quotient : quotient + 1n
  return negative ? -rounded : rounded
}

/** net = gross / (1 + rate), half even. */
function netOfTax(gross: bigint, rateBp: number): bigint {
  if (rateBp === 0) return gross
  return divRoundHalfEven(gross * 10000n, 10000n + BigInt(rateBp))
}

const minor = (amount: string | undefined | null, currency: string): string =>
  majorDecimalToMinor(amount, currency).toString()

// ── tax facts and net lines (mirror of invoicing's former order adapter) ─────────────────────

/** Rates are null when the line carries no usable tax facts; an EMPTY array means "charged nothing". */
function lineTaxFacts(taxLines: OrderTaxLine[] | undefined, currency: string) {
  if (!taxLines) {
    return {
      chargedRateBp: null as number | null,
      sellerRateBp: null as number | null,
      sellerAmountMinor: null as string | null,
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
    const amount = hasAmount ? majorDecimalToMinor(t.amount, currency) : null
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

/** Net unit price and net discount of a line whose Shopify price may include tax. */
function netLineMoney(p: {
  unitAmount: string | undefined | null
  quantity: number
  discountTotals: Array<string | undefined>
  rateBp: number | null
  taxesIncluded: boolean
  currency: string
  /** Every tax Shopify reported on the line (seller and marketplace), when all amounts are known. */
  includedTaxMinor?: bigint | null
}): { unit_price_minor: string; discount_minor: string } {
  const qty = BigInt(Math.max(1, Math.round(p.quantity)))
  const unitGross = majorDecimalToMinor(p.unitAmount, p.currency)
  let discountGross = 0n
  for (const d of p.discountTotals) if (d) discountGross += majorDecimalToMinor(d, p.currency)
  let lineGrossAfter = unitGross * qty - discountGross
  if (lineGrossAfter < 0n) lineGrossAfter = 0n
  const deTax = (v: bigint): bigint =>
    p.taxesIncluded && p.rateBp != null ? netOfTax(v, p.rateBp) : v
  let unitNet = deTax(unitGross)
  // A tax included line whose tax Shopify reported: its net is the gross less exactly that tax, so
  // the invoice totals what was paid to the cent (re-deriving it from the rate can miss by one).
  const knownTax =
    p.taxesIncluded && p.includedTaxMinor != null && p.includedTaxMinor <= lineGrossAfter
      ? p.includedTaxMinor
      : null
  const netAfter = knownTax != null ? lineGrossAfter - knownTax : deTax(lineGrossAfter)
  if (knownTax != null) {
    if (discountGross === 0n && netAfter % qty === 0n) unitNet = netAfter / qty
    else if (unitNet * qty < netAfter) unitNet = (netAfter + qty - 1n) / qty
  }
  let discountNet = unitNet * qty - netAfter
  if (discountNet < 0n) discountNet = 0n
  return { unit_price_minor: unitNet.toString(), discount_minor: discountNet.toString() }
}

/** Every tax Shopify reported on a line, or null when an amount is missing. */
function includedTax(t: ReturnType<typeof lineTaxFacts>): bigint | null {
  if (t.sellerAmountMinor == null) return null
  return BigInt(t.sellerAmountMinor) + BigInt(t.marketplaceAmountMinor)
}

function lineTax(t: ReturnType<typeof lineTaxFacts>): SaleLine["tax"] {
  if (t.sellerRateBp == null) return null
  return {
    rate_bp: t.sellerRateBp,
    ...(t.sellerAmountMinor != null
      ? { amount_minor: t.sellerAmountMinor, line_count: t.sellerTaxLineCount }
      : {}),
    ...(t.marketplaceAmountMinor !== "0" ? { marketplace_minor: t.marketplaceAmountMinor } : {}),
    reported_by_source: true,
  }
}

/** The variant's Admin GraphQL gid (the customs overlay key), from the webhook's numeric id. */
function variantGid(id: string): string {
  if (id === "" || id.startsWith("gid://")) return id
  if (/^\d+$/.test(id)) return `gid://shopify/ProductVariant/${id}`
  return id
}

function address(a: OrderAddress | null | undefined): SaleAddress | null {
  if (!a) return null
  return {
    name: a.name ?? null,
    company: a.company ?? null,
    line1: a.address1 ?? null,
    line2: a.address2 ?? null,
    postcode: a.zip ?? null,
    city: a.city ?? null,
    region: a.province ?? null,
    country: a.country_code ?? null,
  }
}

const trimmed = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null

/** The paid status word of the contract for Shopify's order financial status. */
function paidStatus(fin: string | null | undefined): Sale["paid"]["status"] {
  const f = String(fin ?? "")
    .trim()
    .toLowerCase()
  if (f === "paid") return "paid"
  if (f === "refunded") return "refunded"
  if (f === "partially_refunded") return "partially_refunded"
  if (f === "voided") return "cancelled"
  return "pending"
}

/**
 * The sale of one order. `soldAt` is when the order's webhook arrived (Shopify's order event
 * carries no payment instant): it is never printed for a Shopify order, whose invoice dates
 * stay what they are today.
 */
export function saleFromOrder(order: NormalizedOrder, soldAt: string): Sale {
  const currency = order.totalPrice?.currencyCode ?? "EUR"
  const taxesIncluded = order.taxesIncluded === true
  const name = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ")
  const lines: SaleLine[] = (order.lineItems ?? []).map((li) => {
    const tax = lineTaxFacts(li.taxLines, currency)
    const money = netLineMoney({
      unitAmount: li.priceSet?.amount,
      quantity: Number(li.quantity ?? 1),
      discountTotals: (li.discountAllocations ?? []).map((d) => d?.amount),
      rateBp: tax.chargedRateBp,
      taxesIncluded,
      currency,
      includedTaxMinor: includedTax(tax),
    })
    return {
      description: li.title ?? "",
      quantity: String(li.quantity ?? 1),
      unit_price_minor: money.unit_price_minor,
      discount_minor: money.discount_minor,
      // Shopify flags digital goods (license keys, downloads) as not requiring shipping.
      kind: li.requiresShipping === false ? "software" : "goods",
      variant_ref: variantGid(String(li.variant?.id ?? li.id ?? "")),
      tax: lineTax(tax),
    }
  })
  // Carriage is part of what the buyer paid: its own line (free shipping is no line).
  for (const s of order.shippingLines ?? []) {
    if (majorDecimalToMinor(s.priceSet?.amount, currency) <= 0n) continue
    const tax = lineTaxFacts(s.taxLines, currency)
    const money = netLineMoney({
      unitAmount: s.priceSet?.amount,
      quantity: 1,
      discountTotals: [],
      rateBp: tax.chargedRateBp,
      taxesIncluded,
      currency,
      includedTaxMinor: includedTax(tax),
    })
    lines.push({
      description: s.title ? `Shipping (${s.title})` : "Shipping",
      quantity: "1",
      unit_price_minor: money.unit_price_minor,
      discount_minor: money.discount_minor,
      kind: "shipping",
      variant_ref: "",
      tax: lineTax(tax),
    })
  }
  const customer = order.customer ?? null
  return {
    external_id: String(order.orderId ?? ""),
    refs: {
      order_name: trimmed(order.name),
      po_number: trimmed(order.poNumber),
      account: String(order.shopDomain ?? ""),
      ...(order.createdAt !== undefined ? { placed_at: order.createdAt } : {}),
      ...(order.market ? { market_country: order.market.country ?? null } : {}),
    },
    sold_at: soldAt,
    paid: {
      status: paidStatus(order.financialStatus),
      source_status: order.financialStatus ?? null,
    },
    currency,
    // Lines are net: Shopify's gross prices were de-taxed above.
    prices_include_tax: false,
    buyer: {
      email: customer?.email ?? null,
      name: name === "" ? null : name,
      vat_id: trimmed(order.buyerTaxId),
      // Present (an id or null) exactly when the order has a customer; absent for no customer.
      ...(customer ? { customer_id: customer.id ?? null } : {}),
      billing: address(order.billingAddress),
      delivery: address(order.shippingAddress),
      ...(customer?.id ? { ids: { shopify_customer_id: String(customer.id) } } : {}),
      // What the shop resolved as the destination (ship to, else the customer's address, else billing).
      ...(customer ? { tax_evidence: { destination_country: customer.country ?? null } } : {}),
    },
    lines,
    totals: { total_minor: minor(order.totalPrice?.amount, currency) },
  }
}
