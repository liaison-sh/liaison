// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  fitRailEntries,
  RAIL_GAP_PX,
  RAIL_SLOT_PX,
  railCapacity,
  railColumnCount,
  railGridCell,
} from "./activity-bar-fit"

const ids = ["a", "b", "c", "d", "e", "f", "g"]

describe("railCapacity", () => {
  it("draws everything while the column is unmeasured", () => {
    expect(railCapacity(null, RAIL_SLOT_PX.desktop, RAIL_GAP_PX)).toBe(Number.POSITIVE_INFINITY)
    expect(railCapacity(0, RAIL_SLOT_PX.desktop, RAIL_GAP_PX)).toBe(Number.POSITIVE_INFINITY)
  })

  it("counts slots with the gap between them, not after the last one", () => {
    // 5 slots of 34px with 4 gaps of 4px = 186px.
    expect(railCapacity(186, 34, 4)).toBe(5)
    expect(railCapacity(185, 34, 4)).toBe(4)
    expect(railCapacity(20, 34, 4)).toBe(0)
  })

  it("the tablet's touch slots fit fewer in the same height", () => {
    expect(railCapacity(400, RAIL_SLOT_PX.tablet, RAIL_GAP_PX)).toBeLessThan(
      railCapacity(400, RAIL_SLOT_PX.desktop, RAIL_GAP_PX),
    )
  })
})

describe("fitRailEntries", () => {
  it("keeps every entry and no overflow when they all fit", () => {
    expect(fitRailEntries(ids, 7, null)).toEqual({ visible: ids, overflow: [] })
    expect(fitRailEntries(ids, Number.POSITIVE_INFINITY, "g")).toEqual({
      visible: ids,
      overflow: [],
    })
  })

  it("gives the last slot to the +N control when they do not", () => {
    expect(fitRailEntries(ids, 4, null)).toEqual({
      visible: ["a", "b", "c"],
      overflow: ["d", "e", "f", "g"],
    })
  })

  it("keeps the active entry on the rail, in the last drawn slot", () => {
    expect(fitRailEntries(ids, 4, "f")).toEqual({
      visible: ["a", "b", "f"],
      overflow: ["c", "d", "e", "g"],
    })
  })

  it("leaves a visible active entry where it is", () => {
    expect(fitRailEntries(ids, 4, "b").visible).toEqual(["a", "b", "c"])
  })

  it("with room for the control alone, every entry is behind it", () => {
    expect(fitRailEntries(ids, 1, "c")).toEqual({ visible: [], overflow: ids })
    expect(fitRailEntries(ids, 0, null)).toEqual({ visible: [], overflow: ids })
  })

  it("ignores an active id that is not a rail entry", () => {
    expect(fitRailEntries(ids, 3, "settings").visible).toEqual(["a", "b"])
  })
})

describe("railColumnCount", () => {
  it("fills column one, then column two", () => {
    expect(railColumnCount(8, 5)).toBe(2)
    expect(railColumnCount(10, 5)).toBe(2)
    expect(railColumnCount(11, 5)).toBe(3)
    expect(railColumnCount(4, 5)).toBe(1)
  })

  it("is one column while unmeasured or empty, never zero or infinite", () => {
    expect(railColumnCount(8, Number.POSITIVE_INFINITY)).toBe(1)
    expect(railColumnCount(0, 5)).toBe(1)
    expect(railColumnCount(3, 0)).toBe(3)
  })
})

describe("railGridCell", () => {
  it("keeps column one top to bottom and fills the folded columns from the bottom up", () => {
    const cells = Array.from({ length: 12 }, (_, i) => railGridCell(i, 5))
    expect(cells.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map((row) => ({ row, column: 1 })))
    expect(cells.slice(5, 10)).toEqual([5, 4, 3, 2, 1].map((row) => ({ row, column: 2 })))
    // A short last column sits at the bottom, beside where "+N" was.
    expect(cells.slice(10)).toEqual([
      { row: 5, column: 3 },
      { row: 4, column: 3 },
    ])
  })
})
