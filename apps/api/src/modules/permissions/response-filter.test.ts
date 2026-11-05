// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { dimensionDefRegistry } from "~/modules/apps/app-registries"
import { filterResponse, returnsDimensionDefs } from "~/modules/permissions/response-filter"

const MOCK_ITEMS = [
  { id: "1", name: "EU Widget", market: "eu" },
  { id: "2", name: "US Widget", market: "us" },
  { id: "3", name: "EU Gadget", market: "eu" },
  { id: "4", name: "AP Widget", market: "ap" },
  { id: "5", name: "US Gadget", market: "us" },
  { id: "6", name: "EU Thing", market: "eu" },
  { id: "7", name: "AP Gadget", market: "ap" },
  { id: "8", name: "US Thing", market: "us" },
  { id: "9", name: "AP Thing", market: "ap" },
  { id: "10", name: "EU Doohickey", market: "eu" },
]

const dimensions = { market: { type: "membership" as const } }

describe("filterResponse", () => {
  it("filters to matching items only", () => {
    const result = filterResponse(
      MOCK_ITEMS,
      { market: "test:market" },
      { "test:market": ["eu"] },
      { "test:market": dimensions.market },
    )
    expect(result).toHaveLength(4)
    expect((result as Array<{ market: string }>).every((item) => item.market === "eu")).toBe(true)
  })

  it("wildcard returns all items", () => {
    const result = filterResponse(
      MOCK_ITEMS,
      { market: "test:market" },
      { "test:market": ["*"] },
      { "test:market": dimensions.market },
    )
    expect(result).toHaveLength(10)
  })

  it("multiple grant values", () => {
    const result = filterResponse(
      MOCK_ITEMS,
      { market: "test:market" },
      { "test:market": ["eu", "us"] },
      { "test:market": dimensions.market },
    )
    expect(result).toHaveLength(7)
  })

  it("empty grant returns nothing", () => {
    const result = filterResponse(
      MOCK_ITEMS,
      { market: "test:market" },
      { "test:market": [] },
      { "test:market": dimensions.market },
    )
    expect(result).toHaveLength(0)
  })

  it("empty response from handler returns empty", () => {
    const result = filterResponse(
      [],
      { market: "test:market" },
      { "test:market": ["eu"] },
      { "test:market": dimensions.market },
    )
    expect(result).toHaveLength(0)
  })

  it("single item response returns the item when it matches", () => {
    const result = filterResponse(
      { id: "1", name: "EU Widget", market: "eu" },
      { market: "test:market" },
      { "test:market": ["eu"] },
      { "test:market": dimensions.market },
    )
    expect(result).toEqual({ id: "1", name: "EU Widget", market: "eu" })
  })

  it("no returns.dimensions means no filtering", () => {
    const result = filterResponse(MOCK_ITEMS, {}, {}, {})
    expect(result).toHaveLength(10)
  })

  it("item missing dimension field is excluded (fail-closed)", () => {
    const items = [...MOCK_ITEMS, { id: "11", name: "No Market" }]
    const result = filterResponse(
      items,
      { market: "test:market" },
      { "test:market": ["eu"] },
      { "test:market": dimensions.market },
    )
    expect((result as Array<{ id: string }>).find((i) => i.id === "11")).toBeUndefined()
  })
})

describe("returnsDimensionDefs", () => {
  const ORG = "00000000-0000-0000-0000-0000000000d1"
  const levelDef = { type: "level", order: ["public", "internal", "confidential"] } as const

  it("finds a dimension a tool names by its full key (`<app>:<key>`), as grants carry it", () => {
    dimensionDefRegistry.set([ORG, "rdx", "sensitivity"], levelDef as never)
    try {
      const defs = returnsDimensionDefs(ORG, "rdx", { level: "rdx:sensitivity" })
      expect(defs["rdx:sensitivity"]?.type).toBe("level")
      // So a level grant reaches every row at or under it, not only its own value.
      const rows = [
        { id: 1, level: "public" },
        { id: 2, level: "internal" },
        { id: 3, level: "confidential" },
      ]
      const seen = filterResponse(
        rows,
        { level: "rdx:sensitivity" },
        { "rdx:sensitivity": ["internal"] },
        defs,
      ) as Array<{ id: number }>
      expect(seen.map((r) => r.id)).toEqual([1, 2])
    } finally {
      dimensionDefRegistry.delete([ORG, "rdx", "sensitivity"])
    }
  })

  it("has no definition for a dimension the org's apps do not declare", () => {
    expect(returnsDimensionDefs(ORG, "rdx", { market: "rdx:market" })).toEqual({})
  })
})
