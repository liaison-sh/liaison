// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Colour comes from the data: a block's rows colour its series or categories (map.colorField),
// people read with their avatar (map.personField), the pipeline is one bar of segments with
// counts in its legend, and series without a colour take the theme's chart palette, never the
// accent. A metric's change takes the success or error tone only when the block says which way
// is better.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { paintPart, parseBlockResponse, type SeriesData } from "../dashboards-client"
import { barRowsForm, PeopleRows, PipelineBar } from "./BarRows"
import { categoryColors, seriesDatasets } from "./BlockRenderer"
import { chartConfig, chartPalette } from "./Chart"
import { deltaTone, MetricBlock } from "./MetricBlock"

afterEach(cleanup)

const PIPE: SeriesData = {
  kind: "bar",
  x: ["Inbound", "Received", "Diagnosed"],
  series: [{ name: "value", values: [3, 5, 0] }],
  display: { stackedSingle: true },
  paint: { labels: ["#6b7280", "#3b82f6", null] },
}

const pickLabel = (l: string) => `Show rows for ${l}`

describe("the client reads a chart's paint", () => {
  it("keeps hex colours and ids, drops anything else", () => {
    expect(paintPart({ labels: ["#abc", "red", "url(x)", null], people: ["u-1", 3, ""] })).toEqual({
      paint: { labels: ["#abc", null, null, null], people: ["u-1", null, null] },
    })
    expect(paintPart(null)).toEqual({})
    const res = parseBlockResponse({
      kind: "bar",
      labels: ["a"],
      series: [{ name: "v", values: [1] }],
      display: { stackedSingle: true },
      paint: { labels: ["#22c55e"] },
      meta: {},
    })
    expect(res.ok && res.data).toMatchObject({
      display: { stackedSingle: true },
      paint: { labels: ["#22c55e"] },
    })
  })
})

describe("chart colours", () => {
  it("series without a colour take the palette tokens, never the accent", () => {
    const p = chartPalette(9)
    expect(p).toHaveLength(9)
    expect(new Set(p.slice(0, 8)).size).toBe(8)
    expect(p[8]).toBe(p[0])
  })

  it("a lone series' bars take their categories' colours; a person's falls back to the avatar", () => {
    expect(categoryColors({ labels: ["#111111", null], people: [null, "u-1"] }, 2)).toEqual([
      "#111111",
      expect.stringMatching(/^var\(--avatar-\d-bg\)$/),
    ])
    expect(categoryColors(undefined, 2)).toBeNull()
    const ds = seriesDatasets(PIPE, "prev")
    expect(ds[0]?.colors).toEqual(["#6b7280", "#3b82f6", null])
    const cfg = chartConfig({ type: "bar", labels: PIPE.x, datasets: ds }, "en") as any
    const bg = cfg.data.datasets[0].backgroundColor
    // A bar of 0 is a hairline on the baseline, in the grid's colour.
    expect(cfg.data.datasets[0].minBarLength).toBe(2)
    expect(bg({ dataIndex: 0, raw: 3 })).toBe("#6b7280")
    expect(bg({ dataIndex: 2, raw: 0 })).not.toBe("#6b7280")
    expect(cfg.options.scales.x.border).toBeDefined()
  })

  it("split series take their own colours", () => {
    const d: SeriesData = {
      kind: "bar",
      x: ["Ana"],
      series: [
        { name: "Received", values: [2] },
        { name: "Diagnosed", values: [1] },
      ],
      display: { stacked: true },
      paint: { series: ["#3b82f6", null] },
    }
    const cfg = chartConfig(
      { type: "bar", labels: d.x, datasets: seriesDatasets(d, "prev"), stacked: true },
      "en",
    ) as any
    expect(cfg.data.datasets[0].backgroundColor).toBe("#3b82f6")
    expect(cfg.data.datasets[1].backgroundColor).toBe(chartPalette(2)[1])
    // A stack keeps no hairline (a sliver per series would add up).
    expect(cfg.data.datasets[0].minBarLength).toBeUndefined()
  })

  it("a pie's slices take their colours", () => {
    const cfg = chartConfig(
      {
        type: "pie",
        labels: ["a", "b"],
        datasets: [{ label: "t", values: [1, 2], colors: ["#123456", null] }],
      },
      "en",
    ) as any
    expect(cfg.data.datasets[0].backgroundColor[0]).toBe("#123456")
  })
})

describe("the pipeline", () => {
  it("draws a segment per category with a value, its legend carrying every count", () => {
    expect(barRowsForm(PIPE)).toBe("pipeline")
    const pick = vi.fn()
    render(() => <PipelineBar data={PIPE} locale="en" onPick={pick} pickLabel={pickLabel} />)
    expect(screen.getByTestId("dashboard-pipeline-segment-0").style.background).toBe(
      "rgb(107, 114, 128)",
    )
    // An empty stage draws no segment, but keeps its legend entry with its 0.
    expect(screen.queryByTestId("dashboard-pipeline-segment-2")).toBeNull()
    expect(screen.getByTestId("dashboard-pipeline-legend-2").textContent).toContain("Diagnosed0")
    expect(screen.getByTestId("dashboard-pipeline-legend-1").textContent).toContain("5")
    // A colourless category takes a palette token.
    expect(
      screen
        .getByTestId("dashboard-pipeline-legend-2")
        .querySelector("span")
        ?.getAttribute("style"),
    ).toContain("var(--color-chart-3)")
    fireEvent.click(screen.getByTestId("dashboard-pipeline-segment-1"))
    fireEvent.click(screen.getByTestId("dashboard-pipeline-legend-0"))
    expect(pick.mock.calls).toEqual([
      [1, 0],
      [0, 0],
    ])
  })
})

describe("people rows", () => {
  const WHO: SeriesData = {
    kind: "bar",
    x: ["Tobias", "Unassigned"],
    series: [
      { name: "Received", values: [3, 0] },
      { name: "Inbound", values: [0, 2] },
    ],
    display: { horizontal: true, stacked: true },
    paint: { people: ["u-1", null], series: ["#3b82f6", "#6b7280"] },
  }

  it("one row per person with their disc, total and a track split by series", () => {
    expect(barRowsForm(WHO)).toBe("people")
    const pick = vi.fn()
    render(() => <PeopleRows data={WHO} locale="en" onPick={pick} pickLabel={pickLabel} />)
    const row = screen.getByTestId("dashboard-people-row-0")
    expect(row.textContent).toContain("TO")
    expect(row.textContent).toContain("Tobias")
    expect(row.textContent).toContain("3")
    // Nobody: a neutral disc, no avatar colour.
    expect(screen.getByTestId("dashboard-people-row-1").textContent).toContain("?")
    const seg = screen.getByTestId("dashboard-people-segment-1-1")
    expect(seg.style.width).toBe("66.66666666666666%")
    fireEvent.click(seg)
    expect(pick).toHaveBeenCalledWith(1, 1)
    expect(screen.queryByTestId("dashboard-people-segment-0-1")).toBeNull()
  })

  it("is not the form without people or on its feet", () => {
    expect(barRowsForm({ ...WHO, paint: {} })).toBeNull()
    expect(barRowsForm({ ...WHO, display: { stacked: true } })).toBeNull()
  })
})

describe("the metric's change", () => {
  it("reads neutral unless the block says which way is better", () => {
    expect(deltaTone(0.2, undefined)).toBe("neutral")
    expect(deltaTone(0.2, true)).toBe("good")
    expect(deltaTone(-0.2, true)).toBe("bad")
    expect(deltaTone(0.2, false)).toBe("bad")
    expect(deltaTone(0, true)).toBe("neutral")
  })

  it("draws the figure in the display face, the change toned beside it", () => {
    render(() => (
      <MetricBlock
        data={{
          kind: "metric",
          value: 12,
          previous: 10,
          sparkline: { labels: [], values: [1, 3, 2] },
        }}
        locale="en"
        compareMode="previousPeriod"
        higherIsBetter={false}
      />
    ))
    expect(screen.getByTestId("block-metric-value").className).toContain("font-display")
    const delta = screen.getByTestId("block-metric-delta")
    expect(delta.dataset.tone).toBe("bad")
    expect(delta.className).toContain("text-error")
    expect(
      screen
        .getByTestId("block-metric-sparkline")
        .querySelector("polyline")
        ?.getAttribute("stroke"),
    ).toBe("var(--color-error)")
  })
})
