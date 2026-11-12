// SPDX-License-Identifier: FSL-1.1-ALv2
// The boxtal import kinds (bundle exports the import runner calls in the
// sandbox): local products by SKU, packs with their component bill of
// materials, and shipping profiles. Imports only create: an existing row is
// skipped and left as it is, never upserted.
import { describe, expect, it } from "bun:test"
import { importLocalProducts, importPacks, importShippingProfiles } from "./import-kind"
import { createMockDb } from "./test-db"

function setup() {
  const db = createMockDb()
  return { db, ctx: { db } }
}

const batch = (records: Array<Record<string, unknown>>, label = "erp") => ({
  runId: "run-1",
  kind: "boxtal.x",
  sourceLabel: label,
  records: records.map((record) => ({
    record,
    dedupValue: `${label}:${String(record.sku ?? record.externalRef ?? record.productId)}`,
  })),
})

describe("boxtal.local-product", () => {
  it("creates a SKU once; an existing SKU is skipped and keeps its label", async () => {
    const { db, ctx } = setup()
    await db.insert("local_product", { sku: "PSU-12", label: "Original label" })
    const out = await importLocalProducts(
      batch([
        { sku: "PSU-12", label: "Imported label" },
        { sku: "CAB-2", label: "USB cable" },
        { sku: "CAB-2", label: "Duplicate in the file" },
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["skipped", "created", "skipped"])
    expect(out[1]!.rows).toEqual([{ table: "app_boxtal.local_product", id: expect.any(String) }])
    const rows = db.__all("local_product")
    expect(rows.map((r) => [r.sku, r.label])).toEqual([
      ["PSU-12", "Original label"],
      ["CAB-2", "USB cable"],
    ])
  })
})

describe("boxtal.pack", () => {
  it("creates a pack with its components, keyed by its external ref", async () => {
    const { db, ctx } = setup()
    await db.insert("local_product", { sku: "PSU-12", label: "Power supply" })
    const out = await importPacks(
      batch([
        {
          externalRef: "KIT-1",
          name: "Starter kit",
          length: 40,
          width: 30,
          height: 12,
          grossWeight: 2.4,
          components: [
            { sku: "PSU-12", quantity: 1 },
            { shopifyProductId: "gid://shopify/Product/9", quantity: 2 },
          ],
        },
      ]),
      ctx,
    )
    expect(out[0]!.status).toBe("created")
    const [pack] = db.__all("pack")
    expect([pack!.name, pack!.gross_weight, pack!.external_ref]).toEqual([
      "Starter kit",
      2.4,
      "erp:KIT-1",
    ])
    const comps = db.__all("pack_component")
    expect(comps.map((c) => [c.product_source, c.product_id, c.quantity])).toEqual([
      ["local", "PSU-12", 1],
      ["shopify", "gid://shopify/Product/9", 2],
    ])
    expect(out[0]!.rows.map((r) => r.table)).toEqual([
      "app_boxtal.pack",
      "app_boxtal.pack_component",
      "app_boxtal.pack_component",
    ])
    const again = await importPacks(
      batch([
        {
          externalRef: "KIT-1",
          name: "Renamed",
          length: 1,
          width: 1,
          height: 1,
          grossWeight: 1,
          components: [],
        },
      ]),
      ctx,
    )
    expect(again.map((r) => r.status)).toEqual(["skipped"])
    expect(db.__all("pack")[0]!.name).toBe("Starter kit")
  })

  it("a component with an unknown SKU fails the record and writes nothing", async () => {
    const { db, ctx } = setup()
    const out = await importPacks(
      batch([
        {
          externalRef: "KIT-2",
          name: "Broken kit",
          length: 10,
          width: 10,
          height: 10,
          grossWeight: 1,
          components: [{ sku: "NOPE", quantity: 1 }],
        },
      ]),
      ctx,
    )
    expect(out[0]!.status).toBe("failed")
    expect(out[0]!.error).toMatch(/NOPE/)
    expect(db.__all("pack")).toHaveLength(0)
    expect(db.__all("pack_component")).toHaveLength(0)
  })
})

describe("boxtal.pack: a write that fails midway", () => {
  it("reports the rows already written, so the run ledgers them and undo removes them", async () => {
    const { db } = setup()
    const failing = {
      findMany: db.findMany.bind(db),
      insert: async (entity: string, data: Record<string, unknown>) => {
        if (entity === "pack_component") throw new Error("component write refused")
        return db.insert(entity, data)
      },
    }
    const out = await importPacks(
      batch([
        {
          externalRef: "KIT-3",
          name: "Half kit",
          length: 10,
          width: 10,
          height: 10,
          grossWeight: 1,
          components: [{ shopifyProductId: "123", quantity: 1 }],
        },
      ]),
      { db: failing as never },
    )
    expect(out[0]!.status).toBe("failed")
    expect(out[0]!.error).toMatch(/component write refused/)
    const [pack] = db.__all("pack")
    expect(out[0]!.rows).toEqual([{ table: "app_boxtal.pack", id: String(pack!.id) }])
  })

  it("checks the dimensions before writing anything", async () => {
    const { db, ctx } = setup()
    const out = await importPacks(
      batch([
        {
          externalRef: "KIT-4",
          name: "Flat",
          length: 10,
          width: 10,
          height: 0,
          grossWeight: 1,
          components: [{ shopifyProductId: "123", quantity: 1 }],
        },
      ]),
      ctx,
    )
    expect(out[0]!.status).toBe("failed")
    expect(db.__all("pack")).toHaveLength(0)
  })
})

describe("boxtal.shipping-profile", () => {
  it("creates a product's profile; an existing one is skipped untouched", async () => {
    const { db, ctx } = setup()
    await db.insert("shipping_profile", {
      product_source: "shopify",
      product_id: "V1",
      unit_weight: 1.5,
    })
    const out = await importShippingProfiles(
      batch([
        { productSource: "shopify", productId: "V1", unitWeight: 9 },
        {
          productSource: "local",
          productId: "PSU-12",
          unitWeight: 0.4,
          shortCode: "PS",
          accessory: true,
        },
        { productSource: "shopify", productId: "V2", unitWeight: 0 },
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["skipped", "created", "failed"])
    // The existing per-variant row is untouched; the new one is a shared profile + its link, and
    // its values are mirrored onto a stamped per-variant row for the previous release.
    expect(
      db
        .__all("shipping_profile")
        .map((r) => [r.product_id, r.unit_weight, r.migrated_profile_id ?? null]),
    ).toEqual([
      ["V1", 1.5, null],
      ["PSU-12", 0.4, db.__all("product_profile")[0]!.id],
    ])
    const profiles = db.__all("product_profile")
    expect(profiles.map((r) => [r.unit_weight, r.short_code ?? null, r.accessory ?? null])).toEqual(
      [[0.4, "PS", true]],
    )
    expect(
      db.__all("product_profile_link").map((r) => [r.product_source, r.product_id, r.profile_id]),
    ).toEqual([["local", "PSU-12", profiles[0]!.id]])
  })
})
