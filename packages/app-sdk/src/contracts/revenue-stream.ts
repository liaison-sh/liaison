// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `revenue-stream@1`: the provider contract a sales app (a shop, a payment provider, an org's own
// app) implements so the invoicing app can issue one legal invoice per sale without knowing where
// the sale was made. A provider declares
//
//   "implements": [{ "contract": "revenue-stream", "version": 1,
//     "tools": { "sale_get": "<tool>", "sales_list": "<tool>" } }],
//   "events": { "emits": ["sale:paid", "sale:refunded", "sale:cancelled"] }
//
// and the consumer subscribes once for every provider of the org:
//
//   "events": { "subscribes": { "contract:revenue-stream@1/sale:paid": "<handler>" } }
//
// Events carry only `{ external_id, occurred_at }` (`SaleEvent`): the consumer always reads the
// sale with `sale_get` before acting, so a replayed or late event never acts on stale data. The
// kernel delivers a contract event from every app implementing the contract in the org, with the
// source app's name in the envelope (`event.app`).
//
// Several providers serve one consumer at once (a shop and a payment provider), so the contract is
// `multiProvider`: the consumer names the provider on each call (`ctx.contracts.call(..., {provider})`)
// and the kernel checks that the consumer's own binding table (`contract_calls[].bindingSetting`)
// holds a row for that provider. Its ops are reads only: a multi-provider contract has no outbound op.

import type { ContractSpec } from "./einvoicing-pa"

export const REVENUE_STREAM = "revenue-stream@1" as const

export const revenueStreamV1: ContractSpec = {
  contract: "revenue-stream",
  version: 1,
  multiProvider: true,
  ops: {
    /** `{ external_id }` -> `{ found: false }` or `{ found: true, sale: Sale }`, as the source answers now. */
    sale_get: { required: true, params: ["external_id"] },
    /**
     * `{ paid_from, paid_to, cursor }` (ISO instants, cursor opaque or null) ->
     * `{ sales: Sale[], next: string | null }`: the sales paid in `[paid_from, paid_to)`, for a
     * catch-up and the safety sweep. Order is the provider's; consumers sort by `sold_at`.
     */
    sales_list: { required: true, params: ["paid_from", "paid_to", "cursor"] },
  },
  events: {
    "sale:paid": { required: true },
    "sale:refunded": { required: false },
    "sale:cancelled": { required: false },
  },
}

/** The payload of every revenue-stream event. */
export interface SaleEvent {
  external_id: string
  /** When it happened at the source (ISO instant). */
  occurred_at: string
}

/**
 * A postal address as the source holds it. Values are passed as given (the consumer trims and
 * formats them), so an address read back reproduces exactly what the source said.
 */
export interface SaleAddress {
  /** Addressee (a consignee for a delivery). */
  name?: string | null
  company?: string | null
  line1?: string | null
  line2?: string | null
  postcode?: string | null
  city?: string | null
  /** Province, state or region. */
  region?: string | null
  /** ISO 3166-1 alpha-2. */
  country?: string | null
}

export interface SaleBuyer {
  email: string | null
  /** The person's name (first and last), null when unknown. */
  name: string | null
  kind?: "individual" | "company" | null
  /** A company buyer's legal name, when the source knows it apart from `name`. */
  legal_name?: string | null
  /** The VAT or tax registration number the buyer gave. */
  vat_id?: string | null
  /** `reverse`: the source applied the reverse charge to a business buyer. */
  tax_exempt?: "none" | "exempt" | "reverse" | null
  /** The source's own customer id (null for a guest checkout). */
  customer_id?: string | null
  billing?: SaleAddress | null
  delivery?: SaleAddress | null
  /** Ids the buyer is known by elsewhere, for joins: `shopify_customer_id`, `hub_user_id`, `stripe_customer_id`, ... */
  ids?: Record<string, string>
  /**
   * Location evidence (digital services to consumers need two pieces): `billing_country`,
   * `ip_country`, `card_country`; `destination_country` is where the source resolved the supply
   * goes (the delivery, else the customer's default address, else billing).
   */
  tax_evidence?: {
    billing_country?: string | null
    ip_country?: string | null
    card_country?: string | null
    destination_country?: string | null
  } | null
}

export type SaleLineKind = "goods" | "software" | "service" | "shipping"

/** The tax the source charged on one line. */
export interface SaleLineTax {
  /** Rate the source charged, in basis points (1900 = 19 %). */
  rate_bp?: number
  /** Tax amount for the whole line, minor units (the seller's share: marketplace tax excluded). */
  amount_minor?: string
  /** How many tax lines the source summed into `amount_minor` (each one rounds on its own). */
  line_count?: number
  /** Tax a marketplace facilitator collects and remits itself: never on the seller's invoice. */
  marketplace_minor?: string
  /** The taxing jurisdiction (ISO country, or country-region) when the source states it. */
  jurisdiction?: string | null
  /** True when the rate and amount are what the source itself computed and charged. */
  reported_by_source: boolean
}

export interface SaleLine {
  description: string
  /** Decimal string ("1", "2.5"). */
  quantity: string
  /** Unit price in minor units, net of tax unless the sale says `prices_include_tax`. */
  unit_price_minor: string
  /** Discount on the whole line, minor units, same basis as the unit price. */
  discount_minor?: string
  kind: SaleLineKind
  sku?: string | null
  /** The source's product or variant reference (a customs overlay key for goods). */
  variant_ref?: string | null
  tax?: SaleLineTax | null
  hs_code?: string | null
}

export interface SaleRefund {
  refund_id: string
  amount_minor: string
  /** ISO instant. */
  at: string
  lines?: Array<{ description: string; amount_minor: string }>
}

export type SalePaidStatus = "paid" | "pending" | "refunded" | "partially_refunded" | "cancelled"

export interface Sale {
  /** Unique within the provider (a shop's order id, a payment intent id). */
  external_id: string
  refs?: {
    charge_id?: string | null
    checkout_session_id?: string | null
    stripe_invoice_id?: string | null
    /** The human order reference the buyer quotes ("#1149"). */
    order_name?: string | null
    po_number?: string | null
    /** The account of the provider the sale was made on (a shop domain, a Stripe account). */
    account?: string | null
    /** When the order was placed (ISO instant), when the source states it apart from `sold_at`. */
    placed_at?: string | null
    /** The market (sales channel country) the source sold it in. */
    market_country?: string | null
  }
  /** The instant of payment: the sale date printed on the invoice (ISO instant). */
  sold_at: string
  paid: {
    status: SalePaidStatus
    payment_ref?: string | null
    method?: string | null
    /** The source's own payment status word, when it has one ("paid", "authorized", ...). */
    source_status?: string | null
  }
  /** ISO 4217. */
  currency: string
  /** Unit prices include tax (gross). Absent or false: net. */
  prices_include_tax?: boolean
  buyer: SaleBuyer
  lines: SaleLine[]
  /** What the buyer paid. `subtotal_minor` and `tax_minor` are checked against the lines when given. */
  totals: { total_minor: string; subtotal_minor?: string; tax_minor?: string }
  refunds?: SaleRefund[]
  /** Tax a marketplace facilitator remits itself for the whole sale, never on our document. */
  marketplace_tax_minor?: string | null
}

export interface SalesListResult {
  sales: Sale[]
  next: string | null
}

const MINOR_RE = /^-?\d+$/
const QTY_RE = /^\d+(\.\d+)?$/
const KINDS: ReadonlySet<string> = new Set(["goods", "software", "service", "shipping"])
const PAID: ReadonlySet<string> = new Set([
  "paid",
  "pending",
  "refunded",
  "partially_refunded",
  "cancelled",
])

function isIsoInstant(v: unknown): boolean {
  return typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v))
}

/**
 * The problems of a value claiming to be a `Sale` (empty when it is one). A consumer refuses a
 * sale with problems instead of issuing from it.
 */
export function saleProblems(v: unknown): string[] {
  const out: string[] = []
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["sale: not an object"]
  const s = v as Record<string, unknown>
  if (typeof s.external_id !== "string" || s.external_id.trim() === "")
    out.push("external_id: required")
  if (!isIsoInstant(s.sold_at)) out.push("sold_at: an ISO instant is required")
  const paid = s.paid as Record<string, unknown> | undefined
  if (!paid || typeof paid !== "object" || !PAID.has(String(paid.status)))
    out.push("paid.status: one of paid, pending, refunded, partially_refunded, cancelled")
  if (typeof s.currency !== "string" || !/^[A-Z]{3}$/.test(s.currency))
    out.push("currency: an ISO 4217 code is required")
  const buyer = s.buyer as Record<string, unknown> | undefined
  if (!buyer || typeof buyer !== "object") out.push("buyer: required")
  const totals = s.totals as Record<string, unknown> | undefined
  if (!totals || typeof totals !== "object" || !MINOR_RE.test(String(totals.total_minor)))
    out.push("totals.total_minor: an integer string is required")
  else {
    for (const k of ["subtotal_minor", "tax_minor"]) {
      if (totals[k] != null && !MINOR_RE.test(String(totals[k])))
        out.push(`totals.${k}: an integer string`)
    }
  }
  if (!Array.isArray(s.lines)) out.push("lines: an array is required")
  else {
    s.lines.forEach((l: unknown, i: number) => {
      const line = l as Record<string, unknown>
      if (!line || typeof line !== "object") {
        out.push(`lines[${i}]: not an object`)
        return
      }
      if (typeof line.description !== "string") out.push(`lines[${i}].description: required`)
      if (!QTY_RE.test(String(line.quantity))) out.push(`lines[${i}].quantity: a decimal string`)
      if (!MINOR_RE.test(String(line.unit_price_minor)))
        out.push(`lines[${i}].unit_price_minor: an integer string`)
      if (line.discount_minor != null && !MINOR_RE.test(String(line.discount_minor)))
        out.push(`lines[${i}].discount_minor: an integer string`)
      if (!KINDS.has(String(line.kind)))
        out.push(`lines[${i}].kind: one of goods, software, service, shipping`)
      const tax = line.tax as Record<string, unknown> | null | undefined
      if (tax != null) {
        if (typeof tax !== "object") out.push(`lines[${i}].tax: an object`)
        else {
          if (tax.rate_bp != null && !Number.isInteger(tax.rate_bp))
            out.push(`lines[${i}].tax.rate_bp: an integer`)
          if (tax.amount_minor != null && !MINOR_RE.test(String(tax.amount_minor)))
            out.push(`lines[${i}].tax.amount_minor: an integer string`)
        }
      }
    })
  }
  if (s.refunds != null) {
    if (!Array.isArray(s.refunds)) out.push("refunds: an array")
    else
      s.refunds.forEach((r: unknown, i: number) => {
        const ref = r as Record<string, unknown>
        if (typeof ref?.refund_id !== "string" || ref.refund_id === "")
          out.push(`refunds[${i}].refund_id: required`)
        if (!MINOR_RE.test(String(ref?.amount_minor)))
          out.push(`refunds[${i}].amount_minor: an integer string`)
        if (!isIsoInstant(ref?.at)) out.push(`refunds[${i}].at: an ISO instant`)
      })
  }
  return out
}

/** `"contract:revenue-stream@1/sale:paid"` -> `{ contract: "revenue-stream@1", event: "sale:paid" }`. */
export function parseContractSubscription(key: string): { contract: string; event: string } | null {
  const m = /^contract:([a-z][a-z0-9-]*@\d+)\/([a-z_]+:[a-z_]+)$/.exec(key)
  return m ? { contract: m[1]!, event: m[2]! } : null
}

/** The bus source a contract subscription listens on (`contract:<name>@<version>`). */
export function contractEventSource(contract: string): string {
  return `contract:${contract}`
}
