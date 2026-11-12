// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  packDelete,
  packUpsert,
  packagesList,
  localProductUpsert,
  productProfileUpsert,
} from "./catalog"
import { createMockDb } from "./test-db"

function makeCtx() {
  const db = createMockDb()
  return { ctx: { db } as any, db }
}

describe("catalog CRUD", () => {
  it("product_profile_upsert inserts then updates the same variant's profile — count stays 1", async () => {
    const { ctx, db } = makeCtx()
    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V1",
      unit_weight: 1.2,
      solo_length: 30,
      solo_width: 20,
      solo_height: 10,
      content_category: "content:v1:10120",
    })
    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V1",
      unit_weight: 1.5,
    })
    const rows = db.__all("product_profile")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.unit_weight).toBe(1.5)
    expect(db.__all("product_profile_link")).toHaveLength(1)
  })

  it("product_profile_upsert rejects unit_weight <= 0", async () => {
    const { ctx } = makeCtx()
    await expect(
      productProfileUpsert(ctx, { product_source: "shopify", product_id: "V1", unit_weight: 0 }),
    ).rejects.toThrow()
  })

  it("pack_upsert inserts a pack + its components; update replaces the component set", async () => {
    const { ctx, db } = makeCtx()
    const { id } = await packUpsert(ctx, {
      name: "box-a",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 5,
      components: [
        { product_source: "shopify", product_id: "V1", quantity: 1 },
        { product_source: "shopify", product_id: "V2", quantity: 1 },
      ],
    })
    expect(db.__all("pack")).toHaveLength(1)
    expect(db.__all("pack_component")).toHaveLength(2)
    // update with a new component set replaces the old
    await packUpsert(ctx, {
      id,
      name: "box-a",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 6,
      components: [{ product_source: "shopify", product_id: "V1", quantity: 3 }],
    })
    expect(db.__all("pack")).toHaveLength(1)
    expect(db.__all("pack").find((p) => p.id === id)!.gross_weight).toBe(6)
    const comps = db.__all("pack_component").filter((c) => c.pack_id === id)
    expect(comps).toHaveLength(1)
    expect(comps[0]!.quantity).toBe(3)
  })

  it("pack_upsert persists carton_tare when sent, and null when omitted", async () => {
    const { ctx, db } = makeCtx()
    const { id: tared } = await packUpsert(ctx, {
      name: "box-tared",
      length: 60,
      width: 40,
      height: 20,
      gross_weight: 7.3,
      carton_tare: 0.5,
      components: [],
    })
    expect(db.__all("pack").find((p) => p.id === tared)!.carton_tare).toBe(0.5)

    const { id: untared } = await packUpsert(ctx, {
      name: "box-untared",
      length: 45,
      width: 30,
      height: 15,
      gross_weight: 4.85,
      components: [],
    })
    expect(db.__all("pack").find((p) => p.id === untared)!.carton_tare).toBeNull()
  })

  it("pack_upsert echoes component_count and warns when the BOM is EMPTY (affordance hint, not a fallback)", async () => {
    // REGRESSION (journey l766 S7): a weak model omitted the required 4-item BOM and reported the bundle
    // pack as done. The tool now surfaces the gap — an empty `components` returns a warning so the model
    // knows the bundle carton has no bill of materials, and component_count reports what was actually saved.
    const { ctx } = makeCtx()
    const empty = await packUpsert(ctx, {
      name: "studio-bundle-carton",
      length: 44,
      width: 34,
      height: 24,
      gross_weight: 5,
      components: [],
    })
    expect(empty.component_count).toBe(0)
    expect(empty.warning).toBeDefined()
    expect(empty.warning).toContain("EMPTY")

    const full = await packUpsert(ctx, {
      name: "studio-bundle-carton-full",
      length: 44,
      width: 34,
      height: 24,
      gross_weight: 5,
      components: [
        { product_source: "local", product_id: "RAL-44", quantity: 1 },
        { product_source: "local", product_id: "RAL-WND", quantity: 1 },
        { product_source: "local", product_id: "RAL-CASE", quantity: 1 },
        { product_source: "local", product_id: "RAL-CBL", quantity: 1 },
      ],
    })
    expect(full.component_count).toBe(4)
    expect(full.warning).toBeUndefined()
  })

  it("pack_delete removes the pack and its components", async () => {
    const { ctx, db } = makeCtx()
    const { id } = await packUpsert(ctx, {
      name: "box-a",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 5,
      components: [{ product_source: "shopify", product_id: "V1", quantity: 1 }],
    })
    await packDelete(ctx, { id })
    expect(db.__all("pack")).toHaveLength(0)
    expect(db.__all("pack_component").filter((c) => c.pack_id === id)).toHaveLength(0)
  })

  it("pack_delete on a non-existent id is a no-op", async () => {
    const { ctx } = makeCtx()
    await expect(packDelete(ctx, { id: "missing" })).resolves.toBeDefined()
  })

  it("local_product_upsert is unique on sku (duplicate sku updates)", async () => {
    const { ctx, db } = makeCtx()
    await localProductUpsert(ctx, { sku: "SKU1", label: "Widget" })
    await localProductUpsert(ctx, { sku: "SKU1", label: "Widget v2" })
    expect(db.__all("local_product")).toHaveLength(1)
    expect(db.__all("local_product")[0]!.label).toBe("Widget v2")
  })

  it("packages_list returns profiles, packs (with component labels), and local_products", async () => {
    const { ctx } = makeCtx()
    await productProfileUpsert(ctx, { product_source: "shopify", product_id: "V1", unit_weight: 1 })
    await localProductUpsert(ctx, { sku: "SKU1", label: "Widget" })
    await packUpsert(ctx, {
      name: "box-a",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 5,
      components: [{ product_source: "shopify", product_id: "V1", quantity: 2 }],
    })
    const res = await packagesList(ctx, {})
    expect(res.profiles).toHaveLength(1)
    expect(res.local_products).toHaveLength(1)
    expect(res.packs).toHaveLength(1)
    expect(res.packs[0]!.components).toHaveLength(1)
    expect(res.packs[0]!.components[0]!.quantity).toBe(2)
  })

  it("packages_list flags stale when a component references a missing profile", async () => {
    const { ctx } = makeCtx()
    await packUpsert(ctx, {
      name: "box-a",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 5,
      components: [{ product_source: "shopify", product_id: "GHOST", quantity: 1 }],
    })
    const res = await packagesList(ctx, {})
    expect(res.packs[0]!.stale).toBe(true)
  })
})
