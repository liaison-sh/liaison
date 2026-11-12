// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The carton ladder, the stacking thresholds and the nominal proforma value moved out of the code
// and into the org's packaging policy. This pins that the move changed nothing for an org that
// loads the policy the code used to hardcode, over every composition the characterization fixture
// sweeps (golden captured from the pre-move resolver), and that an org with no policy gets the
// neutral default instead of those cartons.
//
// The golden was re-captured once since, when the split of a stack deeper than every carton changed
// from balanced stacks to the house rule (fill the biggest carton thickest item first, carry the rest
// over): 722 of 2024 cases moved, every one of them a case that already split into several parcels,
// none gained a parcel and 76 lost one.

import { describe, expect, it } from "bun:test"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import {
  CHARACTERIZATION_PROFILES,
  characterizationCases,
  NOMINAL_ITEM_SETS,
  PACK_CONFIGS,
  renderResult,
} from "./__fixtures__/resolver-characterization"
import golden from "./__fixtures__/resolver-characterization.golden.json"
import { buildNominalLines } from "./proforma"
import { type CatalogProfile, type ResolverLine, resolvePackages } from "./resolver"

const GOLDEN = golden as { resolver: Record<string, string>; nominal: unknown[] }

describe("resolver characterization: house packaging policy loaded as org data", () => {
  it("resolves every swept composition exactly as the pre-move resolver did", () => {
    const cases = characterizationCases()
    expect(cases.length).toBe(Object.keys(GOLDEN.resolver).length)
    const diffs: string[] = []
    for (const c of cases) {
      const cfg = PACK_CONFIGS[c.packConfig]!
      const got = renderResult(
        resolvePackages({
          lines: c.lines,
          profiles: CHARACTERIZATION_PROFILES,
          packs: cfg.packs,
          components: cfg.components,
          policy: HOUSE_PACKAGING_POLICY,
        }),
      )
      if (got !== GOLDEN.resolver[c.key])
        diffs.push(`${c.key}: want ${GOLDEN.resolver[c.key]} got ${got}`)
    }
    expect(diffs).toEqual([])
  })

  it("builds every nominal proforma exactly as the pre-move code did", () => {
    const got: unknown[] = []
    for (const items of NOMINAL_ITEM_SETS) {
      for (const category of ["repair", "gift"] as const) {
        const value = HOUSE_PACKAGING_POLICY.nominal_proforma_value_minor!
        got.push({
          category,
          declared_value_minor: value,
          lines: buildNominalLines(items, category, value),
        })
      }
    }
    expect(got).toEqual(GOLDEN.nominal)
  })
})

describe("resolver characterization: no packaging policy (neutral default)", () => {
  const byRef = new Map<string, CatalogProfile>(
    CHARACTERIZATION_PROFILES.map((p) => [`${p.product_source}:${p.product_id}`, p]),
  )

  // Independent oracle for the neutral rule, built from the lines alone for orders no pack covers:
  // every resolvable unit stacks into ONE raw parcel, max footprint, summed thickness and weight.
  function neutralOracle(lines: ResolverLine[]): string {
    let l = 0
    let w = 0
    let h = 0
    let kg = 0
    for (const line of lines) {
      const p = byRef.get(`${line.product_source}:${line.external_id}`)
      if (!p || !p.unit_weight || !p.solo_length || !p.solo_width || !p.solo_height) continue
      l = Math.max(l, p.solo_length)
      w = Math.max(w, p.solo_width)
      h += p.solo_height * line.quantity
      kg += p.unit_weight * line.quantity
    }
    return h === 0 ? "" : `${l}x${w}x${h}@${Math.round(kg * 1000) / 1000}`
  }

  it("never invents a carton: with no pack, every order is one raw stacked parcel", () => {
    const diffs: string[] = []
    for (const c of characterizationCases().filter((x) => x.packConfig === "none")) {
      const res = resolvePackages({
        lines: c.lines,
        profiles: CHARACTERIZATION_PROFILES,
        packs: [],
        components: [],
      })
      const parcels = res.parcels
        .map((p) => `${p.length}x${p.width}x${p.height}@${p.weight}`)
        .join(";")
      if (parcels !== neutralOracle(c.lines))
        diffs.push(`${c.key}: want ${neutralOracle(c.lines)} got ${parcels}`)
    }
    expect(diffs).toEqual([])
  })

  it("keeps a confirmed pack as its own parcel and stacks the leftovers beside it, never merged or cartoned", () => {
    const cfg = PACK_CONFIGS.master!
    const res = resolvePackages({
      lines: [
        { id: "l-INSTR", product_source: "shopify", external_id: "INSTR", quantity: 6 },
        { id: "l-SKIN", product_source: "shopify", external_id: "SKIN", quantity: 1 },
        { id: "l-PLATE", product_source: "shopify", external_id: "PLATE", quantity: 2 },
        { id: "l-CABLE", product_source: "shopify", external_id: "CABLE", quantity: 1 },
      ],
      profiles: CHARACTERIZATION_PROFILES,
      packs: cfg.packs,
      components: cfg.components,
    })
    expect(res.parcels).toEqual([
      { length: 60, width: 39, height: 10, weight: 4.85 },
      { length: 58, width: 38, height: 42, weight: 20.5 },
      { length: 49, width: 34, height: 21, weight: 6.252 },
    ])
    // The same order under the house policy merges the leftovers into the set pack's carton.
    const house = resolvePackages({
      lines: [
        { id: "l-INSTR", product_source: "shopify", external_id: "INSTR", quantity: 6 },
        { id: "l-SKIN", product_source: "shopify", external_id: "SKIN", quantity: 1 },
        { id: "l-PLATE", product_source: "shopify", external_id: "PLATE", quantity: 2 },
        { id: "l-CABLE", product_source: "shopify", external_id: "CABLE", quantity: 1 },
      ],
      profiles: CHARACTERIZATION_PROFILES,
      packs: cfg.packs,
      components: cfg.components,
      policy: HOUSE_PACKAGING_POLICY,
    })
    expect(house.parcels).not.toEqual(res.parcels)
  })

  it("differs from the house policy on the stacks the ladder used to carton", () => {
    const res = resolvePackages({
      lines: [{ id: "l-INSTR", product_source: "shopify", external_id: "INSTR", quantity: 5 }],
      profiles: CHARACTERIZATION_PROFILES,
      packs: [],
      components: [],
    })
    expect(res.parcels).toEqual([{ length: 59, width: 38, height: 40, weight: 20 }])
    expect(GOLDEN.resolver["none|5,0,0,0,0,0"]).toBe("60x40x38@17;59x38x8@4||1")
  })
})
