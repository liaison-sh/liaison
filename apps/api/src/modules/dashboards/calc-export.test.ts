// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calculated values (map.expr over map.values, a measure's expr, another dataset's measure,
// scale, percent of total) and the exports (CSV, snapshot figures, the PDF).

import { describe, expect, it } from "bun:test"
import {
  blockDataCsv,
  type ComputedDashboard,
  changeOf,
  renderDashboardPdf,
  rowAccessCovers,
  rowsCsv,
  snapshotBlock,
} from "~/modules/dashboards/export"
import {
  type DashboardBlock,
  dashboardSpecSchema,
  MAX_SOURCE_ROWS,
  specIssues,
} from "~/modules/dashboards/spec"
import { transformBlock } from "~/modules/dashboards/transform"
import { extractPdfText } from "~/modules/pdf/pdf-text"

const orders = [
  { day: "2026-11-01", total: 100, channel: "web" },
  { day: "2026-11-01", total: 50, channel: "shop" },
  { day: "2026-11-02", total: 30, channel: "web" },
]
const spend = [
  { date: "2026-11-01", cost: 20 },
  { date: "2026-11-02", cost: 15 },
  { date: "2026-11-02", cost: 15 },
]

describe("calculated values", () => {
  it("a metric computes map.expr over named values, one read from another dataset", () => {
    const out = transformBlock(
      "metric",
      {
        values: {
          revenue: { field: "total" },
          web: { field: "total", where: [{ field: "channel", op: "eq", value: "web" }] },
          cost: { field: "cost", dataset: "ads" },
        },
        expr: "revenue / cost",
      },
      orders,
      { datasetRows: { ads: spend } },
    )
    expect(out).toMatchObject({ kind: "metric", value: 3.6 })
    const share = transformBlock(
      "metric",
      {
        values: {
          all: { field: "total" },
          web: { field: "total", where: [{ field: "channel", op: "eq", value: "web" }] },
        },
        expr: "web / all * 100",
      },
      orders,
    )
    expect(share).toMatchObject({ value: 72.222222 })
  })

  it("a chart's measure reads another dataset by the same day, and another computes from both", () => {
    const out = transformBlock(
      "line",
      {
        groupBy: { field: "day", bucket: "day" },
        measures: [
          { label: "Revenue", name: "revenue", field: "total" },
          { label: "Spend", name: "spend", field: "cost", dataset: "ads", categoryField: "date" },
          { label: "ROAS", expr: "revenue / spend" },
        ],
      },
      orders,
      { datasetRows: { ads: spend } },
    )
    if (out.kind !== "line") throw new Error("line")
    expect(out.labels).toEqual(["2026-11-01", "2026-11-02"])
    expect(out.series).toEqual([
      { name: "Revenue", values: [150, 30] },
      { name: "Spend", values: [20, 30] },
      { name: "ROAS", values: [7.5, 1] },
    ])
  })

  it("scale multiplies, percentOfTotal divides by the series total", () => {
    const cents = transformBlock("metric", { value: "total", scale: 0.01 }, orders)
    expect(cents).toMatchObject({ value: 1.8 })
    const pie = transformBlock(
      "pie",
      { label: "channel", value: "total", percentOfTotal: true },
      orders,
    )
    if (pie.kind !== "pie") throw new Error("pie")
    expect(pie.series[0]!.values).toEqual([72.222222, 27.777778])
  })

  it("the spec refuses an expr over unknown names and a measure dataset that is not declared", () => {
    const bad = dashboardSpecSchema.safeParse({
      v: 1,
      blocks: [
        {
          id: "m",
          type: "metric",
          title: "ROAS",
          source: { kind: "tool", tool: "shop:orders" },
          map: { values: { revenue: { field: "total", dataset: "ads" } }, expr: "revenue / spend" },
        },
      ],
    })
    expect(bad.success).toBe(false)
    const issues = bad.success ? [] : specIssues(bad.error).join("\n")
    expect(issues).toContain("'spend' is not a value of this block")
    expect(issues).toContain("reads no dataset 'ads'")
  })
})

describe("exports", () => {
  it("CSV: a chart's labels by series with the compared values; cells that look like formulas are quoted", () => {
    const csv = blockDataCsv("Sales", {
      kind: "bar",
      labels: ["=SUM(A1)", "b, c"],
      series: [{ name: "value", values: [1, 2] }],
      meta: { sourceRows: 2, truncated: false, skippedRows: 0 },
      previous: { labels: [null, null], series: [{ name: "value", values: [3, null] }] },
    })
    expect(csv).toBe('label,value,value (previous)\r\n\'=SUM(A1),1,3\r\n"b, c",2,\r\n')
    expect(
      blockDataCsv("Orders", {
        kind: "metric",
        value: 5,
        previous: 4,
        target: 8,
        meta: { sourceRows: 1, truncated: false, skippedRows: 0 },
      }),
    ).toBe("metric,value,previous,target\r\nOrders,5,4,8\r\n")
    expect(rowsCsv([{ field: "id", label: "Id" }], [{ id: 1 }, { id: null }])).toBe(
      "Id\r\n1\r\n\r\n",
    )
  })

  it("snapshot: a metric's change, a chart's totals with their change", () => {
    expect(changeOf(110, 100)).toBe(0.1)
    expect(changeOf(1, 0)).toBeNull()
    const block = {
      id: "s",
      title: "Sales",
      type: "bar",
      width: 1,
      map: {},
    } as unknown as DashboardBlock
    const snap = snapshotBlock(block, {
      blockId: "s",
      ok: true,
      cached: false,
      computedAt: "",
      window: { mode: "fixed", dates: [] },
      compareWindow: null,
      data: {
        kind: "bar",
        labels: ["a", "b"],
        series: [{ name: "value", values: [3, 7] }],
        meta: { sourceRows: 2, truncated: false, skippedRows: 0 },
        previous: { labels: ["a", "b"], series: [{ name: "value", values: [2, 3] }] },
      },
    })
    expect(snap).toMatchObject({
      series: [{ name: "value", total: 10, previousTotal: 5, change: 1 }],
      top: [
        { label: "b", value: 7 },
        { label: "a", value: 3 },
      ],
    })
  })

  it("PDF: the header prints the period and the filters, then every block", async () => {
    const meta = { sourceRows: 1, truncated: false, skippedRows: 0 }
    const computed = {
      view: {
        id: "d",
        title: "Weekly {{sales}}",
        spec: {
          v: 1,
          description: "For Monday",
          filters: [{ id: "market", label: "Market", type: "select", options: ["FR"] }],
          blocks: [],
        },
        defaultFilters: { market: [] },
        timeZone: "Europe/Paris",
        version: 1,
      },
      blocks: [
        {
          block: { id: "m", title: "Orders", type: "metric" },
          out: {
            blockId: "m",
            ok: true,
            data: { kind: "metric", value: 12, previous: 10, meta },
            cached: false,
            computedAt: "",
            window: {
              mode: "dashboard",
              preset: "lastMonth",
              from: "2026-10-01",
              to: "2026-10-31",
            },
            compareWindow: { mode: "lastYear", from: "2025-10-01", to: "2025-10-31" },
          },
        },
        {
          block: { id: "t", title: "Top", type: "bar" },
          out: {
            blockId: "t",
            ok: true,
            data: { kind: "bar", labels: ["FR"], series: [{ name: "value", values: [4] }], meta },
            cached: false,
            computedAt: "",
            window: { mode: "fixed", dates: [] },
            compareWindow: null,
          },
        },
        {
          block: { id: "x", title: "Broken", type: "metric" },
          out: { blockId: "x", ok: false, error: "no_access", message: "no access to shop:orders" },
        },
      ],
    } as unknown as ComputedDashboard
    const bytes = await renderDashboardPdf(
      computed,
      { market: ["FR"] },
      new Date("2026-11-11T10:00:00Z"),
    )
    const text = (await extractPdfText(bytes)).replace(/\s+/g, " ")
    expect(text).toContain("Weekly {{sales}}")
    expect(text).toContain(
      "Period: 2026-10-01 to 2026-10-31 (last month), compared with 2025-10-01 to 2025-10-31",
    )
    expect(text).toContain("Filters: Market: FR")
    expect(text).toContain("+20.0%")
    expect(text).toContain("Not shown: no access to shop:orders")
  })
})

describe("measures in dependency order (step-3 review MED 7)", () => {
  const measures = [
    { label: "Margin %", expr: "margin / revenue * 100" },
    { label: "Revenue", name: "revenue", field: "total" },
    { label: "Margin", name: "margin", expr: "revenue - cost" },
    { label: "Cost", name: "cost", field: "cost" },
  ]
  const rows = [
    { day: "2026-11-01", total: 100, cost: 60 },
    { day: "2026-11-02", total: 0, cost: 0 },
  ]

  it("a measure reading one defined after it is computed, not 0", () => {
    const out = transformBlock("bar", { x: "day", measures }, rows)
    if (out.kind !== "bar") throw new Error("bar")
    expect(out.series.map((s) => s.name)).toEqual(["Margin %", "Revenue", "Margin", "Cost"])
    expect(out.series[0]!.values[0]).toBe(40)
    expect(out.series[2]!.values).toEqual([40, 0])
  })

  it("a value that cannot compute (division by 0) stays null: the chart draws a gap", () => {
    const out = transformBlock("bar", { x: "day", measures }, rows)
    if (out.kind !== "bar") throw new Error("bar")
    expect(out.series[0]!.values[1]).toBeNull()
  })

  it("the spec refuses a cycle and a self-reference at save time", () => {
    const spec = (ms: unknown[]) =>
      dashboardSpecSchema.safeParse({
        v: 1,
        blocks: [
          {
            id: "c",
            type: "bar",
            title: "C",
            source: { kind: "tool", tool: "shop:orders" },
            map: { x: "day", measures: ms },
          },
        ],
      })
    const self = spec([{ label: "A", name: "a", expr: "a + 1" }])
    expect(self.success).toBe(false)
    expect(self.success ? "" : specIssues(self.error).join("\n")).toMatch(/reads itself|cycle/)
    const loop = spec([
      { label: "A", name: "a", expr: "b + 1" },
      { label: "B", name: "b", expr: "a + 1" },
      { label: "T", name: "t", field: "total" },
    ])
    expect(loop.success).toBe(false)
    expect(loop.success ? "" : specIssues(loop.error).join("\n")).toMatch(/cycle/)
    expect(spec(measures).success).toBe(true)
  })
})

describe("exports (step-3 review LOWs)", () => {
  it("CSV keeps a negative number sent as text numeric; a formula still gets its quote", () => {
    expect(
      rowsCsv([{ field: "n", label: "N" }], [{ n: "-12.50" }, { n: "+3" }, { n: "-A1+1" }]),
    ).toBe("N\r\n-12.50\r\n+3\r\n'-A1+1\r\n")
  })

  it("a measure read from a dataset cut at the row limit says the figures are truncated", () => {
    const many = Array.from({ length: MAX_SOURCE_ROWS + 5 }, (_, i) => ({
      date: "2026-11-01",
      cost: i,
    }))
    const out = transformBlock(
      "bar",
      {
        x: "day",
        measures: [
          { label: "Revenue", field: "total" },
          { label: "Spend", field: "cost", dataset: "ads", categoryField: "date" },
        ],
      },
      orders,
      { datasetRows: { ads: many } },
    )
    expect(out.meta.truncated).toBe(true)
  })
})

describe("recipient row access (step-3 review MED 4)", () => {
  it("covers only when every dimension value and role of the caller is the recipient's too", () => {
    const all = { dimensionGrants: { "*": ["*"] }, roles: ["r1"] }
    const fr = { dimensionGrants: { market: ["FR"] }, roles: ["r1"] }
    const frDe = { dimensionGrants: { market: ["FR", "DE"] }, roles: ["r1", "r2"] }
    const anyMarket = { dimensionGrants: { market: ["*"] }, roles: ["r1"] }
    expect(rowAccessCovers(all, fr)).toBe(true)
    expect(rowAccessCovers(fr, all)).toBe(false)
    expect(rowAccessCovers(frDe, fr)).toBe(true)
    expect(rowAccessCovers(fr, frDe)).toBe(false)
    expect(rowAccessCovers(anyMarket, fr)).toBe(true)
    expect(rowAccessCovers(fr, anyMarket)).toBe(false)
    // A role the caller holds shares rows with it: every grant, but not the role, is narrower.
    expect(rowAccessCovers({ dimensionGrants: { "*": ["*"] }, roles: [] }, fr)).toBe(false)
    expect(rowAccessCovers({ dimensionGrants: {} }, { dimensionGrants: {} })).toBe(true)
  })
})
