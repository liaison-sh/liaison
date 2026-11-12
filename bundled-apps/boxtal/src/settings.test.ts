// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import { NEUTRAL_PACKAGING_POLICY } from "./packaging-policy"
import {
  loadCarrierAllowlist,
  loadExcludePickupPointServices,
  loadLabelFormat,
  loadPackagingPolicy,
  loadProductCodeConfig,
  settingsCarrierAllowlistGet,
  settingsCarrierAllowlistSet,
  settingsFormGet,
  settingsFormSet,
  settingsLabelFormatGet,
  settingsLabelFormatSet,
  settingsPackagingPolicyGet,
  settingsPackagingPolicySet,
  settingsProductCodesGet,
  settingsProductCodesSet,
  settingsSenderAddressGet,
  settingsSenderAddressSet,
  settingsSenderFormGet,
} from "./settings"
import { createMockDb } from "./test-db"

function makeCtx(seed?: Array<Record<string, unknown>>) {
  const db = createMockDb({ seed: seed ? { app_config: seed } : {} })
  return { ctx: { db } as never, db }
}

const FULL = {
  name: "Fabrikam SAS",
  phone: "+33123456789",
  email: "support@fabrikam.example",
  street: "10 Rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  countryIsoCode: "FR",
}

describe("settingsSenderAddress", () => {
  it("get returns null + all-missing when unset", async () => {
    const { ctx } = makeCtx()
    const res = await settingsSenderAddressGet(ctx)
    expect(res.sender).toBeNull()
    expect(res.missing).toContain("all")
  })

  it("set persists, get reads it back with zero missing fields", async () => {
    const { ctx, db } = makeCtx()
    const setRes = await settingsSenderAddressSet(ctx, FULL)
    expect(setRes.ok).toBe(true)
    expect(setRes.missing).toHaveLength(0)
    expect(db.__all("app_config").filter((r) => r.key === "sender_address")).toHaveLength(1)
    const got = await settingsSenderAddressGet(ctx)
    expect(got.sender).toMatchObject({ city: "Paris", countryIsoCode: "FR" })
    expect(got.missing).toHaveLength(0)
  })

  it("set upserts a single row (no duplicate config keys)", async () => {
    const { ctx, db } = makeCtx()
    await settingsSenderAddressSet(ctx, FULL)
    await settingsSenderAddressSet(ctx, { ...FULL, city: "Lyon" })
    expect(db.__all("app_config").filter((r) => r.key === "sender_address")).toHaveLength(1)
    const got = await settingsSenderAddressGet(ctx)
    expect(got.sender?.city).toBe("Lyon")
  })

  it("set flags missing structured fields", async () => {
    const { ctx } = makeCtx()
    const res = await settingsSenderAddressSet(ctx, { name: "X" })
    expect(res.missing).toEqual(
      expect.arrayContaining(["phone", "street", "city", "postalCode", "countryIsoCode"]),
    )
  })
})

describe("settingsCarrierAllowlist", () => {
  it("get returns an empty allowlist (no restriction) when unset, plus the brand catalogue", async () => {
    const { ctx } = makeCtx()
    const res = await settingsCarrierAllowlistGet(ctx)
    expect(res.allowed).toEqual([])
    expect(res.available.map((b) => b.key)).toEqual(expect.arrayContaining(["ups", "fedex", "dhl"]))
  })

  it("set persists canonical keys and get reads them back", async () => {
    const { ctx, db } = makeCtx()
    const res = await settingsCarrierAllowlistSet(ctx, { carriers: ["ups", "fedex", "dhl"] })
    expect(res).toEqual({
      ok: true,
      allowed: ["ups", "fedex", "dhl"],
      exclude_pickup_point_services: true,
    })
    expect(db.__all("app_config").filter((r) => r.key === "carrier_allowlist")).toHaveLength(1)
    expect(await loadCarrierAllowlist(ctx)).toEqual(["ups", "fedex", "dhl"])
  })

  it("accepts brand names/labels and de-dupes to canonical keys", async () => {
    const { ctx } = makeCtx()
    const res = await settingsCarrierAllowlistSet(ctx, { carriers: ["UPS", "FedEx", "DHL", "ups"] })
    expect(res.allowed).toEqual(["ups", "fedex", "dhl"])
  })

  it("rejects an unknown carrier rather than silently dropping it", async () => {
    const { ctx } = makeCtx()
    await expect(settingsCarrierAllowlistSet(ctx, { carriers: ["ups", "acme"] })).rejects.toThrow(
      /Unknown carrier/,
    )
    // Nothing persisted on rejection.
    expect(await loadCarrierAllowlist(ctx)).toEqual([])
  })

  it("upserts a single config row and an empty list lifts the restriction", async () => {
    const { ctx, db } = makeCtx()
    await settingsCarrierAllowlistSet(ctx, { carriers: ["ups", "fedex", "dhl"] })
    const res = await settingsCarrierAllowlistSet(ctx, { carriers: [] })
    expect(res.allowed).toEqual([])
    expect(db.__all("app_config").filter((r) => r.key === "carrier_allowlist")).toHaveLength(1)
    expect(await loadCarrierAllowlist(ctx)).toEqual([])
  })

  it("degrades a corrupt stored value to 'allow all' (empty), never a crash", async () => {
    const { ctx } = makeCtx([{ key: "carrier_allowlist", value: "not-an-array" }])
    expect(await loadCarrierAllowlist(ctx)).toEqual([])
  })

  it("get exposes the pickup-point policy, defaulting to excluded (true) when unset", async () => {
    const { ctx } = makeCtx()
    const res = await settingsCarrierAllowlistGet(ctx)
    expect(res.exclude_pickup_point_services).toBe(true)
  })
})

describe("exclude_pickup_point_services policy", () => {
  it("defaults to true (relay excluded) for an org that never set it", async () => {
    const { ctx } = makeCtx()
    expect(await loadExcludePickupPointServices(ctx)).toBe(true)
  })

  it("persists an explicit false without touching the carrier allowlist", async () => {
    const { ctx, db } = makeCtx()
    await settingsCarrierAllowlistSet(ctx, { carriers: ["ups", "fedex"] })
    const res = await settingsCarrierAllowlistSet(ctx, { exclude_pickup_point_services: false })
    expect(res.exclude_pickup_point_services).toBe(false)
    expect(res.allowed).toEqual(["ups", "fedex"]) // allowlist unchanged by the toggle
    expect(await loadExcludePickupPointServices(ctx)).toBe(false)
    expect(await loadCarrierAllowlist(ctx)).toEqual(["ups", "fedex"])
    expect(
      db.__all("app_config").filter((r) => r.key === "exclude_pickup_point_services"),
    ).toHaveLength(1)
  })

  it("toggling the policy alone does not create a carrier_allowlist row", async () => {
    const { ctx, db } = makeCtx()
    await settingsCarrierAllowlistSet(ctx, { exclude_pickup_point_services: false })
    expect(db.__all("app_config").filter((r) => r.key === "carrier_allowlist")).toHaveLength(0)
  })

  it("upserts a single policy row (re-flipping updates, never duplicates)", async () => {
    const { ctx, db } = makeCtx()
    await settingsCarrierAllowlistSet(ctx, { exclude_pickup_point_services: false })
    await settingsCarrierAllowlistSet(ctx, { exclude_pickup_point_services: true })
    expect(
      db.__all("app_config").filter((r) => r.key === "exclude_pickup_point_services"),
    ).toHaveLength(1)
    expect(await loadExcludePickupPointServices(ctx)).toBe(true)
  })

  it("degrades a corrupt stored value to the default (excluded)", async () => {
    const { ctx } = makeCtx([{ key: "exclude_pickup_point_services", value: "nope" }])
    expect(await loadExcludePickupPointServices(ctx)).toBe(true)
  })
})

describe("label format (ticket-10201)", () => {
  it("defaults to PDF_A4 when unset", async () => {
    const { ctx } = makeCtx()
    expect(await loadLabelFormat(ctx)).toBe("PDF_A4")
    expect(await settingsLabelFormatGet(ctx)).toEqual({
      format: "PDF_A4",
      available: ["PDF_A4", "PDF_10x15"],
    })
  })

  it("persists PDF_10x15 and reads it back", async () => {
    const { ctx } = makeCtx()
    expect(await settingsLabelFormatSet(ctx, { format: "PDF_10x15" })).toEqual({
      format: "PDF_10x15",
    })
    expect(await loadLabelFormat(ctx)).toBe("PDF_10x15")
  })

  it("updates in place rather than stacking config rows", async () => {
    const { ctx, db } = makeCtx()
    await settingsLabelFormatSet(ctx, { format: "PDF_10x15" })
    await settingsLabelFormatSet(ctx, { format: "PDF_A4" })
    const rows = (await db.findMany("app_config", { where: { key: "label_format" } })) as unknown[]
    expect(rows).toHaveLength(1)
    expect(await loadLabelFormat(ctx)).toBe("PDF_A4")
  })

  it("rejects an unknown format", async () => {
    const { ctx } = makeCtx()
    await expect(settingsLabelFormatSet(ctx, { format: "ZPL" })).rejects.toThrow(/PDF_A4/)
  })

  it("degrades a corrupt stored value to the default instead of crashing", async () => {
    const { ctx } = makeCtx([{ key: "label_format", value: 42 }])
    expect(await loadLabelFormat(ctx)).toBe("PDF_A4")
  })
})

describe("settingsProductCodes", () => {
  it("reads the empty default when unset, so skus are shown as they are", async () => {
    const { ctx } = makeCtx()
    expect(await settingsProductCodesGet(ctx)).toEqual({
      strip_prefixes: [],
      strip_suffixes: [],
      aliases: [],
      ranks: [],
    })
    expect(await loadProductCodeConfig(ctx)).toEqual({
      strip_prefixes: [],
      strip_suffixes: [],
      aliases: {},
    })
  })

  it("persists one row, upper-cases alias keys, and replaces only the fields sent", async () => {
    const { ctx, db } = makeCtx()
    await settingsProductCodesSet(ctx, {
      strip_prefixes: ["ACME-"],
      strip_suffixes: ["-B2B"],
      aliases: [{ sku: "k1-hardcover", code: "HC" }],
    })
    const after = await settingsProductCodesSet(ctx, { aliases: [{ sku: "PLATE", code: "MP" }] })
    expect(after).toEqual({
      strip_prefixes: ["ACME-"],
      strip_suffixes: ["-B2B"],
      aliases: [{ sku: "PLATE", code: "MP" }],
      ranks: [],
    })
    expect(db.__all("app_config").filter((r) => r.key === "product_code_aliases")).toHaveLength(1)
  })

  it("rejects a malformed alias with the entry named, writing nothing", async () => {
    const { ctx, db } = makeCtx()
    await expect(
      settingsProductCodesSet(ctx, {
        aliases: [
          { sku: "K1", code: "" },
          { sku: "K2", code: "WAY-TOO-LONG-CODE" },
        ],
      }),
    ).rejects.toThrow(/Invalid alias\(es\).*"K1".*"K2"/)
    expect(db.__all("app_config")).toHaveLength(0)
  })

  it("round-trips display ranks, upper-cased and sorted, and keeps them when other fields change", async () => {
    const { ctx } = makeCtx([
      // A value stored before ranks existed keeps working.
      {
        id: "c1",
        key: "product_code_aliases",
        value: { strip_prefixes: [], strip_suffixes: [], aliases: { PLATE: "MP" } },
      },
    ])
    expect((await settingsProductCodesGet(ctx)).ranks).toEqual([])
    const after = await settingsProductCodesSet(ctx, {
      ranks: [
        { code: "sound", rank: 1000 },
        { code: "ET2", rank: 1 },
        { code: "MP", rank: 2 },
      ],
    })
    expect(after.ranks).toEqual([
      { code: "ET2", rank: 1 },
      { code: "MP", rank: 2 },
      { code: "SOUND", rank: 1000 },
    ])
    expect(after.aliases).toEqual([{ sku: "PLATE", code: "MP" }])
    const kept = await settingsProductCodesSet(ctx, { strip_suffixes: ["-B2B"] })
    expect(kept.ranks).toEqual(after.ranks)
    expect((await loadProductCodeConfig(ctx)).ranks).toEqual({ ET2: 1, MP: 2, SOUND: 1000 })
    // An empty list clears them.
    expect((await settingsProductCodesSet(ctx, { ranks: [] })).ranks).toEqual([])
    expect((await loadProductCodeConfig(ctx)).ranks).toBeUndefined()
  })

  it("rejects a malformed rank with the entry named, writing nothing", async () => {
    const { ctx, db } = makeCtx()
    await expect(
      settingsProductCodesSet(ctx, {
        ranks: [
          { code: "ET2", rank: 1.5 },
          { code: "", rank: 1 },
        ],
      }),
    ).rejects.toThrow(/Invalid rank\(s\).*"ET2"/)
    expect(db.__all("app_config")).toHaveLength(0)
  })

  it("degrades a corrupt stored value to the empty default instead of throwing", async () => {
    const { ctx } = makeCtx([{ id: "c1", key: "product_code_aliases", value: "not an object" }])
    expect(await loadProductCodeConfig(ctx)).toEqual({
      strip_prefixes: [],
      strip_suffixes: [],
      aliases: {},
    })
  })
})

describe("settingsPackagingPolicy", () => {
  it("reads the neutral default when unset: no cartons, no merge, no nominal value", async () => {
    const { ctx } = makeCtx()
    expect(await loadPackagingPolicy(ctx)).toEqual(NEUTRAL_PACKAGING_POLICY)
    expect(await settingsPackagingPolicyGet(ctx)).toEqual({
      ...NEUTRAL_PACKAGING_POLICY,
      configured: false,
    })
  })

  it("persists one row that reads back as the policy sent, and replaces only the fields sent", async () => {
    const { ctx, db } = makeCtx()
    await settingsPackagingPolicySet(ctx, HOUSE_PACKAGING_POLICY)
    expect(await loadPackagingPolicy(ctx)).toEqual(HOUSE_PACKAGING_POLICY)
    const after = await settingsPackagingPolicySet(ctx, { nominal_proforma_value_minor: 250 })
    expect(after).toEqual({
      ...HOUSE_PACKAGING_POLICY,
      nominal_proforma_value_minor: 250,
      configured: true,
    })
    expect(db.__all("app_config").filter((r) => r.key === "packaging_policy")).toHaveLength(1)
  })

  it("reset starts from the neutral default", async () => {
    const { ctx } = makeCtx()
    await settingsPackagingPolicySet(ctx, HOUSE_PACKAGING_POLICY)
    const after = await settingsPackagingPolicySet(ctx, {
      reset: true,
      nominal_proforma_value_minor: 100,
    })
    expect(after).toEqual({
      ...NEUTRAL_PACKAGING_POLICY,
      nominal_proforma_value_minor: 100,
      configured: true,
    })
  })

  it("refuses an out-of-order ladder with every problem named, writing nothing", async () => {
    const { ctx, db } = makeCtx()
    await expect(
      settingsPackagingPolicySet(ctx, {
        raw_stack_max_height: 16,
        cartons: [
          { max_stack_height: 26, length: 60, width: 40, height: 25, tare_weight: 0.5 },
          { max_stack_height: 22, length: 60, width: 40, height: 20, tare_weight: -1 },
        ],
      }),
    ).rejects.toThrow(
      /cartons\[1\]\.tare_weight.*cartons\[1\]\.max_stack_height must be above the previous threshold \(26\)/,
    )
    expect(db.__all("app_config")).toHaveLength(0)
  })

  it("refuses cartons with no raw stack limit", async () => {
    const { ctx } = makeCtx()
    await expect(
      settingsPackagingPolicySet(ctx, {
        cartons: [{ max_stack_height: 22, length: 60, width: 40, height: 20, tare_weight: 0.5 }],
      }),
    ).rejects.toThrow(/raw_stack_max_height must be set when cartons are defined/)
  })

  it("degrades a corrupt stored value to the neutral default instead of half applying it", async () => {
    const { ctx } = makeCtx([
      {
        id: "c1",
        key: "packaging_policy",
        value: { raw_stack_max_height: 16, cartons: [{ max_stack_height: "x" }] },
      },
    ])
    expect(await loadPackagingPolicy(ctx)).toEqual(NEUTRAL_PACKAGING_POLICY)
  })
})

describe("ship-from address approval card", () => {
  it("shows each changed field as old -> new", async () => {
    const { summarizeSenderAddressSet } = await import("./summarizers")
    const s = await summarizeSenderAddressSet(
      {
        name: "Ops",
        company: "Acme",
        street: "2 New St",
        city: "Lyon",
        postalCode: "69001",
        countryIsoCode: "FR",
        email: "o@a.example",
        phone: "1",
      },
      undefined,
      {
        context: {
          sender: {
            name: "Ops",
            company: "Acme",
            street: "1 Old St",
            city: "Lyon",
            postalCode: "69001",
            countryIsoCode: "FR",
            email: "o@a.example",
            phone: "1",
          },
        },
      } as never,
    )
    expect(s.lines).toEqual(["street: 1 Old St -> 2 New St"])
  })
})

// The declarative settings page reads and writes the ship-from address, the
// pickup-point policy and the label format through ONE tool pair: the page
// hands the set tool the object the get tool returned, one path changed
// (settings-routes.ts). The set writes only what changed, and keeps what the
// form does not show (the stored sender's state and type).
describe("settingsSenderFormGet (the settings page's read of the ship-from address)", () => {
  it("returns only the stored, non-empty fields, flat: the shape settings_sender_address_set takes", async () => {
    const { ctx } = makeCtx()
    expect(await settingsSenderFormGet(ctx)).toEqual({})
    const seeded = makeCtx([
      { id: "c1", key: "sender_address", value: { ...FULL, company: " ", type: "BUSINESS" } },
    ])
    expect(await settingsSenderFormGet(seeded.ctx)).toEqual(FULL)
  })

  it("handed back with one field changed, the gated set writes the whole address", async () => {
    const { ctx } = makeCtx([
      { id: "c1", key: "sender_address", value: { ...FULL, type: "BUSINESS" } },
    ])
    await settingsSenderAddressSet(ctx, { ...(await settingsSenderFormGet(ctx)), city: "Lyon" })
    const got = await settingsSenderAddressGet(ctx)
    expect(got.sender).toMatchObject({ ...FULL, city: "Lyon" })
    expect(got.missing).toEqual([])
  })
})

describe("settingsForm (the settings page pair)", () => {
  it("get returns the form with defaults when nothing is stored", async () => {
    const { ctx } = makeCtx()
    expect(await settingsFormGet(ctx)).toEqual({
      exclude_pickup_point_services: true,
      label_format: "PDF_A4",
    })
  })

  it("a get handed back with one path changed writes only that part", async () => {
    const { ctx, db } = makeCtx()
    const form = await settingsFormGet(ctx)
    await settingsFormSet(ctx, { ...form, label_format: "PDF_10x15" })
    expect(await loadLabelFormat(ctx)).toBe("PDF_10x15")
    expect(db.__all("app_config").some((r) => r.key === "exclude_pickup_point_services")).toBe(
      false,
    )
  })

  it("turns the pickup-point exclusion off without touching the carrier allowlist", async () => {
    const { ctx } = makeCtx([{ id: "c2", key: "carrier_allowlist", value: ["ups"] }])
    const form = await settingsFormGet(ctx)
    await settingsFormSet(ctx, { ...form, exclude_pickup_point_services: false })
    expect(await loadExcludePickupPointServices(ctx)).toBe(false)
    expect(await loadCarrierAllowlist(ctx)).toEqual(["ups"])
  })

  it("refuses an unknown label format", async () => {
    const { ctx } = makeCtx()
    const form = await settingsFormGet(ctx)
    await expect(settingsFormSet(ctx, { ...form, label_format: "ZPL" })).rejects.toThrow(
      "format must be one of",
    )
  })
})
