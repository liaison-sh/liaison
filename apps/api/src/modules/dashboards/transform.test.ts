// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The map step, one chart type at a time, and the spec rules each type needs.

import { describe, expect, test } from "bun:test"
import { wrapExternalContent } from "~/lib/external-content"
import {
  blockTtlSec,
  dashboardSpecSchema,
  MAX_SOURCE_ROWS,
  MAX_SOURCE_TTL_SEC,
} from "~/modules/dashboards/spec"
import {
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
