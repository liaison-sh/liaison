// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 4, charts over time: zero-filled date buckets, headline figures (agg-consistent, with
// the comparison's), today's bucket in progress, the smooth curve, and layered (blended) charts
// joined on their date bucket; plus the spec's checks for them.

import { describe, expect, it } from "bun:test"
import { dashboardSpecSchema, layerBlocks, specIssues } from "~/modules/dashboards/spec"
import { attachPrevious, mergeLayers, transformBlock } from "~/modules/dashboards/transform"

const WINDOW = { from: "2026-11-01", to: "2026-11-05" }

const chart = (data: ReturnType<typeof transformBlock>) => {
  if (!("labels" in data)) throw new Error("not a chart")
  return data
}

describe("zero-fill", () => {
  it("a date chart gets every bucket of its window: 0 for sum and count", () => {
    const rows = [
      { day: "2026-11-02", n: 3 },
      { day: "2026-11-04", n: 2 },
    ]
    const out = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "day" }, y: "n" }, rows, {
        window: WINDOW,
      }),
    )
    expect(out.labels).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ])
    expect(out.series[0]!.values).toEqual([0, 3, 0, 2, 0])
  })

  it("an empty bucket is a gap for avg, and split series fill each bucket", () => {
    const rows = [
      { day: "2026-11-02", n: 4, p: "A" },
      { day: "2026-11-02", n: 2, p: "A" },
      { day: "2026-11-03", n: 1, p: "B" },
    ]
    const avg = chart(
      transformBlock(
        "line",
        { groupBy: { field: "day", bucket: "day" }, y: "n", agg: "avg" },
        rows,
        {
          window: { from: "2026-11-01", to: "2026-11-03" },
        },
      ),
    )
    expect(avg.series[0]!.values).toEqual([null, 3, 1])
    const split = chart(
      transformBlock(
        "bar",
        { groupBy: { field: "day", bucket: "day" }, y: "n", series: "p" },
        rows,
        {
          window: { from: "2026-11-01", to: "2026-11-03" },
        },
      ),
    )
    expect(split.series).toEqual([
      { name: "A", values: [0, 6, 0] },
      { name: "B", values: [0, 0, 1] },
    ])
  })

  it("never fills past today, and keeps 100+ buckets (no default cut at 100)", () => {
    const out = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "day" }, agg: "count" }, [], {
        window: { from: "2026-11-01", to: "2026-11-30" },
        today: "2026-11-12",
      }),
    )
    expect(out.labels.length).toBe(12)
    const long = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "day" }, agg: "count" }, [], {
        window: { from: "2026-01-01", to: "2026-06-30" },
      }),
    )
    expect(long.labels.length).toBe(181)
    expect(long.meta.truncated).toBe(false)
  })

  it("a window with no fill (fixed dates) keeps only the buckets with data", () => {
    const out = chart(
      transformBlock("bar", { groupBy: { field: "day", bucket: "day" }, agg: "count" }, [
        { day: "2026-11-03" },
      ]),
    )
    expect(out.labels).toEqual(["2026-11-03"])
  })

  it("the comparison lines up day for day over its own filled window", () => {
    const map = { groupBy: { field: "day", bucket: "day" as const }, y: "n" }
    const cur = transformBlock("line", map, [{ day: "2026-11-03", n: 5 }], {
      window: { from: "2026-11-01", to: "2026-11-03" },
    })
    const prev = transformBlock("line", map, [{ day: "2026-10-02", n: 7 }], {
      window: { from: "2026-10-01", to: "2026-10-03" },
    })
    const out = chart(
      attachPrevious(cur, prev, {
        bucket: "day",
        window: { from: "2026-11-01", to: "2026-11-03" },
        compareWindow: { from: "2026-10-01", to: "2026-10-03" },
      }),
    )
    expect(out.previous!.labels).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"])
    expect(out.previous!.series[0]!.values).toEqual([0, 7, 0])
  })
})

describe("headline, curve and the bucket in progress", () => {
  const rows = [
    { day: "2026-11-01", n: 10, p: "A" },
    { day: "2026-11-02", n: 20, p: "B" },
    { day: "2026-11-02", n: 30, p: "A" },
  ]

  it("total is the block's agg over every row: sum stays sum, avg the average of all rows", () => {
    const sum = chart(
      transformBlock(
        "line",
        { groupBy: { field: "day", bucket: "day" }, y: "n", headline: "total", curve: "smooth" },
        rows,
        { window: { from: "2026-11-01", to: "2026-11-02" } },
      ),
    )
    expect(sum.headline).toEqual([{ key: "total", label: "n", value: 60 }])
    expect(sum.display).toEqual({ curve: "smooth" })
    const avg = chart(
      transformBlock(
        "line",
        { groupBy: { field: "day", bucket: "day" }, y: "n", agg: "avg", headline: "total" },
        rows,
        { window: { from: "2026-11-01", to: "2026-11-02" } },
      ),
    )
    // The average of the three rows, not the average of the daily averages (10 and 25).
    expect(avg.headline![0]!.value).toBe(20)
  })

  it("series gives one figure per split series; a computed measure is a true ratio", () => {
    const split = chart(
      transformBlock(
        "bar",
        { groupBy: { field: "day", bucket: "day" }, y: "n", series: "p", headline: "series" },
        rows,
      ),
    )
    expect(split.headline).toEqual([
      { key: "A", label: "A", value: 40 },
      { key: "B", label: "B", value: 20 },
    ])
    const measures = chart(
      transformBlock(
        "combo",
        {
          groupBy: { field: "day", bucket: "day" },
          headline: "series",
          scale: 2,
          measures: [
            { label: "Units", name: "units", field: "n" },
            { label: "Rows", name: "rows", agg: "count" },
            { label: "Per row", expr: "units / rows" },
          ],
        },
        rows,
      ),
    )
    expect(measures.headline!.map((f) => f.value)).toEqual([120, 6, 40])
  })

  it("the comparison's figure is attached by key", () => {
    const map = {
      groupBy: { field: "day", bucket: "day" as const },
      y: "n",
      headline: "total" as const,
    }
    const out = chart(
      attachPrevious(
        transformBlock("line", map, rows),
        transformBlock("line", map, rows.slice(0, 1)),
      ),
    )
    expect(out.headline).toEqual([{ key: "total", label: "n", value: 60, previous: 10 }])
  })

  it("marks the bucket holding today when the window ends today", () => {
    const opts = { window: { from: "2026-11-01", to: "2026-11-12" }, today: "2026-11-12" }
    const day = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "day" }, agg: "count" }, [], opts),
    )
    expect(day.inProgressLabel).toBe("2026-11-12")
    const week = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "week" }, agg: "count" }, [], opts),
    )
    expect(week.inProgressLabel).toBe("2026-11-09")
    const past = chart(
      transformBlock("line", { groupBy: { field: "day", bucket: "day" }, agg: "count" }, [], {
        window: { from: "2026-10-01", to: "2026-10-12" },
        today: "2026-11-12",
      }),
    )
    expect(past.inProgressLabel).toBeUndefined()
  })
})

describe("layered charts", () => {
  const unitsLayer = {
    id: "units",
    label: "Units",
    as: "bar" as const,
    map: {
      groupBy: { field: "day", bucket: "day" as const },
      y: "n",
      series: "p",
      stacked: true,
      headline: "total" as const,
    },
  }
  const sessionsLayer = {
    id: "sessions",
    label: "Sessions",
    as: "line" as const,
    axis: "right" as const,
    map: { groupBy: { field: "day", bucket: "day" as const }, y: "s", headline: "total" as const },
  }

  it("joins the layers on their buckets: bars, a right-axis line, headline and a ratio", () => {
    const units = transformBlock(
      "bar",
      unitsLayer.map,
      [
        { day: "2026-11-01", n: 2, p: "A" },
        { day: "2026-11-02", n: 3, p: "B" },
      ],
      { window: { from: "2026-11-01", to: "2026-11-02" } },
    )
    const sessions = transformBlock(
      "line",
      sessionsLayer.map,
      [
        { day: "2026-11-01", s: 40 },
        { day: "2026-11-02", s: 60 },
      ],
      { window: { from: "2026-11-01", to: "2026-11-02" } },
    )
    const out = chart(
      mergeLayers(
        [
          { layer: unitsLayer, data: units },
          { layer: sessionsLayer, data: sessions },
        ],
        {
          curve: "smooth",
          headlineCalc: [{ label: "Units per session", expr: "units / sessions" }],
        },
      ),
    )
    expect(out.kind).toBe("combo")
    expect(out.labels).toEqual(["2026-11-01", "2026-11-02"])
    expect(out.series).toEqual([
      { name: "A", values: [2, 0] },
      { name: "B", values: [0, 3] },
      { name: "Sessions", values: [40, 60] },
    ])
    expect(out.display).toEqual({
      lineSeries: ["Sessions"],
      stacked: true,
      rightAxis: ["Sessions"],
      curve: "smooth",
    })
    expect(out.headline!.map((f) => [f.key, f.label, f.value])).toEqual([
      ["units", "Units", 5],
      ["sessions", "Sessions", 100],
      ["Units per session", "Units per session", 0.05],
    ])
    expect(out.layers!.map((l) => [l.id, l.series])).toEqual([
      ["units", ["A", "B"]],
      ["sessions", ["Sessions"]],
    ])
  })

  it("a failed layer shows its error and the others still draw; previous totals feed the ratio", () => {
    const map = sessionsLayer.map
    const cur = transformBlock("line", map, [{ day: "2026-11-01", s: 10 }])
    const withPrev = attachPrevious(cur, transformBlock("line", map, [{ day: "2026-11-01", s: 5 }]))
    const out = chart(
      mergeLayers(
        [
          { layer: unitsLayer, error: { error: "no_access", message: "cannot read" } },
          { layer: { ...sessionsLayer, id: "s2" }, data: withPrev },
        ],
        { headlineCalc: [{ label: "Double", expr: "s2 * 2" }] },
      ),
    )
    expect(out.series.map((s) => s.name)).toEqual(["Sessions"])
    expect(out.layers![0]!.error).toEqual({ error: "no_access", message: "cannot read" })
    expect(out.headline!.at(-1)).toEqual({
      key: "Double",
      label: "Double",
      value: 20,
      previous: 10,
      calc: true,
    })
    expect(out.previous!.series[0]!.values).toEqual([5])
  })

  it("a layered block runs each layer as a block of its own", () => {
    const parsed = dashboardSpecSchema.parse({
      v: 1,
      datasets: { sessions: { kind: "tool", tool: "shop:sessions", params: {} } },
      blocks: [
        {
          id: "blend",
          type: "combo",
          title: "Units and sessions",
          layers: [
            { ...unitsLayer, source: { kind: "tool", tool: "shop:units", params: {} } },
            { ...sessionsLayer, dataset: "sessions" },
          ],
          map: { headlineCalc: [{ label: "Units per session", expr: "units / sessions" }] },
        },
      ],
    })
    const runs = layerBlocks(parsed.blocks[0]!)
    expect(runs.map((b) => [b.id, b.type, b.dataset ?? b.source?.kind])).toEqual([
      ["blend~units", "bar", "tool"],
      ["blend~sessions", "line", "sessions"],
    ])
  })
})

describe("spec checks", () => {
  const layer = (over: Record<string, unknown> = {}) => ({
    id: "a",
    as: "bar",
    source: { kind: "tool", tool: "shop:units", params: {} },
    map: { groupBy: { field: "day", bucket: "day" }, y: "n" },
    ...over,
  })
  const problems = (block: Record<string, unknown>) => {
    const r = dashboardSpecSchema.safeParse({
      v: 1,
      blocks: [{ id: "b", type: "combo", title: "B", ...block }],
    })
    return r.success ? [] : specIssues(r.error)
  }

  it("refuses a join on anything but one shared date bucket", () => {
    expect(
      problems({ layers: [layer(), layer({ id: "b", map: { x: "product", y: "n" } })] }).join("\n"),
    ).toContain("layers join on a date bucket")
    expect(
      problems({
        layers: [
          layer(),
          layer({ id: "b", map: { groupBy: { field: "day", bucket: "week" }, y: "n" } }),
        ],
      }).join("\n"),
    ).toContain("blocks.0.layers: every layer uses the same bucket")
  })

  it("names the field: block source beside layers, a layer map key, headlineCalc needs totals", () => {
    const out = problems({
      source: { kind: "tool", tool: "shop:units", params: {} },
      layers: [
        layer({ map: { groupBy: { field: "day", bucket: "day" }, y: "n", curve: "smooth" } }),
        layer({ id: "b" }),
      ],
      map: { y: "n", headlineCalc: [{ label: "R", expr: "a / b" }] },
    }).join("\n")
    expect(out).toContain("blocks.0.source: a block with layers reads its sources in its layers")
    expect(out).toContain("blocks.0.layers.0.map: a layer's map takes no curve")
    expect(out).toContain("blocks.0.map: a layered block's map takes curve, headlineCalc")
    expect(out).toContain(`reads the layer 'a''s total: give that layer map.headline "total"`)
  })

  it("refuses a 4th layer, a headline beside percentOfTotal, and curve on a bar", () => {
    expect(
      problems({ layers: ["a", "b", "c", "d"].map((id) => layer({ id })) }).join("\n"),
    ).toContain("blocks.0.layers")
    const bar = dashboardSpecSchema.safeParse({
      v: 1,
      blocks: [
        {
          id: "x",
          type: "bar",
          title: "X",
          source: { kind: "tool", tool: "shop:units", params: {} },
          map: { x: "p", y: "n", headline: "total", percentOfTotal: true, curve: "smooth" },
        },
      ],
    })
    const issues = bar.success ? "" : specIssues(bar.error).join("\n")
    expect(issues).toContain("map.headline shows totals: it does not go with map.percentOfTotal")
    expect(issues).toContain("map.curve is for a line, area or combo chart")
  })
})
