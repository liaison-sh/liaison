// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Short codes live on the product (product-attributes.ts): profile codes are copied onto the
// variants' SKUs in the kernel's product attributes (idempotent fill-only backfill, overwrite on
// an explicit code edit), and a draft reads the code from there first, the profile's own code as
// the fallback.
import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { productProfileLinkHandler, productProfileUpsertHandler } from "./handlers"
import { packagesList } from "./catalog"
import {
  CODE_SYNC_TABLE,
  knownVariantSkus,
  type ProductAttributeCtx,
  readShortCodesBySku,
  syncProductCodesJobHandler,
  syncProductShortCodes,
  VARIANT_SKU_TABLE,
  withAttributeShortCodes,
} from "./product-attributes"
import { loadVariantProfiles, LINK_TABLE, PROFILE_TABLE } from "./profiles"
import { createMockDb, type MockDb } from "./test-db"

const V1 = "gid://shopify/ProductVariant/101"
const V2 = "gid://shopify/ProductVariant/102"

/** A fake kernel attribute store + a fake Shopify variants_brief, behind ctx.executeTool. */
function harness(opts: { attrs?: Record<string, string>; skus?: Record<string, string> } = {}) {
  const attrs = new Map(Object.entries(opts.attrs ?? {}))
  const skus = opts.skus ?? { [V1]: "DEV-2-BLK", [V2]: "DEV-2-WHT" }
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const executeTool = async (target: string, args: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    calls.push({ target, args })
    if (target === "shopify:variants_brief") {
      const ids = args.ids as string[]
      return {
        status: "completed",
        result: { variants: ids.filter((id) => skus[id]).map((id) => ({ id, sku: skus[id] })) },
      }
    }
    if (target === "kernel:product_attributes_list") {
      const wanted = args.skus as string[]
      return {
        status: "completed",
        result: {
          attributes: wanted
            .filter((s) => attrs.has(s))
            .map((sku) => ({ sku, key: "short_code", value: attrs.get(sku) })),
          truncated: false,
        },
      }
    }
    if (target === "kernel:product_attributes_upsert") {
      let written = 0
      let unchanged = 0
      for (const i of args.items as Array<{ sku: string; value: string }>) {
        if (attrs.get(i.sku) === i.value) unchanged++
        else {
          attrs.set(i.sku, i.value)
          written++
        }
      }
      return { status: "completed", result: { written, deleted: 0, unchanged } }
    }
    throw new Error(`unexpected cross-app call ${target}`)
  }
  return { attrs, calls, executeTool }
}

/** A tool handler's ctx over the mock db (the repo's usual test fake: only db + executeTool are read). */
function toolCtx(db: MockDb, executeTool: ProductAttributeCtx["executeTool"]): BoxtalToolCtx {
  const bridged: BoxtalToolCtx["executeTool"] = (target, args) =>
    executeTool(target, typeof args === "string" ? (JSON.parse(args) as Record<string, unknown>) : args)
  return { db, executeTool: bridged, orgId: "o" } as unknown as BoxtalToolCtx
}

function seededDb(): MockDb {
  return createMockDb({
    seed: {
      [PROFILE_TABLE]: [
        { id: "p1", unit_weight: 2, short_code: "E2" },
        { id: "p2", unit_weight: 1, short_code: "FS" },
        { id: "p3", unit_weight: 1, short_code: null },
      ],
      [LINK_TABLE]: [
        { id: "l1", product_source: "shopify", product_id: V1, profile_id: "p1" },
        { id: "l2", product_source: "shopify", product_id: V2, profile_id: "p1" },
        { id: "l3", product_source: "local", product_id: "STAND-1", profile_id: "p2" },
        { id: "l4", product_source: "shopify", product_id: "gid://shopify/ProductVariant/999", profile_id: "p3" },
      ],
    },
  })
}

describe("backfill: profile short codes onto product SKUs", () => {
  it("writes each linked variant's SKU, caches Shopify SKUs, and a second run changes nothing", async () => {
    const db = seededDb()
    const h = harness()
    const ctx = { db, executeTool: h.executeTool }
    const first = await syncProductCodesJobHandler({}, ctx)
    expect(first).toMatchObject({ written: 3, unchanged: 0, skipped: 0, pending: false })
    expect(Object.fromEntries(h.attrs)).toEqual({ "DEV-2-BLK": "E2", "DEV-2-WHT": "E2", "STAND-1": "FS" })
    // The Shopify SKUs are cached: the read path never has to call the store.
    const cached = (await db.findMany(VARIANT_SKU_TABLE)) as Array<{ product_id: string; sku: string }>
    expect(cached.map((r) => [r.product_id, r.sku]).sort()).toEqual([
      [V1, "DEV-2-BLK"],
      [V2, "DEV-2-WHT"],
    ])

    h.calls.length = 0
    const second = await syncProductCodesJobHandler({}, ctx)
    expect(second).toMatchObject({ written: 0, unchanged: 3, skipped: 0, pending: false })
    expect(h.calls.map((c) => c.target)).toEqual(["kernel:product_attributes_list"])
  })

  it("the backfill never overwrites a code set elsewhere; an explicit profile edit does", async () => {
    const db = seededDb()
    const h = harness({ attrs: { "STAND-1": "ST" } })
    const ctx = { db, executeTool: h.executeTool }
    await syncProductShortCodes(ctx, { mode: "fill" })
    expect(h.attrs.get("STAND-1")).toBe("ST")
    await syncProductShortCodes(ctx, { mode: "overwrite", profileIds: ["p2"] })
    expect(h.attrs.get("STAND-1")).toBe("FS")
  })

  it("skips a SKU two profiles give different codes, and a variant whose SKU is unknown", async () => {
    const db = seededDb()
    const h = harness({ skus: { [V1]: "SAME", [V2]: "SAME" } })
    await db.update(PROFILE_TABLE, "p2", { short_code: "FS" })
    await db.insert(LINK_TABLE, { product_source: "local", product_id: "SAME", profile_id: "p2" })
    const res = await syncProductShortCodes({ db, executeTool: h.executeTool }, { mode: "fill" })
    // SAME: E2 from p1 (two variants) and FS from p2 -> conflict, skipped.
    expect(h.attrs.has("SAME")).toBe(false)
    expect(h.attrs.get("STAND-1")).toBe("FS")
    expect(res.skipped).toBe(1)
  })

  it("a profile upsert that sets a code pushes it at once; the write never fails on the sync", async () => {
    const db = seededDb()
    const h = harness()
    const res = await productProfileUpsertHandler(
      { product_source: "local", product_id: "STAND-1", unit_weight: 1, short_code: "ST" },
      toolCtx(db, h.executeTool),
    )
    expect(res.product_codes).toMatchObject({ written: 1 })
    expect(h.attrs.get("STAND-1")).toBe("ST")

    const broken = toolCtx(db, async (): Promise<CrossAppEnvelope> => {
      throw new Error("kernel down")
    })
    const ok = await productProfileUpsertHandler(
      { product_source: "local", product_id: "STAND-1", unit_weight: 1.5, short_code: "SX" },
      broken,
    )
    expect(ok.id).toBeTruthy()
    expect(ok.product_codes).toMatchObject({ error: expect.stringContaining("kernel down") })
  })

  it("linking a variant fills its SKU's code from the profile it joined", async () => {
    const db = seededDb()
    const h = harness({ skus: { [V1]: "DEV-2-BLK", [V2]: "DEV-2-WHT", "gid://shopify/ProductVariant/7": "DEV-2-RED" } })
    await productProfileLinkHandler(
      { product_source: "shopify", product_id: "7", profile_id: "p1" },
      toolCtx(db, h.executeTool),
    )
    expect(h.attrs.get("DEV-2-RED")).toBe("E2")
  })
})

describe("read: the product attribute first, the profile's code as fallback", () => {
  it("a variant whose SKU has an attribute reads it; the others keep the profile's code", async () => {
    const db = seededDb()
    await db.insert(VARIANT_SKU_TABLE, { product_source: "shopify", product_id: V1, sku: "DEV-2-BLK" })
    const h = harness({ attrs: { "DEV-2-BLK": "D2", "STAND-1": "FS" } })
    const profiles = await withAttributeShortCodes({ db, executeTool: h.executeTool }, await loadVariantProfiles(db))
    const byId = Object.fromEntries(profiles.map((p) => [p.product_id, p.short_code]))
    expect(byId[V1]).toBe("D2") // attribute wins
    expect(byId[V2]).toBe("E2") // SKU not known yet: the profile's own code
    expect(byId["STAND-1"]).toBe("FS")
    // The read path never calls the store.
    expect(h.calls.map((c) => c.target)).toEqual(["kernel:product_attributes_list"])
  })

  it("any lookup failure leaves the profiles' own codes", async () => {
    const db = seededDb()
    const profiles = await loadVariantProfiles(db)
    const out = await withAttributeShortCodes(
      {
        db,
        executeTool: async (): Promise<CrossAppEnvelope> => ({
          status: "error",
          error: { code: "forbidden", message: "no" },
        }),
      },
      profiles,
    )
    expect(out).toEqual(profiles)
    expect(
      await readShortCodesBySku(
        {
          db,
          executeTool: async () => {
            throw new Error("down")
          },
        },
        ["X"],
      ),
    ).toEqual(new Map())
  })
})

/** The harness, with the kernel's upsert answering `status` instead of writing (parked, refused). */
function parkedHarness(opts: { attrs?: Record<string, string>; skus?: Record<string, string> } = {}) {
  const h = harness(opts)
  let answer: "park" | "error" | "write" = "park"
  const executeTool = async (target: string, args: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    if (target === "kernel:product_attributes_upsert" && answer === "park") {
      h.calls.push({ target, args })
      return { status: "pending_approval", approval_id: "ap1" }
    }
    if (target === "kernel:product_attributes_upsert" && answer === "error") {
      h.calls.push({ target, args })
      return { status: "error", error: { code: "invalid_input", message: "threadId required" } }
    }
    return h.executeTool(target, args)
  }
  return { ...h, executeTool, answer: (a: "park" | "error" | "write") => (answer = a) }
}

async function draftCodes(db: MockDb, executeTool: ProductAttributeCtx["executeTool"]) {
  const profiles = await withAttributeShortCodes({ db, executeTool }, await loadVariantProfiles(db))
  return Object.fromEntries(profiles.map((p) => [p.product_id, p.short_code]))
}

describe("a profile code the kernel did not take yet", () => {
  for (const outcome of ["park", "error"] as const) {
    it(`(${outcome}) the draft reads the profile's NEW code, the catalog says so, and the daily retry clears it`, async () => {
      const db = seededDb()
      const h = parkedHarness({ attrs: { "STAND-1": "FS" } })
      h.answer(outcome)
      const ctx = toolCtx(db, h.executeTool)
      const res = await productProfileUpsertHandler(
        { product_source: "local", product_id: "STAND-1", unit_weight: 1, short_code: "ST" },
        ctx,
      )
      expect(res.product_codes).toMatchObject({ not_synced: 1, pending: outcome === "park" })
      expect(h.attrs.get("STAND-1")).toBe("FS")
      // Not the kernel's stale FS: the operator's new code.
      expect((await draftCodes(db, h.executeTool))["STAND-1"]).toBe("ST")
      const list = await packagesList(ctx, {})
      expect(list.shared_profiles.find((p) => p.id === "p2")?.short_code_sync).toMatchObject({
        state: "pending",
        skus: ["STAND-1"],
      })

      // The daily job retries the pending SKU with overwrite (fill alone would keep FS).
      h.answer("write")
      const job = await syncProductCodesJobHandler({}, { db, executeTool: h.executeTool })
      expect(job.not_synced).toBe(0)
      expect(h.attrs.get("STAND-1")).toBe("ST")
      expect(await db.findMany(CODE_SYNC_TABLE)).toEqual([])
      expect((await draftCodes(db, h.executeTool))["STAND-1"]).toBe("ST")
      const after = await packagesList(ctx, {})
      expect(after.shared_profiles.find((p) => p.id === "p2")?.short_code_sync).toBeNull()
    })
  }

  it("a profile write that leaves the stored code unchanged never overwrites a code set elsewhere", async () => {
    const db = seededDb()
    const h = harness({ attrs: { "STAND-1": "ST" } })
    await productProfileUpsertHandler(
      { product_source: "local", product_id: "STAND-1", unit_weight: 2, short_code: "FS" },
      toolCtx(db, h.executeTool),
    )
    expect(h.attrs.get("STAND-1")).toBe("ST")
    expect(h.calls.some((c) => c.target === "kernel:product_attributes_upsert")).toBe(false)
  })

  it("never clobbers a SKU another profile gives a different code: it reports the conflict", async () => {
    const db = seededDb()
    const h = harness({ attrs: { SAME: "E2" }, skus: { [V1]: "SAME", [V2]: "DEV-2-WHT" } })
    await db.insert(LINK_TABLE, { product_source: "local", product_id: "SAME", profile_id: "p2" })
    const res = await syncProductShortCodes(
      { db, executeTool: h.executeTool },
      { mode: "overwrite", profileIds: ["p2"] },
    )
    expect(h.attrs.get("SAME")).toBe("E2")
    expect(res.conflicts).toEqual([{ sku: "SAME", codes: ["E2", "FS"] }])
    const list = await packagesList(toolCtx(db, h.executeTool), {})
    for (const id of ["p1", "p2"]) {
      expect(list.shared_profiles.find((p) => p.id === id)?.short_code_sync).toMatchObject({
        state: "conflict",
        skus: ["SAME"],
      })
    }
  })
})

describe("the variant SKU cache is read by the variants asked for", () => {
  it("finds a cached SKU however many other variants are cached", async () => {
    const db = seededDb()
    for (let i = 0; i < 1001; i++) {
      await db.insert(VARIANT_SKU_TABLE, { product_source: "shopify", product_id: `gid://shopify/ProductVariant/9${i}`, sku: `X${i}` })
    }
    await db.insert(VARIANT_SKU_TABLE, { product_source: "shopify", product_id: V1, sku: "DEV-2-BLK" })
    const known = await knownVariantSkus(db, [{ product_source: "shopify", product_id: V1 }])
    expect(known.get(`shopify:${V1}`)).toBe("DEV-2-BLK")
  })
})
