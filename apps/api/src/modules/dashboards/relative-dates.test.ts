// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Date tokens in a block's params: the closed grammar, inside strings, month and year
// rollovers, the org's timezone, and an unknown token refused rather than passed through.

import { describe, expect, it } from "bun:test"
import { sourceHash } from "~/modules/dashboards/cache"
import {
  compareWindow,
  DateTokenError,
  dateTokenProblems,
  dateTokensIn,
  hasDateTokens,
  hasRangeTokens,
  resolveDateTokens,
  resolveTimeRange,
  timeRangeProblems,
} from "~/modules/dashboards/relative-dates"
import { dashboardBlockSchema, specIssues } from "~/modules/dashboards/spec"

const at = (iso: string, timeZone = "UTC") => ({ now: new Date(iso), timeZone })
const r = (token: string, iso: string, timeZone = "UTC") =>
  resolveDateTokens(token, at(iso, timeZone))

describe("resolveDateTokens", () => {
  it("resolves every anchor (Tuesday 2026-11-10)", () => {
    const now = "2026-11-10T12:00:00Z"
    expect(r("{{today}}", now)).toBe("2026-11-10")
    expect(r("{{startOfWeek}}", now)).toBe("2026-11-09")
    expect(r("{{startOfMonth}}", now)).toBe("2026-11-01")
    expect(r("{{startOfYear}}", now)).toBe("2026-01-01")
  })

  it("starts the week on Monday, a Sunday included", () => {
    expect(r("{{startOfWeek}}", "2026-11-15T12:00:00Z")).toBe("2026-11-09")
    expect(r("{{startOfWeek}}", "2026-11-09T00:00:00Z")).toBe("2026-11-09")
  })

  it("applies one offset in days, weeks, months or years", () => {
    const now = "2026-11-10T12:00:00Z"
    expect(r("{{today-30d}}", now)).toBe("2026-10-11")
    expect(r("{{today+1d}}", now)).toBe("2026-11-11")
    expect(r("{{startOfWeek-1w}}", now)).toBe("2026-11-02")
    expect(r("{{startOfMonth-1M}}", now)).toBe("2026-10-01")
    expect(r("{{startOfYear-1y}}", now)).toBe("2025-01-01")
  })

  it("rolls over months and years, clamping to the month's last day", () => {
    expect(r("{{startOfMonth-1M}}", "2026-01-15T12:00:00Z")).toBe("2025-12-01")
    expect(r("{{startOfMonth-13M}}", "2026-01-15T12:00:00Z")).toBe("2024-12-01")
    expect(r("{{today+1M}}", "2026-12-20T12:00:00Z")).toBe("2027-01-20")
    expect(r("{{today-1M}}", "2026-03-31T12:00:00Z")).toBe("2026-02-28")
    expect(r("{{today-1M}}", "2028-03-31T12:00:00Z")).toBe("2028-02-29")
    expect(r("{{today-1y}}", "2028-02-29T12:00:00Z")).toBe("2027-02-28")
    expect(r("{{today-10d}}", "2026-01-05T12:00:00Z")).toBe("2025-12-26")
    expect(r("{{startOfMonth-1d}}", "2026-03-10T12:00:00Z")).toBe("2026-02-28")
  })

  it("uses the calendar date of the given timezone", () => {
    // 23:30 UTC on Oct 31 is already Nov 1 in Paris, still Oct 31 in New York.
    const now = "2026-10-31T23:30:00Z"
    expect(r("{{today}}", now, "UTC")).toBe("2026-10-31")
    expect(r("{{startOfMonth}}", now, "Europe/Paris")).toBe("2026-11-01")
    expect(r("{{startOfMonth}}", now, "America/New_York")).toBe("2026-10-01")
    expect(r("{{startOfYear}}", "2026-12-31T23:30:00Z", "Asia/Tokyo")).toBe("2027-01-01")
  })

  it("replaces tokens inside strings and anywhere in the tree, keeping the rest", () => {
    const params = {
      metric: "units",
      period: { since: "{{startOfMonth}}", until: "{{today}}" },
      query: "SELECT x FROM y WHERE segments.date BETWEEN '{{today-29d}}' AND '{{today}}' LIMIT 10",
      list: ["{{startOfYear}}", 3, null, true],
      limit: 50,
    }
    expect(resolveDateTokens(params, at("2026-11-10T12:00:00Z"))).toEqual({
      metric: "units",
      period: { since: "2026-11-01", until: "2026-11-10" },
      query: "SELECT x FROM y WHERE segments.date BETWEEN '2026-10-12' AND '2026-11-10' LIMIT 10",
      list: ["2026-01-01", 3, null, true],
      limit: 50,
    })
    // A literal date stays that date.
    expect(resolveDateTokens({ since: "2026-08-12" }, at("2026-11-10T12:00:00Z"))).toEqual({
      since: "2026-08-12",
    })
  })

  it("throws on an unknown token, never passing it through", () => {
    expect(() => r("{{tomorrow}}", "2026-11-10T12:00:00Z")).toThrow(DateTokenError)
    expect(() => r("{{today-1m}}", "2026-11-10T12:00:00Z")).toThrow(DateTokenError)
    expect(() => r("{{today-1d}", "2026-11-10T12:00:00Z")).toThrow(DateTokenError)
  })
})

describe("dateTokenProblems", () => {
  it("names each unknown token with its path and the grammar", () => {
    const problems = dateTokenProblems(
      {
        ok: "{{today-7d}}",
        period: { since: "{{ today }}" },
        q: ["a {{startOfDecade}} b", "{{today-1m}}"],
        open: "{{today",
      },
      "params",
    )
    expect(problems).toHaveLength(4)
    expect(problems[0]).toStartWith("params.period.since: unknown date token {{ today }}")
    expect(problems[1]).toStartWith("params.q.0: unknown date token {{startOfDecade}}")
    expect(problems[2]).toStartWith("params.q.1: unknown date token {{today-1m}}")
    expect(problems[3]).toStartWith('params.open: a "{{" or "}}"')
    expect(problems[0]).toContain("{{startOfMonth-1M}}")
  })

  it("finds nothing in a spec without tokens", () => {
    expect(dateTokenProblems({ since: "2026-08-12", n: 3 }, "params")).toEqual([])
    expect(hasDateTokens({ since: "2026-08-12" })).toBe(false)
    expect(hasDateTokens({ a: ["{{today}}"] })).toBe(true)
    expect(dateTokensIn({ a: "{{today}} {{today}}", b: "{{startOfMonth}}" })).toEqual([
      "{{today}}",
      "{{startOfMonth}}",
    ])
  })

  it("is checked by the block schema, at save and preview alike", () => {
    const block = (params: Record<string, unknown>) =>
      dashboardBlockSchema.safeParse({
        id: "b",
        type: "metric",
        title: "B",
        source: { kind: "tool", tool: "shop:orders_search", params },
        map: { agg: "count" },
      })
    expect(block({ created_at_min: "{{today-90d}}" }).success).toBe(true)
    const bad = block({ created_at_min: "{{lastMonth}}" })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      expect(specIssues(bad.error).join("\n")).toContain(
        "source.params: created_at_min: unknown date token {{lastMonth}}",
      )
    }
  })
})

describe("sourceHash", () => {
  it("ignores key order and moves with the resolved dates", () => {
    const a = { kind: "tool", tool: "x:y", params: { since: "2026-11-01", n: 1 } }
    const b = { params: { n: 1, since: "2026-11-01" }, tool: "x:y", kind: "tool" }
    expect(sourceHash(a)).toBe(sourceHash(b))
    expect(sourceHash({ ...a, params: { since: "2026-11-02", n: 1 } })).not.toBe(sourceHash(a))
  })
})

describe("the new anchors", () => {
  const now = "2026-11-10T12:00:00Z" // a Tuesday
  it("resolves yesterday, quarter starts and period ends", () => {
    expect(r("{{yesterday}}", now)).toBe("2026-11-09")
    expect(r("{{startOfQuarter}}", now)).toBe("2026-10-01")
    expect(r("{{startOfQuarter-3M}}", now)).toBe("2026-07-01")
    expect(r("{{endOfWeek}}", now)).toBe("2026-11-15")
    expect(r("{{endOfMonth}}", now)).toBe("2026-11-30")
    expect(r("{{endOfQuarter}}", now)).toBe("2026-12-31")
    expect(r("{{endOfYear}}", now)).toBe("2026-12-31")
  })

  it("moves an end-of anchor by whole periods, so last month ends on its last day", () => {
    expect(r("{{endOfMonth-1M}}", now)).toBe("2026-10-31")
    expect(r("{{endOfMonth-9M}}", now)).toBe("2026-02-28")
    expect(r("{{endOfQuarter-3M}}", now)).toBe("2026-09-30")
    expect(r("{{endOfYear-1y}}", now)).toBe("2025-12-31")
    expect(r("{{endOfMonth+1d}}", now)).toBe("2026-12-01")
  })
})

describe("range tokens", () => {
  const opts = (timeZone = "UTC") => ({
    now: new Date("2026-11-10T12:00:00Z"),
    timeZone,
    range: { from: "2026-10-01", to: "2026-10-31" },
  })
  it("become the range's days, with offsets, and its instants with the org's offset", () => {
    const params = {
      since: "{{range.from}}",
      until: "{{range.to}}",
      before: "{{range.from-1d}}",
      q: "created_at:>='{{range.fromTime}}' AND created_at:<='{{range.toTime}}'",
    }
    expect(resolveDateTokens(params, opts("Europe/Paris"))).toEqual({
      since: "2026-10-01",
      until: "2026-10-31",
      before: "2026-09-30",
      // Oct 1 is summer time in Paris (+02:00), Oct 31 is winter time (+01:00).
      q: "created_at:>='2026-10-01T00:00:00+02:00' AND created_at:<='2026-10-31T23:59:59+01:00'",
    })
    expect(resolveDateTokens("{{range.fromTime}}", opts("America/New_York"))).toBe(
      "2026-10-01T00:00:00-04:00",
    )
  })

  it("gives an exclusive end, and starts a day the zone skips at its real first instant", () => {
    expect(resolveDateTokens("{{range.endExclusive}}", opts("Europe/Paris"))).toBe(
      "2026-11-01T00:00:00+01:00",
    )
    // America/Santiago moves 00:00 to 01:00 on 2026-09-06: the day starts at 01:00-03:00.
    const santiago = {
      ...opts("America/Santiago"),
      range: { from: "2026-09-06", to: "2026-09-06" },
    }
    expect(resolveDateTokens("{{range.fromTime}}", santiago)).toBe("2026-09-06T01:00:00-03:00")
    expect(resolveDateTokens("{{range.endExclusive}}", santiago)).toBe("2026-09-07T00:00:00-03:00")
  })

  it("refuses a range token with no range, and finds range tokens", () => {
    expect(() => resolveDateTokens("{{range.from}}", { ...opts(), range: null })).toThrow(
      DateTokenError,
    )
    expect(hasRangeTokens({ a: { b: "x {{range.to}}" } })).toBe(true)
    expect(hasRangeTokens({ a: "{{today}}" })).toBe(false)
    expect(dateTokenProblems({ a: "{{range.middle}}" }, "params")).toHaveLength(1)
  })
})

describe("resolveTimeRange", () => {
  const at = { timeZone: "UTC", now: new Date("2026-11-10T12:00:00Z") }
  it("resolves every preset to inclusive days", () => {
    const w = (preset: Parameters<typeof resolveTimeRange>[0]["preset"]) =>
      resolveTimeRange({ preset }, at)
    expect(w("last7d")).toEqual({ from: "2026-11-04", to: "2026-11-10" })
    expect(w("last30d")).toEqual({ from: "2026-10-12", to: "2026-11-10" })
    expect(w("last90d")).toEqual({ from: "2026-08-13", to: "2026-11-10" })
    expect(w("mtd")).toEqual({ from: "2026-11-01", to: "2026-11-10" })
    expect(w("lastMonth")).toEqual({ from: "2026-10-01", to: "2026-10-31" })
    expect(w("qtd")).toEqual({ from: "2026-10-01", to: "2026-11-10" })
    expect(w("lastQuarter")).toEqual({ from: "2026-07-01", to: "2026-09-30" })
    expect(w("ytd")).toEqual({ from: "2026-01-01", to: "2026-11-10" })
    expect(w("lastYear")).toEqual({ from: "2025-01-01", to: "2025-12-31" })
    expect(
      resolveTimeRange({ preset: "custom", from: "2026-01-05", to: "2026-02-01" }, at),
    ).toEqual({ from: "2026-01-05", to: "2026-02-01" })
  })

  it("names what is wrong with a range", () => {
    expect(timeRangeProblems({ preset: "custom" })).toHaveLength(1)
    expect(timeRangeProblems({ preset: "custom", from: "2026-02-30", to: "2026-03-01" })).toEqual([
      "from '2026-02-30' is not a day (YYYY-MM-DD)",
    ])
    expect(timeRangeProblems({ preset: "custom", from: "2026-03-02", to: "2026-03-01" })).toEqual([
      "from is after to",
    ])
    expect(timeRangeProblems({ preset: "mtd", from: "2026-03-01" })).toHaveLength(1)
    expect(timeRangeProblems({ preset: "mtd" })).toEqual([])
  })
})

describe("compareWindow", () => {
  it("compares with the same days a year earlier, month ends kept", () => {
    expect(compareWindow("last30d", { from: "2026-10-12", to: "2026-11-10" }, "lastYear")).toEqual({
      from: "2025-10-12",
      to: "2025-11-10",
    })
    expect(
      compareWindow("lastMonth", { from: "2028-02-01", to: "2028-02-29" }, "lastYear"),
    ).toEqual({ from: "2027-02-01", to: "2027-02-28" })
    expect(
      compareWindow("lastMonth", { from: "2027-02-01", to: "2027-02-28" }, "lastYear"),
    ).toEqual({ from: "2026-02-01", to: "2026-02-28" })
  })

  it("keeps a rolling or custom range's number of days around 29 February", () => {
    const len = (w: { from: string; to: string } | null) =>
      w ? (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 + 1 : 0
    const cases: [Parameters<typeof compareWindow>[0], string, string][] = [
      ["last7d", "2029-02-22", "2029-02-28"],
      ["last7d", "2028-02-23", "2028-02-29"],
      ["last30d", "2029-01-30", "2029-02-28"],
      ["custom", "2028-02-29", "2028-03-06"],
    ]
    for (const [preset, from, to] of cases) {
      const w = compareWindow(preset, { from, to }, "lastYear")
      expect(len(w)).toBe(len({ from, to }))
    }
    expect(compareWindow("last7d", { from: "2029-02-22", to: "2029-02-28" }, "lastYear")).toEqual({
      from: "2028-02-22",
      to: "2028-02-28",
    })
  })

  it("compares a calendar preset with the period before, the same day span", () => {
    expect(
      compareWindow("mtd", { from: "2026-11-01", to: "2026-11-10" }, "previousPeriod"),
    ).toEqual({ from: "2026-10-01", to: "2026-10-10" })
    expect(
      compareWindow("lastMonth", { from: "2026-10-01", to: "2026-10-31" }, "previousPeriod"),
    ).toEqual({ from: "2026-09-01", to: "2026-09-30" })
    expect(
      compareWindow("lastQuarter", { from: "2026-07-01", to: "2026-09-30" }, "previousPeriod"),
    ).toEqual({ from: "2026-04-01", to: "2026-06-30" })
  })

  it("compares a rolling or custom range with the equal span just before, and none with nothing", () => {
    expect(
      compareWindow("last7d", { from: "2026-11-04", to: "2026-11-10" }, "previousPeriod"),
    ).toEqual({ from: "2026-10-28", to: "2026-11-03" })
    expect(
      compareWindow("custom", { from: "2026-03-01", to: "2026-03-01" }, "previousPeriod"),
    ).toEqual({ from: "2026-02-28", to: "2026-02-28" })
    expect(compareWindow("last7d", { from: "2026-11-04", to: "2026-11-10" }, "none")).toBeNull()
  })
})

describe("a block's range mode in the schema", () => {
  const block = (extra: Record<string, unknown>, params: Record<string, unknown>) =>
    dashboardBlockSchema.safeParse({
      id: "b",
      type: "metric",
      title: "B",
      source: { kind: "tool", tool: "shop:orders_search", params },
      map: { agg: "count" },
      ...extra,
    })
  it("refuses range tokens in a fixed block, and a dashboard block without them", () => {
    expect(block({}, { since: "{{range.from}}" }).success).toBe(true)
    expect(block({ timeRange: "dashboard" }, { since: "{{range.from}}" }).success).toBe(true)
    expect(block({ timeRange: "fixed" }, { since: "{{range.from}}" }).success).toBe(false)
    expect(block({ timeRange: "dashboard" }, { since: "{{today}}" }).success).toBe(false)
  })
})
