// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import {
  type CatalogPack,
  type CatalogPackComponent,
  type CatalogProfile,
  type ResolveInput,
  type ResolverLine,
  resolvePackages as resolveWithPolicy,
} from "./resolver"

// These worked examples are the house carton ladder's: every call resolves under that policy. The
// neutral default (no policy) is pinned in resolver-characterization.test.ts.
function resolvePackages(input: ResolveInput) {
  return resolveWithPolicy({ policy: HOUSE_PACKAGING_POLICY, ...input })
}

function line(source: string | null, id: string | null, qty = 1): ResolverLine {
  return {
    id: `line-${id ?? "typed"}-${qty}`,
    product_source: source,
    external_id: id,
    quantity: qty,
  }
}

function profile(
  source: string,
  id: string,
  weight = 1,
  dims?: Partial<CatalogProfile>,
): CatalogProfile {
  return {
    product_source: source,
    product_id: id,
    unit_weight: weight,
    solo_length: dims?.solo_length ?? 20,
    solo_width: dims?.solo_width ?? 15,
    solo_height: dims?.solo_height ?? 10,
    content_category: dims?.content_category ?? null,
  }
}

function pack(
  name: string,
  dims: {
    length: number
    width: number
    height: number
    gross_weight: number
    carton_tare?: number | null
  },
): CatalogPack {
  const { carton_tare, ...rest } = dims
  return {
    id: `pack-${name}`,
    name,
    ...rest,
    content_category: null,
    carton_tare: carton_tare ?? null,
  }
}

function comp(packId: string, source: string, id: string, qty: number): CatalogPackComponent {
  return { pack_id: packId, product_source: source, product_id: id, quantity: qty }
}

describe("resolvePackages", () => {
  it("solo: one profiled line → one stacked parcel (true dims, no raw margin) + one customs article", () => {
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [profile("shopify", "V1", 1.5)],
      packs: [],
      components: [],
    })
    expect(res.parcels).toHaveLength(1)
    // 20x15x10 item -> raw stack under 17 cm ships at its true dims, no added margin.
    expect(res.parcels[0]).toMatchObject({ length: 20, width: 15, height: 10, weight: 1.5 })
    expect(res.customsArticles).toHaveLength(1)
    expect(res.unresolved).toHaveLength(0)
  })

  it("exact pack: lines exactly cover a pack → one carton parcel, per-line customs", () => {
    const p = pack("box-a", { length: 40, width: 30, height: 20, gross_weight: 5 })
    const res = resolvePackages({
      lines: [line("shopify", "V1"), line("shopify", "V2")],
      profiles: [profile("shopify", "V1"), profile("shopify", "V2")],
      packs: [p],
      components: [comp(p.id, "shopify", "V1", 1), comp(p.id, "shopify", "V2", 1)],
    })
    expect(res.parcels).toHaveLength(1)
    expect(res.parcels[0]).toMatchObject({ length: 40, width: 30, height: 20, weight: 5 })
    // customs articles are per line, not per parcel
    expect(res.customsArticles).toHaveLength(2)
    expect(res.unresolved).toHaveLength(0)
  })

  it("partial pack + leftover: the leftover rides IN the pack parcel when the stack fits", () => {
    const p = pack("box-a", { length: 40, width: 30, height: 20, gross_weight: 5 })
    const res = resolvePackages({
      lines: [line("shopify", "V1"), line("shopify", "V2"), line("shopify", "V1")],
      profiles: [profile("shopify", "V1"), profile("shopify", "V2")],
      packs: [p],
      components: [comp(p.id, "shopify", "V1", 1), comp(p.id, "shopify", "V2", 1)],
    })
    // pack (h 20) + leftover V1 (h 10) -> combined 30 cm -> one 60x40x38 carton
    // (+1 kg carton weight): 5 + 1 + 1 = 7 kg. One carton whenever the stack fits.
    expect(res.parcels).toHaveLength(1)
    expect(res.parcels[0]).toMatchObject({ length: 60, width: 40, height: 38, weight: 7 })
    expect(res.customsArticles).toHaveLength(3)
    expect(res.unresolved).toHaveLength(0)
  })

  it("master box: 5×V1 covered by a pack of 5 → one parcel, per-line articles", () => {
    const p = pack("master", { length: 60, width: 40, height: 40, gross_weight: 20 })
    const res = resolvePackages({
      lines: [line("shopify", "V1", 5)],
      profiles: [profile("shopify", "V1")],
      packs: [p],
      components: [comp(p.id, "shopify", "V1", 5)],
    })
    expect(res.parcels).toHaveLength(1)
    // one input line of qty 5 → one customs article (per input line)
    expect(res.customsArticles).toHaveLength(1)
    expect(res.customsArticles[0]!.quantity).toBe(5)
    expect(res.unresolved).toHaveLength(0)
  })

  it("no profile: a line with no matching profile and no pack → unresolved", () => {
    const res = resolvePackages({
      lines: [line("shopify", "V9")],
      profiles: [],
      packs: [],
      components: [],
    })
    expect(res.parcels).toHaveLength(0)
    expect(res.unresolved).toEqual([{ line: expect.anything(), reason: "no_profile" }])
  })

  it("no join key: a line with external_id null → unresolved (hand-typed line)", () => {
    const res = resolvePackages({
      lines: [line(null, null)],
      profiles: [],
      packs: [],
      components: [],
    })
    expect(res.unresolved[0]!.reason).toBe("no_profile")
  })

  it("missing weight: a matched profile with unit_weight 0 → unresolved missing_weight", () => {
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [profile("shopify", "V1", 0)],
      packs: [],
      components: [],
    })
    expect(res.unresolved[0]!.reason).toBe("missing_weight")
  })

  it("missing dims: a weighted profile with null solo dims → unresolved missing_dims (M3)", () => {
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [
        {
          product_source: "shopify",
          product_id: "V1",
          unit_weight: 1.5,
          solo_length: null,
          solo_width: null,
          solo_height: null,
          content_category: null,
        } as CatalogProfile,
      ],
      packs: [],
      components: [],
    })
    expect(res.parcels).toHaveLength(0)
    expect(res.unresolved[0]!.reason).toBe("missing_dims")
  })

  it("override (named pack/ad-hoc carton): replaces parcels and flags requote", () => {
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [profile("shopify", "V1")],
      packs: [],
      components: [],
      override: { length: 50, width: 50, height: 50, weight: 9 },
    })
    expect(res.parcels).toHaveLength(1)
    expect(res.parcels[0]).toMatchObject({ length: 50, width: 50, height: 50, weight: 9 })
    expect(res.requote).toBe(true)
  })

  it("empty line set → empty result", () => {
    const res = resolvePackages({ lines: [], profiles: [], packs: [], components: [] })
    expect(res).toMatchObject({ parcels: [], customsArticles: [], unresolved: [] })
  })

  it("pack whose component ref has no profile is skipped (not crashed)", () => {
    const p = pack("bad", { length: 40, width: 30, height: 20, gross_weight: 5 })
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [profile("shopify", "V1")],
      packs: [p],
      // component references V2 which has no profile and no line → pack can't match
      components: [comp(p.id, "shopify", "V1", 1), comp(p.id, "shopify", "V2", 1)],
    })
    // pack doesn't match (V2 not in lines) → V1 falls through to a stacked parcel
    expect(res.parcels).toHaveLength(1)
    expect(res.parcels[0]).toMatchObject({ weight: 1 })
  })

  it("two equally-matching packs → deterministic (sorted by name)", () => {
    const pb = pack("b-box", { length: 40, width: 30, height: 20, gross_weight: 5 })
    const pa = pack("a-box", { length: 41, width: 31, height: 21, gross_weight: 6 })
    const res = resolvePackages({
      lines: [line("shopify", "V1")],
      profiles: [profile("shopify", "V1")],
      packs: [pb, pa],
      components: [comp(pb.id, "shopify", "V1", 1), comp(pa.id, "shopify", "V1", 1)],
    })
    // a-box sorts first → its carton (gross_weight 6) wins deterministically
    expect(res.parcels).toHaveLength(1)
    expect(res.parcels[0]).toMatchObject({ weight: 6, length: 41 })
  })
})

describe("stacking calculation — Knowledge 'Tessera Packing & Shipping Reference' section 2 (2026-08-04)", () => {
  // Real per-item figures from the reference base (section 1).
  const et2 = profile("shopify", "ET2", 4.0, { solo_length: 59, solo_width: 38, solo_height: 8 })
  const mp = profile("shopify", "MP", 3.1, { solo_length: 49, solo_width: 34, solo_height: 10 })
  const hc = profile("shopify", "HC", 0.5, { solo_length: 45, solo_width: 30, solo_height: 3 })
  const usbc = profile("shopify", "USBC", 0.052, {
    solo_length: 20,
    solo_width: 15,
    solo_height: 1,
  })
  const bs = profile("shopify", "BS", 0.85, { solo_length: 50, solo_width: 34, solo_height: 1 })
  const ds = profile("shopify", "DS", 0.85, { solo_length: 50, solo_width: 34, solo_height: 1 })

  it("worked example: Tessera 2 alone -> 59x38x8, 4.0 kg (raw stack, no carton, no added margin)", () => {
    // Field regression (ticket 10341 / bf817ca5): resolver was returning 60x39x9,
    // adding a spurious +1 cm to the reference profile on the raw-stack path.
    const res = resolvePackages({
      lines: [line("shopify", "ET2")],
      profiles: [et2],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 59, width: 38, height: 8, weight: 4.0 }])
  })

  it("worked example: Tessera 2 + hard cover -> 59x38x11, 4.5 kg (still raw, no added margin)", () => {
    const res = resolvePackages({
      lines: [line("shopify", "ET2"), line("shopify", "HC")],
      profiles: [et2, hc],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 59, width: 38, height: 11, weight: 4.5 }])
  })

  it("worked example: Tessera 2 + mounting plate -> carton 60x40x20, 7.6 kg", () => {
    const res = resolvePackages({
      lines: [line("shopify", "ET2"), line("shopify", "MP")],
      profiles: [et2, mp],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 20, weight: 7.6 }])
  })

  it("worked example: ET2 + MP + USB-C ships as ONE 60x40x20 carton, never a cable parcel", () => {
    const res = resolvePackages({
      lines: [line("shopify", "ET2"), line("shopify", "MP"), line("shopify", "USBC")],
      profiles: [et2, mp, usbc],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 20, weight: 7.652 }])
    // Customs stays per line — packing never changes the declaration.
    expect(res.customsArticles).toHaveLength(3)
  })

  it("worked example: 3x Tessera 2 -> carton 60x40x25, 12.5 kg", () => {
    const res = resolvePackages({
      lines: [line("shopify", "ET2", 3)],
      profiles: [et2],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 25, weight: 12.5 }])
  })

  it("worked example: 5x Tessera 2 with no master carton -> fill the biggest carton, the rest ships raw", () => {
    // 40 cm of instruments is deeper than the 38 tier: the biggest carton takes as many as fit
    // (4 x 8 cm = 32 cm, 16 kg + 1 kg tare) and the fifth travels in its own box. Never a balanced
    // 3+2 split: the house rule fills a carton before opening the next.
    const res = resolvePackages({
      lines: [line("shopify", "ET2", 5)],
      profiles: [et2],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([
      { length: 60, width: 40, height: 38, weight: 17 },
      { length: 59, width: 38, height: 8, weight: 4 },
    ])
  })

  it("accessories-only order stacks flat into one raw parcel (DS+MP+BS -> 50x34x12, 4.8 kg)", () => {
    // The field regression of 2026-08-04: this exact combo rendered as THREE
    // parcels in the prep grid (one per product). The org rule is one stack.
    const res = resolvePackages({
      lines: [line("shopify", "DS"), line("shopify", "MP"), line("shopify", "BS")],
      profiles: [ds, mp, bs],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 50, width: 34, height: 12, weight: 4.8 }])
  })

  it("a leftover stack rides IN a pack parcel when the combined thickness fits the ladder", () => {
    // Jesse-shaped order: pack covers ET2+BS (60x39x10, 4.85), leftovers MP+USBC.
    // Combined 10+10+1 = 21 cm -> one 60x40x20 carton at 4.85+3.1+0.052+0.5 = 8.502.
    const p = pack("TESSERA2-SILICONE", { length: 60, width: 39, height: 10, gross_weight: 4.85 })
    const res = resolvePackages({
      lines: [
        line("shopify", "ET2"),
        line("shopify", "BS"),
        line("shopify", "MP"),
        line("shopify", "USBC"),
      ],
      profiles: [et2, bs, mp, usbc],
      packs: [p],
      components: [comp(p.id, "shopify", "ET2", 1), comp(p.id, "shopify", "BS", 1)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 20, weight: 8.502 }])
  })

  it("a confirmed master pack too deep for the ladder is never merged into; leftovers stack beside it", () => {
    const master = pack("DEALER-MASTER-5", {
      length: 58,
      width: 38,
      height: 42,
      gross_weight: 20.5,
    })
    const res = resolvePackages({
      lines: [line("shopify", "ET2", 5), line("shopify", "BS", 2), line("shopify", "DS")],
      profiles: [et2, bs, ds],
      packs: [master],
      components: [comp(master.id, "shopify", "ET2", 5)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toHaveLength(2)
    expect(res.parcels).toContainEqual({ length: 58, width: 38, height: 42, weight: 20.5 })
    // 2x BS + 1x DS: 50x34 footprint, 3 cm stacked, raw (no added margin) at 2.55 kg.
    expect(res.parcels).toContainEqual({ length: 50, width: 34, height: 3, weight: 2.55 })
  })

  it("an item with weight but no dims stays unresolved missing_dims, never a zero box in the stack", () => {
    const dimless: CatalogProfile = {
      product_source: "shopify",
      product_id: "MP",
      unit_weight: 3.1,
      solo_length: null,
      solo_width: null,
      solo_height: null,
      content_category: null,
    }
    const res = resolvePackages({
      lines: [line("shopify", "ET2"), line("shopify", "MP")],
      profiles: [et2, dimless],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(1)
    expect(res.unresolved[0]!.reason).toBe("missing_dims")
    // The resolvable item still ships correctly.
    expect(res.parcels).toEqual([{ length: 59, width: 38, height: 8, weight: 4.0 }])
  })

  it("a weight-less item is still missing_weight, never silently stacked at 0", () => {
    const res = resolvePackages({
      lines: [line("shopify", "ET2"), line("shopify", "USBC")],
      profiles: [et2, { ...usbc, unit_weight: 0 }],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(1)
    expect(res.unresolved[0]!.reason).toBe("missing_weight")
    expect(res.parcels[0]!.weight).toBe(4.0)
  })
})

describe("ticket 10341 (bf817ca5): raw-stack margin and double-taring on merge", () => {
  it("defect 1: Tessera 2 alone resolves to its true 59x38x8 profile, not 60x39x9 (field report)", () => {
    // Field reproduction: Tessera 2 profile is 59x38x8 / 4 kg. The resolver was unconditionally
    // adding +1 cm to L, W and P on the raw-stack (no-carton) path, returning 60x39x9.
    const et2 = profile("shopify", "ET2", 4.0, { solo_length: 59, solo_width: 38, solo_height: 8 })
    const res = resolvePackages({
      lines: [line("shopify", "ET2")],
      profiles: [et2],
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 59, width: 38, height: 8, weight: 4.0 }])
  })

  it("defect 2: a pack with a recorded carton_tare is not taped twice on merge (INV-2026-3397)", () => {
    // Field case INV-2026-3397: a named pack whose gross_weight already carries a 0.5 kg
    // carton tare from its original boxing (recorded on the row as carton_tare, not
    // inferred from dims) absorbs a loose leftover item into the SAME carton tier. The old
    // code taped it a second time: 7.3 (pack, already taped) + 0.5 (item) + 0.5 (re-tare) = 8.3.
    // Correct: the tare is counted once -> 7.8.
    const masterUnit = profile("shopify", "MASTERUNIT", 6.8, {
      solo_length: 55,
      solo_width: 35,
      solo_height: 18,
    })
    const cbl = profile("shopify", "CBL", 0.5, { solo_length: 20, solo_width: 15, solo_height: 2 })
    const alreadyBoxedPack = pack("MASTER-ALREADY-BOXED", {
      length: 60,
      width: 40,
      height: 20,
      gross_weight: 7.3,
      carton_tare: 0.5,
    })
    const res = resolvePackages({
      lines: [line("shopify", "MASTERUNIT"), line("shopify", "CBL")],
      profiles: [masterUnit, cbl],
      packs: [alreadyBoxedPack],
      components: [comp(alreadyBoxedPack.id, "shopify", "MASTERUNIT", 1)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 20, weight: 7.8 }])
  })

  it("defect 1b: a pack merging with a raw (no-carton) leftover reports the true combined footprint, not +1 cm (counter-case)", () => {
    // Counter-case: a pack 45x30x4 plus a loose mounting plate 49x34x10 merges raw
    // (combined P = 4+10 = 14, under RAW_STACK_MAX_P) and must report the true 49x34
    // footprint. The old merge-raw branch still added +1 to each loose item's L/W,
    // returning 50x35x14.
    const mp = profile("shopify", "MP", 3.1, { solo_length: 49, solo_width: 34, solo_height: 10 })
    const smallItem = profile("shopify", "SMALL", 0.2, {
      solo_length: 10,
      solo_width: 10,
      solo_height: 1,
    })
    const smallPack = pack("SMALL-BOX", { length: 45, width: 30, height: 4, gross_weight: 0.6 })
    const res = resolvePackages({
      lines: [line("shopify", "SMALL"), line("shopify", "MP")],
      profiles: [smallItem, mp],
      packs: [smallPack],
      components: [comp(smallPack.id, "shopify", "SMALL", 1)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 49, width: 34, height: 14, weight: 3.7 }])
  })

  it("defect 2b: a merge that crosses to a bigger ladder tier re-tares at the NEW tier, not the old one", () => {
    // Counter-case: pack 60x40x20 / 7.3 kg (carton_tare 0.5, tier1) plus a loose 8 cm / 4 kg
    // item pushes combined height to 28 cm, so the ladder now picks the 60x40x38 carton
    // (tare 1.0 kg), a DIFFERENT tier than the pack's own. Skipping all taring (the old
    // isLadderCarton heuristic) declares 11.3 kg; the correct exactly-once number backs
    // out the pack's OWN 0.5 kg tare and applies the new tier's 1.0 kg: 7.3+4.0-0.5+1.0 = 11.8.
    const masterUnit = profile("shopify", "MASTERUNIT", 6.8, {
      solo_length: 55,
      solo_width: 35,
      solo_height: 18,
    })
    const tallItem = profile("shopify", "TALL", 4.0, {
      solo_length: 40,
      solo_width: 30,
      solo_height: 8,
    })
    const taredPack = pack("MASTER-TIER1", {
      length: 60,
      width: 40,
      height: 20,
      gross_weight: 7.3,
      carton_tare: 0.5,
    })
    const res = resolvePackages({
      lines: [line("shopify", "MASTERUNIT"), line("shopify", "TALL")],
      profiles: [masterUnit, tallItem],
      packs: [taredPack],
      components: [comp(taredPack.id, "shopify", "MASTERUNIT", 1)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 38, weight: 11.8 }])
  })

  it("defect 2c: an operator-measured pack (60x40x21, not the nominal ladder dims) still tares exactly once via carton_tare", () => {
    // Counter-case: the isLadderCarton dims-equality heuristic silently double-tared any
    // pack recorded a centimetre off nominal (60x40x21 instead of 60x40x20) -> 8.3 kg, the
    // ORIGINAL unfixed field number. The model-based fix reads carton_tare regardless of
    // whether dims happen to match a ladder tier exactly.
    const masterUnit = profile("shopify", "MASTERUNIT", 6.8, {
      solo_length: 55,
      solo_width: 35,
      solo_height: 19,
    })
    const cbl = profile("shopify", "CBL", 0.5, { solo_length: 20, solo_width: 15, solo_height: 2 })
    const measuredPack = pack("MASTER-MEASURED", {
      length: 60,
      width: 40,
      height: 21,
      gross_weight: 7.3,
      carton_tare: 0.5,
    })
    const res = resolvePackages({
      lines: [line("shopify", "MASTERUNIT"), line("shopify", "CBL")],
      profiles: [masterUnit, cbl],
      packs: [measuredPack],
      components: [comp(measuredPack.id, "shopify", "MASTERUNIT", 1)],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 20, weight: 7.8 }])
  })
})

describe("pure refactor: TRUE-cm carton ladder, no +1 anywhere", () => {
  // Independent re-implementation of the threshold arithmetic exactly as it stood
  // immediately BEFORE this refactor: rawP = trueP + 1, compared against the
  // inflated thresholds 17 / 23 / 27 / 39. This is a test ORACLE, not a copy of the
  // fix: it is used only to prove the new true-scale thresholds (16 / 22 / 26 / 38)
  // choose the IDENTICAL carton tier as the old formula, for every integer true
  // stack thickness, rather than asserting hand-picked numbers that could bake the
  // same off-by-one mistake into the test as into the code.
  const OLD_RAW_MAX_P = 17
  const OLD_CARTON_LADDER = [
    { maxP: 23, length: 60, width: 40, height: 20, weight: 0.5 },
    { maxP: 27, length: 60, width: 40, height: 25, weight: 0.5 },
    { maxP: 39, length: 60, width: 40, height: 38, weight: 1.0 },
  ]
  type OldChoice = "raw" | "too-deep" | (typeof OLD_CARTON_LADDER)[number]
  function oldChoice(trueP: number): OldChoice {
    const rawP = trueP + 1
    if (rawP <= OLD_RAW_MAX_P) return "raw"
    return OLD_CARTON_LADDER.find((c) => rawP <= c.maxP) ?? "too-deep"
  }

  const ITEM_WEIGHT = 3
  function singleItemParcel(trueHeight: number) {
    const id = `H${trueHeight}`
    const p = profile("shopify", id, ITEM_WEIGHT, {
      solo_length: 30,
      solo_width: 20,
      solo_height: trueHeight,
    })
    const res = resolvePackages({
      lines: [line("shopify", id)],
      profiles: [p],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toHaveLength(1)
    return res.parcels[0]!
  }

  function expectMatchesOldChoice(
    parcel: { length: number; width: number; height: number; weight: number },
    trueP: number,
    expected: OldChoice,
  ) {
    if (expected === "raw" || expected === "too-deep") {
      // Both the raw-ship branch and the too-deep-for-any-carton defensive branch
      // ship at true dims with no carton weight added.
      expect(parcel).toEqual({ length: 30, width: 20, height: trueP, weight: ITEM_WEIGHT })
    } else {
      expect(parcel).toEqual({
        length: expected.length,
        width: expected.width,
        height: expected.height,
        weight: ITEM_WEIGHT + expected.weight,
      })
    }
  }

  it("exhaustive sweep: true stack thickness 1..50 chooses the same tier as the pre-refactor formula", () => {
    for (let trueP = 1; trueP <= 50; trueP++) {
      const expected = oldChoice(trueP)
      const parcel = singleItemParcel(trueP)
      expectMatchesOldChoice(parcel, trueP, expected)
    }
  })

  // The same sweep, named at each boundary for a human-readable table: one below, exactly
  // on, and one above every tier edge, plus the raw-to-first-carton edge. Redundant with
  // the sweep above by construction (every one of these true-P values is inside 1..50);
  // kept as an explicit, individually-named boundary table.
  const BOUNDARY_TABLE: Array<{ trueP: number; label: string }> = [
    { trueP: 15, label: "raw, one below the raw/tier1 edge" },
    { trueP: 16, label: "raw, exactly on the raw/tier1 edge" },
    { trueP: 17, label: "tier1 (60x40x20), one above the raw/tier1 edge" },
    { trueP: 21, label: "tier1, one below the tier1/tier2 edge" },
    { trueP: 22, label: "tier1, exactly on the tier1/tier2 edge" },
    { trueP: 23, label: "tier2 (60x40x25), one above the tier1/tier2 edge" },
    { trueP: 25, label: "tier2, one below the tier2/tier3 edge" },
    { trueP: 26, label: "tier2, exactly on the tier2/tier3 edge" },
    { trueP: 27, label: "tier3 (60x40x38), one above the tier2/tier3 edge" },
    { trueP: 37, label: "tier3, one below the too-deep edge" },
    { trueP: 38, label: "tier3, exactly on the too-deep edge" },
    { trueP: 39, label: "too deep for any carton, one above the too-deep edge (defensive raw)" },
  ]
  for (const { trueP, label } of BOUNDARY_TABLE) {
    it(`boundary table: true P ${trueP} -> ${label}`, () => {
      const parcel = singleItemParcel(trueP)
      expectMatchesOldChoice(parcel, trueP, oldChoice(trueP))
    })
  }

  // The point a STACK (multiple items, as opposed to one unsplittable item above) is too
  // deep for any single carton and must split: total true P 38 stays ONE parcel (tier3);
  // 39 must split into two. Two items so the split logic itself (not just the single-item
  // defensive branch above) is exercised.
  it("split boundary: two items totalling true P 38 stay ONE tier3 parcel (60x40x38)", () => {
    const a = profile("shopify", "SA", 2, { solo_length: 30, solo_width: 20, solo_height: 19 })
    const b = profile("shopify", "SB", 2, { solo_length: 30, solo_width: 20, solo_height: 19 })
    const res = resolvePackages({
      lines: [line("shopify", "SA"), line("shopify", "SB")],
      profiles: [a, b],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(0)
    expect(res.parcels).toEqual([{ length: 60, width: 40, height: 38, weight: 5 }])
  })

  it("split boundary: two items totalling true P 39 must split into two parcels", () => {
    const a = profile("shopify", "SC", 2, { solo_length: 30, solo_width: 20, solo_height: 19 })
    const b = profile("shopify", "SD", 2, { solo_length: 30, solo_width: 20, solo_height: 20 })
    const res = resolvePackages({
      lines: [line("shopify", "SC"), line("shopify", "SD")],
      profiles: [a, b],
      packs: [],
      components: [],
    })
    expect(res.unresolved).toHaveLength(0)
    // Each split-off item ships alone: true P 19 and true P 20 both land in tier1
    // (60x40x20), so both resulting parcels have the same carton shape.
    expect(res.parcels).toEqual([
      { length: 60, width: 40, height: 20, weight: 2.5 },
      { length: 60, width: 40, height: 20, weight: 2.5 },
    ])
  })
})
