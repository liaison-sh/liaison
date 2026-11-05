// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quotes ARE Shopify draft orders -- the mirror's oracles.
//
// Drives the four `shopify/draft_order:*` handlers against the shared `createMockDb`
// generic-CRUD surface (the same shape the sandbox bridge exposes), with `shopify:*` calls
// stubbed at the cross-app envelope boundary.
//
// What these pin, in order of how badly each would hurt:
//   * ONE quote per draft order. Two event producers (webhook + tool) can deliver the same
//     create twice; a duplicate here is a duplicate offer sent to a customer.
//   * The thin TOOL-shaped event (only a gid, no line items) must produce the same quote as
//     the fat webhook one, via the draft_orders_get re-fetch.
//   * An incomplete counterparty WAITS instead of failing: the address usually lands on a
//     later draft_orders/update, and refusing then would lose the quote entirely.
//   * completed -> invoiced (and NOT an invoice issued here: the order flow does that),
//     deleted -> rejected.

import { describe, expect, test } from "bun:test"
import type { CrossAppEnvelope } from "../cross-app"
import type { MutationsCtx } from "../mutations"
import { createMockDb, type MockDb } from "../test-db"
import {
  draftOrderLinesToItems,
  netOfIncludedTax,
  majorAmountToMinor,
  onShopifyDraftOrderCompleted,
  onShopifyDraftOrderCreated,
  syncQuoteFromDraftOrder,
  onShopifyDraftOrderDeleted,
  onShopifyDraftOrderUpdated,
  type DraftOrderCtx,
  type NormalizedDraftOrder,
} from "./shopify-draft-order"

const SHOP = "acme.myshopify.com"
const DRAFT_GID = "gid://shopify/DraftOrder/77"

interface Extras {
  executeToolCalls: Array<{ name: string; args: Record<string, unknown> }>
  approvalsRequested: string[]
  resolveContactCalls: Array<{ email?: string; name?: string; externalId?: string }>
}

function issuerRow(): Record<string, unknown> {
  return {
    id: "iss-1",
    legal_name: "Acme SAS",
    country: "FR",
    vat_id: "FR12345678901",
    address: "1 rue Test",
    iban: null,
    swift_bic: null,
    bank_name: null,
    default_language: "fr",
    prefix_invoice: "INV-{YYYY}-",
    prefix_quote: "QUO-{YYYY}-",
    prefix_proforma: "PRO-{YYYY}-",
    prefix_po: "PO-{YYYY}-",
    prefix_credit_note: "CN-{YYYY}-",
    invoice_approval_threshold_minor: null,
    po_approval_threshold_minor: null,
    require_two_eyes: false,
    mail_account_id: null,
    shopify_shop_id: SHOP,
  }
}

function address(overrides?: Record<string, unknown>): NormalizedDraftOrder["billingAddress"] {
  return {
    name: "Buyer SARL",
    company: "Buyer SARL",
    address1: "1 rue Buyer",
    address2: null,
    zip: "75002",
    city: "Paris",
    province: null,
    countryCode: "FR",
    phone: null,
    ...overrides,
  } as NormalizedDraftOrder["billingAddress"]
}

function draftOrder(overrides?: Partial<NormalizedDraftOrder>): NormalizedDraftOrder {
  return {
    draftOrderId: DRAFT_GID,
    name: "#D77",
    status: "open",
    orderId: null,
    orderName: null,
    shopDomain: SHOP,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    currency: "EUR",
    currencyIsPresentment: true,
    totalPrice: "120.00",
    subtotalPrice: "100.00",
    totalTax: "20.00",
    taxesIncluded: false,
    taxExempt: false,
    email: "ap@buyersarl.example",
    note: null,
    tags: [],
    customer: {
      id: "gid://shopify/Customer/42",
      email: "ap@buyersarl.example",
      firstName: "Buyer",
      lastName: "SARL",
      company: null,
    },
    billingAddress: address(),
    shippingAddress: null,
    appliedDiscount: null,
    shippingLine: null,
    taxLines: [],
    lineItems: [
      {
        id: "gid://shopify/DraftOrderLineItem/1",
        title: "Widget",
        sku: "WID-1",
        variantId: "gid://shopify/ProductVariant/9",
        productId: "gid://shopify/Product/3",
        quantity: 2,
        unitPrice: "50.00",
        discountedTotal: "100.00",
        appliedDiscount: null,
        taxable: true,
        requiresShipping: true,
        custom: false,
      },
    ],
    ...overrides,
  }
}

function makeCtx(opts?: {
  seedIssuer?: boolean
  draft?: NormalizedDraftOrder
  getEnvelope?: CrossAppEnvelope
}): { ctx: DraftOrderCtx; db: MockDb; extras: Extras } {
  const db = createMockDb({
    seed: opts?.seedIssuer === false ? {} : { issuer_profiles: [issuerRow()] },
  })
  const extras: Extras = {
    executeToolCalls: [],
    approvalsRequested: [],
    resolveContactCalls: [],
  }
  let idSeq = 0
  const ctx: DraftOrderCtx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    sequences: {
      async allocate({ key }) {
        const existing = await db.findMany("__sequences", { where: { key }, limit: 1 })
        const current = existing[0] as { value?: number; id?: string } | undefined
        const next = (current?.value ?? 0) + 1
        if (current?.id) await db.update("__sequences", String(current.id), { value: next })
        else await db.insert("__sequences", { key, value: next })
        return { value: next }
      },
    },
    pdf: {
      async render() {
        idSeq += 1
        return { file_id: `pdf-${idSeq}`, byte_size: 1024, page_count: 1, sha256: "0".repeat(64), parent_entity_id: crypto.randomUUID() }
      },
    },
    messages: {
      async post() {
        idSeq += 1
        return { message_id: `msg-${idSeq}` }
      },
    },
    async requestApproval(input) {
      extras.approvalsRequested.push(input.tool_name)
      return { approval_id: `appr-${extras.approvalsRequested.length}` }
    },
    async decideApproval() {
      return { status: "ok" }
    },
    async executeTool(name, args) {
      extras.executeToolCalls.push({ name, args })
      if (name === "shopify:draft_orders_get") {
        return (
          opts?.getEnvelope ?? {
            status: "completed",
            result: { draftOrder: opts?.draft ?? draftOrder() },
          }
        )
      }
      return { status: "completed", result: {} }
    },
    async emit() {},
    async resolveContact(params) {
      extras.resolveContactCalls.push(params)
      return { id: "contact-resolved-1" }
    },
  }
  return { ctx, db, extras }
}

function quotes(db: MockDb): Array<Record<string, unknown>> {
  return db.__all("documents").filter((d) => d.type === "quote")
}

// ── The mirror ─────────────────────────────────────────────────────────────

describe("shopify draft_order:created -> quote", () => {
  test("an event without line items is re-fetched and becomes exactly one sent quote", async () => {
    const { ctx, db, extras } = makeCtx()
    const r = await onShopifyDraftOrderCreated(
      { entityId: DRAFT_GID, data: { draftOrder: { id: DRAFT_GID } } },
      ctx,
    )
    expect(r.status).toBe("created")
    // The thin tool-shaped event carries no lines, so the sync MUST re-fetch.
    expect(extras.executeToolCalls.map((c) => c.name)).toContain("shopify:draft_orders_get")
    const all = quotes(db)
    expect(all).toHaveLength(1)
    const q = all[0]!
    expect(q.status).toBe("sent")
    expect(q.shopify_draft_order_id).toBe(DRAFT_GID)
    expect(q.shopify_draft_order_name).toBe("#D77")
    expect(q.counterparty_name).toBe("Buyer SARL")
    expect(q.counterparty_country).toBe("FR")
    expect(q.counterparty_email).toBe("ap@buyersarl.example")
    expect(q.counterparty_contact_id).toBe("contact-resolved-1")
    // 2 x 50.00 EUR = 10_000 minor, + 20% FR domestic VAT.
    expect(String(q.subtotal_minor)).toBe("10000")
    expect(String(q.grand_total_minor)).toBe("12000")
    const lines = db.__all("document_lines").filter((l) => l.document_id === q.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe("Widget")
    expect(String(lines[0]!.unit_price_minor)).toBe("5000")
    expect(lines[0]!.product_source).toBe("shopify")
    expect(lines[0]!.external_id).toBe("gid://shopify/ProductVariant/9")
  })

  // red: drop the poNumber consumption in syncQuoteFromDraftOrder's create path -> a PO number
  // a salesperson typed into the Shopify draft order admin never reaches the quote, even
  // though this is the flow a salesperson is most likely to use.
  test("a PO number typed on the draft order in Shopify reaches the quote, audited as shopify_sync", async () => {
    const { ctx, db } = makeCtx()
    const r = await onShopifyDraftOrderCreated(
      { entityId: DRAFT_GID, data: draftOrder({ poNumber: "PO-4471" }) },
      ctx,
    )
    expect(r.status).toBe("created")
    const q = quotes(db)[0]!
    expect(q.po_number).toBe("PO-4471")
    const log = q.lifecycle_log as Array<Record<string, unknown>>
    const change = log.find((e) => e.event === "po_number_changed")
    expect(change?.to).toBe("PO-4471")
    expect(change?.source).toBe("shopify_sync")
  })

  test("no PO number on the draft order leaves the quote's po_number null", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    expect(quotes(db)[0]!.po_number).toBeNull()
  })

  test("the same event twice still leaves ONE quote (idempotent on the draft order gid)", async () => {
    const { ctx, db } = makeCtx()
    const event = { entityId: DRAFT_GID, data: { draftOrder: { id: DRAFT_GID } } }
    const first = await onShopifyDraftOrderCreated(event, ctx)
    const second = await onShopifyDraftOrderCreated(event, ctx)
    expect(first.status).toBe("created")
    // The second delivery finds the quote and refreshes it rather than issuing a new one.
    expect(second.status).toBe("updated")
    expect(quotes(db)).toHaveLength(1)
  })

  test("a webhook event carrying the full draft order needs no re-fetch", async () => {
    const { ctx, db, extras } = makeCtx()
    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    expect(r.status).toBe("created")
    expect(extras.executeToolCalls.map((c) => c.name)).not.toContain("shopify:draft_orders_get")
    expect(quotes(db)).toHaveLength(1)
  })

  test("an event whose currency is NOT known to be the presentment one is re-fetched, and the quote takes the authoritative currency", async () => {
    // Every amount on the normalized shape is presentment, so a shop-currency
    // label mislabels the money rather than converting it: draft #D332 quoted
    // 149.00 USD and the quote came out 149.00 EUR. A producer that could only
    // resolve the SHOP currency says so, and this handler goes back to
    // draft_orders_get rather than trusting it.
    const shopLabelled = draftOrder({ currency: "EUR", currencyIsPresentment: false })
    const authoritative = draftOrder({ currency: "USD", currencyIsPresentment: true })
    const { ctx, db, extras } = makeCtx({ draft: authoritative })

    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: shopLabelled }, ctx)
    expect(r.status).toBe("created")
    // It went back to the authoritative read...
    expect(extras.executeToolCalls.map((c) => c.name)).toContain("shopify:draft_orders_get")
    // ...and the quote is in the buyer's currency, not the shop's.
    expect(quotes(db)[0]!.currency).toBe("USD")
  })

  test("line discount, order discount share and carriage all reach the quote", async () => {
    const draft = draftOrder({
      lineItems: [
        {
          id: "l1",
          title: "Widget",
          sku: null,
          variantId: "gid://shopify/ProductVariant/9",
          productId: null,
          quantity: 2,
          unitPrice: "50.00",
          discountedTotal: "90.00",
          appliedDiscount: { valueType: "FIXED_AMOUNT", value: "10.00", amount: "10.00" },
          taxable: true,
          requiresShipping: true,
          custom: false,
        },
        {
          id: "l2",
          title: "License",
          sku: null,
          variantId: null,
          productId: null,
          quantity: 1,
          unitPrice: "50.00",
          discountedTotal: "50.00",
          appliedDiscount: null,
          taxable: true,
          requiresShipping: false,
          custom: true,
        },
      ],
      appliedDiscount: {
        title: "Dealer",
        description: null,
        valueType: "FIXED_AMOUNT",
        value: "15.00",
        amount: "15.00",
      },
      shippingLine: { title: "Colissimo", price: "9.90" },
      // (100.00 + 50.00 - 15.00 - 10.00 + 9.90) x 1.20 = 161.88: matches what the quote computes,
      // so this case does not trip the total-drift warning.
      totalPrice: "161.88",
    })
    const { ctx, db } = makeCtx({ draft })
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    const q = quotes(db)[0]!
    const lines = (db.__all("document_lines") as Array<Record<string, unknown>>)
      .filter((l) => l.document_id === q.id)
      .sort((a, b) => Number(a.position) - Number(b.position))
    expect(lines).toHaveLength(3)
    // Order-level 15.00 spread by line value (100.00 vs 50.00 gross): 10.00 + 5.00, and the
    // line's OWN 10.00 discount stays on top of its share.
    expect(String(lines[0]!.discount_minor)).toBe("2000")
    expect(String(lines[1]!.discount_minor)).toBe("500")
    // A line Shopify says needs no shipping is software; carriage is its own shipping line.
    expect(lines[1]!.line_kind).toBe("software")
    expect(lines[2]!.line_kind).toBe("shipping")
    expect(String(lines[2]!.unit_price_minor)).toBe("990")
    // A custom line carries no catalog reference.
    expect(lines[1]!.product_source).toBeNull()
  })

  test("an incomplete counterparty is skipped, and the update that adds the address creates it", async () => {
    const incomplete = draftOrder({ billingAddress: null, shippingAddress: null })
    const { ctx, db } = makeCtx({ draft: incomplete })
    const skipped = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    expect(skipped.status).toBe("skipped")
    if (skipped.status !== "skipped") throw new Error("unreachable")
    expect(skipped.reason).toBe("counterparty_incomplete")
    expect(quotes(db)).toHaveLength(0)

    // Morgan fills the address in; the next update carries it.
    const later = await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    expect(later.status).toBe("created")
    expect(quotes(db)).toHaveLength(1)
  })

  // Shopify keeps the buyer email only on digital-goods drafts, so a physical-goods draft made
  // by the invoicing quote tool comes back without one. The tool knows the recipient, and hands
  // it to the sync as a fallback; the quote must not be skipped for a field the caller has.
  test("a draft without email or customer is completed from the caller's counterparty", async () => {
    const bare = draftOrder({ email: null, customer: null })
    const { ctx, db } = makeCtx({ draft: bare })
    const r = await syncQuoteFromDraftOrder(ctx, {
      draftOrderId: DRAFT_GID,
      counterpartyFallback: {
        contact_id: "contact-from-tool",
        legal_name: "Buyer SARL",
        address: "1 rue Buyer, 75002 Paris",
        country: "FR",
        email: "ap@buyersarl.example",
        vat_id: "FR12345678901",
      },
    })
    expect(r.status).toBe("created")
    const q = quotes(db)[0]!
    expect(q.counterparty_email).toBe("ap@buyersarl.example")
    expect(q.counterparty_vat_id).toBe("FR12345678901")
    // The draft's own address wins over the fallback when it has one.
    expect(String(q.counterparty_address)).toContain("1 rue Buyer")
  })

  // Requested by Priya: a draft order routinely ships somewhere the quote is not billed to. The
  // ship to used to be visible to this handler only as a BILLING fallback, then dropped.
  test("a draft order's shipping address is stored as its own ship to, billing untouched", async () => {
    const { ctx, db } = makeCtx({
      draft: draftOrder({
        billingAddress: address(),
        shippingAddress: address({
          name: "Spedition Nord KG",
          company: null,
          address1: "Am Hafen 12",
          zip: "21079",
          city: "Hamburg",
          countryCode: "DE",
        }),
      }),
    })
    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("created")
    const q = quotes(db)[0]!
    expect(String(q.counterparty_address)).toContain("1 rue Buyer")
    expect(String(q.counterparty_shipping_address)).toContain("Am Hafen 12")
    expect(String(q.counterparty_shipping_address)).toContain("21079 Hamburg")
    // Country folded into the ship to block, which prints no separate country line.
    expect(String(q.counterparty_shipping_address)).toContain("DE")
    expect(q.counterparty_shipping_name).toBe("Spedition Nord KG")
    // HARD CONSTRAINT: the tax country is still the BILLING country.
    expect(q.counterparty_country).toBe("FR")
  })

  test("a draft order with no shipping address stores a null ship to, not a copy of the billing one", async () => {
    const { ctx, db } = makeCtx({ draft: draftOrder({ shippingAddress: null }) })
    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("created")
    const q = quotes(db)[0]!
    expect(q.counterparty_shipping_address ?? null).toBeNull()
    expect(q.counterparty_shipping_name ?? null).toBeNull()
  })

  test("a LATER edit that changes only the shipping address updates the quote's ship to", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    const edited = draftOrder({
      shippingAddress: address({ name: "New Site Contact", company: null, address1: "4 Quai Neuf" }),
    })
    const r = await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: edited }, ctx)
    expect(r.status).toBe("updated")
    const q = quotes(db)[0]!
    expect(String(q.counterparty_shipping_address)).toContain("4 Quai Neuf")
    expect(q.counterparty_shipping_name).toBe("New Site Contact")
  })

  test("no issuer mapped to the shop: skipped, nothing written", async () => {
    const { ctx, db } = makeCtx({ seedIssuer: false })
    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("skipped")
    if (r.status !== "skipped") throw new Error("unreachable")
    expect(r.reason).toBe("issuer_mapping_missing")
    expect(quotes(db)).toHaveLength(0)
  })

  test("an event with no draft order id at all is skipped, not thrown", async () => {
    const { ctx, db } = makeCtx()
    const r = await onShopifyDraftOrderCreated({}, ctx)
    expect(r.status).toBe("skipped")
    if (r.status !== "skipped") throw new Error("unreachable")
    expect(r.reason).toBe("draft_order_id_missing")
    expect(quotes(db)).toHaveLength(0)
  })

  test("a failing draft_orders_get returns an error envelope instead of throwing", async () => {
    const { ctx, db } = makeCtx({
      getEnvelope: { status: "error", error: { code: "shop_unreachable", message: "boom" } },
    })
    const r = await onShopifyDraftOrderCreated({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("shop_unreachable")
    expect(quotes(db)).toHaveLength(0)
  })
})

describe("shopify draft_order:updated -> quote", () => {
  test("an edit in Shopify is applied to the still-sent quote", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const edited = draftOrder({
      lineItems: [
        {
          id: "l1",
          title: "Widget XL",
          sku: null,
          variantId: "gid://shopify/ProductVariant/9",
          productId: null,
          quantity: 3,
          unitPrice: "60.00",
          discountedTotal: "180.00",
          appliedDiscount: null,
          taxable: true,
          requiresShipping: true,
          custom: false,
        },
      ],
      billingAddress: address({ address1: "9 avenue Neuve" }),
      totalPrice: "216.00",
    })
    const r = await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: edited }, ctx)
    expect(r.status).toBe("updated")
    expect(quotes(db)).toHaveLength(1)
    const q = quotes(db)[0]!
    expect(String(q.subtotal_minor)).toBe("18000")
    expect(String(q.grand_total_minor)).toBe("21600")
    expect(String(q.counterparty_address)).toContain("9 avenue Neuve")
    const lines = db.__all("document_lines").filter((l) => l.document_id === q.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe("Widget XL")
  })

  // red: drop the poNumber thread-through in syncQuoteFromDraftOrder's update path -> a
  // salesperson correcting the PO number on an OPEN draft order after creating it sees the
  // quote silently keep the old (or no) value forever.
  test("a LATER edit of the draft order's PO number updates the quote's PO, not just at create", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder({ poNumber: "PO-1000" }) }, ctx)
    expect(quotes(db)[0]!.po_number).toBe("PO-1000")

    const edited = draftOrder({ poNumber: "PO-2000" })
    const r = await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: edited }, ctx)
    expect(r.status).toBe("updated")
    const q = quotes(db)[0]!
    expect(q.po_number).toBe("PO-2000")
    const log = q.lifecycle_log as Array<Record<string, unknown>>
    const changes = log.filter((e) => e.event === "po_number_changed")
    expect(changes).toHaveLength(2)
    expect(changes[1]?.from).toBe("PO-1000")
    expect(changes[1]?.to).toBe("PO-2000")
    expect(changes[1]?.source).toBe("shopify_sync")
  })

  test("an update payload with no PO number does not erase an already-recorded one", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder({ poNumber: "PO-1000" }) }, ctx)
    const edited = draftOrder({ totalPrice: "999.00" }) // no poNumber on this payload
    await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: edited }, ctx)
    expect(quotes(db)[0]!.po_number).toBe("PO-1000")
  })

  test("a settled quote is left alone (an accepted offer is not rewritten under the customer)", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const q = quotes(db)[0]!
    await db.update("documents", String(q.id), { status: "accepted" })
    const edited = draftOrder({ totalPrice: "999.00" })
    const r = await onShopifyDraftOrderUpdated({ entityId: DRAFT_GID, data: edited }, ctx)
    expect(r.status).toBe("noop")
    const after = db.__all("documents").find((d) => d.id === q.id)!
    expect(after.status).toBe("accepted")
    expect(String(after.grand_total_minor)).toBe("12000")
  })
})

describe("shopify draft_order:completed -> quote invoiced", () => {
  test("the quote is invoiced and stamped with the order; no invoice is issued here", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const completed = draftOrder({
      status: "completed",
      orderId: "gid://shopify/Order/900",
      orderName: "#1149",
    })
    const r = await onShopifyDraftOrderCompleted({ entityId: DRAFT_GID, data: completed }, ctx)
    expect(r.status).toBe("invoiced")
    const q = quotes(db)[0]!
    expect(q.status).toBe("invoiced")
    const refs = q.external_refs as Record<string, unknown>
    expect(refs.shopify_order_id).toBe("900")
    expect(refs.shopify_order_number).toBe("#1149")
    expect((q.lifecycle_log as Array<Record<string, unknown>>).map((e) => e.event)).toContain(
      "draft_order_completed",
    )
    // The INVOICE comes from shopify/order:created, never from this handler.
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)
  })

  test("settles on the draft's FINAL lines, not on whatever was last synced", async () => {
    // Draft #D332 had a 25.48 line discount added shortly before it was
    // completed, and quote QUO-2026-0006 froze at the undiscounted price:
    // completion marked the quote invoiced and returned without ever re-syncing
    // the lines, so the last edit before completion was lost for good.
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const linesOf = (id: unknown) =>
      (db.__all("document_lines") as Array<Record<string, unknown>>).filter(
        (l) => l.document_id === id,
      )
    expect(String(linesOf(quotes(db)[0]!.id)[0]!.discount_minor)).toBe("0")

    const discounted = draftOrder({
      status: "completed",
      orderId: "gid://shopify/Order/900",
      orderName: "#1149",
      lineItems: [
        {
          ...draftOrder().lineItems[0]!,
          discountedTotal: "74.52",
          appliedDiscount: { valueType: "FIXED_AMOUNT", value: "25.48", amount: "25.48" },
        },
      ],
    })
    const r = await onShopifyDraftOrderCompleted({ entityId: DRAFT_GID, data: discounted }, ctx)
    expect(r.status).toBe("invoiced")
    const q = quotes(db)[0]!
    // The settled record carries the discount the customer actually got...
    expect(String(linesOf(q.id)[0]!.discount_minor)).toBe("2548")
    // ...and is still properly settled.
    expect(q.status).toBe("invoiced")
    expect((q.external_refs as Record<string, unknown>).shopify_order_id).toBe("900")
  })

  test("completing twice is a no-op (an already invoiced quote is not re-stamped)", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const completed = draftOrder({
      status: "completed",
      orderId: "gid://shopify/Order/900",
      orderName: "#1149",
    })
    await onShopifyDraftOrderCompleted({ entityId: DRAFT_GID, data: completed }, ctx)
    const second = await onShopifyDraftOrderCompleted({ entityId: DRAFT_GID, data: completed }, ctx)
    expect(second.status).toBe("noop")
    const log = quotes(db)[0]!.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === "draft_order_completed")).toHaveLength(1)
  })

  test("a completed draft order with no quote of ours is skipped", async () => {
    const { ctx, db } = makeCtx()
    const completed = draftOrder({ status: "completed", orderId: "gid://shopify/Order/900" })
    const r = await onShopifyDraftOrderCompleted({ entityId: DRAFT_GID, data: completed }, ctx)
    expect(r.status).toBe("skipped")
    if (r.status !== "skipped") throw new Error("unreachable")
    expect(r.reason).toBe("no_quote")
    expect(quotes(db)).toHaveLength(0)
  })
})

describe("shopify draft_order:deleted -> quote rejected", () => {
  test("deleting the draft order rejects the quote", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const r = await onShopifyDraftOrderDeleted({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("rejected")
    const q = quotes(db)[0]!
    expect(q.status).toBe("rejected")
    expect((q.lifecycle_log as Array<Record<string, unknown>>).map((e) => e.event)).toContain(
      "draft_order_deleted",
    )
  })

  test("a delete never re-fetches the draft order (it no longer exists)", async () => {
    const { ctx, extras } = makeCtx()
    await onShopifyDraftOrderDeleted({ entityId: DRAFT_GID }, ctx)
    expect(extras.executeToolCalls).toHaveLength(0)
  })

  test("deleting an already invoiced quote is a no-op", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyDraftOrderCreated({ entityId: DRAFT_GID, data: draftOrder() }, ctx)
    const q = quotes(db)[0]!
    await db.update("documents", String(q.id), { status: "invoiced" })
    const r = await onShopifyDraftOrderDeleted({ entityId: DRAFT_GID }, ctx)
    expect(r.status).toBe("noop")
    expect(db.__all("documents").find((d) => d.id === q.id)!.status).toBe("invoiced")
  })
})

// ── Pure mappers ───────────────────────────────────────────────────────────

describe("draft order money + line mapping (pure)", () => {
  // The EU shop prices tax-inclusive: Shopify's 1.20 EUR line is 1.00 net + 20% VAT. The quote
  // stores net prices and adds its own tax, so mirroring 1.20 as net would bill VAT twice
  // (the first prod round-trip did exactly that: a 1.00 draft became a 1.20 quote).
  test("tax-inclusive draft prices are divided out to net before the quote adds VAT", () => {
    const d = draftOrder({
      taxesIncluded: true,
      taxLines: [{ title: "FR TVA", rate: 0.2, price: "0.20" }],
      shippingLine: { title: "Colissimo", price: "6.00" },
      lineItems: [
        {
          id: null, title: "Tessera 2", sku: null, variantId: "gid://shopify/ProductVariant/9", productId: null,
          quantity: 2, unitPrice: "1.20", discountedTotal: "2.40", appliedDiscount: null,
          taxable: true, requiresShipping: true, custom: false,
        },
        {
          id: null, title: "Tax free item", sku: null, variantId: null, productId: null,
          quantity: 1, unitPrice: "5.00", discountedTotal: "5.00", appliedDiscount: null,
          taxable: false, requiresShipping: true, custom: true,
        },
      ],
    })
    const items = draftOrderLinesToItems(d)
    expect(String(items[0]!.unit_price_minor)).toBe("100")
    expect(String(items[1]!.unit_price_minor)).toBe("500")
    expect(String(items[2]!.unit_price_minor)).toBe("500")
    expect(items[2]!.line_kind).toBe("shipping")
  })

  test("net-priced drafts and tax-free drafts keep their prices as they are", () => {
    expect(String(draftOrderLinesToItems(draftOrder({ taxesIncluded: false }))[0]!.unit_price_minor)).toBe("5000")
    expect(
      String(draftOrderLinesToItems(draftOrder({ taxesIncluded: true, taxLines: [] }))[0]!.unit_price_minor),
    ).toBe("5000")
    expect(String(netOfIncludedTax(12000n, 2000))).toBe("10000")
    expect(String(netOfIncludedTax(100n, 2000))).toBe("83")
  })


  test("major amounts convert to minor units, zero-decimal currencies included", () => {
    expect(majorAmountToMinor("419.40", "EUR")).toBe(41940n)
    expect(majorAmountToMinor("419.4", "EUR")).toBe(41940n)
    expect(majorAmountToMinor("0", "EUR")).toBe(0n)
    expect(majorAmountToMinor(null, "EUR")).toBe(0n)
    expect(majorAmountToMinor("-12.50", "EUR")).toBe(-1250n)
    expect(majorAmountToMinor("5000", "JPY")).toBe(5000n)
  })

  test("the order-level discount's rounding remainder lands on the last line", () => {
    // 10.00 spread over three equal lines is 3.33 each: the last line takes 3.34 so the parts
    // sum EXACTLY to what Shopify discounted.
    const draft = draftOrder({
      appliedDiscount: {
        title: null,
        description: null,
        valueType: "FIXED_AMOUNT",
        value: "10.00",
        amount: "10.00",
      },
      lineItems: [1, 2, 3].map((n) => ({
        id: `l${n}`,
        title: `Item ${n}`,
        sku: null,
        variantId: null,
        productId: null,
        quantity: 1,
        unitPrice: "10.00",
        discountedTotal: "10.00",
        appliedDiscount: null,
        taxable: true,
        requiresShipping: true,
        custom: true,
      })),
    })
    const items = draftOrderLinesToItems(draft)
    const discounts = items.map((i) => BigInt(String(i.discount_minor ?? 0n)))
    expect(discounts).toEqual([333n, 333n, 334n])
    expect(discounts.reduce((a, b) => a + b, 0n)).toBe(1000n)
  })
})

// A DraftOrderCtx is a MutationsCtx: the sync reuses the very tools the UI and agents call,
// so a quote built from a draft order is built by the same code as any other quote.
const _ctxIsMutationsCtx: (c: DraftOrderCtx) => MutationsCtx = (c) => c
void _ctxIsMutationsCtx

// ── prices_include_tax mismatch ────────────────────────────────────────────
//
// The issuer profile's `prices_include_tax` is meant to MIRROR the shop's "include tax in
// prices". When the two disagree, a price typed in Liaison means something different from the
// same price typed in the Shopify admin, so the sync says so. It must only WARN: this draft
// order's own `taxesIncluded` is authoritative for this draft, so the quote is unchanged.

describe("issuer prices_include_tax vs the shop setting", () => {
  async function syncWithCapturedWarnings(
    profileSaysInclusive: boolean,
    draftTaxesIncluded: boolean,
  ): Promise<{ warnings: string[]; result: Awaited<ReturnType<typeof syncQuoteFromDraftOrder>>; db: MockDb }> {
    const draft = draftOrder({
      taxesIncluded: draftTaxesIncluded,
      ...(draftTaxesIncluded ? { taxLines: [{ title: "VAT", rate: 0.2, price: "20.00" }] } : {}),
    })
    const { ctx, db } = makeCtx({ draft })
    await db.update("issuer_profiles", "iss-1", { prices_include_tax: profileSaysInclusive })
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "))
    }
    try {
      const result = await syncQuoteFromDraftOrder(ctx, { draftOrderId: DRAFT_GID, draft })
      return { warnings, result, db }
    } finally {
      console.warn = realWarn
    }
  }

  test("profile says inclusive, the draft order is net: warns and still creates the quote", async () => {
    const { warnings, result, db } = await syncWithCapturedWarnings(true, false)
    expect(result.status).toBe("created")
    expect(
      warnings.some((w) => w.includes("set prices_include_tax on the issuer profile to match the shop")),
    ).toBe(true)
    // Unchanged: the draft order's own flag drove the lines, so 2 x 50.00 net stands.
    const q = quotes(db)[0]!
    expect(String(q.subtotal_minor)).toBe("10000")
    expect(String(q.tax_total_minor)).toBe("2000")
  })

  test("profile and shop agree: no mismatch warning", async () => {
    const { warnings, result } = await syncWithCapturedWarnings(false, false)
    expect(result.status).toBe("created")
    expect(warnings.some((w) => w.includes("set prices_include_tax on the issuer profile"))).toBe(
      false,
    )
  })

  test("both inclusive: no warning, and the included tax is still divided out of the lines", async () => {
    const { warnings, result, db } = await syncWithCapturedWarnings(true, true)
    expect(result.status).toBe("created")
    expect(warnings.some((w) => w.includes("set prices_include_tax on the issuer profile"))).toBe(
      false,
    )
    const q = quotes(db)[0]!
    // 2 x 50.00 gross at 20% -> 2 x 41.67 net.
    expect(String(q.subtotal_minor)).toBe("8334")
  })
})
