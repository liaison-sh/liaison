// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Colour and people from the data: map.colorField colours each series (or each category),
// map.personField names each category's person, map.keepOrder keeps the source's order, and
// map.stackedSingle draws one bar of categories; plus the spec's checks for them.

import { describe, expect, it } from "bun:test"
import { mapProblems } from "~/modules/dashboards/spec"
import { colorOf, transformBlock } from "~/modules/dashboards/transform"

const chart = (data: ReturnType<typeof transformBlock>) => {
  if (!("labels" in data)) throw new Error("not a chart")
  return data
}

// A status aggregate as a source returns it: in status order, each row with its status colour.
const STATUS_ROWS = [
  { groupLabel: "Inbound", value: 3, color: "#6b7280" },
  { groupLabel: "Received", value: 5, color: "#3b82f6" },
  { groupLabel: "Diagnosed", value: 1, color: null },
]

describe("colorField", () => {
  it("colours each category from its rows, in the order kept", () => {
    const out = chart(
      transformBlock(
        "bar",
        { x: "groupLabel", y: "value", colorField: "color", keepOrder: true },
        STATUS_ROWS,
      ),
    )
    expect(out.labels).toEqual(["Inbound", "Received", "Diagnosed"])
    expect(out.paint?.labels).toEqual(["#6b7280", "#3b82f6", null])
  })

  it("without keepOrder a bar sorts by value, and the colours follow their category", () => {
    const out = chart(
      transformBlock("bar", { x: "groupLabel", y: "value", colorField: "color" }, STATUS_ROWS),
    )
    expect(out.labels).toEqual(["Received", "Inbound", "Diagnosed"])
    expect(out.paint?.labels).toEqual(["#3b82f6", "#6b7280", null])
  })

  it("with a series split, colours each series", () => {
    const rows = [
      { who: "Ana", stage: "Received", n: 2, c: "#3b82f6" },
      { who: "Ana", stage: "Diagnosed", n: 1, c: "#8b5cf6" },
      { who: "Ben", stage: "Received", n: 1, c: "#3b82f6" },
    ]
    const out = chart(
      transformBlock(
        "bar",
        { x: "who", y: "n", series: "stage", colorField: "c", stacked: true },
        rows,
      ),
    )
    expect(out.series.map((s) => s.name)).toEqual(["Received", "Diagnosed"])
    expect(out.paint?.series).toEqual(["#3b82f6", "#8b5cf6"])
    expect(out.paint?.labels).toBeUndefined()
  })

  it("takes hex colours only: any other CSS is no colour", () => {
    expect(colorOf("#abc")).toBe("#abc")
    expect(colorOf("#22c55e")).toBe("#22c55e")
    expect(colorOf("red")).toBeNull()
    expect(colorOf("url(x)")).toBeNull()
    expect(colorOf("#22c55e;background:red")).toBeNull()
    const out = chart(
      transformBlock("pie", { label: "k", value: "n", colorField: "c" }, [
        { k: "a", n: 1, c: "expression(alert(1))" },
      ]),
    )
    expect(out.paint).toBeUndefined()
  })

  it("a pie colours its slices", () => {
    const out = chart(
      transformBlock("pie", { label: "groupLabel", value: "value", colorField: "color" }, [
        STATUS_ROWS[0]!,
      ]),
    )
    expect(out.paint?.labels).toEqual(["#6b7280"])
  })
})

describe("personField", () => {
  it("names each category's person", () => {
    const rows = [
      { groupLabel: "Ana", userId: "u-1", value: 2 },
      { groupLabel: "Unassigned", userId: null, value: 1 },
    ]
    const out = chart(
      transformBlock(
        "bar",
        { x: "groupLabel", y: "value", personField: "userId", horizontal: true },
        rows,
      ),
    )
    expect(out.paint?.people).toEqual(["u-1", null])
  })
})

describe("stackedSingle", () => {
  it("is echoed in display", () => {
    const out = chart(
      transformBlock(
        "bar",
        { x: "groupLabel", y: "value", stackedSingle: true, keepOrder: true },
        STATUS_ROWS,
      ),
    )
    expect(out.display?.stackedSingle).toBe(true)
  })
})

describe("the spec", () => {
  it("refuses the keys where they mean nothing", () => {
    expect(mapProblems("line", { x: "d", y: "n", stackedSingle: true })).toContain(
      "map.stackedSingle is for a bar chart",
    )
    expect(
      mapProblems("bar", { x: "d", y: "n", series: "s", stackedSingle: true }).join(" "),
    ).toContain("map.stackedSingle draws one bar")
    expect(mapProblems("metric", { value: "n", colorField: "c" })).toContain(
      "map.colorField is for a bar, line, area, combo or pie chart",
    )
    expect(mapProblems("line", { x: "d", y: "n", personField: "u" })).toContain(
      "map.personField is for a bar or pie chart",
    )
    expect(
      mapProblems("bar", { x: "d", y: "n", keepOrder: true, sort: { field: "n", dir: "asc" } }),
    ).toContain("map.keepOrder keeps the source's order: no map.sort beside it")
    expect(
      mapProblems("bar", {
        x: "groupLabel",
        y: "value",
        colorField: "color",
        personField: "userId",
        keepOrder: true,
        stackedSingle: true,
      }),
    ).toEqual([])
  })
})
