// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The house packing rules, as the operations team specified them in a reference engine
// (__fixtures__/reference-packing-engine.ts), replayed through the generic resolver. The org data
// below (shipping profiles with short codes and the beside flag, master cartons, carton ladder) is
// the reference engine's own tables expressed as packaging policy, so every assertion here is one of
// the reference engine's 27 tests run against the resolver, followed by a differential replay of the
// real worklist and a deterministic sweep: the resolver must produce the reference engine's parcels,
// parcel for parcel, dimension for dimension, gram for gram.

import { describe, expect, it } from "bun:test"
import {
  CARTON_20_MAX_STACK,
  CARTON_20_TARE,
  CARTON_30_MAX_STACK,
  CARTON_30_TARE_ASSUMED,
  MASTER_CARTONS,
  PRODUCTS,
  type ProductCode,
  RAW_STACK_MAX_HEIGHT,
  computeParcels as referenceComputeParcels,
  SMALL_ACCESSORIES,
} from "./__fixtures__/reference-packing-engine"
import type { PackagingPolicy } from "./packaging-policy"
import { type CatalogProfile, type Parcel, type ResolverLine, resolvePackages } from "./resolver"

const gid = (variantId: string) => `gid://shopify/ProductVariant/${variantId}`

/** Every reference product variant as a shipping profile carrying its short code. */
const PROFILES: CatalogProfile[] = Object.values(PRODUCTS).flatMap((p) =>
  p.variantIds.map((v) => ({
    product_source: "shopify",
    product_id: gid(v),
    unit_weight: p.grossWeight,
    solo_length: p.length,
    solo_width: p.width,
    solo_height: p.height,
    content_category: null,
    short_code: p.code,
    accessory: SMALL_ACCESSORIES.includes(p.code),
  })),
)

function policy(opts: { standardCarton30Tare?: number } = {}): PackagingPolicy {
  return {
    raw_stack_max_height: RAW_STACK_MAX_HEIGHT,
    cartons: [
      {
        max_stack_height: CARTON_20_MAX_STACK,
        length: 60,
        width: 40,
        height: 20,
        tare_weight: CARTON_20_TARE,
      },
      {
        max_stack_height: CARTON_30_MAX_STACK,
        length: 60,
        width: 40,
        height: 30,
        tare_weight: opts.standardCarton30Tare ?? CARTON_30_TARE_ASSUMED,
        ...(opts.standardCarton30Tare === undefined ? { tare_assumed: true } : {}),
      },
    ],
    merge_leftovers_into_packs: false,
    pack_merge_height_allowance: 0,
    nominal_proforma_value_minor: null,
    master_cartons: MASTER_CARTONS.map((m) => ({
      short_code: m.code,
      units: m.units,
      length: m.length,
      width: m.width,
      height: m.height,
      weight: m.weight,
    })),
  }
}

interface CodeLine {
  code: string
  quantity: number
  /** Which of the product's variants the line names (default the first). */
  variant?: number
}

function linesFor(lines: CodeLine[]): ResolverLine[] {
  return lines.map((l, i) => {
    const product = PRODUCTS[l.code as ProductCode]
    const variant = product ? product.variantIds[l.variant ?? 0] : `unknown-${l.code}`
    return {
      id: `L${i}`,
      product_source: "shopify",
      external_id: gid(variant!),
      quantity: l.quantity,
    }
  })
}

function computeParcels(lines: CodeLine[], opts: { standardCarton30Tare?: number } = {}) {
  return resolvePackages({
    lines: linesFor(lines),
    profiles: PROFILES,
    packs: [],
    components: [],
    policy: policy(opts),
  })
}

const dims = (p: Parcel) => ({ l: p.length, w: p.width, h: p.height, kg: p.weight })

describe("reference packing rules: raw stacks", () => {
  it("Tessera 2 alone travels as its own box, nothing added", () => {
    const { parcels } = computeParcels([{ code: "ET2", quantity: 1 }])
    expect(parcels.map(dims)).toEqual([{ l: 59, w: 38, h: 8, kg: 4 }])
  })

  it("Tessera 2 + hard cover stacks to 11 cm at 4.5 kg", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 1 },
      { code: "HC", quantity: 1 },
    ])
    expect(parcels.length).toBe(1)
    expect(parcels[0]!.height).toBe(11)
    expect(parcels[0]!.weight).toBe(4.5)
  })

  it("Tessera 2 + fabric skin stacks to 9 cm at 4.65 kg", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 1 },
      { code: "FS", quantity: 1 },
    ])
    expect(parcels[0]!.height).toBe(9)
    expect(parcels[0]!.weight).toBe(4.65)
  })
})

describe("reference packing rules: small accessories lie beside the stack", () => {
  it("PSU + cable + Tessera 2: only the tallest accessory adds height (order 3360)", () => {
    const { parcels } = computeParcels([
      { code: "PS", quantity: 1 },
      { code: "USBC", quantity: 1 },
      { code: "ET2", quantity: 1 },
    ])
    expect(parcels.map(dims)).toEqual([{ l: 59, w: 38, h: 11, kg: 4.252 }])
  })

  it("2 skins + PSU + 2 cables: 2 cm of skins + 3 cm beside (order 3355)", () => {
    const { parcels } = computeParcels([
      { code: "BS", quantity: 2 },
      { code: "PS", quantity: 1 },
      { code: "USBC", quantity: 2 },
    ])
    expect(parcels.map(dims)).toEqual([{ l: 50, w: 34, h: 5, kg: 2.004 }])
  })

  it("many cables never stack: one Tessera 2 + 6 cables is still 9 cm", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 1 },
      { code: "USBC", quantity: 6 },
    ])
    expect(parcels[0]!.height).toBe(9)
  })

  it("accessories alone do stack, since there is nothing to sit beside", () => {
    const { parcels } = computeParcels([
      { code: "PS", quantity: 1 },
      { code: "USBC", quantity: 1 },
    ])
    expect(parcels.length).toBe(1)
    expect(parcels[0]!.height).toBe(4)
    expect(parcels[0]!.weight).toBe(0.252)
  })
})

describe("reference packing rules: standard cartons", () => {
  it("Tessera 2 + mounting plate goes in the 60x40x20 at 7.6 kg", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 1 },
      { code: "MP", quantity: 1 },
    ])
    expect(parcels.map(dims)).toEqual([{ l: 60, w: 40, h: 20, kg: 7.6 }])
  })

  it("Tessera 2 + hard cover + plate goes in the 60x40x20 at 8.1 kg", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 1 },
      { code: "HC", quantity: 1 },
      { code: "MP", quantity: 1 },
    ])
    expect(parcels[0]!.height).toBe(20)
    expect(parcels[0]!.weight).toBe(8.1)
  })

  it("3 Tessera 2 stack to 24 cm and take the 60x40x30 carton", () => {
    const { parcels, warnings } = computeParcels([{ code: "ET2", quantity: 3 }], {
      standardCarton30Tare: 0.5,
    })
    expect(parcels.map(dims)).toEqual([{ l: 60, w: 40, h: 30, kg: 12.5 }])
    expect(warnings).toEqual([])
  })

  it("the 60x40x30 tare is flagged as an assumption when not supplied", () => {
    const { warnings } = computeParcels([{ code: "ET2", quantity: 3 }])
    expect(warnings.some((w) => w.includes("assumed tare"))).toBe(true)
  })

  it("4 Tessera 2 exceed one carton: it splits deterministically, never silently", () => {
    const { parcels } = computeParcels([{ code: "ET2", quantity: 4 }], {
      standardCarton30Tare: 0.5,
    })
    expect(parcels.map(dims)).toEqual([
      { l: 60, w: 40, h: 30, kg: 12.5 },
      { l: 59, w: 38, h: 8, kg: 4 },
    ])
  })
})

describe("reference packing rules: master cartons take priority", () => {
  it("5 Tessera 2 ship as ONE master carton, 60x39x38 at 21 kg", () => {
    const { parcels } = computeParcels([{ code: "ET2", quantity: 5 }])
    expect(parcels.map(dims)).toEqual([{ l: 60, w: 39, h: 38, kg: 21 }])
  })

  it("10 Tessera 2 ship as two master cartons", () => {
    const { parcels } = computeParcels([{ code: "ET2", quantity: 10 }])
    expect(parcels.map(dims)).toEqual([
      { l: 60, w: 39, h: 38, kg: 21 },
      { l: 60, w: 39, h: 38, kg: 21 },
    ])
  })

  it("6 Tessera 2 + 2 black skins: one master carton, the rest stacked", () => {
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 6 },
      { code: "BS", quantity: 2 },
    ])
    expect(parcels.map(dims)).toEqual([
      { l: 60, w: 39, h: 38, kg: 21 },
      { l: 59, w: 38, h: 10, kg: 5.7 },
    ])
  })

  it("20 black skins ship as one master carton at 18 kg", () => {
    const { parcels } = computeParcels([{ code: "BS", quantity: 20 }])
    expect(parcels.map(dims)).toEqual([{ l: 50, w: 34, h: 37, kg: 18 }])
  })

  it("21 black skins: one master carton plus one loose skin", () => {
    const { parcels } = computeParcels([{ code: "BS", quantity: 21 }])
    expect(parcels.length).toBe(2)
    expect(parcels[1]!.height).toBe(1)
    expect(parcels[1]!.weight).toBe(0.85)
  })

  it("12 hard covers and 4 mounting plates each hit their master carton", () => {
    expect(computeParcels([{ code: "HC", quantity: 12 }]).parcels.map(dims)).toEqual([
      { l: 51, w: 41, h: 35, kg: 13.4 },
    ])
    expect(computeParcels([{ code: "MP", quantity: 4 }]).parcels.map(dims)).toEqual([
      { l: 50, w: 41, h: 35, kg: 13.2 },
    ])
  })

  it("20 fabric skins and 20 silicone skins have their own master weights", () => {
    expect(computeParcels([{ code: "FS", quantity: 20 }]).parcels[0]!.weight).toBe(16)
    expect(computeParcels([{ code: "DS", quantity: 20 }]).parcels[0]!.weight).toBe(18)
  })
})

describe("reference packing rules: the absolute rule, no margin ever", () => {
  it("NO dimension is ever a reference value + 1 cm", () => {
    for (const product of Object.values(PRODUCTS)) {
      const p = computeParcels([{ code: product.code, quantity: 1 }]).parcels[0]!
      expect(dims(p)).toEqual({
        l: product.length,
        w: product.width,
        h: product.height,
        kg: product.grossWeight,
      })
    }
  })

  it("a single black skin is 50x34x1, never 51x35x2", () => {
    const p = computeParcels([{ code: "BS", quantity: 1 }]).parcels[0]!
    expect(`${p.length}x${p.width}x${p.height}`).toBe("50x34x1")
  })

  it("the engine is deterministic: line order never changes the result", () => {
    const a = computeParcels([
      { code: "USBC", quantity: 1 },
      { code: "ET2", quantity: 7 },
      { code: "MP", quantity: 1 },
    ])
    const b = computeParcels([
      { code: "MP", quantity: 1 },
      { code: "ET2", quantity: 7 },
      { code: "USBC", quantity: 1 },
    ])
    expect(a.parcels).toEqual(b.parcels)
  })
})

describe("reference packing rules: guard rails", () => {
  it("an oversized stack splits into cartons, never an invented carton", () => {
    const { parcels } = computeParcels([{ code: "HC", quantity: 11 }], {
      standardCarton30Tare: 0.5,
    })
    expect(parcels.length).toBeGreaterThanOrEqual(2)
    expect(parcels.every((p) => p.height <= 30)).toBe(true)
  })

  it("an empty order produces no parcel and says so", () => {
    const { parcels, warnings } = computeParcels([])
    expect(parcels).toEqual([])
    expect(warnings.some((w) => w.includes("Nothing to pack"))).toBe(true)
  })

  it("an unknown product is reported, never guessed", () => {
    const { parcels, unresolved } = computeParcels([{ code: "EMB-SOUND", quantity: 1 }])
    expect(parcels).toEqual([])
    expect(unresolved.map((u) => u.reason)).toEqual(["no_profile"])
  })

  it("variant ids resolve: every variant of a product counts toward its master carton", () => {
    // Five Tessera 2 spread over three different variants still fill ONE master carton.
    const { parcels } = computeParcels([
      { code: "ET2", quantity: 2, variant: 0 },
      { code: "ET2", quantity: 2, variant: 2 },
      { code: "ET2", quantity: 1, variant: 4 },
    ])
    expect(parcels.map(dims)).toEqual([{ l: 60, w: 39, h: 38, kg: 21 }])
  })

  it("every master carton refers to a product the catalog carries", () => {
    const codes = new Set(PROFILES.map((p) => p.short_code))
    for (const m of policy().master_cartons) expect(codes.has(m.short_code)).toBe(true)
  })
})

// The real 2026-08-12 to-prepare worklist (order numbers and lines only).
const WORKLIST: Array<{ order: string; lines: CodeLine[] }> = [
  { order: "3346", lines: [{ code: "ET2", quantity: 1 }] },
  { order: "3338", lines: [{ code: "ET2", quantity: 1 }] },
  {
    order: "3358",
    lines: [
      { code: "ET2", quantity: 1 },
      { code: "DS", quantity: 1 },
    ],
  },
  { order: "3357", lines: [{ code: "BS", quantity: 1 }] },
  {
    order: "3355",
    lines: [
      { code: "BS", quantity: 2 },
      { code: "PS", quantity: 1 },
      { code: "USBC", quantity: 2 },
    ],
  },
  { order: "3356", lines: [{ code: "ET2", quantity: 1 }] },
  {
    order: "3351",
    lines: [
      { code: "DS", quantity: 1 },
      { code: "ET2", quantity: 1 },
    ],
  },
  {
    order: "3360",
    lines: [
      { code: "PS", quantity: 1 },
      { code: "USBC", quantity: 1 },
      { code: "ET2", quantity: 1 },
    ],
  },
  {
    order: "3344",
    lines: [
      { code: "BS", quantity: 1 },
      { code: "USBC", quantity: 1 },
      { code: "MP", quantity: 1 },
      { code: "ET2", quantity: 1 },
    ],
  },
  {
    order: "3335",
    lines: [
      { code: "BS", quantity: 2 },
      { code: "ET2", quantity: 5 },
      { code: "DS", quantity: 1 },
    ],
  },
  {
    order: "3315",
    lines: [
      { code: "BS", quantity: 2 },
      { code: "ET2", quantity: 6 },
    ],
  },
  {
    order: "3365",
    lines: [
      { code: "MP", quantity: 1 },
      { code: "PS", quantity: 1 },
      { code: "ET2", quantity: 1 },
    ],
  },
]

function reference(lines: CodeLine[], opts: { standardCarton30Tare?: number } = {}) {
  const result = referenceComputeParcels(
    lines.map((l) => ({ code: l.code as ProductCode, quantity: l.quantity })),
    opts,
  )
  return {
    parcels: result.parcels.map((p) => ({ l: p.length, w: p.width, h: p.height, kg: p.weight })),
    warned: result.warnings.length > 0,
    // The one known divergence: when what is left is accessories only and they stack deeper than
    // the biggest carton, the reference engine puts ALL of them in that carton (a carton declared
    // shallower than its contents). The resolver fills the carton and carries the rest over.
    overfilled: result.parcels.some(
      (p) =>
        p.kind === "standard_carton" &&
        Object.keys(p.contents).every((c) => SMALL_ACCESSORIES.includes(c as ProductCode)) &&
        Object.entries(p.contents).reduce(
          (h, [c, q]) => h + PRODUCTS[c as ProductCode].height * (q ?? 0),
          0,
        ) > p.height,
    ),
  }
}

function ours(lines: CodeLine[], opts: { standardCarton30Tare?: number } = {}) {
  const result = computeParcels(lines, opts)
  return { parcels: result.parcels.map(dims), warned: result.warnings.length > 0 }
}

describe("reference packing rules: differential replay", () => {
  it("the 12 orders of the real worklist resolve exactly as the reference engine computes them", () => {
    for (const c of WORKLIST) {
      const { overfilled, ...expected } = reference(c.lines, { standardCarton30Tare: 0.5 })
      expect(overfilled).toBe(false)
      expect({ order: c.order, ...ours(c.lines, { standardCarton30Tare: 0.5 }) }).toEqual({
        order: c.order,
        ...expected,
      })
    }
  })

  it("a deterministic sweep of 3000 orders matches the reference engine parcel for parcel", () => {
    const codes = Object.keys(PRODUCTS) as ProductCode[]
    // Mulberry32: a fixed seed, so a failure always replays the same order.
    let seed = 0x5eed
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const diffs: string[] = []
    let compared = 0
    let overfilledCases = 0
    for (let n = 0; n < 3000; n++) {
      const lines: CodeLine[] = []
      for (const code of codes) {
        const r = rand()
        if (r < 0.55) continue
        const quantity = r < 0.85 ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 24)
        lines.push({ code, quantity })
      }
      const tare = rand() < 0.5 ? { standardCarton30Tare: 0.5 } : {}
      const { overfilled, ...expected } = reference(lines, tare)
      if (overfilled) {
        overfilledCases++
        continue
      }
      compared++
      const a = JSON.stringify(ours(lines, tare))
      const b = JSON.stringify(expected)
      if (a !== b) diffs.push(`${JSON.stringify(lines)}: ours ${a} reference ${b}`)
    }
    expect(diffs.slice(0, 5)).toEqual([])
    // The divergence is a narrow class, never the bulk of the sweep.
    expect(compared).toBeGreaterThan(2900)
    expect(overfilledCases).toBeLessThan(100)
  })

  it("accessories alone deeper than the biggest carton fill it and carry the rest, never overfill it", () => {
    // 13 power supplies stack to 39 cm: the 60x40x30 takes 10 (30 cm), the other 3 travel raw.
    const { parcels } = computeParcels([{ code: "PS", quantity: 13 }], {
      standardCarton30Tare: 0.5,
    })
    expect(parcels.map(dims)).toEqual([
      { l: 60, w: 40, h: 30, kg: 2.5 },
      { l: 20, w: 15, h: 9, kg: 0.6 },
    ])
  })
})
