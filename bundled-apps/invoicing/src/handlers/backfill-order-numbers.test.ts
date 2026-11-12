// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One-time order-number backfill tests. Mirrors the reconcile-shopify-payments
// harness (createMockDb + an executeTool stubbed by tool name).

import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import {
  type BackfillCrossAppEnvelope,
  type BackfillCtx,
  backfillOrderNumbers,
  backfillOrderNumbersJobHandler,
  ORDER_NUMBER_BACKFILL_MARKER,
} from "./backfill-order-numbers"

interface SeedDocOptions {
  id?: string
  shopify_order_id?: string | null
  shopify_order_number?: string | null
  external_refs?: Record<string, unknown> | null
  lifecycle_log?: Array<Record<string, unknown>>
}

function seedDoc(over: SeedDocOptions = {}): Record<string, unknown> {
  return {
    id: over.id ?? "doc-1",
    type: "invoice",
    status: "issued",
    shopify_order_id: over.shopify_order_id === undefined ? "9001" : over.shopify_order_id,
    shopify_order_number: over.shopify_order_number ?? null,
    external_refs: over.external_refs ?? {},
    lifecycle_log: over.lifecycle_log ?? [
      { event: "issued", actor: "system", ts: "2026-06-01T00:00:00Z" },
    ],
  }
}

function makeCtx(opts?: {
  docs?: Array<Record<string, unknown>>
  ordersByGid?: Record<string, BackfillCrossAppEnvelope>
}): {
  ctx: BackfillCtx
  db: MockDb
  calls: Array<{ target: string; args: Record<string, unknown> }>
} {
  const db = createMockDb({ seed: { documents: opts?.docs ?? [] } })
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const ctx: BackfillCtx = {
    db,
    async executeTool(target, args) {
      calls.push({ target, args })
      if (target === "shopify:orders_get") {
        return (
          opts?.ordersByGid?.[String(args.id ?? "")] ?? {
            status: "error",
            error: { code: "NOT_FOUND", message: "no such order" },
          }
        )
      }
      return { status: "error", error: { code: "UNKNOWN_TOOL", message: `unhandled ${target}` } }
    },
  }
  return { ctx, db, calls }
}

function doc(db: MockDb, id: string): Record<string, unknown> {
  const found = db.__all("documents").find((d) => d.id === id)
  if (!found) throw new Error(`no document ${id}`)
  return found
}

describe("backfillOrderNumbers (one-time, v0.9.0)", () => {
  test("resolves the order name from Shopify and records it on the column AND external_refs", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [seedDoc({ shopify_order_id: "12768069779622" })],
      ordersByGid: {
        "gid://shopify/Order/12768069779622": {
          status: "completed",
          result: { name: "#1149" },
        },
      },
    })
    const r = await backfillOrderNumbers(ctx, { now: new Date("2026-08-27T10:00:00Z") })
    expect(r.filled_from_shopify).toBe(1)
    const d = doc(db, "doc-1")
    expect(d.shopify_order_number).toBe("#1149")
    expect((d.external_refs as Record<string, unknown>).shopify_order_number).toBe("#1149")
    expect(calls).toHaveLength(1)
  })

  test("uses external_refs when the importer already recorded the number — no Shopify call", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [
        seedDoc({ external_refs: { shopify_order_number: "#2677", import_source: "sufio.csv" } }),
      ],
    })
    const r = await backfillOrderNumbers(ctx)
    expect(r.filled_from_refs).toBe(1)
    expect(r.filled_from_shopify).toBe(0)
    expect(doc(db, "doc-1").shopify_order_number).toBe("#2677")
    expect(calls).toHaveLength(0)
  })

  test("one Shopify fetch per UNIQUE order — a split order's two documents share it", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [
        seedDoc({ id: "doc-goods", shopify_order_id: "9001" }),
        seedDoc({ id: "doc-software", shopify_order_id: "9001" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9001": { status: "completed", result: { name: "#3276" } },
      },
    })
    await backfillOrderNumbers(ctx)
    expect(calls).toHaveLength(1)
    expect(doc(db, "doc-goods").shopify_order_number).toBe("#3276")
    expect(doc(db, "doc-software").shopify_order_number).toBe("#3276")
  })

  test("a second run is a NO-OP — the marker makes it idempotent and self-terminating", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [seedDoc({ shopify_order_id: "9001" })],
      ordersByGid: {
        "gid://shopify/Order/9001": { status: "completed", result: { name: "#3276" } },
      },
    })
    await backfillOrderNumbers(ctx)
    const second = await backfillOrderNumbers(ctx)
    expect(second.filled_from_shopify).toBe(0)
    expect(second.already_done).toBe(1)
    expect(calls).toHaveLength(1)
    const log = doc(db, "doc-1").lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === ORDER_NUMBER_BACKFILL_MARKER)).toHaveLength(1)
  })

  test("an order Shopify has no name for is marked done, so it is never refetched", async () => {
    // Without the marker the job would refetch this document every run forever
    // and never terminate.
    const { ctx, db, calls } = makeCtx({
      docs: [seedDoc({ shopify_order_id: "9001" })],
      ordersByGid: { "gid://shopify/Order/9001": { status: "completed", result: {} } },
    })
    const r = await backfillOrderNumbers(ctx)
    expect(r.no_name_available).toBe(1)
    expect(doc(db, "doc-1").shopify_order_number).toBeNull()
    await backfillOrderNumbers(ctx)
    expect(calls).toHaveLength(1)
  })

  test("documents with no Shopify order at all are skipped, not counted as remaining work", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [seedDoc({ id: "manual", shopify_order_id: null, external_refs: {} })],
    })
    const r = await backfillOrderNumbers(ctx)
    expect(r.filled_from_refs + r.filled_from_shopify).toBe(0)
    expect(r.remaining).toBe(0)
    expect(r.already_done).toBe(0)
    expect(calls).toHaveLength(0)
    expect(doc(db, "manual").lifecycle_log).toHaveLength(1)
  })

  test("a document that already carries an order number is left alone", async () => {
    const { ctx, calls } = makeCtx({
      docs: [seedDoc({ shopify_order_number: "#1149" })],
    })
    const r = await backfillOrderNumbers(ctx)
    expect(r.already_done).toBe(1)
    expect(calls).toHaveLength(0)
  })

  test("batch bound — the overflow is reported as remaining and picked up next run", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({ id: "doc-a", shopify_order_id: "1" }),
        seedDoc({ id: "doc-b", shopify_order_id: "2" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/1": { status: "completed", result: { name: "#1" } },
        "gid://shopify/Order/2": { status: "completed", result: { name: "#2" } },
      },
    })
    const first = await backfillOrderNumbers(ctx, { batchSize: 1 })
    expect(first.filled_from_shopify).toBe(1)
    expect(first.remaining).toBe(1)
    const second = await backfillOrderNumbers(ctx, { batchSize: 1 })
    expect(second.filled_from_shopify).toBe(1)
    expect(second.remaining).toBe(0)
    expect(doc(db, "doc-a").shopify_order_number).toBe("#1")
    expect(doc(db, "doc-b").shopify_order_number).toBe("#2")
  })

  test("a failed Shopify fetch leaves the document UNMARKED so the next run retries it", async () => {
    const { ctx, db } = makeCtx({ docs: [seedDoc({ shopify_order_id: "9001" })] })
    const r = await backfillOrderNumbers(ctx)
    // The envelope is an error, not a throw: no name, nothing written, and the
    // marker records that Shopify had nothing for us rather than spinning.
    expect(r.no_name_available).toBe(1)
    expect(doc(db, "doc-1").shopify_order_number).toBeNull()
  })

  test("job handler wrapper takes the kernel (payload, ctx) shape", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ shopify_order_id: "9001" })],
      ordersByGid: {
        "gid://shopify/Order/9001": { status: "completed", result: { name: "#3276" } },
      },
    })
    const r = await backfillOrderNumbersJobHandler({}, ctx)
    expect(r.filled_from_shopify).toBe(1)
    expect(doc(db, "doc-1").shopify_order_number).toBe("#3276")
  })
})
