// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  summarizeCustomersEmailMarketingConsentUpdate,
  summarizeCustomersTag,
  summarizeCustomersUpdate,
  summarizeDraftOrderCreate,
  summarizeFulfillmentsCreate,
  summarizeFulfillmentsUpdateTracking,
  summarizeInventoryAdjust,
  summarizeOrderUpdate,
  summarizeProductsCreate,
  summarizeProductsMerge,
  summarizeProductsPublish,
  summarizeProductsUnpublish,
  summarizeProductsUpdate,
  summarizeRefundsCreate,
  summarizeReturnsRequest,
  summarizeVariantsUpdate,
} from "./summarizers"

describe("summarizeDraftOrderCreate — order-level discount in the gated approval summary", () => {
  // The approval summary is the toolEvent output the Opus judge grades. It must describe the draft
  // AS IT WILL EXECUTE after handler normalisation — a uniform whole-order discount as ORDER-LEVEL.
  it("a uniform per-line discount on a multi-line draft → an ORDER-LEVEL discount line", async () => {
    const s = await summarizeDraftOrderCreate({
      input: {
        note: "UK export — post-Brexit customs, commercial invoice required",
        purchasingEntity: { customerId: "gid://shopify/Customer/42" },
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/1",
            quantity: 8,
            appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU 20% discount" },
          },
          {
            variantId: "gid://shopify/ProductVariant/2",
            quantity: 8,
            appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU 20% discount" },
          },
        ],
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Order-level discount \(whole order\): 20% off/)
    // the per-line items must NOT each carry their own discount label (it's order-level now)
    expect(s.lines.filter((l) => /20% off/.test(l) && !/Order-level/.test(l))).toHaveLength(0)
    expect(joined).toMatch(/UK export — post-Brexit customs, commercial invoice required/)
    expect(joined).toMatch(/gid:\/\/shopify\/Customer\/42/)
  })

  it("a discount on just ONE line of a multi-line draft → still reported ORDER-LEVEL", async () => {
    const s = await summarizeDraftOrderCreate({
      input: {
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/1",
            quantity: 8,
            appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU" },
          },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 8 },
        ],
      },
    })
    expect(s.lines.join("\n")).toMatch(/Order-level discount \(whole order\): 20% off/)
  })

  it("an explicit order-level discount is reported as order-level", async () => {
    const s = await summarizeDraftOrderCreate({
      input: {
        appliedDiscount: { value: 15, valueType: "PERCENTAGE", title: "Promo" },
        lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }],
      },
    })
    expect(s.lines.join("\n")).toMatch(/Order-level discount \(whole order\): 15% off \(Promo\)/)
  })

  it("DIFFERENT per-line discounts (a genuine per-line mix) stay PER LINE, no order-level line", async () => {
    const s = await summarizeDraftOrderCreate({
      input: {
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/1",
            quantity: 10,
            appliedDiscount: { value: 30, valueType: "PERCENTAGE", title: "Dealer" },
          },
          {
            variantId: "gid://shopify/ProductVariant/2",
            quantity: 2,
            appliedDiscount: { value: 10, valueType: "PERCENTAGE", title: "Accessory" },
          },
        ],
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).not.toMatch(/Order-level discount/)
    expect(joined).toMatch(/30% off \(Dealer\)/)
    expect(joined).toMatch(/10% off \(Accessory\)/)
  })

  it("a single-line draft keeps its discount shown on the line (not lifted)", async () => {
    const s = await summarizeDraftOrderCreate({
      input: {
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/9",
            quantity: 25,
            appliedDiscount: { value: 40, valueType: "PERCENTAGE", title: "Dealer" },
          },
        ],
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).not.toMatch(/Order-level discount/)
    expect(joined).toMatch(/40% off \(Dealer\)/)
  })

  it("hydrated variants_brief context renders PRODUCT TITLES (never a bare gid) + buyer identity", async () => {
    // The card previously read "1× gid://shopify/ProductVariant/57467363623243" — the approver had
    // no idea what product they were approving. With the summarizerContext hydration the line names
    // the product, tags digital goods, and shows the buyer the order binds to.
    const s = await summarizeDraftOrderCreate(
      {
        input: {
          email: "jeff@example-buyer.com",
          billingAddress: { firstName: "Jeff", lastName: "Cross" },
          lineItems: [
            {
              variantId: "gid://shopify/ProductVariant/9",
              quantity: 1,
              appliedDiscount: { value: 100, valueType: "PERCENTAGE", title: "Comp" },
            },
          ],
        },
      },
      undefined,
      {
        connectionIdentifier: "demo.myshopify.com",
        context: {
          variants: [
            {
              id: "gid://shopify/ProductVariant/9",
              title: "Tessera Sound",
              sku: "EMB-SOUND",
              price: "79.00",
              requiresShipping: false,
            },
          ],
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/1× Tessera Sound \(list 79\.00\) \[digital\]/)
    expect(joined).not.toMatch(/gid:\/\/shopify\/ProductVariant/)
    expect(joined).toMatch(/Buyer email: jeff@example-buyer\.com/)
    expect(joined).toMatch(/Buyer: Jeff Cross/)
  })

  it("degrades to the raw gid when hydration is absent (context null)", async () => {
    const s = await summarizeDraftOrderCreate({
      input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 2 }] },
    })
    expect(s.lines.join("\n")).toMatch(/2× gid:\/\/shopify\/ProductVariant\/9/)
  })
})

describe("summarizeProductsMerge — the gated merge approval card is human-legible (BL-262)", () => {
  // The merge DELETES a listing, so the card the human approves must name BOTH the kept survivor and
  // the deleted duplicate (by TITLE, not an opaque id) and surface the data-loss caveat — the judge
  // grades this summary.
  it("names the survivor + the deleted duplicate by title and surfaces the data-loss + redirect caveat", async () => {
    const s = await summarizeProductsMerge({
      survivorId: "gid://shopify/Product/100",
      duplicateId: "gid://shopify/Product/200",
      survivorTitle: "Kestrel 6 Recorder (canonical)",
      duplicateTitle: "Kestrel 6 Recorder (migration dup)",
    })
    const joined = s.lines.join("\n")
    expect(s.kind).toBe("products_merge")
    // KEEP names the survivor title, DELETE names the duplicate title (not an id).
    expect(joined).toMatch(/KEEP \(survivor\): Kestrel 6 Recorder \(canonical\)/)
    expect(joined).toMatch(/DELETE \(duplicate\): Kestrel 6 Recorder \(migration dup\)/)
    // The reviewer is told this DELETES the duplicate, and that reviews/metafields do NOT carry over.
    expect(s.subtitle ?? "").toMatch(/DELETES the duplicate/i)
    expect(joined).toMatch(/reviews and metafields do NOT carry over/i)
    // The reassign + redirect legs are named so the action is legible.
    expect(joined).toMatch(/[Rr]eassign/)
    expect(joined).toMatch(/redirect/i)
  })

  it("unwraps an `input`-wrapped params shape (the manifest declares params.input)", async () => {
    const s = await summarizeProductsMerge({
      input: {
        survivorId: "gid://shopify/Product/1",
        duplicateId: "gid://shopify/Product/2",
        survivorTitle: "Keeper",
        duplicateTitle: "Goner",
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/KEEP \(survivor\): Keeper/)
    expect(joined).toMatch(/DELETE \(duplicate\): Goner/)
  })

  it("falls back to the ids when titles are absent (card is never blank)", async () => {
    const s = await summarizeProductsMerge({
      survivorId: "gid://shopify/Product/100",
      duplicateId: "gid://shopify/Product/200",
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/KEEP \(survivor\): gid:\/\/shopify\/Product\/100/)
    expect(joined).toMatch(/DELETE \(duplicate\): gid:\/\/shopify\/Product\/200/)
  })

  it("accepts the natural aliases keepId/removeId", async () => {
    const s = await summarizeProductsMerge({
      keepId: "gid://shopify/Product/7",
      removeId: "gid://shopify/Product/8",
      keepTitle: "Canonical",
      removeTitle: "Dup",
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/KEEP \(survivor\): Canonical/)
    expect(joined).toMatch(/DELETE \(duplicate\): Dup/)
  })
})

describe("summarizeRefundsCreate — gid shortening + notifyCustomer subtitle", () => {
  it("a flat goodwill refund names the amount and order id (shortened gid)", async () => {
    const s = await summarizeRefundsCreate({
      orderId: "gid://shopify/Order/12390079529291",
      amount: "50.00",
    })
    expect(s.title).toBe("Refund 50.00 on order 12390079529291")
    expect(s.lines.join("\n")).toMatch(/Flat goodwill refund: 50.00/)
  })

  it("notify defaults true (API default) -> subtitle says customer WILL be notified", async () => {
    const s = await summarizeRefundsCreate({ orderId: "gid://shopify/Order/1", amount: "10.00" })
    expect(s.subtitle).toBe("Customer WILL be notified")
  })

  it("notify:false -> subtitle says no customer notification", async () => {
    const s = await summarizeRefundsCreate({
      orderId: "gid://shopify/Order/1",
      amount: "10.00",
      notify: false,
    })
    expect(s.subtitle).toBe("No customer notification")
  })

  it("line-item refund lists each item + restock type instead of a flat amount", async () => {
    const s = await summarizeRefundsCreate({
      orderId: "gid://shopify/Order/1",
      refundLineItems: [
        { lineItemId: "gid://shopify/LineItem/1", quantity: 2, restockType: "RETURN" },
      ],
    })
    expect(s.lines.join("\n")).toMatch(/Refund 2x line item 1 \(restock: RETURN\)/)
  })
})

describe("summarizeFulfillmentsCreate / summarizeFulfillmentsUpdateTracking — notifyCustomer honesty", () => {
  it("fulfillments_create: no notifyCustomer, no policy set -> 'No customer notification' (API default false)", async () => {
    const s = await summarizeFulfillmentsCreate(
      { orderId: "gid://shopify/Order/1", fulfillment: {} },
      undefined,
      {
        connectionIdentifier: null,
        context: { shippingEmailPolicy: "caller" },
      },
    )
    expect(s.subtitle).toBe("No customer notification")
  })

  it("fulfillments_create: notifyCustomer:true, no policy set -> 'Customer WILL be notified'", async () => {
    const s = await summarizeFulfillmentsCreate(
      {
        orderId: "gid://shopify/Order/1",
        fulfillment: { notifyCustomer: true, trackingInfo: { company: "UPS", number: "1Z999" } },
      },
      undefined,
      { connectionIdentifier: null, context: { shippingEmailPolicy: "caller" } },
    )
    expect(s.subtitle).toBe("Customer WILL be notified")
    expect(s.lines.join("\n")).toMatch(/Tracking: UPS 1Z999/)
  })

  it("fulfillments_update_tracking: notifyCustomer defaults false per manifest (no policy set)", async () => {
    const s = await summarizeFulfillmentsUpdateTracking(
      {
        fulfillmentId: "gid://shopify/Fulfillment/1",
        trackingInfoInput: { company: "DHL", number: "999" },
      },
      undefined,
      { connectionIdentifier: null, context: { attributes: { shippingEmailPolicy: "caller" } } },
    )
    expect(s.subtitle).toBe("No customer notification")
    expect(s.lines.join("\n")).toMatch(/Carrier: DHL/)
    expect(s.lines.join("\n")).toMatch(/Tracking number: 999/)
  })
})

describe("summarizeProductsCreate — human-legible product fields", () => {
  it("names the title, status, vendor and tags", async () => {
    const s = await summarizeProductsCreate({
      input: {
        title: "Kestrel 6 Recorder",
        status: "ACTIVE",
        vendor: "Fabrikam",
        tags: ["synth", "controller"],
      },
    })
    expect(s.title).toBe("Create product: Kestrel 6 Recorder")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Status: ACTIVE/)
    expect(joined).toMatch(/Vendor: Fabrikam/)
    expect(joined).toMatch(/Tags: synth, controller/)
  })
})

describe("summarizeInventoryAdjust — reason + per-line deltas", () => {
  it("shows the reason and each inventory delta with gid-shortened item/location", async () => {
    const s = await summarizeInventoryAdjust({
      input: {
        reason: "correction",
        name: "available",
        changes: [
          {
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/9",
            delta: -3,
          },
        ],
      },
    })
    expect(s.subtitle).toBe("correction")
    expect(s.lines.join("\n")).toMatch(/-3 on item 1 at location 9/)
  })
})

describe("summarizeReturnsRequest — return line items with reasons", () => {
  it("lists each return line item's quantity and reason", async () => {
    const s = await summarizeReturnsRequest({
      input: {
        orderId: "gid://shopify/Order/5",
        returnLineItems: [
          {
            fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1",
            quantity: 1,
            returnReason: "DEFECTIVE",
          },
        ],
      },
    })
    expect(s.title).toMatch(/Request return on order 5/)
    expect(s.lines.join("\n")).toMatch(/1x 1: DEFECTIVE/)
  })
})

describe("summarizeCustomersEmailMarketingConsentUpdate — consent state change", () => {
  it("shows the new marketing state and opt-in level", async () => {
    const s = await summarizeCustomersEmailMarketingConsentUpdate({
      customerId: "gid://shopify/Customer/42",
      input: {
        emailMarketingConsent: {
          marketingState: "SUBSCRIBED",
          marketingOptInLevel: "CONFIRMED_OPT_IN",
        },
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/New state: SUBSCRIBED/)
    expect(joined).toMatch(/Opt-in level: CONFIRMED_OPT_IN/)
  })
})

// ─── summarizerContext rich-card hydration (BL — new kernel mechanism) ─────────
//
// The kernel now calls every untrusted-app summarizer as (params, meta), where
// meta = { connectionIdentifier, context }. `context` is the `.data` of the manifest
// tool's declared summarizerContext read (e.g. orders_get's OrderDetail, customers_get's
// NormalizedHit), fetched at gate time under the caller's authorization. These tests
// exercise the RICH path (context present) and the GRACEFUL DEGRADATION path (meta/context
// absent — the context fetch is best-effort and must never break the card).

/** A realistic orders_get (OrderDetail) fixture: order #2830 for "Quinn" (a US customer),
 *  one line item, with a total. Mirrors the actual shape reads.ts#orders_get returns. */
const ORDER_CONTEXT_FIXTURE = {
  id: "gid://shopify/Order/12390079529291",
  entity: "order",
  title: "#2830",
  name: "#2830",
  market: "us",
  currency: "USD",
  attributes: {
    email: "quinn@example.com",
    shippingCountry: "United States",
    shippingCountryCode: "US",
    processedAt: "2026-04-09T14:32:00Z",
  },
  customer: { email: "quinn@example.com", first_name: "Quinn", last_name: "US" },
  customerAddress: null,
  shippingAddress: null,
  totalPrice: { amount: "699.00", currencyCode: "USD" },
  lineItems: [
    {
      id: "gid://shopify/LineItem/1",
      title: "Kestrel 6 Recorder",
      quantity: 1,
      variant: { id: "gid://shopify/ProductVariant/1", title: "Default", sku: "RAL-44" },
    },
  ],
  fulfillments: [],
  refunds: [],
  returns: [],
}

/** A realistic customers_get (NormalizedHit) fixture. */
const CUSTOMER_CONTEXT_FIXTURE = {
  id: "gid://shopify/Customer/555",
  entity: "customer",
  title: "Alex Rivera",
  market: null,
  currency: "USD",
  attributes: {
    email: "alex.rivera@example.com",
    phone: "+1-555-0100",
    firstName: "Alex",
    lastName: "Rivera",
    tags: ["vip"],
    amountSpent: { amount: "4200.00", currencyCode: "USD" },
    numberOfOrders: "6",
    createdAt: "2024-11-02T08:00:00Z",
  },
}

describe("summarizeFulfillmentsCreate — rich card from summarizerContext (orders_get)", () => {
  it("names the human order number, customer, item count, and each line item when context is present", async () => {
    const s = await summarizeFulfillmentsCreate(
      { orderId: "gid://shopify/Order/12390079529291", fulfillment: {} },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: ORDER_CONTEXT_FIXTURE },
    )
    expect(s.title).toBe("Fulfill order #2830 for Quinn US (1 item)")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Customer: Quinn US quinn@example\.com/)
    expect(joined).toMatch(/Order placed: 2026-04-09/)
    expect(joined).toMatch(/1x Kestrel 6 Recorder/)
    expect(joined).toMatch(/Order total: 699\.00 USD/)
    expect(joined).toMatch(/Ships to: United States/)
  })

  it("builds the external Shopify admin order link from the gid → numeric id + connectionIdentifier", async () => {
    const s = await summarizeFulfillmentsCreate(
      { orderId: "gid://shopify/Order/12390079529291", fulfillment: {} },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: ORDER_CONTEXT_FIXTURE },
    )
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([
      {
        label: "Open order in Shopify",
        url: "https://fabrikam.myshopify.com/admin/orders/12390079529291",
      },
    ])
  })

  it("degrades gracefully to the params-only title/lines when meta is absent", async () => {
    const s = await summarizeFulfillmentsCreate({
      orderId: "gid://shopify/Order/1",
      fulfillment: {},
    })
    expect(s.title).toBe("Fulfill order 1")
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([])
  })

  it("degrades gracefully when context is present but null (read failed at gate time)", async () => {
    const s = await summarizeFulfillmentsCreate(
      { orderId: "gid://shopify/Order/1", fulfillment: {} },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: null },
    )
    expect(s.title).toBe("Fulfill order 1")
    // connectionIdentifier alone still produces the external link — it does not depend on context.
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([
      { label: "Open order in Shopify", url: "https://fabrikam.myshopify.com/admin/orders/1" },
    ])
  })
})

describe("summarizeRefundsCreate — rich card from summarizerContext (orders_get)", () => {
  it("names the amount, human order number, and customer", async () => {
    const s = await summarizeRefundsCreate(
      { orderId: "gid://shopify/Order/12390079529291", amount: "50.00" },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: ORDER_CONTEXT_FIXTURE },
    )
    expect(s.title).toBe("Refund 50.00 on order #2830 for Quinn US")
    expect(s.lines.join("\n")).toMatch(/Flat goodwill refund: 50\.00/)
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([
      {
        label: "Open order in Shopify",
        url: "https://fabrikam.myshopify.com/admin/orders/12390079529291",
      },
    ])
  })

  it("degrades to the shortened-gid title when meta/context is absent", async () => {
    const s = await summarizeRefundsCreate({
      orderId: "gid://shopify/Order/12390079529291",
      amount: "50.00",
    })
    expect(s.title).toBe("Refund 50.00 on order 12390079529291")
  })
})

describe("summarizeOrderUpdate — rich card from summarizerContext (orders_get)", () => {
  it("names the human order number + customer alongside the tag/note changes", async () => {
    const s = await summarizeOrderUpdate(
      { input: { id: "gid://shopify/Order/12390079529291", tags: ["vip"] } },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: ORDER_CONTEXT_FIXTURE },
    )
    expect(s.title).toBe("Update order #2830 for Quinn US")
    expect(s.lines.join("\n")).toMatch(/Tags: vip/)
  })
})

describe("summarizeCustomersUpdate / summarizeCustomersTag — rich card from summarizerContext (customers_get)", () => {
  it("customers_update: shows the customer's current email/phone/lifetime spend from context", async () => {
    const s = await summarizeCustomersUpdate(
      { input: { id: "gid://shopify/Customer/555", note: "Called about a return" } },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: CUSTOMER_CONTEXT_FIXTURE },
    )
    expect(s.title).toBe("Update customer Alex Rivera")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Email: alex\.rivera@example\.com/)
    expect(joined).toMatch(/Phone: \+1-555-0100/)
    expect(joined).toMatch(/Customer since: 2024-11-02/)
    expect(joined).toMatch(/Lifetime spend: 4200\.00 USD/)
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([
      {
        label: "Open customer in Shopify",
        url: "https://fabrikam.myshopify.com/admin/customers/555",
      },
    ])
  })

  it("customers_tag: names the customer from context instead of a bare gid", async () => {
    const s = await summarizeCustomersTag(
      { customerId: "gid://shopify/Customer/555", tags: ["vip"], op: "add" },
      undefined,
      { connectionIdentifier: "fabrikam.myshopify.com", context: CUSTOMER_CONTEXT_FIXTURE },
    )
    expect(s.title).toBe("Add tag on customer Alex Rivera")
  })

  it("customers_update degrades to the bare id when context is absent", async () => {
    const s = await summarizeCustomersUpdate({ input: { id: "gid://shopify/Customer/555" } })
    expect(s.title).toBe("Update customer 555")
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([])
  })
})

describe("summarizeProductsUpdate — rich card from summarizerContext (products_get)", () => {
  it("falls back to the CURRENT product title from context when the caller isn't renaming it", async () => {
    const s = await summarizeProductsUpdate(
      { input: { id: "gid://shopify/Product/100", status: "ACTIVE" } },
      undefined,
      {
        connectionIdentifier: "fabrikam.myshopify.com",
        context: {
          id: "gid://shopify/Product/100",
          entity: "product",
          title: "Kestrel 6 Recorder",
          market: null,
          currency: null,
          attributes: {},
        },
      },
    )
    expect(s.title).toBe("Update product Kestrel 6 Recorder")
    expect((s.links ?? []).filter((l) => "url" in l)).toEqual([
      {
        label: "Open product in Shopify",
        url: "https://fabrikam.myshopify.com/admin/products/100",
      },
    ])
  })

  it("shows the listing's creation date from context", async () => {
    const s = await summarizeProductsUpdate(
      { input: { id: "gid://shopify/Product/100", status: "ACTIVE" } },
      undefined,
      {
        connectionIdentifier: "fabrikam.myshopify.com",
        context: {
          id: "gid://shopify/Product/100",
          entity: "product",
          title: "Kestrel 6 Recorder",
          market: null,
          currency: null,
          attributes: { createdAt: "2023-06-15T00:00:00Z" },
        },
      },
    )
    expect(s.lines.join("\n")).toMatch(/Listed since: 2023-06-15/)
  })
})

describe("update summarizers never claim 'no changes' while payload fields exist", () => {
  // The live failure: a variants_update setting inventoryItem.requiresShipping=false rendered
  // "No field changes detected in the payload" — the approver had NO idea what they were
  // approving. Every field outside a summarizer's whitelist must still render as a legible
  // line, and consequence-bearing fields get first-class wording.
  it("variants_update: inventoryItem.requiresShipping=false renders the digital-good explanation", async () => {
    const s = await summarizeVariantsUpdate(
      {
        input: {
          id: "gid://shopify/ProductVariant/57467363623243",
          inventoryItem: { requiresShipping: false },
        },
      },
      undefined,
      {
        connectionIdentifier: "demo.myshopify.com",
        context: { title: "Tessera Sound - Default Title", sku: "EMB-SOUND" },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).not.toMatch(/No field changes detected/)
    expect(joined).toMatch(/Requires shipping -> no \(marks this a DIGITAL good/)
  })

  it("variants_update: requiresShipping=true renders the physical-good wording", async () => {
    const s = await summarizeVariantsUpdate({
      input: { id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } },
    })
    expect(s.lines.join("\n")).toMatch(/Requires shipping -> yes \(marks this a PHYSICAL good/)
  })

  it("variants_update: an unknown extra field still renders as a humanized line", async () => {
    const s = await summarizeVariantsUpdate({
      input: {
        id: "gid://shopify/ProductVariant/1",
        taxable: false,
        inventoryItem: { tracked: true },
      },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Taxable -> no/)
    expect(joined).toMatch(/Inventory tracking -> on/)
    expect(joined).not.toMatch(/No field changes detected/)
  })

  it("products_update: unlisted fields render instead of being swallowed", async () => {
    const s = await summarizeProductsUpdate({
      input: { id: "gid://shopify/Product/1", giftCard: true },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Gift card -> yes/)
    expect(joined).not.toMatch(/No field changes detected/)
  })

  it("customers_update: unlisted fields render instead of being swallowed", async () => {
    const s = await summarizeCustomersUpdate({
      input: { id: "gid://shopify/Customer/1", taxExempt: true },
    })
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Tax exempt -> yes/)
    expect(joined).not.toMatch(/No field changes detected/)
  })
})

describe("summarizeDraftOrderCreate -- computed effective prices (anti-fabrication oracle)", () => {
  it("shows effective unit price per discounted line and the projected order total", async () => {
    const s = await summarizeDraftOrderCreate(
      {
        input: {
          lineItems: [
            { quantity: 20, variantId: "gid://shopify/ProductVariant/1" },
            {
              quantity: 10,
              variantId: "gid://shopify/ProductVariant/2",
              appliedDiscount: {
                value: 14,
                valueType: "FIXED_AMOUNT",
                description: "PO unit price 53.00 vs list 67.00",
              },
            },
            {
              quantity: 10,
              variantId: "gid://shopify/ProductVariant/3",
              appliedDiscount: {
                value: 7,
                valueType: "FIXED_AMOUNT",
                description: "PO unit price 27.00 vs list 34.00",
              },
            },
          ],
        },
      },
      undefined,
      {
        connectionIdentifier: "demo.myshopify.com",
        context: {
          variants: [
            { id: "gid://shopify/ProductVariant/1", title: "Retail - Tessera", price: "599.00" },
            {
              id: "gid://shopify/ProductVariant/2",
              title: "Retail - Mounting Plate",
              price: "67.00",
            },
            { id: "gid://shopify/ProductVariant/3", title: "Retail - Hard Cover", price: "34.00" },
          ],
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toContain("-> 53.00/unit")
    expect(joined).toContain("-> 27.00/unit")
    expect(joined).toContain("Projected total before shipping/tax: 12780.00")
  })

  it("omits the projected total when a line has no resolvable list price", async () => {
    const s = await summarizeDraftOrderCreate({
      input: { lineItems: [{ quantity: 2, variantId: "gid://shopify/ProductVariant/unknown" }] },
    })
    expect(s.lines.join("\n")).not.toContain("Projected total")
  })
})

describe("summarizeProductsPublish / Unpublish: the card names the channels the call will act on", () => {
  // Prod regression: an id-only publish card said "Publishes to the default sales channel" while the
  // handler sent an empty channel list. The card now lists the channels resolved by
  // products_publication_targets (the summarizerContext), the same set the handler sends.
  const context = {
    id: "gid://shopify/Product/16099791012171",
    entity: "product",
    title: "Kestrel 6",
    attributes: {
      createdAt: "2026-10-01T10:00:00Z",
      publishTargets: [
        { publicationId: "gid://shopify/Publication/2", name: "Headless" },
        { publicationId: "gid://shopify/Publication/3", name: "Point of Sale" },
      ],
      unpublishTargets: [{ publicationId: "gid://shopify/Publication/1", name: "Online Store" }],
    },
  }
  const meta = { connectionIdentifier: "resonant-audio.myshopify.com", context }

  it("publish lists each target channel by name", async () => {
    const s = await summarizeProductsPublish(
      { id: "gid://shopify/Product/16099791012171" },
      undefined,
      meta,
    )
    expect(s.title).toBe("Publish product Kestrel 6")
    expect(s.lines).toContain("Sales channel: Headless")
    expect(s.lines).toContain("Sales channel: Point of Sale")
    expect(s.lines.join("\n")).not.toContain("default sales channel")
  })

  it("publish without hydrated context never claims a default sales channel", async () => {
    const s = await summarizeProductsPublish({ id: "gid://shopify/Product/1" }, undefined, {
      connectionIdentifier: null,
      context: null,
    })
    expect(s.lines.join("\n")).not.toContain("default sales channel")
    expect(s.lines.join("\n")).toContain("every channel this product is not on yet")
  })

  it("unpublish lists the channels it takes the product off", async () => {
    const s = await summarizeProductsUnpublish(
      { id: "gid://shopify/Product/16099791012171" },
      undefined,
      meta,
    )
    expect(s.lines).toContain("Sales channel: Online Store")
    expect(s.lines.join("\n")).not.toContain("default sales channel")
  })
})

describe("fulfilment cards say exactly what the shipping email policy will do", () => {
  // The handler decides Shopify's email by the org's policy at execution (lib/b2b.ts). The card is
  // staged first, so it reads the same policy and the order's B2B verdict from the hydrated read
  // (orders_get / fulfillments_get) and never promises an email it cannot vouch for.
  const META = (context: unknown) => ({ connectionIdentifier: "fabrikam.myshopify.com", context })
  const create = (notifyCustomer?: boolean) => ({
    orderId: "gid://shopify/Order/1",
    fulfillment: notifyCustomer === undefined ? {} : { notifyCustomer },
  })
  const retail = { b2b: false, reason: null }
  const b2b = { b2b: true, reason: "b2b_company_buyer" }

  const tracked = (notifyCustomer?: boolean) => ({
    orderId: "gid://shopify/Order/1",
    fulfillment: {
      trackingInfo: { company: "UPS", trackingNumber: "1Z999" },
      ...(notifyCustomer === undefined ? {} : { notifyCustomer }),
    },
  })

  it("retail_only: a retail order with tracking says the customer will be notified, whatever the caller passed", async () => {
    const s = await summarizeFulfillmentsCreate(
      tracked(false),
      undefined,
      META({ shippingEmailPolicy: "retail_only", b2bOrder: retail }),
    )
    expect(s.subtitle).toBe("Customer will be notified: retail order")
  })

  it("retail_only and all: a create without a tracking number says no email yet (the handler's no_tracking)", async () => {
    for (const ctx of [
      { shippingEmailPolicy: "retail_only", b2bOrder: retail },
      { shippingEmailPolicy: "all" },
    ]) {
      const s = await summarizeFulfillmentsCreate(create(true), undefined, META(ctx))
      expect(s.subtitle).toBe("Customer will not be notified: no tracking number yet")
    }
    const all = await summarizeFulfillmentsCreate(
      tracked(),
      undefined,
      META({ shippingEmailPolicy: "all" }),
    )
    expect(all.subtitle).toBe("Customer will be notified (policy: every order)")
  })

  it("retail_only: a B2B order says the customer will not be notified, even when the caller asks", async () => {
    const s = await summarizeFulfillmentsCreate(
      create(true),
      undefined,
      META({ shippingEmailPolicy: "retail_only", b2bOrder: b2b }),
    )
    expect(s.subtitle).toBe("Customer will not be notified: B2B order")
  })

  it("policy unset (caller): the caller's flag, as before", async () => {
    const yes = await summarizeFulfillmentsCreate(
      create(true),
      undefined,
      META({ shippingEmailPolicy: "caller", b2bOrder: b2b }),
    )
    expect(yes.subtitle).toBe("Customer WILL be notified")
    const no = await summarizeFulfillmentsCreate(
      create(),
      undefined,
      META({ shippingEmailPolicy: "caller" }),
    )
    expect(no.subtitle).toBe("No customer notification")
  })

  it("not knowable at staging (no read, no policy, no verdict): decided at execution", async () => {
    for (const meta of [
      undefined,
      META(null),
      META({ name: "#1" }),
      META({ shippingEmailPolicy: "retail_only" }),
    ]) {
      const s = await summarizeFulfillmentsCreate(create(true), undefined, meta)
      expect(s.subtitle).toBe("Notification decided at execution (store shipping email policy)")
    }
  })

  it("the tracking card reads the fulfilment's verdict and tracking: one email, with the first number only", async () => {
    const p = (info: Record<string, unknown>) => ({
      fulfillmentId: "gid://shopify/Fulfillment/1",
      trackingInfoInput: info,
      notifyCustomer: true,
    })
    const attrs = (b2bOrder: unknown, numbers: string[], policy = "retail_only") =>
      META({
        attributes: {
          shippingEmailPolicy: policy,
          b2bOrder,
          trackingInfo: numbers.map((number) => ({ number })),
        },
      })
    const card = async (info: Record<string, unknown>, meta: ReturnType<typeof META>) =>
      (await summarizeFulfillmentsUpdateTracking(p(info), undefined, meta)).subtitle
    expect(await card({ number: "1Z" }, attrs(b2b, []))).toBe(
      "Customer will not be notified: B2B order",
    )
    expect(await card({ number: "1Z" }, attrs(retail, []))).toBe(
      "Customer will be notified: retail order",
    )
    expect(await card({ number: "1Z" }, attrs(null, [], "all"))).toBe(
      "Customer will be notified (policy: every order)",
    )
    const already = "Customer will not be notified: the fulfillment already has a tracking number"
    expect(await card({ number: "1Z" }, attrs(retail, ["OLD"]))).toBe(already)
    expect(await card({ number: "1Z" }, attrs(retail, ["1Z"]))).toBe(already)
    expect(await card({ number: "1Z" }, attrs(null, ["OLD"], "all"))).toBe(already)
    expect(
      await card({ company: "DHL", url: "https://track.example.com/1Z" }, attrs(retail, [])),
    ).toBe("Customer will not be notified: no tracking number yet")
    expect(await card({ company: "DHL" }, attrs(retail, ["OLD"]))).toBe(
      "Customer will not be notified: no tracking number yet",
    )
    expect(await card({ number: "1Z" }, META(null))).toBe(
      "Notification decided at execution (store shipping email policy)",
    )
  })
})
