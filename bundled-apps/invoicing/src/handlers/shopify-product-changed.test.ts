// SPDX-License-Identifier: FSL-1.1-ALv2
//
// onShopifyProductChanged — syncs Shopify product customs (HS code + country of
// origin + customs-description metafield) into product_customs_overlay.
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { onShopifyProductChanged, type ProductSyncCtx } from "./shopify-product-changed"

const PRODUCT = {
  id: "gid://shopify/Product/2",
  attributes: {
    customs_description: "Electronic pad controller",
    variants: [
      {
        id: "gid://shopify/ProductVariant/22",
        hs_code: "9207.10",
        country_of_origin: "CN",
        customs_description: "Electronic pad controller",
      },
      // Unclassified variant — no customs data → must NOT create an overlay row.
      { id: "gid://shopify/ProductVariant/23", hs_code: null, country_of_origin: null, customs_description: null },
    ],
  },
}

function makeCtx(result: unknown = PRODUCT, status: "completed" | "error" = "completed") {
  const db = createMockDb({})
  const calls: Array<{ target: string; args: unknown }> = []
  const ctx = {
    db,
    executeTool: async (target: string, args: unknown) => {
      calls.push({ target, args })
      return status === "completed"
        ? ({ status: "completed", result } as const)
        : ({ status: "error", error: { code: "target_app_unavailable", message: "down" } } as const)
    },
  } as unknown as ProductSyncCtx
  return { ctx, db, calls }
}

describe("onShopifyProductChanged (Shopify customs → overlay sync)", () => {
  test("fetches the product via shopify:products_get and upserts one overlay row per customs-bearing variant", async () => {
    const { ctx, db, calls } = makeCtx()
    const r = await onShopifyProductChanged({ entityId: "gid://shopify/Product/2" }, ctx)
    expect(r.status).toBe("ok")
    expect(r.synced).toBe(1) // the unclassified variant is skipped
    expect(calls[0]?.target).toBe("shopify:products_get")
    const rows = db.__all("product_customs_overlay")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: "shopify",
      external_id: "gid://shopify/ProductVariant/22",
      hs_code: "9207.10",
      country_of_origin: "CN",
      customs_description: "Electronic pad controller",
    })
  })

  test("re-sync updates the same row (idempotent on source + external_id)", async () => {
    const { ctx, db } = makeCtx()
    await onShopifyProductChanged({ entityId: "gid://shopify/Product/2" }, ctx)
    await onShopifyProductChanged({ entityId: "gid://shopify/Product/2" }, ctx)
    expect(db.__all("product_customs_overlay")).toHaveLength(1)
  })

  test("skips gracefully when shopify:products_get is unavailable (offline / not installed)", async () => {
    const { ctx, db } = makeCtx(PRODUCT, "error")
    const r = await onShopifyProductChanged({ entityId: "gid://shopify/Product/2" }, ctx)
    expect(r.status).toBe("skipped")
    expect(db.__all("product_customs_overlay")).toHaveLength(0)
  })

  test("skips when the event carries no product id", async () => {
    const { ctx } = makeCtx()
    const r = await onShopifyProductChanged({}, ctx)
    expect(r.status).toBe("skipped")
    expect(r.synced).toBe(0)
  })
})
