// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A `revenue-stream@1` sale as the order payload the issuing flow consumes (`OrderPaidPayload`,
// handlers/shopify-order-paid.ts). The mapping is exact: a Shopify sale (the shopify app's
// `saleFromOrder`) maps to the very payload the former order adapter produced, number for number
// and string for string (`shopify-sale.golden.test.ts`), so moving Shopify onto the contract
// changes no document. Every other provider's sale goes through the same mapping.

import type { Sale, SaleAddress } from "@liaison/app-sdk/contracts"
import type {
  OrderAddress,
  OrderDeliveryAddress,
  OrderPaidPayload,
} from "../handlers/shopify-order-paid"
import type { LineKind } from "../issue"

const PAID_AT_SALE: ReadonlySet<string> = new Set(["paid", "refunded", "partially_refunded"])

function addrStr(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** The Bill-to block (company, street, locality): legal name and country print on their own lines. */
export function formatSaleAddress(a: SaleAddress | null | undefined): string | null {
  if (!a) return null
  const locality = [a.postcode, a.city].filter(Boolean).join(" ")
  const localityWithRegion = a.region ? [locality, a.region].filter(Boolean).join(", ") : locality
  const lines = [
    a.company ?? null,
    a.line1 ?? null,
    a.line2 ?? null,
    localityWithRegion || null,
  ].filter((l): l is string => !!l && l.trim() !== "")
  return lines.length > 0 ? lines.join("\n") : null
}

/** The Ship-to block, with the consignee country folded in (it prints no country line). */
export function formatSaleShippingAddress(a: SaleAddress | null | undefined): string | null {
  const base = formatSaleAddress(a)
  if (!base) return null
  const country = a?.country?.trim()
  return country ? `${base}\n${country}` : base
}

/** True when the sale names a buyer at all (a guest checkout with nothing known has none). */
function hasBuyer(sale: Sale): boolean {
  const b = sale.buyer
  return b.customer_id !== undefined || b.email != null || b.name != null
}

/** The line kind the issue flow takes: a service is not merchandise (it joins the software scope). */
function lineKindOf(kind: Sale["lines"][number]["kind"]): LineKind {
  if (kind === "service") return "software"
  return kind
}

export function orderPaidPayloadFromSale(sale: Sale): OrderPaidPayload {
  const b = sale.buyer
  const billingSrc = b.billing ?? null
  const deliverySrc = b.delivery ?? null
  const destination = b.tax_evidence?.destination_country ?? undefined
  // Two countries, two jobs: the billing country prints under the Bill-to address (the billing
  // address, else the delivery used as its fallback); the tax country is where the supply goes.
  const billingCountry =
    (billingSrc ? billingSrc.country : deliverySrc?.country) ?? destination ?? undefined
  const taxCountry = deliverySrc?.country ?? destination ?? billingCountry ?? undefined
  const billingFrom = billingSrc ?? deliverySrc
  const billing: OrderAddress | null = billingFrom
    ? {
        company: addrStr(billingFrom.company),
        line1: addrStr(billingFrom.line1),
        line2: addrStr(billingFrom.line2),
        postcode: addrStr(billingFrom.postcode),
        city: addrStr(billingFrom.city),
        country_code: addrStr(billingFrom.country)?.toUpperCase() ?? null,
      }
    : null
  const delivery: OrderDeliveryAddress | null = deliverySrc
    ? {
        name: addrStr(deliverySrc.name) ?? addrStr(deliverySrc.company),
        line1: addrStr(deliverySrc.line1),
        line2: addrStr(deliverySrc.line2),
        postcode: addrStr(deliverySrc.postcode),
        city: addrStr(deliverySrc.city),
        country_code: addrStr(deliverySrc.country)?.toUpperCase() ?? null,
      }
    : null
  const shippingName = deliverySrc?.name ?? deliverySrc?.company ?? undefined
  const legalName = b.legal_name || b.name || b.email || undefined
  const refs = sale.refs ?? {}
  return {
    id: sale.external_id,
    order_number: refs.order_name ?? null,
    shop_id: refs.account ?? "",
    createdAt: refs.placed_at ?? undefined,
    // The source's own word when it has one (the shop's), else whether it was paid at all: a
    // sale refunded since was paid when it was made (its refunds are credit notes of their own).
    financial_status:
      sale.paid.source_status !== undefined
        ? sale.paid.source_status
        : PAID_AT_SALE.has(sale.paid.status)
          ? "paid"
          : sale.paid.status,
    po_number: refs.po_number ?? null,
    total_price_minor: sale.totals.total_minor,
    currency: sale.currency,
    customer: hasBuyer(sale)
      ? {
          id: b.customer_id ?? null,
          email: b.email ?? null,
          contact_id: null, // resolved before issuing (resolveContact)
          country: billingCountry,
          tax_country: taxCountry,
          legal_name: legalName,
          vat_id: b.vat_id ?? null,
          address: formatSaleAddress(billingFrom),
          shipping_address: formatSaleShippingAddress(deliverySrc),
          shipping_name: shippingName ?? null,
          billing,
          delivery,
        }
      : undefined,
    line_items: sale.lines.map((l) => ({
      id: l.variant_ref ?? "",
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      discount_minor: l.discount_minor ?? "0",
      ...(l.tax && typeof l.tax.rate_bp === "number"
        ? {
            tax_rate_bp: l.tax.rate_bp,
            ...(l.tax.amount_minor != null
              ? {
                  shopify_tax_minor: l.tax.amount_minor,
                  shopify_tax_line_count: l.tax.line_count ?? 1,
                }
              : {}),
            ...(l.tax.marketplace_minor != null && l.tax.marketplace_minor !== "0"
              ? { marketplace_tax_minor: l.tax.marketplace_minor }
              : {}),
          }
        : {}),
      line_kind: lineKindOf(l.kind),
    })),
    market:
      refs.market_country !== undefined ? { country: refs.market_country ?? undefined } : undefined,
  }
}
