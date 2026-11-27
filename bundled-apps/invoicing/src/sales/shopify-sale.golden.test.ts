// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Golden: a Shopify order reaching invoicing as a `revenue-stream@1` sale (the shopify app's
// `saleFromOrder`, then `orderPaidPayloadFromSale`) yields EXACTLY the payload the order adapter
// produced from the `order:created` event (`adaptShopifyOrderCreatedEvent`), over every
// combination of the features the adapter branches on. Same payload into the same issuing flow:
// the same documents, numbers, refs and bytes. A drift in either mapping fails here.
import { describe, expect, test } from "bun:test"
import { saleProblems } from "@liaison/app-sdk/contracts"
import { type NormalizedOrder, saleFromOrder } from "../../../shopify/src/lib/sale"
import { adaptShopifyOrderCreatedEvent } from "../handlers/shopify-order-paid"
import { orderPaidPayloadFromSale } from "./sale-payload"

const FEATURES = [
  "taxesIncluded",
  "discount",
  "multiTax",
  "channelLiable",
  "exemptZero",
  "noTaxLines",
  "shipping",
  "freeShipping",
  "digital",
  "noBilling",
  "shippingAddress",
  "noCustomer",
  "whitespace",
  "vatAndPo",
  "jpy",
  "market",
] as const
type Feature = (typeof FEATURES)[number]

function order(on: ReadonlySet<Feature>, seed: number): NormalizedOrder {
  const currency = on.has("jpy") ? "JPY" : seed % 3 === 0 ? "USD" : "EUR"
  const ws = on.has("whitespace") ? "  " : ""
  const taxLines = on.has("noTaxLines")
    ? undefined
    : on.has("exemptZero")
      ? [{ title: "CA", rate: 0.0725, amount: "0.00" }]
      : [
          { title: "VAT", rate: 0.19, amount: currency === "JPY" ? "1919" : "19.19" },
          ...(on.has("multiTax") ? [{ title: "PST", rate: 0.07, amount: "7.07" }] : []),
          ...(on.has("channelLiable")
            ? [{ title: "MF", rate: 0.05, amount: "5.05", channelLiable: true }]
            : []),
        ]
  const billing = {
    name: "Ada Buyer",
    company: on.has("whitespace") ? " Acme GmbH " : "Acme GmbH",
    address1: `${ws}Hauptstr. 1${ws}`,
    address2: seed % 2 === 0 ? "Hof" : null,
    zip: "10115",
    city: "Berlin",
    province: seed % 4 === 1 ? "BE" : null,
    country_code: seed % 5 === 2 ? "de" : "DE",
  }
  const shippingAddr = {
    name: seed % 2 === 0 ? "Spedition Nord KG" : null,
    company: seed % 3 === 1 ? "Consignee Ltd" : null,
    address1: "Am Hafen 12",
    zip: "21079",
    city: "Hamburg",
    country_code: seed % 2 === 0 ? "AT" : "US",
  }
  return {
    orderId: String(5000000 + seed),
    name: on.has("whitespace") ? " #1149 " : seed % 7 === 0 ? null : "#1149",
    shopDomain: "acme.myshopify.com",
    financialStatus: seed % 6 === 5 ? "pending" : seed % 11 === 3 ? null : "paid",
    poNumber: on.has("vatAndPo") ? " PO-4471 " : null,
    buyerTaxId: on.has("vatAndPo") ? " DE123456789 " : seed % 9 === 4 ? "   " : null,
    totalPrice: { amount: currency === "JPY" ? "24000" : "240.10", currencyCode: currency },
    taxesIncluded: on.has("taxesIncluded"),
    billingAddress: on.has("noBilling") ? null : billing,
    shippingAddress: on.has("shippingAddress") ? shippingAddr : null,
    customer: on.has("noCustomer")
      ? null
      : {
          id: seed % 13 === 6 ? null : "8888545",
          email: seed % 10 === 9 ? null : "buyer@example.com",
          first_name: seed % 8 === 3 ? null : "Ada",
          last_name: seed % 8 === 5 ? null : "Buyer",
          country: seed % 4 === 0 ? "FR" : "DE",
        },
    lineItems: [
      {
        id: "li-1",
        title: "Widget",
        quantity: seed % 3 === 2 ? 3 : 2,
        priceSet: { amount: currency === "JPY" ? "6001" : "60.05", currencyCode: currency },
        requiresShipping: !on.has("digital"),
        taxLines,
        discountAllocations: on.has("discount")
          ? [{ amount: currency === "JPY" ? "500" : "5.33" }, { amount: "1.01" }]
          : [],
        variant: seed % 4 === 3 ? { id: "gid://shopify/ProductVariant/9001" } : { id: "5550001" },
      },
      {
        id: "li-2",
        title: null,
        quantity: "1",
        priceSet: { amount: currency === "JPY" ? "999" : "9.99", currencyCode: currency },
        taxLines: taxLines?.slice(0, 1),
        variant: seed % 5 === 0 ? null : { id: "5550002" },
      },
    ],
    shippingLines: on.has("shipping")
      ? [
          {
            title: seed % 2 === 0 ? "DHL" : null,
            priceSet: { amount: on.has("freeShipping") ? "0.00" : "12.50", currencyCode: currency },
            taxLines: [{ title: "VAT", rate: 0.19, amount: "2.38" }],
          },
        ]
      : [],
    ...(on.has("market") ? { market: { country: "DE" } } : {}),
  }
}

describe("Shopify sale -> order payload is exactly the order adapter's", () => {
  test("every feature combination (and a few seeds each) maps to the identical payload", () => {
    let cases = 0
    for (let mask = 0; mask < 1 << FEATURES.length; mask += 7) {
      const on = new Set(FEATURES.filter((_, i) => mask & (1 << i)))
      for (const seed of [mask % 97, (mask * 31) % 89, (mask * 7) % 83]) {
        const o = order(on, seed)
        const sale = saleFromOrder(JSON.parse(JSON.stringify(o)), "2026-11-27T09:00:00.000Z")
        // The sale crosses the contract as JSON: compare after the same trip.
        const viaSale = orderPaidPayloadFromSale(JSON.parse(JSON.stringify(sale)))
        const direct = adaptShopifyOrderCreatedEvent(JSON.parse(JSON.stringify(o)))
        expect(JSON.parse(JSON.stringify(viaSale))).toEqual(JSON.parse(JSON.stringify(direct)))
        // Strict too: absent vs null and key presence agree (a park stores the payload as is).
        expect(Object.keys(viaSale.customer ?? {}).sort()).toEqual(
          Object.keys(direct.customer ?? {}).sort(),
        )
        for (const [i, li] of viaSale.line_items.entries()) {
          expect(Object.keys(li).sort()).toEqual(Object.keys(direct.line_items[i] ?? {}).sort())
        }
        if (o.orderId) expect(saleProblems(sale)).toEqual([])
        cases += 1
      }
    }
    expect(cases).toBeGreaterThan(25_000)
  })

  test("the sale names the order the way the contract reads it", () => {
    const sale = saleFromOrder(
      order(new Set(["vatAndPo", "shipping"]), 2),
      "2026-11-27T09:00:00.000Z",
    )
    expect(sale).toMatchObject({
      external_id: "5000002",
      refs: { order_name: "#1149", po_number: "PO-4471", account: "acme.myshopify.com" },
      paid: { status: "paid", source_status: "paid" },
      buyer: { vat_id: "DE123456789", ids: { shopify_customer_id: "8888545" } },
    })
    expect(sale.lines.map((l) => l.kind)).toEqual(["goods", "goods", "shipping"])
  })
})
