// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Characterization cases for the package resolver and the nominal proforma. The golden
// (resolver-characterization.golden.json) was captured from the resolver as it stood while the
// carton ladder, the stacking thresholds and the 1 EUR nominal value were still constants in the
// code. With the house packaging policy below loaded as org data, every case must resolve to the
// same output byte for byte.
//
// The catalog is a retail-boxed instrument shop: a 59x38x8 instrument, a mounting plate, two
// skins, a hard cover, a power supply and a cable. Every composition of those counts is swept
// (single units, stacks at and around each ladder threshold, mixed products), against no pack, a
// confirmed instrument+skin pack, and a five-instrument master pack too deep for the ladder, plus a
// few unresolvable lines.

import type { CatalogPack, CatalogPackComponent, CatalogProfile, Parcel, ResolveResult, ResolverLine } from "../resolver"

function profile(id: string, weight: number, l: number, w: number, h: number): CatalogProfile {
  return {
    product_source: "shopify",
    product_id: id,
    unit_weight: weight,
    solo_length: l,
    solo_width: w,
    solo_height: h,
    content_category: null,
  }
}

export const CHARACTERIZATION_PROFILES: CatalogProfile[] = [
  profile("INSTR", 4.0, 59, 38, 8),
  profile("PLATE", 3.1, 49, 34, 10),
  profile("SKIN", 0.85, 50, 34, 1),
  profile("FSKIN", 0.65, 50, 34, 1),
  profile("COVER", 0.5, 45, 30, 3),
  profile("PSU", 0.2, 20, 15, 3),
  profile("CABLE", 0.052, 20, 15, 1),
  { ...profile("NOWEIGHT", 0, 20, 15, 1) },
  { ...profile("NODIMS", 1, 20, 15, 1), solo_height: null },
]

const PACK_SET: CatalogPack = {
  id: "pack-set",
  name: "INSTR-SKIN",
  length: 60,
  width: 39,
  height: 10,
  gross_weight: 4.85,
  content_category: null,
  carton_tare: null,
}
const PACK_TAPED: CatalogPack = {
  id: "pack-taped",
  name: "INSTR-COVER-TAPED",
  length: 60,
  width: 40,
  height: 20,
  gross_weight: 5.0,
  content_category: null,
  carton_tare: 0.5,
}
const PACK_MASTER: CatalogPack = {
  id: "pack-master",
  name: "MASTER-5",
  length: 58,
  width: 38,
  height: 42,
  gross_weight: 20.5,
  content_category: null,
  carton_tare: null,
}

export const PACK_CONFIGS: Record<string, { packs: CatalogPack[]; components: CatalogPackComponent[] }> = {
  none: { packs: [], components: [] },
  set: {
    packs: [PACK_SET],
    components: [
      { pack_id: PACK_SET.id, product_source: "shopify", product_id: "INSTR", quantity: 1 },
      { pack_id: PACK_SET.id, product_source: "shopify", product_id: "SKIN", quantity: 1 },
    ],
  },
  taped: {
    packs: [PACK_TAPED],
    components: [
      { pack_id: PACK_TAPED.id, product_source: "shopify", product_id: "INSTR", quantity: 1 },
      { pack_id: PACK_TAPED.id, product_source: "shopify", product_id: "COVER", quantity: 1 },
    ],
  },
  master: {
    packs: [PACK_MASTER, PACK_SET],
    components: [
      { pack_id: PACK_MASTER.id, product_source: "shopify", product_id: "INSTR", quantity: 5 },
      { pack_id: PACK_SET.id, product_source: "shopify", product_id: "INSTR", quantity: 1 },
      { pack_id: PACK_SET.id, product_source: "shopify", product_id: "SKIN", quantity: 1 },
    ],
  },
}

export interface CharacterizationCase {
  key: string
  packConfig: keyof typeof PACK_CONFIGS
  lines: ResolverLine[]
}

const SWEEP: Array<{ id: string; max: number }> = [
  { id: "INSTR", max: 6 },
  { id: "PLATE", max: 2 },
  { id: "SKIN", max: 2 },
  { id: "COVER", max: 1 },
  { id: "PSU", max: 1 },
  { id: "CABLE", max: 1 },
]

function linesFor(counts: number[]): ResolverLine[] {
  const lines: ResolverLine[] = []
  counts.forEach((qty, i) => {
    if (qty > 0) {
      const id = SWEEP[i]!.id
      lines.push({ id: `l-${id}`, product_source: "shopify", external_id: id, quantity: qty })
    }
  })
  return lines
}

export function characterizationCases(): CharacterizationCase[] {
  const out: CharacterizationCase[] = []
  const counts = SWEEP.map(() => 0)
  const walk = (i: number) => {
    if (i === SWEEP.length) {
      if (counts.every((c) => c === 0)) return
      for (const packConfig of Object.keys(PACK_CONFIGS)) {
        out.push({ key: `${packConfig}|${counts.join(",")}`, packConfig, lines: linesFor(counts) })
      }
      return
    }
    for (let c = 0; c <= SWEEP[i]!.max; c++) {
      counts[i] = c
      walk(i + 1)
    }
    counts[i] = 0
  }
  walk(0)
  // Unresolvable lines mixed with resolvable ones.
  const extras: Array<{ key: string; lines: ResolverLine[] }> = [
    {
      key: "typed-line",
      lines: [
        { id: "l-typed", product_source: null, external_id: null, quantity: 1 },
        { id: "l-INSTR", product_source: "shopify", external_id: "INSTR", quantity: 1 },
      ],
    },
    {
      key: "unknown-product",
      lines: [
        { id: "l-UNKNOWN", product_source: "shopify", external_id: "UNKNOWN", quantity: 2 },
        { id: "l-PLATE", product_source: "shopify", external_id: "PLATE", quantity: 2 },
      ],
    },
    {
      key: "no-weight-no-dims",
      lines: [
        { id: "l-NOWEIGHT", product_source: "shopify", external_id: "NOWEIGHT", quantity: 1 },
        { id: "l-NODIMS", product_source: "shopify", external_id: "NODIMS", quantity: 1 },
        { id: "l-INSTR", product_source: "shopify", external_id: "INSTR", quantity: 3 },
      ],
    },
  ]
  for (const e of extras) {
    for (const packConfig of Object.keys(PACK_CONFIGS)) {
      out.push({ key: `${packConfig}|${e.key}`, packConfig, lines: e.lines })
    }
  }
  return out
}

function parcelString(p: Parcel): string {
  return `${p.length}x${p.width}x${p.height}@${p.weight}`
}

/** Compact, order-preserving rendering of a resolver result for the golden. */
export function renderResult(r: ResolveResult): string {
  const parcels = r.parcels.map(parcelString).join(";")
  const unresolved = r.unresolved.map((u) => `${u.line.id}:${u.reason}`).join(",")
  return `${parcels}|${unresolved}|${r.customsArticles.length}`
}

/** Item sets for the nominal proforma (repair and gift categories). */
export const NOMINAL_ITEM_SETS: Array<Array<{ name: string; quantity: number; external_id?: string }>> = [
  [{ name: "Instrument", quantity: 1, external_id: "INSTR" }],
  [
    { name: "Instrument", quantity: 1, external_id: "INSTR" },
    { name: "Power supply", quantity: 1, external_id: "PSU" },
    { name: "Cable", quantity: 1, external_id: "CABLE" },
  ],
  [
    { name: "Instrument", quantity: 7, external_id: "INSTR" },
    { name: "Plate", quantity: 1, external_id: "PLATE" },
  ],
  [{ name: "Pads", quantity: 3 }, { name: "Skin", quantity: 2, external_id: "SKIN" }],
  Array.from({ length: 120 }, (_, i) => ({ name: `Part ${i}`, quantity: 1 })),
]
