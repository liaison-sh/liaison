// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Draft order create and complete refuse an order Invoicing would not invoice. The fake Invoicing
// below answers with the REAL rule module, so these pin the whole path: the facts the Shopify app
// reads, the cross-app question, and the refusal before anything is staged or sent.

import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { ordersInvoiceabilityCheck } from "../../../invoicing/src/order-invoiceability"
import {
  draft_orders_complete,
  draft_orders_complete_preflight,
  draft_orders_create,
  draft_orders_create_preflight,
} from "./draft-orders"
import { INVOICEABILITY_CHECK_TOOL } from "./invoiceability"

const SHOP = "demo.myshopify.com"
const CUSTOMER = "gid://shopify/Customer/25609709781323"
const IT_ADDRESS = {
  name: "Giulia Rossi",
  company: "Pretty Face SAS",
  address1: "Via Roma 1",
  zip: "20100",
  city: "Milano",
  countryCodeV2: "IT",
}

function makeCtx(opts: {
  fetchResponses: unknown[]
  /** null: Invoicing not installed (the dispatch errors). Otherwise the shop it is mapped to. */
  invoicingShop: string | null
  /** Drop ctx.executeTool entirely. */
  noCrossApp?: boolean
}) {
  const calls: Array<{ body: string }> = []
  const crossApp: Array<{ target: string; args: Record<string, unknown> }> = []
  const responses = [...opts.fetchResponses]
  const issuerRows =
    opts.invoicingShop == null
      ? []
      : [{ id: "iss-1", legal_name: "Seller SAS", country: "FR", shopify_shop_id: opts.invoicingShop }]
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) =>
        entity === "install_metadata"
          ? [{ id: "i1", shopDomain: SHOP, connectionId: "ca1", apiVersion: "2026-04" }]
          : [],
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [{ id: "ca1", ownerType: "org", ownerId: null, identifier: SHOP, displayName: null }],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string, init?: { body?: string }) => {
      calls.push({ body: init?.body ?? "" })
      return { status: 200, headers: {}, body: JSON.stringify(responses.shift() ?? {}) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { get: async () => null },
    ...(opts.noCrossApp
      ? {}
      : {
          executeTool: async (target: string, args: Record<string, unknown>) => {
            crossApp.push({ target, args })
            if (target !== INVOICEABILITY_CHECK_TOOL || opts.invoicingShop == null)
              return { status: "error", error: { code: "TOOL_NOT_FOUND", message: `${target} not installed` } }
            const db = {
              findMany: async (table: string, q: { where?: Record<string, unknown> }) =>
                table === "issuer_profiles"
                  ? issuerRows.filter((r) => r.shopify_shop_id === q.where?.shopify_shop_id)
                  : [],
            }
            return { status: "completed", result: await ordersInvoiceabilityCheck({ db: db as never }, args) }
          },
        }),
  } as unknown as AppContext
  return { ctx, calls, crossApp }
}

const mutations = (calls: Array<{ body: string }>) => calls.filter((c) => /mutation /.test(c.body))

/** The customer of the incident: a tax exempt Italian business with no email on Shopify. */
const customerNode = (over: Record<string, unknown> = {}) => ({
  data: {
    customer: {
      id: CUSTOMER,
      email: null,
      firstName: "Giulia",
      lastName: "Rossi",
      taxExempt: true,
      defaultAddress: IT_ADDRESS,
      ...over,
    },
  },
})

/** A custom line needs no variant lookup, so the only Shopify read is the customer's. */
const createParams = (input: Record<string, unknown> = {}) => ({
  input: {
    purchasingEntity: { customerId: CUSTOMER },
    shippingAddress: { firstName: "Giulia", lastName: "Rossi", address1: "Via Roma 1", city: "Milano", zip: "20100", countryCode: "IT" },
    lineItems: [{ title: "Studio Controller", quantity: 1, originalUnitPriceWithCurrency: { amount: "500.00", currencyCode: "EUR" }, requiresShipping: false }],
    ...input,
  },
})

describe("draft_orders_create refuses an order Invoicing would not invoice", () => {
  it("preflight: a customer with no email and a tax exempt EU buyer with no VAT number, both named, nothing sent", async () => {
    const { ctx, calls, crossApp } = makeCtx({ fetchResponses: [customerNode()], invoicingShop: SHOP })
    const out = await draft_orders_create_preflight(createParams(), ctx)
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("NOT_INVOICEABLE")
    expect(err.message).toContain("customers_update")
    expect(err.message).toContain("VAT number")
    expect(crossApp[0]!.args).toMatchObject({ shop_id: SHOP, stage: "create", customer_id: CUSTOMER, email: null, tax_exempt: true })
    expect(mutations(calls)).toHaveLength(0)
  })

  it("preflight: an email on the draft does not stand in for the linked customer's missing one", async () => {
    const { ctx } = makeCtx({ fetchResponses: [customerNode({ taxExempt: false })], invoicingShop: SHOP })
    const out = await draft_orders_create_preflight(createParams({ email: "buyer@pretty-face.it" }), ctx)
    expect((out as { error: { code: string } }).error.code).toBe("NOT_INVOICEABLE")
  })

  it("preflight: passes once the customer has an email and the VAT number rides as a custom attribute", async () => {
    const { ctx } = makeCtx({ fetchResponses: [customerNode({ email: "buyer@pretty-face.it" })], invoicingShop: SHOP })
    const out = await draft_orders_create_preflight(
      createParams({ customAttributes: [{ key: "VAT number", value: "IT01234567890" }] }),
      ctx,
    )
    expect(out).toEqual({ ok: true })
  })

  it("the handler refuses too (the customer can change before the approve), with no draftOrderCreate", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [customerNode()], invoicingShop: SHOP })
    await expect(draft_orders_create(createParams(), ctx)).rejects.toThrow(/Invoicing would not invoice/)
    expect(mutations(calls)).toHaveLength(0)
  })

  it("unchanged without Invoicing: not installed, mapped to another shop, or no cross-app dispatch", async () => {
    for (const opts of [{ invoicingShop: null }, { invoicingShop: "other.myshopify.com" }, { invoicingShop: SHOP, noCrossApp: true }]) {
      const { ctx } = makeCtx({ fetchResponses: [customerNode()], ...opts })
      expect(await draft_orders_create_preflight(createParams(), ctx)).toEqual({ ok: true })
    }
  })
})

const draftNode = (over: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) => ({
  data: {
    draftOrder: {
      id: "gid://shopify/DraftOrder/348",
      email: null,
      taxExempt: false,
      totalPriceSet: { presentmentMoney: { amount: "500.00" } },
      totalTaxSet: { presentmentMoney: { amount: "0.00" } },
      customAttributes: [],
      billingAddress: IT_ADDRESS,
      shippingAddress: IT_ADDRESS,
      customer: customerNode(customer).data.customer,
      ...over,
    },
  },
})

describe("draft_orders_complete refuses a draft Invoicing would not invoice, whoever made it", () => {
  it("preflight: refuses the incident's draft (no customer email, exempt, no VAT number), nothing completed", async () => {
    const { ctx, calls, crossApp } = makeCtx({ fetchResponses: [draftNode()], invoicingShop: SHOP })
    const out = await draft_orders_complete_preflight({ id: "gid://shopify/DraftOrder/348", paymentPending: true }, ctx)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("NOT_INVOICEABLE")
    expect(err.message).toContain("Refusing to complete this draft order")
    expect(err.message).toContain("customers_update")
    expect(err.message).toContain("VAT number")
    expect(crossApp[0]!.args).toMatchObject({ stage: "complete", draft_order_id: "gid://shopify/DraftOrder/348", total_tax: "0.00" })
    expect(mutations(calls)).toHaveLength(0)
  })

  it("preflight: a reverse charge draft charged VAT is told to set taxExempt", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        draftNode(
          { totalTaxSet: { presentmentMoney: { amount: "110.00" } }, customAttributes: [{ key: "Partita IVA", value: "IT01234567890" }] },
          { email: "buyer@pretty-face.it", taxExempt: false },
        ),
      ],
      invoicingShop: SHOP,
    })
    const out = await draft_orders_complete_preflight({ id: "gid://shopify/DraftOrder/348" }, ctx)
    expect((out as { error: { message: string } }).error.message).toContain("taxExempt: true")
  })

  it("preflight: passes an invoiceable draft", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        draftNode({ customAttributes: [{ key: "VAT number", value: "IT01234567890" }] }, { email: "buyer@pretty-face.it" }),
      ],
      invoicingShop: SHOP,
    })
    expect(await draft_orders_complete_preflight({ id: "gid://shopify/DraftOrder/348" }, ctx)).toEqual({ ok: true })
  })

  it("the handler refuses before draftOrderComplete is sent", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [draftNode()], invoicingShop: SHOP })
    await expect(draft_orders_complete({ id: "gid://shopify/DraftOrder/348" }, ctx)).rejects.toThrow(/NOT_INVOICEABLE|Invoicing would not invoice/)
    expect(mutations(calls)).toHaveLength(0)
  })

  it("unchanged without Invoicing mapped to this shop", async () => {
    const { ctx } = makeCtx({ fetchResponses: [draftNode()], invoicingShop: null })
    expect(await draft_orders_complete_preflight({ id: "gid://shopify/DraftOrder/348" }, ctx)).toEqual({ ok: true })
  })
})
