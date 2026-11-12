// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})

import { parseBlockResponse, type SeriesData } from "../dashboards-client"
import { layerErrors } from "./BlockCard"
import { BlockRenderer, layerOfSeries, seriesDatasets, seriesPick } from "./BlockRenderer"
import { chartConfig } from "./Chart"
import { headlineChange } from "./ChartHeadline"

afterEach(() => cleanup())

type Any = any

const OVER_TIME = {
  kind: "line",
  labels: ["2026-11-10", "2026-11-11", "2026-11-12"],
  series: [{ name: "sessions", values: [4, 0, 2] }],
  previous: {
    labels: ["2026-10-10", "2026-10-11", "2026-10-12"],
    series: [{ name: "sessions", values: [10, 3, 6] }],
  },
  display: { curve: "smooth" },
  inProgressLabel: "2026-11-12",
  headline: [{ key: "total", label: "sessions", value: 6, previous: 8 }],
  meta: { sourceRows: 3, truncated: false, skippedRows: 0 },
}

const BLENDED = {
  kind: "combo",
  labels: ["2026-11-01", "2026-11-02"],
  series: [
    { name: "Alpha", values: [1, 2] },
    { name: "Beta", values: [0, 1] },
    { name: "Sessions", values: [4, 3] },
  ],
  display: { lineSeries: ["Sessions"], rightAxis: ["Sessions"], stacked: true, curve: "smooth" },
  headline: [
    { key: "units", label: "Units", value: 4, previous: 2, layer: "units" },
    { key: "sessions", label: "Sessions", value: 7, previous: 7, layer: "sessions" },
    { key: "Units per session", label: "Units per session", value: 0.5714, calc: true },
  ],
  layers: [
    {
      id: "units",
      label: "Units",
      as: "bar",
      axis: "left",
      series: ["Alpha", "Beta"],
      meta: { sourceRows: 4, truncated: false, skippedRows: 0 },
    },
    {
      id: "sessions",
      label: "Sessions",
      as: "line",
      axis: "right",
      series: ["Sessions"],
      meta: { sourceRows: 2, truncated: false, skippedRows: 0 },
    },
  ],
  meta: { sourceRows: 6, truncated: false, skippedRows: 0 },
}

function parsed(body: unknown): SeriesData {
  const r = parseBlockResponse(body)
  if (!r.ok) throw new Error("refused")
  return r.data as SeriesData
}

describe("the wire", () => {
  it("reads the headline, the bucket in progress, the curve and the layers", () => {
    const d = parsed(OVER_TIME)
    expect(d.headline).toEqual([{ key: "total", label: "sessions", value: 6, previous: 8 }])
    expect(d.inProgressLabel).toBe("2026-11-12")
    expect(d.display?.curve).toBe("smooth")
    const b = parsed({
      ...BLENDED,
      layers: [
        BLENDED.layers[0],
        { ...BLENDED.layers[1], error: { error: "no_access", message: "nope" } },
      ],
    })
    expect(b.display?.rightAxis).toEqual(["Sessions"])
    expect(b.layers?.map((l) => [l.id, l.as, l.axis])).toEqual([
      ["units", "bar", "left"],
      ["sessions", "line", "right"],
    ])
    expect(b.headline?.[2]).toMatchObject({ calc: true })
    expect(layerErrors(b)).toEqual([
      { id: "sessions", label: "Sessions", error: "no_access", message: "nope" },
    ])
  })
})

describe("drawing over time", () => {
  it("curves smoothly only when asked, and draws today's bucket dotted", () => {
    const d = parsed(OVER_TIME)
    const sets = seriesDatasets(d, "Oct 10 – 12, 2026", { current: "Nov 10 – 12, 2026" })
    const c: Any = chartConfig(
      { type: "line", labels: d.x, datasets: sets, curve: "smooth", inProgressIndex: 2 },
      "en",
    )
    const [cur, prev] = c.data.datasets
    expect(cur.cubicInterpolationMode).toBe("monotone")
    expect(cur.segment.borderDash({ p1DataIndex: 2 })).toEqual([2, 3])
    expect(cur.segment.borderDash({ p1DataIndex: 1 })).toBeUndefined()
    // The comparison stays dashed as before, never dotted.
    expect(prev.segment).toBeUndefined()
    expect(prev.borderDash).toEqual([4, 4])
    const straight: Any = chartConfig({ type: "line", labels: d.x, datasets: sets }, "en")
    expect(straight.data.datasets[0].tension).toBe(0)
    expect(straight.data.datasets[0].cubicInterpolationMode).toBeUndefined()
  })

  it("draws today's bar faint", () => {
    const c: Any = chartConfig(
      {
        type: "bar",
        labels: ["a", "b"],
        datasets: [{ label: "x", values: [1, 2] }],
        inProgressIndex: 1,
      },
      "en",
    )
    const bg = c.data.datasets[0].backgroundColor
    expect(bg({ dataIndex: 1 })).not.toBe(bg({ dataIndex: 0 }))
  })

  it("names the legend by the real days and the tooltip by both days", () => {
    const d = parsed(OVER_TIME)
    const sets = seriesDatasets(d, "Oct 10 – 12, 2026", { current: "Nov 10 – 12, 2026" })
    expect(sets.map((s) => s.label)).toEqual(["Nov 10 – 12, 2026", "Oct 10 – 12, 2026"])
    const c: Any = chartConfig({ type: "line", labels: d.x, datasets: sets }, "en")
    const label = c.options.plugins.tooltip.callbacks.label
    expect(c.options.plugins.tooltip.mode).toBe("index")
    expect(label({ datasetIndex: 0, dataIndex: 1, raw: 0 })).toBe("sessions: 0")
    expect(label({ datasetIndex: 1, dataIndex: 1, raw: 3 })).toBe("Oct 11: 3")
  })

  it("puts a blended chart's right-axis layer on the right axis only", () => {
    const d = parsed(BLENDED)
    const sets = seriesDatasets(d, "Previous period", {
      rightAxis: (n) => `${n} (right axis)`,
    })
    expect(sets.map((s) => s.label)).toEqual(["Alpha", "Beta", "Sessions (right axis)"])
    const c: Any = chartConfig({ type: "combo", labels: d.x, datasets: sets, stacked: true }, "en")
    expect(c.data.datasets.map((x: Any) => x.yAxisID ?? "y")).toEqual(["y", "y", "y1"])
    expect(c.data.datasets[2].type).toBe("line")
    expect(c.options.scales.y1.position).toBe("right")
  })

  it("a pick reads its own layer's rows", () => {
    const d = parsed(BLENDED)
    expect(seriesPick(d, 1, 0)).toEqual({ category: "2026-11-02", layer: "units", series: "Alpha" })
    expect(seriesPick(d, 0, 2)).toEqual({ category: "2026-11-01", layer: "sessions" })
    // A name another layer took first carries " (<label>)": the rows know it without.
    const renamed: SeriesData = {
      ...d,
      layers: d.layers?.map((l) =>
        l.id === "units" ? { ...l, series: ["Alpha (Units)", "Beta"] } : l,
      ),
    }
    expect(layerOfSeries(renamed, "Alpha (Units)")).toEqual({ layer: "units", series: "Alpha" })
    expect(layerOfSeries(d, "Nobody")).toBeNull()
  })
})

describe("the headline", () => {
  it("reads a change calmly, with an arrow", () => {
    expect(headlineChange(-0.25, "en")).toBe("↓ 25%")
    expect(headlineChange(0.12, "en")).toBe("↑ 12%")
    expect(headlineChange(0, "en")).toBe("0%")
    expect(headlineChange(-0.25, "fr")).toMatch(/^↓ 25\s?%$/)
  })

  it("shows the total, its change and the comparison's days, then the in-progress note", () => {
    render(() => (
      <BlockRenderer
        data={parsed(OVER_TIME)}
        locale="en"
        window={{ from: "2026-11-01", to: "2026-11-12" }}
        compareWindow={{ from: "2026-10-01", to: "2026-10-12" }}
      />
    ))
    expect(screen.getByTestId("chart-headline-value-0").textContent).toBe("6")
    const change = screen.getByTestId("chart-headline-change-0")
    expect(change.textContent).toBe("↓ 25%")
    expect(change.getAttribute("data-direction")).toBe("down")
    // Neutral text colour: never an alarm colour.
    expect(change.className).toContain("text-text-secondary")
    expect(change.className).not.toMatch(/red|green|danger|success/)
    expect(screen.getByTestId("chart-headline-compare").textContent).toMatch(/Oct 1.+12, 2026/)
    expect(screen.getByTestId("chart-in-progress")).toBeTruthy()
  })

  it("names the comparison in French", () => {
    render(() => (
      <BlockRenderer
        data={parsed(OVER_TIME)}
        locale="fr"
        window={{ from: "2026-11-01", to: "2026-11-12" }}
        compareWindow={{ from: "2026-10-01", to: "2026-10-12" }}
      />
    ))
    expect(screen.getByTestId("chart-headline-compare").textContent).toMatch(/1.+12 oct\. 2026/)
  })

  it("shows several figures for a blended chart, a computed one as a plain number", () => {
    render(() => <BlockRenderer data={parsed(BLENDED)} locale="en" />)
    expect(screen.getByTestId("chart-headline-value-0").textContent).toBe("4")
    expect(screen.getByTestId("chart-headline-change-0").textContent).toBe("↑ 100%")
    expect(screen.getByTestId("chart-headline-change-1").textContent).toBe("0%")
    expect(screen.getByTestId("chart-headline-value-2").textContent).toBe("0.57")
    expect(screen.queryByTestId("chart-headline-change-2")).toBeNull()
    expect(screen.queryByTestId("chart-in-progress")).toBeNull()
  })
})
