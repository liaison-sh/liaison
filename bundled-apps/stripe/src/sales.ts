// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One-off payments taken through Stripe Checkout as `revenue-stream@1` sales. A sale is a
// PaymentIntent that succeeded with no Stripe invoice (subscriptions and other invoiced charges
// stay under the card stream, never here), read from its Checkout Session:
//
//   GET /v1/checkout/sessions?payment_intent=<pi>&expand[]=data.line_items
//       &expand[]=data.payment_intent.latest_charge
//
// The session holds what the invoice needs and the bare charge does not: the buyer's details as
// they typed them at checkout (`customer_details`: email, name, business name, address, tax ids,
// `tax_exempt`), each line with the tax Stripe Tax computed on it and its rate, the totals, and the
// session's metadata (`buyerUserId` is the buyer's account id at the seller, `buyer.ids.hub_user_id`).
// A payment with no Checkout Session is not a sale here (`found: false`): it keeps the unmatched
// payment path a person decides.
//
// Needs, on the restricted key: Checkout Sessions Read and PaymentIntents Read (403 otherwise,
// reported as `permission_missing`).

import type { Sale, SaleLine } from "@liaison/app-sdk/contracts"
import { type StripeHttpCtx, stripeFetch } from "./http"
import { listRefunds } from "./money-events"

type Obj = Record<string, unknown>

const PI = /^pi_[A-Za-z0-9_]+$/
const PAGE = 100

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" ? str((v as Obj).id) : null
const isoOfUnix = (v: unknown): string | null =>
  typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null

/** Stripe's tax id types that are VAT numbers of a business buyer. */
const VAT_TYPES = new Set(["eu_vat", "gb_vat", "ch_vat", "no_vat", "eu_oss_vat"])

function rateBpOf(taxes: unknown): { rate_bp: number; jurisdiction: string | null } | null {
  if (!Array.isArray(taxes) || taxes.length === 0) return null
  let bp = 0
  let jurisdiction: string | null = null
  for (const t of taxes as Obj[]) {
    const rate = (t.rate ?? {}) as Obj
    bp += Math.round(num(rate.percentage) * 100)
    jurisdiction ??= str(rate.country) ?? str(rate.jurisdiction)
  }
  return { rate_bp: bp, jurisdiction }
}

function lineOf(item: Obj, kind: SaleLine["kind"]): SaleLine {
  const q = Math.max(1, Math.round(num(item.quantity) || 1))
  const subtotal = BigInt(Math.round(num(item.amount_subtotal)))
  const total = BigInt(Math.round(num(item.amount_total)))
  const tax = BigInt(Math.round(num(item.amount_tax)))
  const discount = BigInt(Math.round(num(item.amount_discount)))
  const taxes = item.taxes as Obj[] | undefined
  const inclusive =
    Array.isArray(taxes) && taxes.some((t) => ((t.rate ?? {}) as Obj).inclusive === true)
  const description = str(item.description) ?? "Item"
  // Net lines: an exclusive price keeps its discount explicit; an inclusive one is net of the tax
  // Stripe computed (total after discount, less its tax), its discount folded into the price.
  let net = inclusive ? total - tax : subtotal
  const disc = inclusive ? 0n : discount
  let quantity = q
  if (net % BigInt(q) !== 0n) quantity = 1
  const unit = net / BigInt(quantity)
  net = unit * BigInt(quantity)
  const rate = rateBpOf(taxes)
  return {
    description: quantity === 1 && q > 1 ? `${q} x ${description}` : description,
    quantity: String(quantity),
    unit_price_minor: unit.toString(),
    discount_minor: disc.toString(),
    kind,
    sku: str(((item.price ?? {}) as Obj).id),
    tax: rate
      ? {
          rate_bp: rate.rate_bp,
          amount_minor: tax.toString(),
          line_count: Array.isArray(taxes) ? taxes.length : 1,
          jurisdiction: rate.jurisdiction,
          reported_by_source: true,
        }
      : {
          // Stripe Tax computed nothing on the line (reverse charge, exempt, outside its reach).
          rate_bp: 0,
          amount_minor: tax.toString(),
          line_count: 1,
          jurisdiction: null,
          reported_by_source: true,
        },
  }
}

/** The sale of one completed Checkout Session (`line_items` and `payment_intent.latest_charge` expanded). */
export function saleFromSession(session: Obj, refunds: Obj[]): Sale | null {
  const pi = (session.payment_intent ?? null) as Obj | string | null
  const piId = idOf(pi)
  if (!piId || session.mode !== "payment" || idOf(session.invoice)) return null
  const intent = typeof pi === "object" && pi ? pi : {}
  const charge = (intent.latest_charge ?? null) as Obj | null
  const chargeId = idOf(intent.latest_charge)
  const details = (session.customer_details ?? {}) as Obj
  const addr = (details.address ?? null) as Obj | null
  const taxIds = (Array.isArray(details.tax_ids) ? details.tax_ids : []) as Obj[]
  const vat = taxIds.find((t) => VAT_TYPES.has(String(t.type))) ?? null
  const shipping = (session.shipping_details ?? session.collected_information ?? null) as Obj | null
  const shipAddr = (shipping?.address ?? null) as Obj | null
  const kind: SaleLine["kind"] = shipAddr ? "goods" : "service"
  const items = (((session.line_items ?? {}) as Obj).data ?? []) as Obj[]
  const lines = items.map((it) => lineOf(it, kind))
  const shippingCost = (session.shipping_cost ?? null) as Obj | null
  if (shippingCost && num(shippingCost.amount_total) > 0) {
    const t = rateBpOf(shippingCost.taxes)
    const sTax = BigInt(Math.round(num(shippingCost.amount_tax)))
    lines.push({
      description: "Shipping",
      quantity: "1",
      unit_price_minor: (BigInt(Math.round(num(shippingCost.amount_total))) - sTax).toString(),
      discount_minor: "0",
      kind: "shipping",
      tax: {
        rate_bp: t?.rate_bp ?? 0,
        amount_minor: sTax.toString(),
        line_count: 1,
        jurisdiction: t?.jurisdiction ?? null,
        reported_by_source: true,
      },
    })
  }
  const amount = Math.round(num(session.amount_total))
  const succeeded = refunds.filter((r) => r.status === "succeeded")
  const refunded = succeeded.reduce((s, r) => s + Math.round(num(r.amount)), 0)
  const status: Sale["paid"]["status"] =
    refunded <= 0 ? "paid" : refunded >= amount ? "refunded" : "partially_refunded"
  const metadata = (session.metadata ?? {}) as Obj
  const customerId = idOf(session.customer)
  const businessName = str(details.business_name)
  const ids: Record<string, string> = {}
  const hubUser = str(metadata.buyerUserId)
  if (hubUser) ids.hub_user_id = hubUser
  if (customerId) ids.stripe_customer_id = customerId
  const card = ((charge?.payment_method_details ?? {}) as Obj).card as Obj | undefined
  const soldAt =
    isoOfUnix(charge?.created) ?? isoOfUnix(intent.created) ?? isoOfUnix(session.created)
  const subtotal = lines.reduce(
    (s, l) => s + BigInt(l.unit_price_minor) * BigInt(l.quantity) - BigInt(l.discount_minor ?? "0"),
    0n,
  )
  const totalTax = Math.round(num(((session.total_details ?? {}) as Obj).amount_tax))
  return {
    external_id: piId,
    refs: {
      charge_id: chargeId,
      checkout_session_id: str(session.id),
      order_name: str(metadata.orderRef) ?? str(metadata.order_ref),
      po_number: null,
      account: null,
      placed_at: isoOfUnix(session.created),
    },
    sold_at: soldAt ?? new Date(0).toISOString(),
    paid: { status, payment_ref: chargeId, method: str(card?.brand) ? "card" : null },
    currency: String(session.currency ?? "eur").toUpperCase(),
    prices_include_tax: false,
    buyer: {
      email: str(details.email),
      name: str(details.name),
      kind: vat || businessName ? "company" : "individual",
      legal_name: businessName,
      vat_id: str(vat?.value),
      tax_exempt:
        details.tax_exempt === "reverse" || details.tax_exempt === "exempt"
          ? details.tax_exempt
          : "none",
      ...(customerId ? { customer_id: customerId } : {}),
      billing: addr
        ? {
            name: str(details.name),
            company: businessName,
            line1: str(addr.line1),
            line2: str(addr.line2),
            postcode: str(addr.postal_code),
            city: str(addr.city),
            region: str(addr.state),
            country: str(addr.country),
          }
        : null,
      delivery: shipAddr
        ? {
            name: str(shipping?.name),
            line1: str(shipAddr.line1),
            line2: str(shipAddr.line2),
            postcode: str(shipAddr.postal_code),
            city: str(shipAddr.city),
            region: str(shipAddr.state),
            country: str(shipAddr.country),
          }
        : null,
      ids,
      tax_evidence: {
        billing_country: str(addr?.country),
        card_country: str(card?.country),
        destination_country: str(shipAddr?.country) ?? str(addr?.country),
      },
    },
    lines,
    totals: {
      total_minor: String(amount),
      subtotal_minor: subtotal.toString(),
      tax_minor: String(totalTax),
    },
    refunds: succeeded.map((r) => ({
      refund_id: String(r.id),
      amount_minor: String(Math.round(num(r.amount))),
      at: isoOfUnix(r.created) ?? new Date(0).toISOString(),
    })),
  }
}

const EXPAND = ["data.line_items", "data.payment_intent.latest_charge"]

async function refundsOfSale(ctx: StripeHttpCtx, sale: Obj): Promise<Obj[]> {
  const intent = (sale.payment_intent ?? {}) as Obj
  const chargeId = idOf(intent.latest_charge)
  return chargeId ? listRefunds(ctx, chargeId) : []
}

/** `revenue-stream@1` `sale_get`: the sale of one PaymentIntent, as Stripe answers now. */
export async function rs_sale_get(
  params: { external_id?: string },
  ctx: StripeHttpCtx,
): Promise<{ found: false } | { found: true; sale: Sale }> {
  const pi = String(params?.external_id ?? "").trim()
  if (!PI.test(pi)) return { found: false }
  const list = await stripeFetch<{ data?: Obj[] }>(ctx, "/v1/checkout/sessions", {
    params: { payment_intent: pi, limit: 1, expand: EXPAND },
  })
  const session = list?.data?.[0]
  if (!session) return { found: false }
  const sale = saleFromSession(session, await refundsOfSale(ctx, session))
  return sale ? { found: true, sale } : { found: false }
}

/**
 * `revenue-stream@1` `sales_list`: the one-off sales of the Checkout Sessions completed in
 * `[paid_from, paid_to)` (by the session's creation), newest first as Stripe lists them; the
 * cursor is the last session id read.
 */
export async function rs_sales_list(
  params: { paid_from?: string; paid_to?: string; cursor?: string | null },
  ctx: StripeHttpCtx,
): Promise<{ sales: Sale[]; next: string | null }> {
  const from = Date.parse(String(params?.paid_from ?? ""))
  const to = Date.parse(String(params?.paid_to ?? ""))
  if (Number.isNaN(from) || Number.isNaN(to)) return { sales: [], next: null }
  const cursor = str(params?.cursor)
  const list = await stripeFetch<{ data?: Obj[]; has_more?: boolean }>(
    ctx,
    "/v1/checkout/sessions",
    {
      params: {
        status: "complete",
        created: { gte: Math.floor(from / 1000), lt: Math.ceil(to / 1000) },
        limit: PAGE,
        ...(cursor ? { starting_after: cursor } : {}),
        expand: EXPAND,
      },
    },
  )
  const page = Array.isArray(list?.data) ? list.data : []
  const sales: Sale[] = []
  for (const s of page) {
    if (s.payment_status !== "paid") continue
    const sale = saleFromSession(s, await refundsOfSale(ctx, s))
    if (sale) sales.push(sale)
  }
  const last = page.length > 0 ? str(page[page.length - 1]?.id) : null
  return { sales, next: list?.has_more && last ? last : null }
}
