// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { appendFilterParams, blockDataQuery, type DashboardFilterDef } from "./dashboards-client"
import {
  defaultOf,
  effectiveFilters,
  filtersFromQuery,
  filtersKey,
  hasFiltersInQuery,
  valueText,
  withFiltersInPath,
  withoutFiltersInPath,
} from "./filters"

const defs: DashboardFilterDef[] = [
  { id: "market", label: "Market", type: "select", options: ["FR", "DE"], default: "FR" },
  { id: "channel", label: "Channel", type: "multi", options: ["b2b", "dtc"] },
  { id: "q", label: "Search", type: "text" },
]

describe("filters in a URL", () => {
  it("reads the dashboard's filters only, repeated values for a multi, empty for all", () => {
    const got = filtersFromQuery("f.market=&f.channel=b2b&f.channel=dtc&f.other=x&range=ytd", defs)
    expect(got).toEqual({ market: [], channel: ["b2b", "dtc"] })
  })

  it("keeps one value for a select and drops repeats", () => {
    expect(filtersFromQuery("f.market=FR&f.market=DE", defs)).toEqual({ market: ["FR"] })
    expect(filtersFromQuery("f.channel=b2b&f.channel=b2b", defs)).toEqual({ channel: ["b2b"] })
  })

  it("a stale or edited link loses the values the server would refuse, never the blocks", () => {
    const long = "x".repeat(201)
    expect(
      filtersFromQuery(`f.market=JP&f.channel=dtc&f.channel=gone&f.channel=b2b&f.q=${long}`, defs),
    ).toEqual({ market: [], channel: ["b2b", "dtc"], q: [] })
    expect(filtersFromQuery("f.q=%7B%7Brange.from%7D%7D", defs)).toEqual({ q: [] })
  })

  it("writes every filter, an empty one as `f.<id>=`, and keeps the range parameters", () => {
    const path = withFiltersInPath("/dashboard/d1?range=ytd&f.old=1", {
      market: [],
      channel: ["b2b", "dtc"],
    })
    const q = new URLSearchParams(path.split("?")[1])
    expect(q.get("range")).toBe("ytd")
    expect(q.has("f.old")).toBe(false)
    expect(q.get("f.market")).toBe("")
    expect(q.getAll("f.channel")).toEqual(["b2b", "dtc"])
    expect(hasFiltersInQuery(path.split("?")[1] ?? "")).toBe(true)
    expect(withoutFiltersInPath(path)).toBe("/dashboard/d1?range=ytd")
  })
})

describe("which values a dashboard shows", () => {
  it("the link wins over the remembered values, which win over the defaults", () => {
    const got = effectiveFilters(defs, {
      url: { market: ["DE"] },
      remembered: { market: ["FR"], channel: ["dtc"] },
      defaults: { market: ["FR"], channel: [], q: [] },
    })
    expect(got).toEqual({ market: ["DE"], channel: ["dtc"], q: [] })
  })

  it("an explicit 'all' in the link beats a default", () => {
    expect(effectiveFilters(defs, { url: { market: [] } }).market).toEqual([])
  })

  it("falls back to the spec's defaults", () => {
    expect(effectiveFilters(defs, {})).toEqual({ market: ["FR"], channel: [], q: [] })
    expect(defaultOf(defs[0]!)).toEqual(["FR"])
  })

  it("keys values whatever their order", () => {
    expect(filtersKey({ a: ["2", "1"], b: [] })).toBe(filtersKey({ b: [], a: ["1", "2"] }))
  })

  it("reads 'All' when empty, and shortens long multi values", () => {
    expect(valueText([], "All")).toBe("All")
    expect(valueText(["FR", "DE"], "All")).toBe("FR, DE")
    expect(valueText(["FR", "DE", "IT"], "All")).toBe("FR +2")
  })
})

describe("filter values on the wire", () => {
  it("sends each value, repeated for a multi, and an empty value for all", () => {
    const q = new URLSearchParams()
    appendFilterParams(q, { market: [], channel: ["b2b", "dtc"] })
    expect(q.toString()).toBe("f.channel=b2b&f.channel=dtc&f.market=")
    expect(
      blockDataQuery({
        range: { timeRange: { preset: "ytd" }, compare: "none" },
        filters: { market: ["FR"] },
      }),
    ).toBe("?range=ytd&compare=none&f.market=FR")
  })
})
