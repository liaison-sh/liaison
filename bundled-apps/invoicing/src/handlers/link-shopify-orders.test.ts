// SPDX-License-Identifier: FSL-1.1-ALv2
//
// documents_link_shopify_orders: an issued document that names its Shopify order only by number
// learns the order's id, and only when the order provably belongs to the document's buyer in the
// issuer profile's own shop. Harness: createMockDb + an executeTool stubbed by tool name.

import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import {
  type LinkOrdersCtx,
  type LinkOrdersEnvelope,
  linkShopifyOrders,
  SHOPIFY_ORDER_LINKED_EVENT,
} from "./link-shopify-orders"

const SHOP = "example-shop.myshopify.com"
const ISSUER = "11111111-1111-4111-8111-111111111111"

function issuer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ISSUER, legal_name: "Example SAS", shopify_shop_id: SHOP, ...over }
}

function legacyDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc-1",
    type: "invoice",
    status: "paid",
    number: "1001",
    issuer_profile_id: ISSUER,
    shopify_order_id: null,
    shopify_order_number: "1001",
    counterparty_email: "Buyer@Example.test ",
    counterparty_contact_id: null,
    total_ttc: 120,
    lines: [{ description: "Thing", quantity: 1, unit_price: 100 }],
    lifecycle_log: [{ event: "imported", ts: "2026-01-01T00:00:00Z" }],
    ...over,
  }
}

interface OrderHit {
  id: string
  title: string
  attributes: { email?: string | null; customer?: { id?: string; email?: string | null } | null }
}

function hit(name: string, numericId: string, email: string | null, customerId?: string): OrderHit {
  return {
    id: `gid://shopify/Order/${numericId}`,
    title: name,
    attributes: {
      email,
      customer: customerId ? { id: `gid://shopify/Customer/${customerId}`, email } : null,
    },
  }
}

function makeCtx(opts: {
  docs: Array<Record<string, unknown>>
  issuers?: Array<Record<string, unknown>>
  /** Order hits per searched name ("#1001"). */
  orders?: Record<string, OrderHit[]>
  shopDomain?: string | null
  search?: (args: Record<string, unknown>) => LinkOrdersEnvelope | undefined
  contacts?: Record<string, { email?: string | null; externalIds?: Record<string, string> }>
}): {
  ctx: LinkOrdersCtx
  db: MockDb
  calls: Array<{ target: string; args: Record<string, unknown> }>
} {
  const db = createMockDb({
    seed: { documents: opts.docs, issuer_profiles: opts.issuers ?? [issuer()] },
  })
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const ctx: LinkOrdersCtx = {
    db,
    async executeTool(target, args) {
      calls.push({ target, args })
      if (target === "shopify:orders_search") {
        const custom = opts.search?.(args)
        if (custom) return custom
        const m = /^name:(.+)$/.exec(String(args.query ?? ""))
        const name = m ? (m[1] as string).replace(/^"|"$/g, "") : ""
        return {
          status: "completed",
          result: {
            results: opts.orders?.[name] ?? [],
            ...(opts.shopDomain === null ? {} : { shopDomain: opts.shopDomain ?? SHOP }),
          },
        }
      }
      if (target === "kernel:contacts_read") {
        const c = opts.contacts?.[String(args.contactId)]
        if (!c) return { status: "error", error: { code: "NOT_FOUND", message: "no contact" } }
        return { status: "completed", result: { contact: { id: args.contactId, ...c } } }
      }
      return { status: "error", error: { code: "UNKNOWN_TOOL", message: target } }
    },
  }
  return { ctx, db, calls }
}

function row(db: MockDb, id: string): Record<string, unknown> {
  const found = db.__all("documents").find((d) => d.id === id)
  if (!found) throw new Error(`no document ${id}`)
  return found
}

function outcomeOf(res: Record<string, unknown>, id: string): string | undefined {
  const results = res.results as Array<{ document_id: string; outcome: string }>
  return results.find((r) => r.document_id === id)?.outcome
}

describe("linkShopifyOrders", () => {
  test("links an issued document to its order when the order's email is the buyer's", async () => {
    const before = legacyDoc()
    const { ctx, db } = makeCtx({
      docs: [before],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(res.linked).toBe(1)
    const after = row(db, "doc-1")
    expect(after.shopify_order_id).toBe("5550001")
    // Only the link column and the log move: no legal field changes.
    for (const k of [
      "number",
      "status",
      "type",
      "counterparty_email",
      "total_ttc",
      "lines",
      "shopify_order_number",
    ]) {
      expect(after[k]).toEqual(before[k])
    }
    const log = after.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
    expect(log[1]?.event).toBe(SHOPIFY_ORDER_LINKED_EVENT)
    expect(log[1]?.shopify_order_id).toBe("5550001")
  })

  test("a dry run (the default) reports and writes nothing", async () => {
    const { ctx, db } = makeCtx({
      docs: [legacyDoc()],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, {})
    expect(res.dry_run).toBe(true)
    expect(res.would_link).toBe(1)
    expect(outcomeOf(res, "doc-1")).toBe("would_link")
    expect(row(db, "doc-1").shopify_order_id).toBeNull()
  })

  test("idempotent: a second run finds nothing to do", async () => {
    const { ctx, calls } = makeCtx({
      docs: [legacyDoc()],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    await linkShopifyOrders(ctx, { dry_run: false })
    const searches = calls.length
    const again = await linkShopifyOrders(ctx, { dry_run: false })
    expect(again.linked).toBe(0)
    expect(again.results).toEqual([])
    expect(calls.length).toBe(searches)
  })

  test("a different email on the order is reported, never linked", async () => {
    const { ctx, db } = makeCtx({
      docs: [legacyDoc()],
      orders: { "#1001": [hit("#1001", "5550001", "someone-else@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("email_mismatch")
    expect(row(db, "doc-1").shopify_order_id).toBeNull()
  })

  test("an order with no email, or a document with none, is reported", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        legacyDoc(),
        legacyDoc({
          id: "doc-2",
          number: "1002",
          shopify_order_number: "#1002",
          counterparty_email: null,
        }),
      ],
      orders: {
        "#1001": [hit("#1001", "5550001", null)],
        "#1002": [hit("#1002", "5550002", "buyer@example.test")],
      },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("order_email_missing")
    expect(outcomeOf(res, "doc-2")).toBe("document_email_missing")
    expect(row(db, "doc-1").shopify_order_id).toBeNull()
    expect(row(db, "doc-2").shopify_order_id).toBeNull()
  })

  test("the linked contact's email stands in when the document carries none", async () => {
    const { ctx, db } = makeCtx({
      docs: [legacyDoc({ counterparty_email: "", counterparty_contact_id: "c-1" })],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
      contacts: { "c-1": { email: "BUYER@example.test" } },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("linked")
    expect(row(db, "doc-1").shopify_order_id).toBe("5550001")
  })

  test("a contact whose Shopify customer differs from the order's is reported", async () => {
    const { ctx, db } = makeCtx({
      docs: [legacyDoc({ counterparty_contact_id: "c-1" })],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test", "777")] },
      contacts: {
        "c-1": {
          email: "buyer@example.test",
          externalIds: { shopify: "gid://shopify/Customer/888" },
        },
      },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("customer_mismatch")
    expect(row(db, "doc-1").shopify_order_id).toBeNull()
  })

  test("no order, or more than one with that name, is reported", async () => {
    const { ctx } = makeCtx({
      docs: [legacyDoc(), legacyDoc({ id: "doc-2", number: "1002", shopify_order_number: "1002" })],
      orders: {
        // A prefix hit (#10010) is not the order #1001.
        "#1001": [hit("#10010", "5550010", "buyer@example.test")],
        "#1002": [
          hit("#1002", "5550002", "buyer@example.test"),
          hit("#1002", "5550003", "buyer@example.test"),
        ],
      },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("order_not_found")
    expect(outcomeOf(res, "doc-2")).toBe("order_ambiguous")
  })

  test("the connected shop must be the issuer profile's mapped shop", async () => {
    const orders = { "#1001": [hit("#1001", "5550001", "buyer@example.test")] }
    const other = makeCtx({ docs: [legacyDoc()], orders, shopDomain: "other.myshopify.com" })
    expect(outcomeOf(await linkShopifyOrders(other.ctx, { dry_run: false }), "doc-1")).toBe(
      "shop_mismatch",
    )
    const unknown = makeCtx({ docs: [legacyDoc()], orders, shopDomain: null })
    expect(outcomeOf(await linkShopifyOrders(unknown.ctx, { dry_run: false }), "doc-1")).toBe(
      "shop_unverified",
    )
    const unmapped = makeCtx({
      docs: [legacyDoc()],
      orders,
      issuers: [issuer({ shopify_shop_id: null })],
    })
    const res = await linkShopifyOrders(unmapped.ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("issuer_has_no_shop")
    expect(unmapped.calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(0)
    expect(row(unmapped.db, "doc-1").shopify_order_id).toBeNull()
  })

  test("an order another document already carries is reported, never shared", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        legacyDoc(),
        {
          id: "doc-0",
          type: "invoice",
          status: "paid",
          number: "INV-1",
          issuer_profile_id: ISSUER,
          shopify_order_id: "5550001",
          shopify_order_number: "#1001",
          counterparty_email: "buyer@example.test",
          lifecycle_log: [],
        },
      ],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(res, "doc-1")).toBe("order_already_linked")
    expect(row(db, "doc-1").shopify_order_id).toBeNull()
  })

  test("an invoice and its credit note naming the same order are linked together", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [
        legacyDoc(),
        legacyDoc({ id: "doc-2", type: "credit_note", number: "CN-1", status: "issued" }),
      ],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(res.linked).toBe(2)
    expect(row(db, "doc-2").shopify_order_id).toBe("5550001")
    // One Shopify read per order name.
    expect(calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(1)
  })

  test("drafts, voided documents, quotes and proformas are never candidates", async () => {
    const { ctx } = makeCtx({
      docs: [
        legacyDoc({ id: "d-draft", status: "draft", number: null }),
        legacyDoc({ id: "d-void", status: "voided" }),
        legacyDoc({ id: "d-quote", type: "quote" }),
        legacyDoc({ id: "d-proforma", type: "proforma" }),
      ],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
    })
    const res = await linkShopifyOrders(ctx, { dry_run: false })
    expect(res.results).toEqual([])
  })

  test("a failed Shopify read is reported and retried by the next run", async () => {
    let fail = true
    const { ctx, db } = makeCtx({
      docs: [legacyDoc()],
      orders: { "#1001": [hit("#1001", "5550001", "buyer@example.test")] },
      search: () =>
        fail ? { status: "error", error: { code: "THROTTLED", message: "slow down" } } : undefined,
    })
    const first = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(first, "doc-1")).toBe("lookup_failed")
    fail = false
    const second = await linkShopifyOrders(ctx, { dry_run: false })
    expect(outcomeOf(second, "doc-1")).toBe("linked")
    expect(row(db, "doc-1").shopify_order_id).toBe("5550001")
  })

  test("pages with limit and next_cursor", async () => {
    const docs = ["a", "b", "c"].map((id, i) =>
      legacyDoc({ id: `doc-${id}`, number: `100${i}`, shopify_order_number: `100${i}` }),
    )
    const { ctx } = makeCtx({ docs, orders: {} })
    const first = await linkShopifyOrders(ctx, { limit: 2 })
    expect((first.results as unknown[]).length).toBe(2)
    expect(first.next_cursor).toBe("doc-b")
    expect(first.remaining).toBe(1)
    const second = await linkShopifyOrders(ctx, { limit: 2, cursor: first.next_cursor as string })
    expect((second.results as Array<{ document_id: string }>).map((r) => r.document_id)).toEqual([
      "doc-c",
    ])
    expect(second.next_cursor).toBeNull()
  })
})
