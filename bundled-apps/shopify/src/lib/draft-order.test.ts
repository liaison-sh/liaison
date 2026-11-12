// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure normalizer tests for the shared NormalizedDraftOrder shape produced by
// BOTH producers (draft_orders/* webhooks and the draft_orders_get GraphQL
// read). See the quotes-are-draft-orders design contract.
import { describe, expect, it } from "bun:test"
import {
  normalizeDraftOrderNode,
  normalizeDraftOrderWebhook,
  type ShopifyDraftOrderGraphQLNode,
  type ShopifyDraftOrderWebhookPayload,
} from "./draft-order"

describe("normalizeDraftOrderWebhook", () => {
  const OPEN_DRAFT_ORDER: ShopifyDraftOrderWebhookPayload = {
    id: 4_002,
    name: "#D4",
    status: "open",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    currency: "USD",
    total_price: "266.00",
    subtotal_price: "280.00",
    total_tax: "0.00",
    taxes_included: false,
    tax_exempt: false,
    email: "buyer@corp.example",
    note: "Quote for Corp Inc",
    tags: "liaison-quote,market:us",
    customer: {
      id: 6_001,
      email: "buyer@corp.example",
      first_name: "Cara",
      last_name: "Client",
      default_address: { company: "Corp Inc" },
    },
    billing_address: {
      name: "Cara Client",
      company: "Corp Inc",
      address1: "42 Main St",
      city: "Austin",
      province: "TX",
      zip: "73301",
      country_code: "us",
      phone: "555-1000",
    },
    shipping_address: {
      name: "Cara Client",
      address1: "1 Depot Rd",
      city: "Austin",
      province: "TX",
      zip: "73301",
      country_code: "us",
    },
    applied_discount: {
      title: "Volume",
      description: "flat off",
      value_type: "fixed_amount",
      value: "14.00",
      amount: "14.00",
    },
    shipping_line: { title: "Ground", price: "0.00" },
    tax_lines: [{ title: "TX Sales Tax", rate: 0.0825, price: "0.00" }],
    line_items: [
      {
        id: 9_101,
        title: "Blue Widget",
        sku: "BLU-1",
        variant_id: 8_201,
        product_id: 7_301,
        quantity: 4,
        price: "50.00",
        applied_discount: { value_type: "fixed_amount", value: "10.00", amount: "10.00" },
        taxable: true,
        requires_shipping: true,
        custom: false,
      },
      {
        id: 9_102,
        title: "Custom engraving",
        quantity: 1,
        price: "10.00",
        taxable: false,
        requires_shipping: false,
        custom: true,
      },
    ],
  }

  it("builds gids for the draft order, customer and line item variant/product ids", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, "demo.myshopify.com")
    expect(norm.draftOrderId).toBe("gid://shopify/DraftOrder/4002")
    expect(norm.customer?.id).toBe("gid://shopify/Customer/6001")
    expect(norm.lineItems[0]?.variantId).toBe("gid://shopify/ProductVariant/8201")
    expect(norm.lineItems[0]?.productId).toBe("gid://shopify/Product/7301")
  })

  it("lower-cases status (REST already lower-case) and threads shopDomain through", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, "demo.myshopify.com")
    expect(norm.status).toBe("open")
    expect(norm.shopDomain).toBe("demo.myshopify.com")
  })

  it("has no order linkage while the draft is still open", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    expect(norm.orderId).toBeNull()
    // The REST webhook payload never carries the order name, even once completed.
    expect(norm.orderName).toBeNull()
  })

  it("splits the comma-separated tags string into an array", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    expect(norm.tags).toEqual(["liaison-quote", "market:us"])
  })

  it("normalizes billing and shipping addresses, upper-casing the country code", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    expect(norm.billingAddress).toMatchObject({
      name: "Cara Client",
      company: "Corp Inc",
      address1: "42 Main St",
      city: "Austin",
      province: "TX",
      zip: "73301",
      countryCode: "US",
      phone: "555-1000",
    })
    expect(norm.shippingAddress).toMatchObject({ address1: "1 Depot Rd", countryCode: "US" })
  })

  it("normalizes the order-level applied discount, keeping amount as a major-unit string", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    expect(norm.appliedDiscount).toEqual({
      title: "Volume",
      description: "flat off",
      valueType: "FIXED_AMOUNT",
      value: "14.00",
      amount: "14.00",
    })
  })

  it("normalizes the shipping line and tax lines", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    expect(norm.shippingLine).toEqual({ title: "Ground", price: "0.00" })
    expect(norm.taxLines).toEqual([{ title: "TX Sales Tax", rate: 0.0825, price: "0.00" }])
  })

  it("computes discountedTotal as quantity*price minus the line discount amount", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    // 4 * 50.00 - 10.00 = 190.00
    expect(norm.lineItems[0]?.discountedTotal).toBe("190.00")
  })

  it("falls back to quantity*price when a line carries no discount", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    // 1 * 10.00, no discount
    expect(norm.lineItems[1]?.discountedTotal).toBe("10.00")
  })

  it("marks a custom line item (no variant/product ids) correctly", () => {
    const norm = normalizeDraftOrderWebhook(OPEN_DRAFT_ORDER, null)
    const custom = norm.lineItems[1]
    expect(custom?.custom).toBe(true)
    expect(custom?.variantId).toBeNull()
    expect(custom?.productId).toBeNull()
    expect(custom?.taxable).toBe(false)
    expect(custom?.requiresShipping).toBe(false)
  })

  const COMPLETED_DRAFT_ORDER: ShopifyDraftOrderWebhookPayload = {
    id: 4_003,
    name: "#D5",
    status: "completed",
    order_id: 5_500,
    currency: "USD",
    total_price: "100.00",
    line_items: [],
  }

  it("carries order_id (as a gid) once completed, with orderName left null (webhook has no order name)", () => {
    const norm = normalizeDraftOrderWebhook(COMPLETED_DRAFT_ORDER, null)
    expect(norm.status).toBe("completed")
    expect(norm.orderId).toBe("gid://shopify/Order/5500")
    expect(norm.orderName).toBeNull()
  })

  const MINIMAL_DELETE_PAYLOAD: ShopifyDraftOrderWebhookPayload = { id: 4_004 }

  it("normalizes a minimal draft_orders/delete payload ({ id } only) with nulls everywhere else", () => {
    const norm = normalizeDraftOrderWebhook(MINIMAL_DELETE_PAYLOAD, "demo.myshopify.com")
    expect(norm.draftOrderId).toBe("gid://shopify/DraftOrder/4004")
    expect(norm.name).toBeNull()
    expect(norm.status).toBeNull()
    expect(norm.customer).toBeNull()
    expect(norm.billingAddress).toBeNull()
    expect(norm.shippingAddress).toBeNull()
    expect(norm.appliedDiscount).toBeNull()
    expect(norm.shippingLine).toBeNull()
    expect(norm.taxLines).toEqual([])
    expect(norm.lineItems).toEqual([])
    expect(norm.tags).toEqual([])
  })
})

describe("normalizeDraftOrderNode", () => {
  const NODE: ShopifyDraftOrderGraphQLNode = {
    id: "gid://shopify/DraftOrder/5001",
    name: "#D6",
    status: "INVOICE_SENT",
    tags: ["liaison-quote"],
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-03T10:00:00Z",
    email: "buyer@example.org",
    note2: "Quote for Beta LLC",
    taxExempt: false,
    taxesIncluded: true,
    currencyCode: "GBP",
    totalPriceSet: { presentmentMoney: { amount: "240.00" } },
    subtotalPriceSet: { presentmentMoney: { amount: "260.00" } },
    totalTaxSet: { presentmentMoney: { amount: "0.00" } },
    order: null,
    appliedDiscount: {
      title: "Beta discount",
      description: "10 percent",
      valueType: "PERCENTAGE",
      value: "10.0",
      amountSet: { presentmentMoney: { amount: "20.00" } },
    },
    shippingLine: { title: "Express", originalPriceSet: { presentmentMoney: { amount: "0.00" } } },
    taxLines: [{ title: "VAT", rate: 0.2, priceSet: { presentmentMoney: { amount: "0.00" } } }],
    billingAddress: {
      name: "Beta Buyer",
      company: "Beta LLC",
      address1: "10 High St",
      city: "London",
      zip: "E1 6AN",
      countryCodeV2: "gb",
      phone: "020-1234",
    },
    shippingAddress: null,
    customer: {
      id: "gid://shopify/Customer/6100",
      email: "buyer@example.org",
      firstName: "Beta",
      lastName: "Buyer",
      defaultAddress: { company: "Beta LLC" },
    },
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/DraftOrderLineItem/1",
            title: "Widget",
            sku: "WID-1",
            custom: false,
            taxable: true,
            requiresShipping: true,
            quantity: 3,
            variant: {
              id: "gid://shopify/ProductVariant/9200",
              product: { id: "gid://shopify/Product/7400" },
            },
            originalUnitPriceSet: { presentmentMoney: { amount: "80.00" } },
            discountedTotalSet: { presentmentMoney: { amount: "220.00" } },
            appliedDiscount: {
              valueType: "FIXED_AMOUNT",
              value: "20.00",
              amountSet: { presentmentMoney: { amount: "20.00" } },
            },
          },
        },
      ],
    },
  }

  it("takes the currency from the same money bag the amounts come from", () => {
    // Draft #D332 quoted 149.00 USD to a customer in Yerevan and invoicing
    // built the quote as 149.00 EUR, ~15% over: every amount is read from
    // presentmentMoney, but the currency used to come from the DraftOrder's
    // `currencyCode`, which is the SHOP's currency. On a draft sold in another
    // currency the amounts were relabelled rather than converted.
    const norm = normalizeDraftOrderNode(
      {
        ...NODE,
        currencyCode: "EUR", // shop currency
        totalPriceSet: { presentmentMoney: { amount: "123.52", currencyCode: "USD" } },
      },
      null,
    )
    expect(norm.currency).toBe("USD")
    expect(norm.totalPrice).toBe("123.52")
  })

  it("falls back to the shop currencyCode when the bag carries none", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.currency).toBe("GBP")
  })

  it("lower-cases the GraphQL (upper-case) status", () => {
    const norm = normalizeDraftOrderNode(NODE, "demo.myshopify.com")
    expect(norm.status).toBe("invoice_sent")
  })

  it("passes the gid through unchanged (GraphQL ids are already gids)", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.draftOrderId).toBe("gid://shopify/DraftOrder/5001")
    expect(norm.customer?.id).toBe("gid://shopify/Customer/6100")
  })

  it("resolves order id/name from the order sub-object, null when the draft is not completed", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.orderId).toBeNull()
    expect(norm.orderName).toBeNull()
  })

  it("resolves money fields from presentmentMoney amounts", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.totalPrice).toBe("240.00")
    expect(norm.subtotalPrice).toBe("260.00")
    expect(norm.totalTax).toBe("0.00")
  })

  it("normalizes the billing address, upper-casing countryCodeV2 into countryCode", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.billingAddress).toMatchObject({ countryCode: "GB", address1: "10 High St" })
    expect(norm.shippingAddress).toBeNull()
  })

  it("normalizes the order-level applied discount and shipping line", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.appliedDiscount).toEqual({
      title: "Beta discount",
      description: "10 percent",
      valueType: "PERCENTAGE",
      value: "10.0",
      amount: "20.00",
    })
    expect(norm.shippingLine).toEqual({ title: "Express", price: "0.00" })
  })

  it("normalizes line items from the edges/node GraphQL connection shape", () => {
    const norm = normalizeDraftOrderNode(NODE, null)
    expect(norm.lineItems).toHaveLength(1)
    const li = norm.lineItems[0]
    expect(li?.variantId).toBe("gid://shopify/ProductVariant/9200")
    expect(li?.productId).toBe("gid://shopify/Product/7400")
    expect(li?.unitPrice).toBe("80.00")
    expect(li?.discountedTotal).toBe("220.00")
    expect(li?.appliedDiscount).toEqual({
      valueType: "FIXED_AMOUNT",
      value: "20.00",
      amount: "20.00",
    })
  })

  const COMPLETED_NODE: ShopifyDraftOrderGraphQLNode = {
    ...NODE,
    id: "gid://shopify/DraftOrder/5002",
    status: "COMPLETED",
    order: { id: "gid://shopify/Order/8800", name: "#1149" },
  }

  it("resolves order id/name once the draft order is completed", () => {
    const norm = normalizeDraftOrderNode(COMPLETED_NODE, null)
    expect(norm.status).toBe("completed")
    expect(norm.orderId).toBe("gid://shopify/Order/8800")
    expect(norm.orderName).toBe("#1149")
  })

  const EMPTY_LINE_ITEMS_NODE: ShopifyDraftOrderGraphQLNode = {
    id: "gid://shopify/DraftOrder/5003",
    status: "OPEN",
  }

  it("handles a node with no lineItems connection at all (empty array, no throw)", () => {
    const norm = normalizeDraftOrderNode(EMPTY_LINE_ITEMS_NODE, null)
    expect(norm.lineItems).toEqual([])
    expect(norm.tags).toEqual([])
    expect(norm.customer).toBeNull()
  })
})

describe("normalizeDraftOrderNode: the B2B buyer", () => {
  const base = { id: "gid://shopify/DraftOrder/1", taxesIncluded: false, lineItems: { edges: [] } }

  it("reads the company, its location addresses, tax registration id and contact email", () => {
    const norm = normalizeDraftOrderNode(
      {
        ...base,
        purchasingEntity: {
          company: { name: "Buyer Industries SAS" },
          contact: { customer: { email: "buyer@buyer-industries.example" } },
          location: {
            name: "Head office",
            taxSettings: { taxRegistrationId: "FR99887766554", taxExempt: true },
            billingAddress: {
              recipient: "Accounts",
              companyName: "Buyer Industries SAS",
              address1: "5 rue Exemple",
              zip: "69002",
              city: "Lyon",
              countryCode: "FR",
            },
            shippingAddress: null,
          },
        },
      },
      null,
    )
    expect(norm.taxesIncluded).toBe(false)
    expect(norm.purchasingCompany).toEqual({
      companyName: "Buyer Industries SAS",
      locationName: "Head office",
      taxRegistrationId: "FR99887766554",
      taxExempt: true,
      contactEmail: "buyer@buyer-industries.example",
      billingAddress: {
        name: "Accounts",
        company: "Buyer Industries SAS",
        address1: "5 rue Exemple",
        address2: null,
        zip: "69002",
        city: "Lyon",
        province: null,
        countryCode: "FR",
        phone: null,
      },
      shippingAddress: null,
    })
  })

  it("a consumer draft (the Customer arm reads as {}) has no company", () => {
    expect(
      normalizeDraftOrderNode({ ...base, purchasingEntity: {} }, null).purchasingCompany,
    ).toBeNull()
    expect(normalizeDraftOrderNode(base, null).purchasingCompany).toBeNull()
  })

  it("a price override is the line's unit price", () => {
    const norm = normalizeDraftOrderNode(
      {
        ...base,
        lineItems: {
          edges: [
            {
              node: {
                id: "l1",
                title: "Item",
                quantity: 1,
                originalUnitPriceSet: {
                  presentmentMoney: { amount: "699.00", currencyCode: "EUR" },
                },
                priceOverride: { amount: "629.00", currencyCode: "EUR" },
              },
            },
          ],
        },
      },
      null,
    )
    expect(norm.lineItems[0]).toMatchObject({
      unitPrice: "629.00",
      priceOverride: "629.00",
      appliedDiscount: null,
    })
  })
})
