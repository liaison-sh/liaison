// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E4 — refund / order-updated / order-cancelled handler tests.
//
// Drives each handler through the shared `createMockDb` generic-CRUD surface.
// All three handlers look up the target document by indexed equality on the
// top-level `shopify_order_id` column, so tests seed full `documents` rows
// with that column populated (matching what issueDocument persists).

import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import { type OrderCancelledCtx, onShopifyOrderCancelled } from "./shopify-order-cancelled"
import {
  type OrderUpdatedCtx,
  type OrderUpdatedExecuteToolEnvelope,
  observeShopifyOrderUpdated,
} from "./shopify-order-updated"
import { onShopifyRefundCreated, type RefundCtx } from "./shopify-refund-created"

interface SeedDocOptions {
  id: string
  shopify_order_id?: string
  status?: string
  payment_status?: string
  number?: string | null
  grand_total_minor?: bigint | string
  lifecycle_log?: Array<Record<string, unknown>>
  /** Extra keys merged into `external_refs` (e.g. a pre-recorded
   *  `downstream_order_sig` billing baseline). */
  external_refs?: Record<string, unknown>
  /** Document type. Defaults to "invoice"; set "credit_note" for a document
   *  that inherited the order's shopify_order_id via creditNoteCreateAndIssue. */
  type?: string
}

function seedDocument(db: MockDb, opts: SeedDocOptions): void {
  db.__seed("documents", [
    {
      id: opts.id,
      type: opts.type ?? "invoice",
      status: opts.status ?? "issued",
      payment_status: opts.payment_status ?? "unpaid",
      number: opts.number ?? null,
      grand_total_minor:
        typeof opts.grand_total_minor === "bigint"
          ? opts.grand_total_minor.toString()
          : (opts.grand_total_minor ?? "0"),
      lifecycle_log: opts.lifecycle_log ?? [],
      external_refs: {
        ...(opts.shopify_order_id ? { shopify_order_id: opts.shopify_order_id } : {}),
        ...(opts.external_refs ?? {}),
      },
      shopify_order_id: opts.shopify_order_id ?? null,
    },
  ])
}

// ── Refund ─────────────────────────────────────────────────────────────

function makeRefundCtx(): { ctx: RefundCtx; db: MockDb } {
  const db = createMockDb()
  const ctx: RefundCtx = {
    getUserId: async () => "user-1",
    db,
  }
  return { ctx, db }
}

describe("onShopifyRefundCreated (E4)", () => {
  test("full refund → payment_status=refunded; lifecycle log appended", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [{ event: "issued" }],
    })
    const result = await onShopifyRefundCreated(
      {
        id: "refund-1",
        order_id: "shopify-order-1",
        refund_amount_minor: 10000n,
        shop_id: "shop-1",
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.payment_status).toBe("refunded")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({ event: "refunded" })
  })

  test("partial refund → payment_status=partial; lifecycle event partially_refunded", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    const result = await onShopifyRefundCreated(
      {
        id: "refund-1",
        order_id: "shopify-order-1",
        refund_amount_minor: 4000n,
        shop_id: "shop-1",
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect(doc.payment_status).toBe("partial")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({ event: "partially_refunded" })
  })

  test("refund for unknown order_id → parks awaiting_data", async () => {
    const { ctx, db } = makeRefundCtx()
    const result = await onShopifyRefundCreated(
      {
        id: "refund-1",
        order_id: "nonexistent-order",
        refund_amount_minor: 1000n,
        shop_id: "shop-1",
      },
      ctx,
    )
    expect(result.status).toBe("deferred")
    const deferred = db.__all("deferred_events")
    expect(deferred[0]!.status).toBe("awaiting_data")
    expect(deferred[0]!.reason).toBe("invoice_not_found_for_refund")
  })

  test("refunded already-refunded order → second refund still records lifecycle entry", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      grand_total_minor: 10000n,
      payment_status: "refunded",
      lifecycle_log: [{ event: "refunded" }],
    })
    const result = await onShopifyRefundCreated(
      {
        id: "refund-2",
        order_id: "shopify-order-1",
        refund_amount_minor: 0n,
        shop_id: "shop-1",
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
  })

  test("kernel envelope ({ data }) is unwrapped — order_id read from event.data", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-9",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    const result = await onShopifyRefundCreated(
      { data: { id: "refund-env", order_id: "ord-9", refund_amount_minor: 10000n } },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect(doc.payment_status).toBe("refunded")
  })

  test("webhook shape (major amount + currency) converts to minor units", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-10",
      grand_total_minor: 12000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    const result = await onShopifyRefundCreated(
      { data: { id: "9999", order_id: "ord-10", amount: "60.00", currency: "EUR" } },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect(doc.payment_status).toBe("partial") // 6000 < 12000
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({ refund_amount_minor: "6000" })
  })

  test("idempotent on refund id — gid + numeric forms of the same refund record once", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-11",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    // Programmatic tool emit (gid id) then the Shopify webhook (numeric id) for
    // the SAME refund — normalizeRefundId collapses both to "555".
    await onShopifyRefundCreated(
      {
        data: {
          id: "gid://shopify/Refund/555",
          order_id: "ord-11",
          amount: "100.00",
          currency: "EUR",
        },
      },
      ctx,
    )
    await onShopifyRefundCreated(
      { data: { id: "555", order_id: "ord-11", amount: "100.00", currency: "EUR" } },
      ctx,
    )
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
  })

  // ── C2: two distinct refund webhooks summing to >=100% reach refunded ────

  test("two distinct refund webhooks summing to the total → refunded (cumulative)", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-multi",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    // First webhook: 4000 of 10000 — stays partial.
    const r1 = await onShopifyRefundCreated(
      { data: { id: "111", order_id: "ord-multi", refund_amount_minor: 4000n } },
      ctx,
    )
    expect(r1.status).toBe("ok")
    if (r1.status !== "ok") throw new Error("unreachable")
    expect(r1.payment_status).toBe("partial")
    // Second, DISTINCT webhook: 6000 — cumulative 10000 === total → refunded.
    const r2 = await onShopifyRefundCreated(
      { data: { id: "222", order_id: "ord-multi", refund_amount_minor: 6000n } },
      ctx,
    )
    expect(r2.status).toBe("ok")
    if (r2.status !== "ok") throw new Error("unreachable")
    expect(r2.payment_status).toBe("refunded")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect(doc.payment_status).toBe("refunded")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({
      event: "partially_refunded",
      refund_amount_minor: "4000",
    })
    expect(log[1]).toMatchObject({
      event: "refunded",
      refund_amount_minor: "6000",
    })
  })

  test("two distinct refund webhooks summing PAST the total still reach refunded", async () => {
    const { ctx, db } = makeRefundCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-over",
      grand_total_minor: 10000n,
      payment_status: "paid",
      lifecycle_log: [],
    })
    await onShopifyRefundCreated(
      { data: { id: "111", order_id: "ord-over", refund_amount_minor: 7000n } },
      ctx,
    )
    const r2 = await onShopifyRefundCreated(
      { data: { id: "222", order_id: "ord-over", refund_amount_minor: 5000n } },
      ctx,
    )
    expect(r2.status).toBe("ok")
    if (r2.status !== "ok") throw new Error("unreachable")
    // 7000 + 5000 = 12000 >= 10000 → refunded.
    expect(r2.payment_status).toBe("refunded")
  })
})

// ── OrderUpdated ─────────────────────────────────────────────────────────

function makeUpdatedCtx(): {
  ctx: OrderUpdatedCtx
  db: MockDb
  attentions: Array<{ entity: string; action: string; entityId?: string }>
} {
  const db = createMockDb()
  const attentions: Array<{ entity: string; action: string; entityId?: string }> = []
  const ctx: OrderUpdatedCtx = {
    getUserId: async () => "user-1",
    db,
    async emit(event) {
      attentions.push({ entity: event.entity, action: event.action, entityId: event.entityId })
    },
  }
  return { ctx, db, attentions }
}

/** Same as `makeUpdatedCtx`, plus a recording `ctx.executeTool` — used by the
 *  order_reissue_apply staging tests. `executeTool` never actually runs
 *  orderReissueApply (that only happens on the kernel's post-approval
 *  re-entry, which is out of scope for this pure handler-level mock): it
 *  just records the call and returns a fake pending-approval envelope, which
 *  is enough to prove the handler staged exactly the right gated call. */
function makeUpdatedCtxWithReissue(): {
  ctx: OrderUpdatedCtx
  db: MockDb
  attentions: Array<{ entity: string; action: string; entityId?: string }>
  executeToolCalls: Array<{ target: string; args: Record<string, unknown> }>
} {
  const db = createMockDb()
  const attentions: Array<{ entity: string; action: string; entityId?: string }> = []
  const executeToolCalls: Array<{ target: string; args: Record<string, unknown> }> = []
  const ctx: OrderUpdatedCtx = {
    getUserId: async () => "user-1",
    db,
    async emit(event) {
      attentions.push({ entity: event.entity, action: event.action, entityId: event.entityId })
    },
    async executeTool(target, args): Promise<OrderUpdatedExecuteToolEnvelope> {
      executeToolCalls.push({ target, args })
      return { status: "pending_approval", approval_id: `appr-${executeToolCalls.length}` }
    },
  }
  return { ctx, db, attentions, executeToolCalls }
}

/** Build a normalized-order-shaped `order:updated` payload (the shape the
 *  handler reads billing fields off). `orderId` doubles as the bare-object id
 *  field the kernel may deliver directly. */
function orderUpdate(opts: {
  orderId: string
  total: string
  currency?: string
  lines?: Array<{ sku: string; quantity: number; price: string }>
  changed_fields?: string[]
}): Record<string, unknown> {
  const currency = opts.currency ?? "EUR"
  return {
    orderId: opts.orderId,
    changed_fields: opts.changed_fields ?? [],
    totalPrice: { amount: opts.total, currencyCode: currency },
    lineItems: (opts.lines ?? [{ sku: "SKU-1", quantity: 1, price: opts.total }]).map((l) => ({
      quantity: l.quantity,
      priceSet: { amount: l.price, currencyCode: currency },
      variant: { sku: l.sku },
    })),
  }
}

describe("observeShopifyOrderUpdated (E4)", () => {
  test("first observation records a billing baseline silently — no attention", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      number: "INV-2026-0001",
      lifecycle_log: [],
    })
    const result = await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "shopify-order-1",
        total: "120.00",
        changed_fields: ["line_items", "shipping_address"],
      }),
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    // Lifecycle audit is always recorded, even when we don't alert.
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      event: "downstream_change_observed",
      changed_fields: ["line_items", "shipping_address"],
    })
    // Baseline is persisted, but no attention on the first observation.
    expect((doc.external_refs as Record<string, unknown>).downstream_order_sig).toEqual(
      expect.any(String),
    )
    expect(attentions).toHaveLength(0)
  })

  test("routine update with unchanged billing raises no attention", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-2",
      number: "INV-2026-0002",
      lifecycle_log: [],
    })
    // First update establishes the baseline (no alert).
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-2", total: "120.00" }), ctx)
    // A follow-up webhook with identical billing (e.g. a fulfillment/tag change
    // that leaves the total and lines untouched) must NOT re-alert.
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-2", total: "120.00" }), ctx)
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    // Both observations are logged for audit...
    expect((doc.lifecycle_log as unknown[]).length).toBe(2)
    // ...but neither raised an attention item.
    expect(attentions).toHaveLength(0)
  })

  test("billable change (total differs) raises one attention on the document detail", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-3",
      number: "INV-2026-0003",
      lifecycle_log: [],
    })
    // Baseline at 120.00.
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-3", total: "120.00" }), ctx)
    expect(attentions).toHaveLength(0)
    // A genuine edit — the order total moved to 150.00.
    const result = await observeShopifyOrderUpdated(
      orderUpdate({ orderId: "ord-3", total: "150.00", changed_fields: ["line_items"] }),
      ctx,
    )
    expect(result.status).toBe("ok")
    expect(attentions).toHaveLength(1)
    // `entity: "detail"` (+ document id) deep-links the item to the document
    // detail tab (`invoicing:detail`), not the dead `invoicing:invoicing`.
    expect(attentions[0]).toMatchObject({
      entity: "detail",
      action: "order_edited",
      entityId: "doc-1",
    })
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect((doc.lifecycle_log as unknown[]).length).toBe(2)
  })

  test("a repeated identical change does not re-alert (baseline advances)", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-4", number: "INV-2026-0004" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-4", total: "120.00" }), ctx) // baseline
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-4", total: "150.00" }), ctx) // change -> alert
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-4", total: "150.00" }), ctx) // same -> quiet
    expect(attentions).toHaveLength(1)
    expect(attentions[0]).toMatchObject({ entity: "detail", action: "order_edited" })
  })

  test("a line swap at constant total still counts as a billable change", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-5", number: "INV-2026-0005" })
    await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-5",
        total: "100.00",
        lines: [{ sku: "AAA", quantity: 1, price: "100.00" }],
      }),
      ctx,
    ) // baseline
    // Same total, different line contents -> a real edit that could need a credit note.
    await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-5",
        total: "100.00",
        lines: [{ sku: "BBB", quantity: 2, price: "50.00" }],
      }),
      ctx,
    )
    expect(attentions).toHaveLength(1)
    expect(attentions[0]).toMatchObject({ entity: "detail", action: "order_edited" })
  })

  test("split order: both invoices baseline then alert on the same order edit", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, { id: "doc-goods", shopify_order_id: "ord-6", number: "INV-2026-0006" })
    seedDocument(db, { id: "doc-soft", shopify_order_id: "ord-6", number: "INV-2026-0007" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-6", total: "120.00" }), ctx) // baseline both
    expect(attentions).toHaveLength(0)
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-6", total: "150.00" }), ctx) // edit
    // Each document of the split order surfaces its own review item.
    expect(attentions).toHaveLength(2)
    expect(new Set(attentions.map((a) => a.entityId))).toEqual(new Set(["doc-goods", "doc-soft"]))
    expect(attentions.every((a) => a.entity === "detail")).toBe(true)
  })

  test("a credit note does not participate in downstream change detection", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    // The order has an issued invoice AND a credit note that inherited the
    // order's shopify_order_id (creditNoteCreateAndIssue).
    seedDocument(db, { id: "doc-inv", shopify_order_id: "ord-cn", number: "INV-2026-0010" })
    seedDocument(db, {
      id: "doc-cn",
      shopify_order_id: "ord-cn",
      number: "CN-2026-0001",
      type: "credit_note",
    })
    // Baseline both, then a genuine billable edit.
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-cn", total: "120.00" }), ctx)
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-cn", total: "150.00" }), ctx)

    const invoice = db.__all("documents").find((d) => d.id === "doc-inv")!
    const creditNote = db.__all("documents").find((d) => d.id === "doc-cn")!

    // The invoice observed both webhooks and alerted once on the real change.
    expect((invoice.lifecycle_log as unknown[]).length).toBe(2)
    expect(attentions).toHaveLength(1)
    expect(attentions[0]).toMatchObject({
      entity: "detail",
      action: "order_edited",
      entityId: "doc-inv",
    })

    // The credit note is untouched: no downstream_change_observed lifecycle
    // entry, no baseline signature, and no attention card ever named it.
    expect((creditNote.lifecycle_log as unknown[]).length).toBe(0)
    expect(
      (creditNote.external_refs as Record<string, unknown>).downstream_order_sig,
    ).toBeUndefined()
    expect(attentions.some((a) => a.entityId === "doc-cn")).toBe(false)
  })

  test("no invoice yet → noop, no attention", async () => {
    const { ctx, attentions } = makeUpdatedCtx()
    const result = await observeShopifyOrderUpdated(
      orderUpdate({ orderId: "shopify-order-1", total: "10.00" }),
      ctx,
    )
    expect(result.status).toBe("noop")
    if (result.status !== "noop") throw new Error("unreachable")
    expect(result.reason).toBe("no_invoice_yet")
    expect(attentions).toHaveLength(0)
  })

  test("kernel envelope ({ entityId, data }) is unwrapped — real-event shape", async () => {
    const { ctx, db, attentions } = makeUpdatedCtx()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-7", number: "INV-2026-0008" })
    const result = await observeShopifyOrderUpdated(
      {
        entityId: "ord-7",
        data: orderUpdate({ orderId: "ord-7", total: "120.00", changed_fields: ["line_items"] }),
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect((doc.lifecycle_log as Array<Record<string, unknown>>)[0]).toMatchObject({
      event: "downstream_change_observed",
      shopify_order_id: "ord-7",
      changed_fields: ["line_items"],
    })
    // First observation via the wrapped envelope still just baselines.
    expect(attentions).toHaveLength(0)
    expect((doc.external_refs as Record<string, unknown>).downstream_order_sig).toEqual(
      expect.any(String),
    )
  })

  test("bare normalized order (direct delivery, `orderId` field, no entityId/data)", async () => {
    const { ctx, db } = makeUpdatedCtx()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-direct", number: "INV-2026-0009" })
    // The kernel may hand the subscriber the normalized order object directly
    // (no { entityId, data } envelope) — its id field is `orderId`.
    const result = await observeShopifyOrderUpdated(
      orderUpdate({ orderId: "ord-direct", total: "80.00" }),
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect((doc.lifecycle_log as Array<Record<string, unknown>>)[0]).toMatchObject({
      event: "downstream_change_observed",
      shopify_order_id: "ord-direct",
    })
  })

  // ── order_reissue_apply staging ─────────────────────────────────────────

  test("an order edit that changes the amounts stages order_reissue_apply once, issues nothing itself", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-amt", number: "INV-2026-0100" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-amt", total: "120.00" }), ctx) // baseline
    expect(executeToolCalls).toHaveLength(0)

    const result = await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-amt",
        total: "150.00",
        lines: [{ sku: "SKU-1", quantity: 1, price: "150.00" }],
      }),
      ctx,
    )
    expect(result.status).toBe("ok")
    // Exactly one gated call, targeting THIS app's own reissue tool.
    expect(executeToolCalls).toHaveLength(1)
    expect(executeToolCalls[0]!.target).toBe("invoicing:order_reissue_apply")
    expect(executeToolCalls[0]!.args).toMatchObject({
      original_document_id: "doc-1",
      shopify_order_id: "ord-amt",
      // The store's "150.00" is 150 EUR. It was read as 150 cents: only a fraction counted as major.
      items: [expect.objectContaining({ unit_price_minor: 15000 })],
    })
    // Staging the gated call must not itself create any document — issuance
    // only happens once a human approves (out of this handler's control).
    expect(db.__all("documents").filter((d) => d.id !== "doc-1")).toHaveLength(0)
  })

  test("an order edit that changes nothing financial does not stage order_reissue_apply", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-notes", number: "INV-2026-0101" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-notes", total: "120.00" }), ctx) // baseline
    // Same total and lines — an address/notes/tags-only webhook.
    await observeShopifyOrderUpdated(
      orderUpdate({ orderId: "ord-notes", total: "120.00", changed_fields: ["note", "tags"] }),
      ctx,
    )
    expect(executeToolCalls).toHaveLength(0)
  })

  test("a repeated webhook delivery for the same edit does not stack a second order_reissue_apply call", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-repeat", number: "INV-2026-0102" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-repeat", total: "120.00" }), ctx) // baseline
    const edited = orderUpdate({
      orderId: "ord-repeat",
      total: "150.00",
      lines: [{ sku: "SKU-1", quantity: 1, price: "150.00" }],
    })
    await observeShopifyOrderUpdated(edited, ctx) // the edit -> stages the reissue
    await observeShopifyOrderUpdated(edited, ctx) // Shopify redelivers the SAME webhook
    expect(executeToolCalls).toHaveLength(1)
    // The dedupe key is order id + billing signature, so any concurrent
    // redelivery that DID reach a second executeTool call before this app's
    // own baseline-advance committed would carry the IDENTICAL key value,
    // and the kernel's approvalDedupeKeyParam matching collapses it into the
    // same pending approval rather than stacking a duplicate.
    const key = executeToolCalls[0]!.args.dedupe_key
    expect(typeof key).toBe("string")
    expect(key).toContain("ord-repeat")
  })

  test("a later, different edit stages a fresh order_reissue_apply with a different dedupe key", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    seedDocument(db, { id: "doc-1", shopify_order_id: "ord-again", number: "INV-2026-0103" })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-again", total: "120.00" }), ctx) // baseline
    await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-again",
        total: "150.00",
        lines: [{ sku: "SKU-1", quantity: 1, price: "150.00" }],
      }),
      ctx,
    ) // edit 1
    await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-again",
        total: "180.00",
        lines: [{ sku: "SKU-1", quantity: 1, price: "180.00" }],
      }),
      ctx,
    ) // edit 2, genuinely different
    expect(executeToolCalls).toHaveLength(2)
    expect(executeToolCalls[0]!.args.dedupe_key).not.toBe(executeToolCalls[1]!.args.dedupe_key)
  })

  // Regression: a split order (goods + software) raises TWO calls, one per
  // invoice half, but `currentSig` is computed ONCE per order — before the
  // fix both calls carried the SAME dedupe_key, so the kernel's dedupe
  // (execute-tool.ts) restaged the pending approval IN PLACE and only the
  // last-in-loop document kept its reissue queued; the other invoice's
  // credit note + replacement was silently clobbered before any human saw
  // it. This is the order shape shipped most and nothing else covered it.
  test("a split order raises one reissue approval per invoice half", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    // Two invoices for the SAME order: the goods half and the software half.
    seedDocument(db, {
      id: "doc-goods",
      shopify_order_id: "ord-split",
      number: "INV-2026-0200",
    })
    seedDocument(db, {
      id: "doc-software",
      shopify_order_id: "ord-split",
      number: "INV-2026-0201",
    })
    await observeShopifyOrderUpdated(orderUpdate({ orderId: "ord-split", total: "120.00" }), ctx) // baseline, both docs
    expect(executeToolCalls).toHaveLength(0)

    await observeShopifyOrderUpdated(
      orderUpdate({
        orderId: "ord-split",
        total: "150.00",
        lines: [{ sku: "SKU-1", quantity: 1, price: "150.00" }],
      }),
      ctx,
    )

    // Both halves raise their own gated reissue call, against their OWN document.
    expect(executeToolCalls).toHaveLength(2)
    const docIds = executeToolCalls.map((c) => c.args.original_document_id).sort()
    expect(docIds).toEqual(["doc-goods", "doc-software"])

    // The two calls' dedupe keys must be DISTINCT — this is the actual defect:
    // before the fix both calls carried the same order+signature key.
    const keyGoods = executeToolCalls.find((c) => c.args.original_document_id === "doc-goods")!.args
      .dedupe_key
    const keySoftware = executeToolCalls.find(
      (c) => c.args.original_document_id === "doc-software",
    )!.args.dedupe_key
    expect(typeof keyGoods).toBe("string")
    expect(typeof keySoftware).toBe("string")
    expect(keyGoods).not.toBe(keySoftware)
  })

  test("a repeated webhook for the same edit and the same document still dedupes to one", async () => {
    const { ctx, db, executeToolCalls } = makeUpdatedCtxWithReissue()
    seedDocument(db, {
      id: "doc-goods",
      shopify_order_id: "ord-split-repeat",
      number: "INV-2026-0210",
    })
    seedDocument(db, {
      id: "doc-software",
      shopify_order_id: "ord-split-repeat",
      number: "INV-2026-0211",
    })
    await observeShopifyOrderUpdated(
      orderUpdate({ orderId: "ord-split-repeat", total: "120.00" }),
      ctx,
    ) // baseline
    const edited = orderUpdate({
      orderId: "ord-split-repeat",
      total: "150.00",
      lines: [{ sku: "SKU-1", quantity: 1, price: "150.00" }],
    })
    await observeShopifyOrderUpdated(edited, ctx) // the edit -> stages one reissue per document
    await observeShopifyOrderUpdated(edited, ctx) // Shopify redelivers the SAME webhook

    // Two documents, each still dedupes its own repeated delivery to one call.
    expect(executeToolCalls).toHaveLength(2)
    const goodsCalls = executeToolCalls.filter((c) => c.args.original_document_id === "doc-goods")
    const softwareCalls = executeToolCalls.filter(
      (c) => c.args.original_document_id === "doc-software",
    )
    expect(goodsCalls).toHaveLength(1)
    expect(softwareCalls).toHaveLength(1)
  })
})

// ── OrderCancelled ────────────────────────────────────────────────────────

function makeCancelledCtx(): {
  ctx: OrderCancelledCtx
  db: MockDb
  attentions: Array<{ entity: string; action: string }>
} {
  const db = createMockDb()
  const attentions: Array<{ entity: string; action: string }> = []
  const ctx: OrderCancelledCtx = {
    getUserId: async () => "user-1",
    db,
    async emit(event) {
      attentions.push({ entity: event.entity, action: event.action })
    },
  }
  return { ctx, db, attentions }
}

describe("onShopifyOrderCancelled (E4)", () => {
  test("issued invoice exists → attention emitted", async () => {
    const { ctx, db, attentions } = makeCancelledCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      number: "INV-2026-0001",
      status: "issued",
      lifecycle_log: [],
    })
    const result = await onShopifyOrderCancelled(
      { id: "shopify-order-1", shop_id: "shop-1", cancel_reason: "customer" },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.attention_emitted).toBe(true)
    // Every cancelled document also emits the kernel audit event
    // (document:cancelled) alongside the attention-raising one.
    expect(attentions).toHaveLength(2)
    expect(attentions[0]).toMatchObject({ entity: "document", action: "cancelled" })
    expect(attentions[1]).toMatchObject({ entity: "detail", action: "order_cancelled" })
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({
      event: "shopify_order_cancelled",
      cancel_reason: "customer",
    })
  })

  test("draft invoice → lifecycle log and audit event, no attention", async () => {
    const { ctx, db, attentions } = makeCancelledCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "shopify-order-1",
      number: null,
      status: "draft",
      lifecycle_log: [],
    })
    const result = await onShopifyOrderCancelled({ id: "shopify-order-1", shop_id: "shop-1" }, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.attention_emitted).toBe(false)
    // The document:cancelled audit event still fires (it is unconditional),
    // but no "detail"/order_cancelled attention is raised for a draft.
    expect(attentions).toHaveLength(1)
    expect(attentions[0]).toMatchObject({ entity: "document", action: "cancelled" })
    expect(attentions.some((a) => a.entity === "detail")).toBe(false)
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
  })

  test("no invoice → noop", async () => {
    const { ctx, attentions } = makeCancelledCtx()
    const result = await onShopifyOrderCancelled({ id: "shopify-order-1", shop_id: "shop-1" }, ctx)
    expect(result.status).toBe("noop")
    expect(attentions).toHaveLength(0)
  })

  test("kernel envelope ({ entityId, data.orderId }) is unwrapped — issued invoice → attention", async () => {
    const { ctx, db, attentions } = makeCancelledCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-8",
      number: "INV-2026-0008",
      status: "issued",
      lifecycle_log: [],
    })
    const result = await onShopifyOrderCancelled(
      { entityId: "ord-8", data: { orderId: "ord-8", cancel_reason: "fraud" } },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.attention_emitted).toBe(true)
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({
      event: "shopify_order_cancelled",
      shopify_order_id: "ord-8",
      cancel_reason: "fraud",
    })
    expect(attentions).toHaveLength(2)
    expect(attentions[1]).toMatchObject({ entity: "detail", action: "order_cancelled" })
  })

  test("bare normalized order (direct delivery, `orderId` field, no entityId/data)", async () => {
    const { ctx, db, attentions } = makeCancelledCtx()
    seedDocument(db, {
      id: "doc-1",
      shopify_order_id: "ord-direct",
      number: "INV-2026-0010",
      status: "issued",
      lifecycle_log: [],
    })
    const result = await onShopifyOrderCancelled({ orderId: "ord-direct" }, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.attention_emitted).toBe(true)
    const doc = db.__all("documents").find((d) => d.id === "doc-1")!
    expect((doc.lifecycle_log as Array<Record<string, unknown>>)[0]).toMatchObject({
      event: "shopify_order_cancelled",
      shopify_order_id: "ord-direct",
    })
  })
})
