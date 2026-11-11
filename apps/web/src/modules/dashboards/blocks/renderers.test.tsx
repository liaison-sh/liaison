// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const charts = vi.hoisted(() => ({
  made: [] as Array<{ config: any; destroyed: boolean }>,
  registered: [] as unknown[],
}))

vi.mock("chart.js", () => {
  class Chart {
    entry: { config: any; destroyed: boolean }
    static register(...items: unknown[]) {
      charts.registered.push(...items)
    }
    constructor(_canvas: unknown, config: any) {
      this.entry = { config, destroyed: false }
      charts.made.push(this.entry)
    }
    destroy() {
      this.entry.destroyed = true
    }
  }
  const names = [
    "BarController",
    "BarElement",
    "LineController",
    "LineElement",
    "PointElement",
    "Filler",
    "PieController",
    "ArcElement",
    "CategoryScale",
    "LinearScale",
    "Tooltip",
    "Legend",
  ]
  return { Chart, ...Object.fromEntries(names.map((n) => [n, n])) }
})

import { BlockRenderer } from "./BlockRenderer"
import { Chart, chartConfig } from "./Chart"
import { MetricBlock } from "./MetricBlock"
import { TableBlock, tableColumns } from "./TableBlock"

afterEach(() => {
  cleanup()
  charts.made.length = 0
})

describe("MetricBlock", () => {
  it("shows the value with the block's format", () => {
    render(() => (
      <MetricBlock
        data={{ kind: "metric", value: 1520 }}
        format="currency"
        currency="EUR"
        locale="en"
      />
    ))
    expect(screen.getByTestId("block-metric-value").textContent).toBe("€1,520.00")
  })

  it("prefers the data's own format", () => {
    render(() => (
      <MetricBlock
        data={{ kind: "metric", value: 0.5, format: "percent" }}
        format="number"
        locale="en"
      />
    ))
    expect(screen.getByTestId("block-metric-value").textContent).toBe("50%")
  })

  it("says there is no value rather than showing 0", () => {
    render(() => <MetricBlock data={{ kind: "metric", value: null }} locale="en" />)
    expect(screen.getByTestId("block-metric-empty").textContent).toBe("No value yet")
    expect(screen.queryByTestId("block-metric-value")).toBeNull()
  })
})

describe("TableBlock", () => {
  const data = {
    kind: "table" as const,
    columns: [
      { field: "name", label: "Product" },
      { field: "total", label: "Total", format: "currency" as const },
      { field: "day", label: "Day", format: "date" as const },
    ],
    rows: [
      { name: "Mug", total: 12, day: "2026-11-01" },
      { name: "Cap", total: 7.5, day: "2026-11-02" },
    ],
  }

  it("renders headers and formatted cells on CardTable", () => {
    render(() => <TableBlock data={data} currency="EUR" locale="en" />)
    expect(screen.getByText("Product")).toBeTruthy()
    const first = screen.getByTestId("block-table-row-0")
    expect(first.textContent).toContain("Mug")
    expect(first.textContent).toContain("€12.00")
    expect(first.textContent).toContain("Nov 1, 2026")
  })

  it("shows the empty state for no rows", () => {
    render(() => <TableBlock data={{ ...data, rows: [] }} locale="en" />)
    expect(screen.getByTestId("block-empty").textContent).toBe("No data for this block yet")
  })

  it("anchors the first column, aligns figures right and folds past four", () => {
    const cols = tableColumns(
      [
        { field: "a", label: "A" },
        { field: "b", label: "B", format: "number" },
        { field: "c", label: "C" },
        { field: "d", label: "D", format: "date" },
        { field: "e", label: "E" },
      ],
      () => "",
    )
    expect(cols.map((c) => c.role)).toEqual(["anchor", "meta", "secondary", "meta", "fold"])
    expect(cols[1]).toMatchObject({ align: "right", numeric: true })
  })
})

describe("Chart", () => {
  it("draws through chart.js with only the pieces its kinds use registered (area fill included)", async () => {
    render(() => (
      <Chart
        type="bar"
        labels={["2026-11-01", "2026-11-02"]}
        datasets={[{ label: "total", values: [3, 4] }]}
        locale="en"
      />
    ))
    await waitFor(() => expect(charts.made.length).toBe(1))
    expect(charts.registered).toEqual([
      "BarController",
      "BarElement",
      "LineController",
      "LineElement",
      "PointElement",
      "Filler",
      "PieController",
      "ArcElement",
      "CategoryScale",
      "LinearScale",
      "Tooltip",
      "Legend",
    ])
    const cfg = charts.made[0]?.config
    expect(cfg.type).toBe("bar")
    expect(cfg.data.labels).toEqual(["Nov 1", "Nov 2"])
    expect(cfg.data.datasets[0].data).toEqual([3, 4])
    expect(screen.getByTestId("dashboard-chart").dataset.chartType).toBe("bar")
  })

  it("destroys its chart when unmounted", async () => {
    const { unmount } = render(() => (
      <Chart type="line" labels={["a"]} datasets={[{ label: "x", values: [1] }]} locale="en" />
    ))
    await waitFor(() => expect(charts.made.length).toBe(1))
    unmount()
    expect(charts.made[0]?.destroyed).toBe(true)
  })

  it("formats the y axis and tooltips with the block's format", () => {
    const cfg: any = chartConfig(
      {
        type: "line",
        labels: ["a"],
        datasets: [{ label: "Revenue", values: [10] }],
        format: "currency",
        currency: "EUR",
      },
      "en",
    )
    expect(cfg.options.scales.y.ticks.callback(10)).toBe("€10.00")
    expect(
      cfg.options.plugins.tooltip.callbacks.label({ dataset: { label: "Revenue" }, raw: 10 }),
    ).toBe("Revenue: €10.00")
    expect(cfg.options.plugins.legend.display).toBe(false)
  })

  it("gives a pie one colour per slice and no axes", () => {
    const cfg: any = chartConfig(
      { type: "pie", labels: ["a", "b", "c"], datasets: [{ label: "", values: [1, 2, 3] }] },
      "en",
    )
    expect(cfg.data.datasets[0].backgroundColor).toHaveLength(3)
    expect(new Set(cfg.data.datasets[0].backgroundColor).size).toBe(3)
    expect(cfg.options.scales).toBeUndefined()
  })
})

describe("BlockRenderer", () => {
  it("draws each kind", async () => {
    render(() => (
      <div>
        <div data-testid="m">
          <BlockRenderer data={{ kind: "metric", value: 3 }} locale="en" />
        </div>
        <div data-testid="l">
          <BlockRenderer
            data={{ kind: "line", x: ["a"], series: [{ name: "s", values: [1] }] }}
            locale="en"
          />
        </div>
        <div data-testid="p">
          <BlockRenderer
            data={{ kind: "pie", labels: ["a"], values: [1] }}
            title="Share"
            locale="en"
          />
        </div>
      </div>
    ))
    expect(screen.getByTestId("m").textContent).toBe("3")
    expect(screen.getByTestId("l").querySelector("[data-chart-type=line]")).toBeTruthy()
    expect(screen.getByTestId("p").querySelector("[data-chart-type=pie]")).toBeTruthy()
    await waitFor(() => expect(charts.made.length).toBe(2))
  })

  it("applies the spec's format when the data has none", () => {
    render(() => (
      <BlockRenderer
        data={{ kind: "metric", value: 0.2 }}
        map={{ format: "percent" }}
        locale="en"
      />
    ))
    expect(screen.getByTestId("block-metric-value").textContent).toBe("20%")
  })

  it("shows the empty state for a chart with nothing to draw", () => {
    render(() => <BlockRenderer data={{ kind: "bar", x: [], series: [] }} locale="en" />)
    expect(screen.getByTestId("block-empty")).toBeTruthy()
    expect(screen.queryByTestId("dashboard-chart")).toBeNull()
  })
})
