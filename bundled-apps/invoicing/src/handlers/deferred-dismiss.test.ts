// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deferred_dismiss (createMockDb): a person closes a park that must never issue (a staff test, a
// voided order) with a reason; the park is resolved as dismissed, audited, and the order flow skips
// that order for good. Also pins the link of a replacement invoice next to the documents it
// replaced (documents_link_shopify_orders) and that the order lookup lists the live invoice first.
import { describe, expect, test } from "bun:test"
import { documentsForOrders } from "../reads"
import { createMockDb } from "../test-db"
import { deferredDismiss, deferredDismissPreflight, parkDismissed } from "./deferred-dismiss"
import { linkShopifyOrders } from "./link-shopify-orders"
import { onShopifyOrderPaid } from "./shopify-order-paid"

const PARK = "11111111-1111-4111-8111-111111111111"
const ORDER = "1000000000001"

function ctxWith(db: ReturnType<typeof createMockDb>) {
  const emits: Array<{ entity: string; action: string; data?: unknown }> = []
  return {
    emits,
    ctx: {
      db,
      getUserId: async () => "user-1",
      approval: { approvalRequestId: "request-9", approvalDeciderId: "user-owner", toolName: "x" },
      emit: async (e: { entity: string; action: string; data?: unknown }) => {
        emits.push(e)
      },
    },
  }
}

describe("deferred_dismiss", () => {
  test("refuses without a reason, and refuses a park already resolved", async () => {
    const db = createMockDb({
      seed: {
        deferred_events: [
          {
            id: PARK,
            event_id: ORDER,
            status: "awaiting_data",
            reason: "einvoice_data_missing",
            blocked_on: {},
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            event_id: "1",
            status: "resolved",
            blocked_on: {},
          },
        ],
      },
    })
    const { ctx } = ctxWith(db)
    const none = await deferredDismissPreflight(ctx, { deferred_id: PARK, reason: " " })
    expect("error" in none && none.error.code).toBe("reason_required")
    const done = await deferredDismissPreflight(ctx, {
      deferred_id: "22222222-2222-4222-8222-222222222222",
      reason: "staff test purchase",
    })
    expect("error" in done && done.error.code).toBe("already_resolved")
  })

  test("closes the park with the reason, who and when, audited; the order then never issues", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [
          { id: "iss-1", country: "FR", legal_name: "Acme", shopify_shop_id: "shop-1" },
        ],
        deferred_events: [
          {
            id: PARK,
            event_id: ORDER,
            status: "awaiting_data",
            reason: "einvoice_data_missing",
            blocked_on: { kind: "einvoice_data" },
          },
        ],
      },
    })
    const { ctx, emits } = ctxWith(db)
    const r = await deferredDismiss(ctx, { deferred_id: PARK, reason: "staff test purchase" })
    expect(r.status).toBe("completed")
    const row = db.__all("deferred_events")[0]!
    expect(row.status).toBe("resolved")
    expect(row.reason).toBe("dismissed")
    const dismissed = (row.blocked_on as { dismissed: Record<string, unknown> }).dismissed
    expect(dismissed.reason).toBe("staff test purchase")
    expect(dismissed.by).toBe("user-owner")
    expect(dismissed.previous_reason).toBe("einvoice_data_missing")
    expect(emits.some((e) => e.entity === "deferred" && e.action === "dismissed")).toBe(true)
    expect(await parkDismissed(db, ORDER)).toBe(true)
    const replay = await onShopifyOrderPaid(
      { id: ORDER, shop_id: "shop-1", total_price_minor: "8900", line_items: [] } as never,
      ctx as never,
    )
    expect(replay).toEqual({ status: "skipped", reason: "park_dismissed" })
    expect(db.__all("documents")).toHaveLength(0)
  })
})

describe("a replacement invoice and its order", () => {
  const seedDocs = (): Array<Record<string, unknown>> => [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "invoice",
      status: "issued",
      payment_status: "credited",
      number: "INV-2026-0201",
      issuer_profile_id: "iss-1",
      shopify_order_id: ORDER,
      grand_total_minor: "8900",
      lifecycle_log: [],
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "credit_note",
      status: "issued",
      number: "CN-2026-0021",
      issuer_profile_id: "iss-1",
      shopify_order_id: ORDER,
      original_document_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      grand_total_minor: "-8900",
      lifecycle_log: [],
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      type: "invoice",
      status: "fulfilled",
      payment_status: "paid",
      number: "INV-2026-0202",
      issuer_profile_id: "iss-1",
      shopify_order_number: "#1202",
      counterparty_email: "buyer@example.com",
      grand_total_minor: "8900",
      lifecycle_log: [],
    },
  ]
  const shopify = async (target: string) =>
    target === "shopify:orders_search"
      ? {
          status: "completed" as const,
          result: {
            shopDomain: "shop.myshopify.com",
            results: [{ id: ORDER, title: "#1202", attributes: { email: "buyer@example.com" } }],
          },
        }
      : { status: "error" as const, error: { code: "not_found", message: "no" } }

  test("links the live replacement when the order's other documents are a credited invoice and its credit note", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [{ id: "iss-1", shopify_shop_id: "shop.myshopify.com" }],
        documents: seedDocs(),
      },
    })
    const r = (await linkShopifyOrders({ db, executeTool: shopify }, { dry_run: false })) as {
      results: Array<{ number: string; outcome: string }>
    }
    expect(r.results.find((x) => x.number === "INV-2026-0202")?.outcome).toBe("linked")
    const linked = db.__all("documents").find((d) => d.number === "INV-2026-0202")!
    expect(linked.shopify_order_id).toBe(ORDER)
  })

  test("still refuses when another LIVE invoice carries the order", async () => {
    const docs = seedDocs()
    docs[0] = { ...docs[0]!, payment_status: "paid" }
    docs.splice(1, 1)
    const db = createMockDb({
      seed: {
        issuer_profiles: [{ id: "iss-1", shopify_shop_id: "shop.myshopify.com" }],
        documents: docs,
      },
    })
    const r = (await linkShopifyOrders({ db, executeTool: shopify }, { dry_run: false })) as {
      results: Array<{ number: string; outcome: string }>
    }
    expect(r.results.find((x) => x.number === "INV-2026-0202")?.outcome).toBe(
      "order_already_linked",
    )
  })

  test("the order lookup lists the live invoice first", async () => {
    const docs = seedDocs()
    docs[2] = { ...docs[2]!, shopify_order_id: ORDER }
    const db = createMockDb({ seed: { documents: docs } })
    const { links } = await documentsForOrders({ db } as never, { shopify_order_ids: [ORDER] })
    expect(links.map((l) => l.number)).toEqual(["INV-2026-0202", "INV-2026-0201", "CN-2026-0021"])
  })
})
