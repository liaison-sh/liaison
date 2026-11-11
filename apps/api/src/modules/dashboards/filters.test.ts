// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard filters: values checked against the spec, {{filter.<id>}} tokens in a source's
// params (empty = the param dropped), and map.where on the rows.

import { describe, expect, it } from "bun:test"
import {
  applyWhere,
  defaultFilterValues,
  FilterValueError,
  normalizeFilterValues,
  resolveFilterTokens,
  resolveWhere,
  sanitizeSavedFilterValues,
} from "~/modules/dashboards/filters"
import {
  dateTokenProblems,
  dateTokensIn,
  resolveDateTokens,
} from "~/modules/dashboards/relative-dates"
import type { DashboardSpec } from "~/modules/dashboards/spec"

const spec = {
  filters: [
    { id: "market", label: "Market", type: "select", options: ["FR", "DE", "US"], default: "FR" },
    { id: "channel", label: "Channel", type: "multi", options: ["b2b", "dtc"] },
    { id: "q", label: "Search", type: "text" },
  ],
} as unknown as Pick<DashboardSpec, "filters">

describe("filter values", () => {
  it("absent takes the default, present empty is all", () => {
    expect(defaultFilterValues(spec)).toEqual({ market: ["FR"], channel: [], q: [] })
    expect(normalizeFilterValues(spec, { channel: ["b2b", "dtc"] })).toEqual({
      market: ["FR"],
      channel: ["b2b", "dtc"],
      q: [],
    })
    expect(normalizeFilterValues(spec, { market: [""] }).market).toEqual([])
  })

  it("refuses an unknown filter, a value outside the options, two values for a select", () => {
    expect(() => normalizeFilterValues(spec, { nope: ["x"] })).toThrow(FilterValueError)
    expect(() => normalizeFilterValues(spec, { market: ["JP"] })).toThrow(/not an option/)
    expect(() => normalizeFilterValues(spec, { market: ["FR", "DE"] })).toThrow(/one value/)
    expect(normalizeFilterValues(spec, { q: ["anything"] }).q).toEqual(["anything"])
  })

  it("saved values that no longer fit are forgotten, not refused", () => {
    expect(
      sanitizeSavedFilterValues(spec, { market: ["DE"], gone: ["x"], channel: ["nope"] }),
    ).toEqual({ market: ["DE"] })
    expect(sanitizeSavedFilterValues(spec, null)).toEqual({})
  })
})

describe("filter tokens in a source's params", () => {
  it("a whole token becomes the value; a multi stays a list; empty drops the param", () => {
    const params = {
      market: "{{filter.market}}",
      channels: "{{filter.channel}}",
      query: "tag:{{filter.channel}} status:open",
      list: ["a", "{{filter.q}}"],
      since: "{{today-30d}}",
    }
    expect(
      resolveFilterTokens<unknown>(params, { market: ["FR"], channel: ["b2b", "dtc"], q: [] }),
    ).toEqual({
      market: "FR",
      channels: ["b2b", "dtc"],
      query: "tag:b2b,dtc status:open",
      list: ["a"],
      since: "{{today-30d}}",
    })
    expect(resolveFilterTokens<unknown>(params, { market: [], channel: [], q: ["x"] })).toEqual({
      list: ["a", "x"],
      since: "{{today-30d}}",
    })
  })

  it("is a valid token for the date grammar, but never resolved as a date", () => {
    expect(dateTokenProblems({ m: "{{filter.market}}" }, "")).toEqual([])
    expect(dateTokenProblems({ m: "{{filter.}}" }, "")).toHaveLength(1)
    expect(dateTokensIn({ a: "{{filter.market}}", b: "{{today}}" })).toEqual(["{{today}}"])
    expect(() =>
      resolveDateTokens("{{filter.market}}", { timeZone: "UTC", now: new Date() }),
    ).toThrow(/not resolved/)
  })
})

describe("map.where", () => {
  const rows = [
    { id: 1, market: "FR", total: "10", tags: ["b2b", "vip"], note: "" },
    { id: 2, market: "DE", total: 5, tags: ["dtc"], note: "late" },
    { id: 3, market: "FR", total: 0, tags: [], note: null },
    { id: 4, market: null, total: "20", tags: ["dtc"], note: "Late delivery" },
  ]
  const ids = (where: Parameters<typeof resolveWhere>[0], values = {}) =>
    applyWhere(rows, resolveWhere(where, values)).map((r) => r.id)

  it("compares numbers as numbers, strings as strings, lists by any element", () => {
    expect(ids([{ field: "market", op: "eq", value: "FR" }])).toEqual([1, 3])
    expect(ids([{ field: "market", op: "neq", value: "FR" }])).toEqual([2, 4])
    expect(ids([{ field: "total", op: "gt", value: 5 }])).toEqual([1, 4])
    expect(ids([{ field: "total", op: "lte", value: "5" }])).toEqual([2, 3])
    expect(ids([{ field: "tags", op: "eq", value: "dtc" }])).toEqual([2, 4])
    expect(ids([{ field: "market", op: "in", value: ["DE", "US"] }])).toEqual([2])
    expect(ids([{ field: "note", op: "contains", value: "late" }])).toEqual([2, 4])
    expect(ids([{ field: "note", op: "empty" }])).toEqual([1, 3])
    expect(ids([{ field: "tags", op: "notEmpty" }])).toEqual([1, 2, 4])
  })

  it("a clause on a filter: dropped while it is empty, a multi value is 'one of'", () => {
    const where = [{ field: "market", op: "eq" as const, value: { filter: "market" } }]
    expect(ids(where, { market: [] })).toEqual([1, 2, 3, 4])
    expect(ids(where, { market: ["DE"] })).toEqual([2])
    expect(ids(where, { market: ["DE", "FR"] })).toEqual([1, 2, 3])
    const not = [{ field: "market", op: "neq" as const, value: { filter: "market" } }]
    expect(ids(not, { market: ["DE", "FR"] })).toEqual([4])
  })
})
