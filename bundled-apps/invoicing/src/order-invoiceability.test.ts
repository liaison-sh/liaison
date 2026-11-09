// SPDX-License-Identifier: FSL-1.1-ALv2
//
// orders_invoiceability_check: the prediction of what the order-created auto-flow would park.

import { describe, expect, it } from "bun:test"
import {
  type ProspectiveOrderFacts,
  invoiceabilityProblems,
  ordersInvoiceabilityCheck,
} from "./order-invoiceability"

const FR_ISSUER = { country: "FR" }
const IT_ADDRESS = {
  company: "Pretty Face SAS",
  address1: "Via Roma 1",
  zip: "20100",
  city: "Milano",
  country_code: "IT",
}
const FR_ADDRESS = { address1: "12 rue de la Paix", zip: "75002", city: "Paris", country_code: "FR" }

/** A tax exempt Italian business buyer, linked customer, as an agent would draft it. */
const italianB2b = (over: Partial<ProspectiveOrderFacts> = {}): ProspectiveOrderFacts => ({
  shop_id: "shop.myshopify.com",
  stage: "create",
  customer_id: "gid://shopify/Customer/1",
  email: "buyer@pretty-face.it",
  legal_name: "Giulia Rossi",
  billing_address: IT_ADDRESS,
  shipping_address: IT_ADDRESS,
  vat_id: "IT01234567890",
  tax_exempt: true,
  total_price: null,
  total_tax: null,
  ...over,
})

const reasons = (facts: ProspectiveOrderFacts, issuer = FR_ISSUER): string[] =>
  invoiceabilityProblems(facts, issuer).map((p) => p.reason)

describe("invoiceabilityProblems: what the order-created auto-flow would park", () => {
  it("a linked customer with no email and a tax exempt EU buyer with no VAT number: both are named", () => {
    const problems = invoiceabilityProblems(italianB2b({ email: null, vat_id: null }), FR_ISSUER)
    expect(problems.map((p) => p.reason)).toEqual(["customer_email_missing", "tax_rate_placeholder"])
    expect(problems[0]!.message).toContain("customers_update")
    expect(problems[0]!.message).toContain("gid://shopify/Customer/1")
    expect(problems[1]!.message).toContain("VAT number")
    expect(problems[1]!.message).toContain("IT")
  })

  it("an unlinked draft with no email is told to pass input.email", () => {
    const [p] = invoiceabilityProblems(italianB2b({ customer_id: null, email: null }), FR_ISSUER)
    expect(p!.reason).toBe("customer_email_missing")
    expect(p!.message).toContain("input.email")
  })

  it("the same buyer with its email and VAT number is invoiceable (reverse charge)", () => {
    expect(reasons(italianB2b())).toEqual([])
  })

  it("no postal address anywhere (billing, ship to, customer default) parks counterparty_incomplete", () => {
    const facts = italianB2b({ billing_address: null, shipping_address: null, customer_default_address: null })
    expect(reasons(facts)).toEqual(["counterparty_incomplete"])
    expect(reasons({ ...facts, customer_default_address: IT_ADDRESS })).toEqual([])
  })

  it("an intra-EU consumer charged VAT by Shopify is invoiceable (OSS); charged none it is not", () => {
    const consumer = italianB2b({ vat_id: null, tax_exempt: false, stage: "complete", total_price: "122.00" })
    expect(reasons({ ...consumer, total_tax: "22.00" })).toEqual([])
    expect(reasons({ ...consumer, total_tax: "0.00" })).toEqual(["tax_rate_placeholder"])
    // At create the tax is not computed yet: an untaxed outcome is only known when exempt.
    expect(reasons({ ...consumer, stage: "create", total_price: null, total_tax: null })).toEqual([])
  })

  it("a reverse charge sale that Shopify charged VAT on parks tax_on_exempt_treatment", () => {
    const facts = italianB2b({ tax_exempt: false, stage: "complete", total_price: "120.00", total_tax: "20.00" })
    const problems = invoiceabilityProblems(facts, FR_ISSUER)
    expect(problems.map((p) => p.reason)).toEqual(["tax_on_exempt_treatment"])
    expect(problems[0]!.message).toContain("taxExempt")
  })

  it("a domestic sale with no VAT number is fine, and a zero total is never refused", () => {
    const domestic = italianB2b({ vat_id: null, tax_exempt: false, billing_address: FR_ADDRESS, shipping_address: FR_ADDRESS })
    expect(reasons(domestic)).toEqual([])
    expect(reasons(italianB2b({ email: null, vat_id: null, total_price: "0" }))).toEqual([])
  })
})

describe("ordersInvoiceabilityCheck: applies only when an issuer profile is mapped to the shop", () => {
  const db = (rows: Array<Record<string, unknown>>) =>
    ({
      findMany: async (table: string, q: { where?: Record<string, unknown> }) =>
        table === "issuer_profiles" ? rows.filter((r) => r.shopify_shop_id === q.where?.shopify_shop_id) : [],
    }) as never
  const issuer = { id: "iss-1", legal_name: "Seller SAS", country: "FR", shopify_shop_id: "shop.myshopify.com" }

  it("no issuer mapped to the shop: does not apply, whatever the order lacks", async () => {
    const out = await ordersInvoiceabilityCheck({ db: db([]) }, italianB2b({ email: null, vat_id: null }))
    expect(out).toEqual({ applies: false, problems: [] })
  })

  it("mapped: returns the problems and one message naming every fix", async () => {
    const out = await ordersInvoiceabilityCheck({ db: db([issuer]) }, italianB2b({ email: null, vat_id: null }))
    expect(out.applies).toBe(true)
    expect(out.issuer_profile_id).toBe("iss-1")
    expect(out.problems.map((p) => p.reason)).toEqual(["customer_email_missing", "tax_rate_placeholder"])
    expect(out.message).toContain("customers_update")
    expect(out.message).toContain("VAT number")
  })

  it("mapped and complete: no problems, no message", async () => {
    const out = await ordersInvoiceabilityCheck({ db: db([issuer]) }, italianB2b())
    expect(out).toEqual({ applies: true, issuer_profile_id: "iss-1", problems: [] })
  })
})
