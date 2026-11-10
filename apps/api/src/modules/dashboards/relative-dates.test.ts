// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Date tokens in a block's params: the closed grammar, inside strings, month and year
// rollovers, the org's timezone, and an unknown token refused rather than passed through.

import { describe, expect, it } from "bun:test"
import { sourceHash } from "~/modules/dashboards/cache"
import {
  DateTokenError,
  dateTokenProblems,
  dateTokensIn,
  hasDateTokens,
  resolveDateTokens,
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
    expect(() => r("{{yesterday}}", "2026-11-10T12:00:00Z")).toThrow(DateTokenError)
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
        q: ["a {{startOfQuarter}} b", "{{today-1m}}"],
        open: "{{today",
      },
      "params",
    )
    expect(problems).toHaveLength(4)
    expect(problems[0]).toStartWith("params.period.since: unknown date token {{ today }}")
    expect(problems[1]).toStartWith("params.q.0: unknown date token {{startOfQuarter}}")
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
