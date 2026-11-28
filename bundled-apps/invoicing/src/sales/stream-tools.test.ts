// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bound stream's buyer source key: the `source.stream` the buyer invoices API emits for its
// sales (the name the shop's website gives that stream). Set and cleared through
// `revenue_stream_bind`, validated, refused on the shop's stream, shown by `revenue_streams_list`.
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { revenueStreamBind, revenueStreamsList, type StreamToolsCtx } from "./stream-tools"

function makeCtx() {
  const db = createMockDb({
    seed: {
      issuer_profiles: [{ id: "issuer-1", legal_name: "Studio Test SARL", country: "FR" }],
      revenue_streams: [
        {
          id: "stream-stripe",
          provider_app: "stripe",
          source_ref: null,
          label: "Stripe",
          issuer_profile_id: "issuer-1",
          mode: "auto",
          issue_from: "2026-11-01T00:00:00.000Z",
          mail: "none",
        },
        {
          id: "stream-shop",
          provider_app: "shopify",
          source_ref: null,
          label: "Shopify",
          issuer_profile_id: null,
          mode: "auto",
          issue_from: null,
          mail: "invoice_only",
        },
      ],
    },
    bridgeWhereOperators: true,
  })
  const ctx = { db, getUserId: async () => "user-1", approval: null } as unknown as StreamToolsCtx
  return { ctx, db }
}

describe("revenue_stream_bind buyerSourceKey", () => {
  test("sets, shows and clears the key a bound stream's sales are listed under", async () => {
    const { ctx } = makeCtx()
    const r = await revenueStreamBind(ctx, { streamId: "stream-stripe", buyerSourceKey: "hub" })
    expect(r.status).toBe("completed")
    expect((r as { stream: { buyerSourceKey: string | null } }).stream.buyerSourceKey).toBe("hub")
    const list = await revenueStreamsList(ctx)
    const stripe = list.streams.find((s) => s.streamId === "stream-stripe")
    expect(stripe?.buyerSourceKey).toBe("hub")
    // Other fields are kept.
    expect(stripe?.mode).toBe("auto")
    const cleared = await revenueStreamBind(ctx, {
      streamId: "stream-stripe",
      buyerSourceKey: null,
    })
    expect((cleared as { stream: { buyerSourceKey: string | null } }).stream.buyerSourceKey).toBe(
      null,
    )
  })

  test("a key that is not a short lower-case name is refused", async () => {
    const { ctx } = makeCtx()
    for (const bad of ["", "Hub", "hub key", "-hub", "x".repeat(41)]) {
      const r = await revenueStreamBind(ctx, { streamId: "stream-stripe", buyerSourceKey: bad })
      expect(r.status).toBe("error")
    }
  })

  test("the shop's stream keeps shopify", async () => {
    const { ctx } = makeCtx()
    const r = await revenueStreamBind(ctx, { streamId: "stream-shop", buyerSourceKey: "hub" })
    expect(r).toMatchObject({ status: "error", error: { code: "shop_source_key_fixed" } })
  })
})
