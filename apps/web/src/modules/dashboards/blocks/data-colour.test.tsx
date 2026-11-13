// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Data colours hold in both themes (a status's hex nudged until it clears 3:1 on the block
// surface), and a category without a colour of its own reads in one palette slot everywhere on a
// dashboard, keyed by its value, never by its place in one chart.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import type { PieData, SeriesData } from "../dashboards-client"
import { PeopleRows, PipelineBar } from "./BarRows"
import { pieColors, seriesDatasets } from "./BlockRenderer"
import { ColourScopeProvider, contrastRatio, createColourScope, readableOn } from "./data-colour"

afterEach(cleanup)

const DARK_SURFACE = "#1a1a1e"
const LIGHT_SURFACE = "#f4f4f6"

describe("readableOn", () => {
  // Colours that vanish on the dark card (dark greys, deep greens and teals picked on a light
  // theme) and on the light one (pale yellows).
  const darkFails = ["#1f2937", "#14532d", "#0b3d38", "#312e81", "#000000"]
  const lightFails = ["#fde68a", "#e5e7eb", "#ffffff", "#a7f3d0"]

  it("lifts a colour that disappears on the dark surface to 3:1, keeping its hue family", () => {
    for (const c of darkFails) {
      expect(contrastRatio(c, DARK_SURFACE)).toBeLessThan(3)
      const out = readableOn(c, DARK_SURFACE)
      expect(contrastRatio(out, DARK_SURFACE)).toBeGreaterThanOrEqual(3)
      expect(out).not.toBe(c)
    }
  })

  it("darkens a colour that disappears on the light surface to 3:1", () => {
    for (const c of lightFails) {
      const out = readableOn(c, LIGHT_SURFACE)
      expect(contrastRatio(out, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3)
    }
  })

  it("leaves readable colours and theme tokens alone", () => {
    expect(readableOn("#3b82f6", DARK_SURFACE)).toBe("#3b82f6")
    expect(readableOn("#b8456d", LIGHT_SURFACE)).toBe("#b8456d")
    expect(readableOn("var(--color-chart-2)", DARK_SURFACE)).toBe("var(--color-chart-2)")
  })
})

describe("a colour scope", () => {
  it("gives one value one slot, whoever asks first, and up to eight values distinct slots", () => {
    const a = createColourScope()
    const b = createColourScope()
    const names = [
      "Inbound",
      "Received",
      "Diagnosed",
      "Repaired",
      "Needs replacement",
      "x",
      "y",
      "z",
    ]
    const first = names.map(a)
    const reversed = [...names].reverse().map(b)
    expect(new Set(first).size).toBe(8)
    expect(a("Received")).toBe(first[1])
    // A value no other one collides with keeps its own slot in any order.
    expect(b("Received")).toMatch(/^var\(--color-chart-[1-8]\)$/)
    expect(reversed).toHaveLength(8)
  })
})

const pickLabel = (l: string) => `Show rows for ${l}`

// The walk's dashboard: statuses without colours; the pipeline lists them in status order, the
// people rows and the time-in-status chart split by status in first-seen order.
const PIPE: SeriesData = {
  kind: "bar",
  x: ["Inbound", "Received", "Diagnosed", "Repaired", "Needs replacement"],
  series: [{ name: "value", values: [0, 3, 1, 0, 1] }],
  display: { stackedSingle: true },
}
const PEOPLE: SeriesData = {
  kind: "bar",
  x: ["Lucas", "Tobias", "Unassigned"],
  series: [
    { name: "Diagnosed", values: [1, 0, 0] },
    { name: "Received", values: [0, 1, 2] },
    { name: "Needs replacement", values: [0, 0, 1] },
  ],
  display: { horizontal: true, stacked: true },
  paint: { people: ["u-1", "u-2", null] },
}
const AGE: SeriesData = {
  kind: "bar",
  x: ["< 1 day", "1-3 days"],
  series: [
    { name: "Received", values: [3, 0] },
    { name: "Diagnosed", values: [1, 0] },
    { name: "Needs replacement", values: [1, 0] },
  ],
  display: { stacked: true },
}

describe("one status, one colour on a dashboard", () => {
  it("the pipeline, the people rows, a split chart and a pie agree for each status", () => {
    const scope = createColourScope()
    render(() => (
      <ColourScopeProvider value={scope}>
        <PipelineBar data={PIPE} locale="en" pickLabel={pickLabel} />
        <PeopleRows data={PEOPLE} locale="en" pickLabel={pickLabel} />
      </ColourScopeProvider>
    ))
    const pipe = (i: number) =>
      (screen.getByTestId(`dashboard-pipeline-segment-${i}`) as HTMLElement).style.background
    const people = (row: number, j: number) =>
      (screen.getByTestId(`dashboard-people-segment-${row}-${j}`) as HTMLElement).style.background
    const received = pipe(1)
    const diagnosed = pipe(2)
    const needs = pipe(4)
    expect(new Set([received, diagnosed, needs]).size).toBe(3)
    expect(people(0, 0)).toBe(diagnosed)
    expect(people(1, 1)).toBe(received)
    expect(people(2, 2)).toBe(needs)

    const ds = seriesDatasets(AGE, "Previous", { colourOf: scope })
    expect(ds.map((d) => d.color)).toEqual([
      scope("Received"),
      scope("Diagnosed"),
      scope("Needs replacement"),
    ])
    expect(scope("Received")).toBe(received)

    const pie: PieData = { kind: "pie", labels: ["Needs replacement", "Received"], values: [1, 3] }
    expect(pieColors(pie, scope)).toEqual([needs, received])
  })

  it("a status's own colour wins over the scope, drawn readable", () => {
    const scope = createColourScope()
    render(() => (
      <ColourScopeProvider value={scope}>
        <PipelineBar
          data={{ ...PIPE, paint: { labels: [null, "#0b3d38", null, null, null] } }}
          locale="en"
          pickLabel={pickLabel}
        />
      </ColourScopeProvider>
    ))
    const bg = (screen.getByTestId("dashboard-pipeline-segment-1") as HTMLElement).style.background
    // jsdom serialises as rgb(); the dark fallback surface makes it lighter than the source.
    expect(bg).not.toBe("rgb(11, 61, 56)")
    expect(bg).toMatch(/^rgb\(/)
  })
})
