// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The block types and map options of step 2: area, stacked, horizontal, combo (measures and
// lines), funnel (stages or categories), text, where before aggregation, record links; and
// the spec rules each needs (datasets, filters, a text block without source).

import { describe, expect, test } from "bun:test"
import { resolveWhere } from "~/modules/dashboards/filters"
import { dashboardSpecSchema, mapProblems } from "~/modules/dashboards/spec"
import {
  attachPrevious,
  recordLink,
  TransformError,
  transformBlock,
} from "~/modules/dashboards/transform"

const orders = [
  { id: "o1", day: "2026-11-01", total: "10", channel: "b2b", market: "FR", step: "paid" },
  { id: "o2", day: "2026-11-01", total: "5", channel: "dtc", market: "DE", step: "paid" },
  { id: "o3", day: "2026-11-02", total: "20", channel: "b2b", market: "FR", step: "shipped" },
  { id: "o4", day: "2026-11-02", total: "1", channel: "dtc", market: "FR", step: "cart" },
]

describe("chart types", () => {
  test("area is a line filled; stacked and horizontal are echoed for the web", () => {
    const area = transformBlock(
      "area",
      { groupBy: { field: "day" }, y: "total", series: "channel", stacked: true },
      orders,
    )
    expect(area).toMatchObject({
      kind: "area",
      labels: ["2026-11-01", "2026-11-02"],
      series: [
        { name: "b2b", values: [10, 20] },
        { name: "dtc", values: [5, 1] },
      ],
      display: { stacked: true },
    })
    const bar = transformBlock("bar", { x: "market", agg: "count", horizontal: true }, orders)
    expect(bar).toMatchObject({ kind: "bar", labels: ["FR", "DE"], display: { horizontal: true } })
  })

  test("combo: one series per measure, the named ones drawn as lines on their own axis", () => {
    const combo = transformBlock(
      "combo",
      {
        groupBy: { field: "day" },
        measures: [
          { label: "Revenue", field: "total", agg: "sum" },
          { label: "Orders", agg: "count" },
        ],
        lineSeries: ["Orders"],
        secondaryAxis: true,
      },
      orders,
    )
    expect(combo).toMatchObject({
      kind: "combo",
      labels: ["2026-11-01", "2026-11-02"],
      series: [
        { name: "Revenue", values: [15, 21] },
        { name: "Orders", values: [2, 2] },
      ],
      display: { lineSeries: ["Orders"], secondaryAxis: true },
    })
    // Without lineSeries, the last series is the line.
    const split = transformBlock(
      "combo",
      { groupBy: { field: "day" }, y: "total", series: "channel" },
      orders,
    )
    expect(split).toMatchObject({ display: { lineSeries: ["dtc"] } })
  })

  test("funnel from stages: one aggregation each over all rows, or a path into one object", () => {
    const out = transformBlock(
      "funnel",
      {
        stages: [
          { label: "Orders", agg: "count" },
          { label: "Revenue", field: "total" },
        ],
      },
      orders,
    )
    expect(out).toMatchObject({
      kind: "funnel",
      labels: ["Orders", "Revenue"],
      series: [{ name: "value", values: [4, 36] }],
    })
    const totals = transformBlock(
      "funnel",
      {
        stages: [
          { label: "Visits", field: "visits" },
          { label: "Carts", field: "carts" },
        ],
      },
      { visits: 100, carts: 12 },
    )
    expect(totals).toMatchObject({ labels: ["Visits", "Carts"], series: [{ values: [100, 12] }] })
  })

  test("funnel from categories follows map.order; a missing stage is 0", () => {
    const out = transformBlock(
      "funnel",
      { x: "step", agg: "count", order: ["cart", "paid", "shipped", "delivered"] },
      orders,
    )
    expect(out).toMatchObject({
      labels: ["cart", "paid", "shipped", "delivered"],
      series: [{ values: [1, 2, 1, 0] }],
    })
  })

  test("text: the markdown, no rows", () => {
    expect(transformBlock("text", {}, null, { text: "**Target**: 40 units" })).toMatchObject({
      kind: "text",
      markdown: "**Target**: 40 units",
    })
  })

  test("previous values align on a combo's measures and a funnel's stages", () => {
    const map = {
      x: "market",
      measures: [
        { label: "Revenue", field: "total" },
        { label: "Orders", agg: "count" as const },
      ],
    }
    const cur = transformBlock("combo", map, orders)
    const prev = transformBlock("combo", map, orders.slice(0, 2))
    const out = attachPrevious(cur, prev)
    expect(out).toMatchObject({
      previous: {
        labels: ["FR", "DE"],
        series: [
          { name: "Revenue", values: [10, 5] },
          { name: "Orders", values: [1, 1] },
        ],
      },
    })
  })
})

describe("where before aggregation", () => {
  test("rows that fail are left out of every figure, and counted", () => {
    const out = transformBlock("metric", { value: "total" }, orders, {
      where: resolveWhere([{ field: "market", op: "eq", value: { filter: "market" } }], {
        market: ["FR"],
      }),
    })
    expect(out).toMatchObject({ value: 31, meta: { sourceRows: 4, filteredRows: 1 } })
  })

  test("an empty filter keeps every row and says nothing", () => {
    const out = transformBlock("metric", { value: "total" }, orders, {
      where: resolveWhere([{ field: "market", op: "eq", value: { filter: "market" } }], {}),
    })
    expect(out.meta.filteredRows).toBeUndefined()
    expect(out).toMatchObject({ value: 36 })
  })

  test("a where on a one-object result is refused", () => {
    expect(() =>
      transformBlock(
        "metric",
        { value: "n" },
        { n: 3 },
        {
          where: resolveWhere([{ field: "x", op: "notEmpty" }], {}),
        },
      ),
    ).toThrow(TransformError)
  })
})

describe("record links", () => {
  test("a table's rows carry their link: a path template or an entity", () => {
    const out = transformBlock(
      "table",
      { columns: [{ field: "id", label: "Order" }], link: "/shop/orders/{{id}}" },
      [...orders, { id: "a b/c" }, { total: 1 }],
    )
    expect(out.kind === "table" && out.links).toEqual([
      { kind: "path", href: "/shop/orders/o1" },
      { kind: "path", href: "/shop/orders/o2" },
      { kind: "path", href: "/shop/orders/o3" },
      { kind: "path", href: "/shop/orders/o4" },
      { kind: "path", href: "/shop/orders/a%20b%2Fc" },
      null,
    ])
    expect(recordLink({ id: 7 }, { entity: "order", idField: "id" }, "shop")).toEqual({
      kind: "entity",
      app: "shop",
      entityType: "order",
      id: "7",
    })
    expect(recordLink({ id: 7 }, { entity: "order", idField: "id" })).toBeNull()
  })
})

describe("spec rules", () => {
  const src = { kind: "tool", tool: "shop:orders_search", params: {} }
  const parse = (spec: Record<string, unknown>) => dashboardSpecSchema.safeParse({ v: 1, ...spec })
  const issues = (spec: Record<string, unknown>) => {
    const r = parse(spec)
    return r.success ? [] : r.error.issues.map((i) => i.message)
  }

  test("a block reads its own source or a declared dataset, never both or neither", () => {
    expect(
      parse({
        datasets: { orders: src },
        blocks: [
          { id: "a", type: "metric", title: "A", dataset: "orders", map: { agg: "count" } },
          {
            id: "b",
            type: "table",
            title: "B",
            dataset: "orders",
            map: { columns: [{ field: "id", label: "Id" }] },
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      issues({
        blocks: [{ id: "a", type: "metric", title: "A", dataset: "nope", map: { agg: "count" } }],
      }),
    ).toContain("no dataset 'nope' in spec.datasets")
    expect(
      issues({ blocks: [{ id: "a", type: "metric", title: "A", map: { agg: "count" } }] }).join(),
    ).toContain("one of source, dataset")
  })

  test("a text block has text and no source", () => {
    expect(
      parse({ blocks: [{ id: "t", type: "text", title: "Notes", text: "B2B = tagged b2b" }] })
        .success,
    ).toBe(true)
    expect(
      issues({ blocks: [{ id: "t", type: "text", title: "Notes", source: src, text: "x" }] }),
    ).toContain("a text block reads no source")
  })

  test("filter tokens and where clauses name declared filters", () => {
    const filters = [{ id: "market", label: "Market", type: "select", options: ["FR", "DE"] }]
    expect(
      parse({
        filters,
        blocks: [
          {
            id: "a",
            type: "metric",
            title: "A",
            source: { ...src, params: { market: "{{filter.market}}" } },
            map: { agg: "count", where: [{ field: "m", op: "eq", value: { filter: "market" } }] },
          },
        ],
      }).success,
    ).toBe(true)
    const bad = issues({
      blocks: [
        {
          id: "a",
          type: "metric",
          title: "A",
          source: { ...src, params: { market: "{{filter.market}}" } },
          map: { agg: "count", where: [{ field: "m", op: "eq", value: { filter: "channel" } }] },
        },
      ],
    })
    expect(bad).toContain("{{filter.market}} names no filter in spec.filters")
    expect(bad).toContain("names no filter 'channel' in spec.filters")
    expect(
      issues({ filters: [{ id: "m", label: "M", type: "select" }], blocks: [] }).join(),
    ).toContain("needs options")
    expect(
      issues({
        filters: [{ id: "m", label: "M", type: "select", options: ["FR"], default: "JP" }],
        blocks: [],
      }),
    ).toContain("'JP' is not one of the options")
  })

  test("a dataset block follows the range when its dataset reads it", () => {
    expect(
      issues({
        datasets: { orders: { ...src, params: { since: "{{range.from}}" } } },
        blocks: [
          {
            id: "a",
            type: "metric",
            title: "A",
            dataset: "orders",
            timeRange: "fixed",
            map: { agg: "count" },
          },
        ],
      }).join(),
    ).toContain('a "fixed" block cannot use')
  })

  test("map options belong to their chart types", () => {
    expect(mapProblems("pie", { label: "x", agg: "count", stacked: true })).toContain(
      "map.stacked is for a bar, area or combo chart",
    )
    expect(mapProblems("combo", { x: "d", y: "t" }).join()).toContain(
      "map.measures (two or more) or map.series",
    )
    expect(
      mapProblems("combo", {
        x: "d",
        measures: [
          { label: "A", field: "t" },
          { label: "B", agg: "count" },
        ],
        lineSeries: ["C"],
      }),
    ).toContain("map.lineSeries names 'C', which is not a measure label")
    expect(mapProblems("funnel", { x: "step" }).join()).toContain("needs map.y")
    expect(mapProblems("line", { link: "/x/{{id}}", x: "d", agg: "count" })).toEqual([])
    expect(
      dashboardSpecSchema.safeParse({
        v: 1,
        blocks: [
          {
            id: "a",
            type: "table",
            title: "A",
            source: src,
            map: { columns: [{ field: "id", label: "Id" }], link: "https://evil.example/{{id}}" },
          },
        ],
      }).success,
    ).toBe(false)
  })
})
