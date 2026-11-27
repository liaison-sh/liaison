// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One-off Checkout payments as revenue-stream@1 sales: a consumer in Germany at 19 %, a business
// in Belgium under the reverse charge, a buyer in the United States paying in USD, a refunded
// sale, and what is not a sale (a subscription invoice, no session).
import { describe, expect, it } from "bun:test"
import { saleProblems } from "@liaison/app-sdk/contracts"
import { rs_sale_get, saleFromSession } from "./sales"

type Obj = Record<string, unknown>

function session(over: Obj = {}, item: Obj = {}): Obj {
  return {
    id: "cs_1",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "eur",
    created: 1795000000,
    invoice: null,
    customer: null,
    amount_subtotal: 2000,
    amount_total: 2380,
    total_details: { amount_tax: 380, amount_discount: 0, amount_shipping: 0 },
    customer_details: {
      email: "lena@example.de",
      name: "Lena Buyer",
      business_name: null,
      address: {
        line1: "Hauptstr. 1",
        line2: null,
        postal_code: "10115",
        city: "Berlin",
        state: null,
        country: "DE",
      },
      tax_exempt: "none",
      tax_ids: [],
    },
    metadata: { buyerUserId: "user-42" },
    payment_intent: {
      id: "pi_1",
      created: 1795000005,
      latest_charge: {
        id: "ch_1",
        created: 1795000010,
        payment_method_details: { card: { brand: "visa", country: "DE" } },
      },
    },
    line_items: {
      data: [
        {
          description: "Sound pack",
          quantity: 1,
          amount_subtotal: 2000,
          amount_total: 2380,
          amount_tax: 380,
          amount_discount: 0,
          price: { id: "price_1", unit_amount: 2000 },
          taxes: [{ amount: 380, rate: { percentage: 19, country: "DE", inclusive: false } }],
          ...item,
        },
      ],
    },
    ...over,
  }
}

describe("saleFromSession", () => {
  it("a consumer in Germany: net line, 19 % as Stripe charged it, buyer and evidence", () => {
    const sale = saleFromSession(session(), [])
    expect(sale && saleProblems(sale)).toEqual([])
    expect(sale).toMatchObject({
      external_id: "pi_1",
      refs: { charge_id: "ch_1", checkout_session_id: "cs_1" },
      sold_at: new Date(1795000010 * 1000).toISOString(),
      paid: { status: "paid", payment_ref: "ch_1" },
      currency: "EUR",
      buyer: {
        email: "lena@example.de",
        kind: "individual",
        vat_id: null,
        ids: { hub_user_id: "user-42" },
        billing: { country: "DE", city: "Berlin" },
        tax_evidence: { billing_country: "DE", card_country: "DE" },
      },
      lines: [
        {
          description: "Sound pack",
          quantity: "1",
          unit_price_minor: "2000",
          kind: "service",
          tax: { rate_bp: 1900, amount_minor: "380", jurisdiction: "DE", reported_by_source: true },
        },
      ],
      totals: { total_minor: "2380", subtotal_minor: "2000", tax_minor: "380" },
    })
  })

  it("a business in Belgium under the reverse charge: its VAT number, no tax", () => {
    const sale = saleFromSession(
      session(
        {
          amount_total: 2000,
          total_details: { amount_tax: 0 },
          customer_details: {
            email: "ap@studio.example.be",
            name: "Jan",
            business_name: "Studio BV",
            address: { line1: "Rue 1", postal_code: "1000", city: "Bruxelles", country: "BE" },
            tax_exempt: "reverse",
            tax_ids: [{ type: "eu_vat", value: "BE0123456789" }],
          },
        },
        { amount_total: 2000, amount_tax: 0, taxes: [] },
      ),
      [],
    )
    expect(sale).toMatchObject({
      buyer: {
        kind: "company",
        legal_name: "Studio BV",
        vat_id: "BE0123456789",
        tax_exempt: "reverse",
      },
      lines: [{ unit_price_minor: "2000", tax: { rate_bp: 0, amount_minor: "0" } }],
      totals: { total_minor: "2000", tax_minor: "0" },
    })
  })

  it("a buyer in the United States paying in USD", () => {
    const sale = saleFromSession(
      session(
        {
          currency: "usd",
          amount_total: 2000,
          total_details: { amount_tax: 0 },
          customer_details: {
            email: "a@example.com",
            name: "Al",
            address: {
              line1: "1 Main St",
              postal_code: "10001",
              city: "New York",
              state: "NY",
              country: "US",
            },
            tax_exempt: "none",
            tax_ids: [],
          },
        },
        { amount_total: 2000, amount_tax: 0, taxes: [] },
      ),
      [],
    )
    expect(sale).toMatchObject({
      currency: "USD",
      buyer: { billing: { country: "US", region: "NY" } },
      lines: [{ tax: { rate_bp: 0 } }],
    })
  })

  it("a refunded sale names its refunds; a partial one is partially refunded", () => {
    const full = saleFromSession(session(), [
      { id: "re_1", amount: 2380, status: "succeeded", created: 1795100000 },
      { id: "re_x", amount: 100, status: "failed", created: 1795100001 },
    ])
    expect(full?.paid.status).toBe("refunded")
    expect(full?.refunds).toEqual([
      { refund_id: "re_1", amount_minor: "2380", at: new Date(1795100000 * 1000).toISOString() },
    ])
    const part = saleFromSession(session(), [
      { id: "re_2", amount: 500, status: "succeeded", created: 1795100000 },
    ])
    expect(part?.paid.status).toBe("partially_refunded")
  })

  it("a quantity that does not divide its net is one line naming the quantity", () => {
    const sale = saleFromSession(session({}, { quantity: 3, amount_subtotal: 2000 }), [])
    expect(sale?.lines[0]).toMatchObject({
      description: "3 x Sound pack",
      quantity: "1",
      unit_price_minor: "2000",
    })
  })

  it("a subscription invoice or a non-payment session is not a sale", () => {
    expect(saleFromSession(session({ invoice: "in_1" }), [])).toBeNull()
    expect(saleFromSession(session({ mode: "subscription" }), [])).toBeNull()
  })
})

describe("rs_sale_get", () => {
  it("reads the session of the payment intent, and its refunds", async () => {
    const urls: string[] = []
    const ctx = {
      async fetch(url: string) {
        urls.push(url)
        if (url.includes("/v1/checkout/sessions"))
          return { status: 200, headers: {}, body: JSON.stringify({ data: [session()] }) }
        if (url.includes("/v1/refunds"))
          return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
        return { status: 404, headers: {}, body: "{}" }
      },
    }
    const out = await rs_sale_get({ external_id: "pi_1" }, ctx)
    expect(out).toMatchObject({ found: true, sale: { external_id: "pi_1" } })
    expect(urls[0]).toContain("payment_intent=pi_1")
    expect(decodeURIComponent(urls[0] ?? "")).toContain("expand[0]=data.line_items")
    expect(await rs_sale_get({ external_id: "ch_1" }, ctx)).toEqual({ found: false })
  })

  it("a payment with no checkout session is not found", async () => {
    const ctx = {
      fetch: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: [] }) }),
    }
    expect(await rs_sale_get({ external_id: "pi_9" }, ctx)).toEqual({ found: false })
  })
})
