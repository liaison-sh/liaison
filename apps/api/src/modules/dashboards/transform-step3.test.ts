// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 3 transforms: date buckets are calendar days in the org's time zone, and quarter and
// year buckets.

import { describe, expect, it } from "bun:test"
import { DATE_BUCKETS } from "~/modules/dashboards/spec"
import {
  attachPrevious,
  bucketOfDay,
  calendarDayOf,
  categoryOf,
  transformBlock,
} from "~/modules/dashboards/transform"

describe("org time zone buckets", () => {
  it("puts a timestamp on the org's calendar day; a date-only value stays as written", () => {
    expect(calendarDayOf("2026-11-01T23:30:00Z", "Europe/Paris")).toBe("2026-11-02")
    expect(calendarDayOf("2026-11-01T23:30:00Z", "UTC")).toBe("2026-11-01")
    expect(calendarDayOf("2026-11-02T03:00:00Z", "America/New_York")).toBe("2026-11-01")
    expect(calendarDayOf("2026-11-02", "America/New_York")).toBe("2026-11-02")
    expect(calendarDayOf("2026-02-30", "UTC")).toBeNull()
    expect(calendarDayOf("not a date", "UTC")).toBeNull()
  })

  it("a sparkline over a Paris window keeps an order at 00:30 local on its first day", () => {
    const rows = [
      { at: "2026-10-31T23:30:00Z", total: 5 }, // 00:30 on Nov 1 in Paris
      { at: "2026-11-02T10:00:00Z", total: 7 },
    ]
    const out = transformBlock(
      "metric",
      { value: "total", agg: "sum", sparkline: { field: "at", bucket: "day" } },
      rows,
      { window: { from: "2026-11-01", to: "2026-11-03" }, timeZone: "Europe/Paris" },
    )
    if (out.kind !== "metric") throw new Error("metric")
    expect(out.sparkline).toEqual({
      labels: ["2026-11-01", "2026-11-02", "2026-11-03"],
      values: [5, 7, 0],
    })
    expect(out.sparkline!.values.reduce((a, b) => a + b, 0)).toBe(out.value!)
  })

  it("a chart groups by the org's day, and a drill-down matches the same label", () => {
    const rows = [{ at: "2026-11-01T23:30:00Z" }, { at: "2026-11-01T10:00:00Z" }]
    const out = transformBlock(
      "bar",
      { groupBy: { field: "at", bucket: "day" }, agg: "count" },
      rows,
      {
        timeZone: "Europe/Paris",
      },
    )
    if (out.kind !== "bar") throw new Error("bar")
    expect(out.labels).toEqual(["2026-11-01", "2026-11-02"])
    expect(categoryOf(rows[0]!, "at", "day", "Europe/Paris")).toBe("2026-11-02")
  })
})

describe("quarter and year buckets", () => {
  it("are declared buckets with labels 2026-Q4 and 2026", () => {
    expect(DATE_BUCKETS).toContain("quarter")
    expect(DATE_BUCKETS).toContain("year")
    expect(bucketOfDay("2026-11-07", "quarter")).toBe("2026-Q4")
    expect(bucketOfDay("2026-01-01", "quarter")).toBe("2026-Q1")
    expect(bucketOfDay("2026-11-07", "year")).toBe("2026")
    expect(bucketOfDay("2026-11-08", "week")).toBe("2026-11-02")
  })

  it("groups, and aligns a comparison by position from the window start", () => {
    const map = {
      groupBy: { field: "day", bucket: "quarter" as const },
      y: "n",
      agg: "sum" as const,
    }
    const cur = transformBlock("line", map, [
      { day: "2026-01-10", n: 1 },
      { day: "2026-05-10", n: 2 },
    ])
    const prev = transformBlock("line", map, [
      { day: "2025-02-10", n: 10 },
      { day: "2025-04-10", n: 20 },
    ])
    if (cur.kind !== "line") throw new Error("line")
    expect(cur.labels).toEqual(["2026-Q1", "2026-Q2"])
    const out = attachPrevious(cur, prev, {
      bucket: "quarter",
      window: { from: "2026-01-01", to: "2026-06-30" },
      compareWindow: { from: "2025-01-01", to: "2025-06-30" },
    })
    if (out.kind !== "line") throw new Error("line")
    expect(out.previous?.labels).toEqual(["2025-Q1", "2025-Q2"])
    expect(out.previous?.series[0]?.values).toEqual([10, 20])
  })
})
