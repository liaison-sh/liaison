// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The map step, one chart type at a time, and the spec rules each type needs.

import { describe, expect, test } from "bun:test"
import { wrapExternalContent } from "~/lib/external-content"
import {
  blockTtlSec,
  dashboardSpecSchema,
  MAX_BLOCK_SERIES,
  MAX_SOURCE_ROWS,
  MAX_SOURCE_TTL_SEC,
} from "~/modules/dashboards/spec"
import {
  attachPrevious,
  bucketKey,
  extractRows,
  TransformError,
  transformBlock,
  unfenceSourceResult,
} from "~/modules/dashboards/transform"

const orders = [
  {
    id: 1,
    date_created: "2026-11-01T09:00:00Z",
    total: "10.50",
    status: "completed",
    country: "FR",
  },
  {
    id: 2,
    date_created: "2026-11-01T18:30:00Z",
    total: "4.50",
    status: "completed",
    country: "DE",
  },
  { id: 3, date_created: "2026-11-02T10:00:00Z", total: "20", status: "refunded", country: "FR" },
  { id: 4, date_created: "2026-11-03T10:00:00Z", total: 5, status: "completed", country: "FR" },
  { id: 5, date_created: "not a date", total: "1", status: "completed", country: null },
]

describe("metric", () => {
  test("sums a field over the rows (numeric strings count as numbers)", () => {
    const out = transformBlock(
      "metric",
      { value: "total", format: "currency", currency: "EUR" },
      orders,
    )
    expect(out).toMatchObject({
      kind: "metric",
      value: 41,
      meta: { format: "currency", currency: "EUR", sourceRows: 5 },
    })
  })
  test("count needs no value; avg, min and max", () => {
    expect(transformBlock("metric", { agg: "count" }, { items: orders })).toMatchObject({
      value: 5,
    })
    expect(transformBlock("metric", { value: "total", agg: "avg" }, orders)).toMatchObject({
      value: 8.2,
    })
    expect(transformBlock("metric", { value: "total", agg: "min" }, orders)).toMatchObject({
      value: 1,
    })
    expect(transformBlock("metric", { value: "total", agg: "max" }, orders)).toMatchObject({
      value: 20,
    })
  })
  test("reads a scalar path when the source returns one object", () => {
    expect(
      transformBlock("metric", { value: "totals.sales" }, { totals: { sales: "99.9" } }),
    ).toMatchObject({
      value: 99.9,
    })
  })
})

describe("table", () => {
  test("projects columns, sorts and cuts to the limit", () => {
    const out = transformBlock(
      "table",
      {
        columns: [
          { field: "id", label: "Order" },
          { field: "total", label: "Total" },
        ],
        sort: { field: "total", dir: "desc" },
        limit: 2,
      },
      orders,
    )
    expect(out).toEqual({
      kind: "table",
      columns: [
        { field: "id", label: "Order" },
        { field: "total", label: "Total" },
      ],
      rows: [
        { id: 3, total: "20" },
        { id: 1, total: "10.50" },
      ],
      meta: { sourceRows: 5, truncated: true, skippedRows: 0 },
    })
  })
})

describe("bar and line", () => {
  test("line: revenue by day, a date bucket, category ascending; unusable dates skipped", () => {
    const out = transformBlock(
      "line",
      { groupBy: { field: "date_created", bucket: "day" }, y: "total", agg: "sum" },
      orders,
    )
    expect(out).toMatchObject({
      kind: "line",
      labels: ["2026-11-01", "2026-11-02", "2026-11-03"],
      series: [{ name: "total", values: [15, 20, 5] }],
      meta: { skippedRows: 1 },
    })
  })
  test("bar: count by category, value descending by default, split by series", () => {
    const out = transformBlock("bar", { x: "country", agg: "count" }, orders)
    expect(out).toMatchObject({
      labels: ["FR", "DE", "(none)"],
      series: [{ name: "value", values: [3, 1, 1] }],
    })
    const split = transformBlock(
      "bar",
      { x: "country", y: "total", series: "status" },
      orders.slice(0, 4),
    )
    expect(split).toMatchObject({
      labels: ["FR", "DE"],
      series: [
        { name: "completed", values: [15.5, 4.5] },
        { name: "refunded", values: [20, 0] },
      ],
    })
  })
  test("series are capped: the largest by total are kept, in source order, and it says so", () => {
    // 30 series over one category; series s<n> totals n, so s10..s29 are the 20 largest.
    const rows = Array.from({ length: 30 }, (_, n) => ({ x: "a", s: `s${n}`, v: n }))
    const out = transformBlock("bar", { x: "x", y: "v", series: "s" }, rows)
    if (out.kind !== "bar") throw new Error("expected a bar")
    expect(out.series.map((s) => s.name)).toEqual(
      Array.from({ length: MAX_BLOCK_SERIES }, (_, i) => `s${i + 10}`),
    )
    expect(out.meta.truncated).toBe(true)
  })
  test("sort by category or by value, and an unknown sort field is refused", () => {
    const byKey = transformBlock(
      "bar",
      { x: "country", agg: "count", sort: { field: "country", dir: "asc" } },
      orders,
    )
    expect(byKey).toMatchObject({ labels: ["(none)", "DE", "FR"] })
    expect(() =>
      transformBlock(
        "bar",
        { x: "country", agg: "count", sort: { field: "nope", dir: "asc" } },
        orders,
      ),
    ).toThrow(TransformError)
  })
  test("week and month buckets", () => {
    expect(bucketKey(new Date("2026-11-07T12:00:00Z"), "week")).toBe("2026-11-02")
    expect(bucketKey(new Date("2026-11-02T00:00:00Z"), "week")).toBe("2026-11-02")
    expect(bucketKey(new Date("2026-11-07T12:00:00Z"), "month")).toBe("2026-11")
    expect(bucketKey(new Date(1_762_500_000 * 1000), "day")).toBe(
      bucketKey(new Date(1_762_500_000_000), "day"),
    )
  })
})

describe("pie", () => {
  test("slices by label, value aggregated, limited", () => {
    const out = transformBlock(
      "pie",
      { groupBy: { field: "status" }, value: "total", limit: 1 },
      orders,
    )
    expect(out).toMatchObject({
      kind: "pie",
      labels: ["completed"],
      series: [{ values: [21] }],
      meta: { truncated: true },
    })
  })
})

describe("rows and limits", () => {
  test("rows come from the result, rowsPath, or its only list", () => {
    expect(extractRows({ orders: [{ a: 1 }], next: null }).rows).toEqual([{ a: 1 }])
    expect(extractRows({ page: { list: [{ a: 1 }] } }, "page.list").rows).toEqual([{ a: 1 }])
    expect(() => extractRows({ page: 1 }, "page")).toThrow(TransformError)
    expect(() =>
      transformBlock("table", { columns: [{ field: "a", label: "A" }] }, { a: 1 }),
    ).toThrow(TransformError)
  })
  test("reads at most MAX_SOURCE_ROWS rows and says so", () => {
    const many = Array.from({ length: MAX_SOURCE_ROWS + 5 }, () => ({ n: 1 }))
    expect(transformBlock("metric", { value: "n" }, many)).toMatchObject({
      value: MAX_SOURCE_ROWS,
      meta: { truncated: true, sourceRows: MAX_SOURCE_ROWS + 5 },
    })
  })
})

describe("the spec", () => {
  const block = (b: Record<string, unknown>) => ({
    v: 1,
    blocks: [{ id: "b1", title: "B", source: { kind: "tool", tool: "shop:orders_list" }, ...b }],
  })
  test("each chart type names what its map lacks", () => {
    const issues = (b: Record<string, unknown>) => {
      const r = dashboardSpecSchema.safeParse(block(b))
      return r.success ? [] : r.error.issues.map((i) => i.message)
    }
    expect(issues({ type: "metric", map: {} })[0]).toContain("map.value")
    expect(issues({ type: "table", map: {} })[0]).toContain("map.columns")
    expect(issues({ type: "line", map: { y: "total" } })[0]).toContain("groupBy")
    expect(issues({ type: "pie", map: { groupBy: { field: "s" } } })[0]).toContain("map.value")
    expect(issues({ type: "bar", map: { x: "c", agg: "count" } })).toEqual([])
  })
  test("at most 24 blocks, unique ids, refreshSec within 60..86400", () => {
    const b = {
      id: "x",
      type: "metric",
      title: "M",
      source: { kind: "tool", tool: "a:b" },
      map: { agg: "count" },
    }
    expect(
      dashboardSpecSchema.safeParse({
        v: 1,
        blocks: Array.from({ length: 25 }, (_, i) => ({ ...b, id: `b${i}` })),
      }).success,
    ).toBe(false)
    expect(dashboardSpecSchema.safeParse({ v: 1, blocks: [b, b] }).success).toBe(false)
    expect(
      dashboardSpecSchema.safeParse({ v: 1, blocks: [{ ...b, refreshSec: 30 }] }).success,
    ).toBe(false)
    expect(
      dashboardSpecSchema.safeParse({ v: 1, blocks: [{ ...b, refreshSec: 3600 }] }).success,
    ).toBe(true)
    expect(dashboardSpecSchema.safeParse({ v: 2, blocks: [] }).success).toBe(false)
  })
})

describe("cache lifetime", () => {
  test("every source (store too) is cached at most 900 s; a shorter interval stays", () => {
    expect(MAX_SOURCE_TTL_SEC).toBe(900)
    expect(blockTtlSec({ refreshSec: 86_400 })).toBe(900)
    expect(blockTtlSec({ refreshSec: 120 })).toBe(120)
    expect(blockTtlSec({})).toBe(60)
  })
})

describe("unfenceSourceResult", () => {
  test("a connector read's fenced items become rows the map reads", () => {
    const items = [
      { number: "94", total: "692.50", date_created: "2026-11-07T10:00:00" },
      { number: "93", total: "1026.00", date_created: "2026-11-06T10:00:00" },
    ]
    const result = {
      connection: "woo",
      operation: "orders_list",
      count: 2,
      items: wrapExternalContent(JSON.stringify(items)),
    }
    const unfenced = unfenceSourceResult(result) as { items: unknown }
    expect(unfenced.items).toEqual(items)
    expect(transformBlock("metric", { value: "total", agg: "sum" }, unfenced)).toMatchObject({
      value: 1718.5,
    })
  })

  test("fenced text that is not JSON, and unfenced results, stay as they are", () => {
    const plain = { items: [{ a: 1 }] }
    expect(unfenceSourceResult(plain)).toBe(plain)
    const text = { note: wrapExternalContent("hello") }
    expect(unfenceSourceResult(text)).toBe(text)
  })
})

describe("metric extras and the comparison", () => {
  const rows = [
    { day: "2026-11-01T10:00:00Z", total: 10 },
    { day: "2026-11-01T18:00:00Z", total: 5 },
    { day: "2026-11-03T09:00:00Z", total: 7 },
    { day: "not a date", total: 1 },
  ]

  test("a metric echoes its target and draws a sparkline from the same rows", () => {
    const out = transformBlock(
      "metric",
      { value: "total", agg: "sum", target: 40, sparkline: { field: "day", bucket: "day" } },
      rows,
    )
    expect(out).toMatchObject({ kind: "metric", value: 23, target: 40 })
    if (out.kind !== "metric") throw new Error("metric")
    expect(out.sparkline).toEqual({ labels: ["2026-11-01", "2026-11-03"], values: [15, 7] })
    // The undated row counts in the value and is not reported skipped twice.
    expect(out.meta.skippedRows).toBe(0)
  })

  test("a sum sparkline is filled with zeros over the dashboard window", () => {
    const out = transformBlock(
      "metric",
      { value: "total", sparkline: { field: "day", bucket: "day" } },
      rows,
      { window: { from: "2026-10-31", to: "2026-11-03" } },
    )
    if (out.kind !== "metric") throw new Error("metric")
    expect(out.sparkline).toEqual({
      labels: ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
      values: [0, 15, 0, 7],
    })
  })

  test("the spec keeps target and sparkline to metrics", () => {
    const spec = (map: Record<string, unknown>, type = "bar") =>
      dashboardSpecSchema.safeParse({
        v: 1,
        blocks: [{ id: "a", type, title: "A", source: { kind: "tool", tool: "x:y" }, map }],
      }).success
    expect(spec({ x: "status", agg: "count", target: 3 })).toBe(false)
    expect(spec({ agg: "count", target: 3, sparkline: { field: "day" } }, "metric")).toBe(true)
  })

  test("a metric takes the previous value", () => {
    const cur = transformBlock("metric", { agg: "count" }, rows)
    const prev = transformBlock("metric", { agg: "count" }, rows.slice(0, 2))
    expect(attachPrevious(cur, prev)).toMatchObject({ value: 4, previous: 2 })
  })

  test("categories match by label and series by name", () => {
    const cur = transformBlock("bar", { x: "sku", y: "n" }, [
      { sku: "A", n: 5 },
      { sku: "B", n: 3 },
    ])
    const prev = transformBlock("bar", { x: "sku", y: "n" }, [
      { sku: "B", n: 2 },
      { sku: "C", n: 9 },
    ])
    const out = attachPrevious(cur, prev)
    if (out.kind !== "bar") throw new Error("bar")
    expect(out.labels).toEqual(["A", "B"])
    expect(out.previous).toEqual({
      labels: [null, "B"],
      series: [{ name: "n", values: [null, 2] }],
    })
  })

  test("date buckets match by their distance from each window's start", () => {
    const line = (data: { d: string; n: number }[]) =>
      transformBlock("line", { groupBy: { field: "d", bucket: "day" }, y: "n" }, data)
    const cur = line([
      { d: "2026-11-01", n: 1 },
      { d: "2026-11-03", n: 3 },
    ])
    const prev = line([
      { d: "2025-11-01", n: 10 },
      { d: "2025-11-02", n: 20 },
      { d: "2025-11-03", n: 30 },
    ])
    const out = attachPrevious(cur, prev, {
      bucket: "day",
      window: { from: "2026-11-01", to: "2026-11-03" },
      compareWindow: { from: "2025-11-01", to: "2025-11-03" },
    })
    if (out.kind !== "line") throw new Error("line")
    expect(out.previous).toEqual({
      labels: ["2025-11-01", "2025-11-03"],
      series: [{ name: "n", values: [10, 30] }],
    })
    const months = (data: { d: string; n: number }[]) =>
      transformBlock("bar", { groupBy: { field: "d", bucket: "month" }, y: "n" }, data)
    const byMonth = attachPrevious(
      months([{ d: "2026-11-05", n: 1 }]),
      months([
        { d: "2026-10-05", n: 7 },
        { d: "2026-09-05", n: 9 },
      ]),
      {
        bucket: "month",
        window: { from: "2026-11-01", to: "2026-11-30" },
        compareWindow: { from: "2026-10-01", to: "2026-10-31" },
      },
    )
    if (byMonth.kind !== "bar") throw new Error("bar")
    expect(byMonth.previous?.series[0]?.values).toEqual([7])
  })

  test("a table is never compared", () => {
    const t = transformBlock("table", { columns: [{ field: "total", label: "Total" }] }, rows)
    expect(attachPrevious(t, t)).toEqual(t)
  })
})
