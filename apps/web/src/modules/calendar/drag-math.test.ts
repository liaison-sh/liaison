// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { createRange, deltaMinutes, minutesAt, moveRange, resizeEnd } from "./drag-math"

const HOUR = 48

describe("drag math", () => {
  it("snaps a pointer to the quarter hour under it, inside the day", () => {
    expect(minutesAt(14 * HOUR + 5, HOUR)).toBe(14 * 60)
    expect(minutesAt(14 * HOUR + 13, HOUR)).toBe(14 * 60 + 15)
    expect(minutesAt(-20, HOUR)).toBe(0)
    expect(minutesAt(25 * HOUR, HOUR)).toBe(24 * 60)
  })

  it("rounds a drag distance to the nearest quarter hour", () => {
    expect(deltaMinutes(HOUR, HOUR)).toBe(60)
    expect(deltaMinutes(7, HOUR)).toBe(15)
    expect(deltaMinutes(5, HOUR)).toBe(0)
    expect(deltaMinutes(-HOUR / 2, HOUR)).toBe(-30)
  })

  it("a drag-create covers both ends whichever way it went", () => {
    const day = new Date(2026, 10, 27)
    const down = createRange(day, 14 * 60, 15 * 60 + 45)
    expect([down.start.getHours(), down.end.getHours(), down.end.getMinutes()]).toEqual([14, 16, 0])
    const up = createRange(day, 15 * 60 + 45, 14 * 60)
    expect(up.start.getTime()).toBe(down.start.getTime())
    expect(up.end.getTime()).toBe(down.end.getTime())
  })

  it("a move keeps the duration across days; a resize never goes under 15 minutes", () => {
    const start = new Date(2026, 10, 27, 9, 0)
    const end = new Date(2026, 10, 27, 10, 30)
    const moved = moveRange(start, end, 45, 2)
    expect(moved.start).toEqual(new Date(2026, 10, 29, 9, 45))
    expect(moved.end).toEqual(new Date(2026, 10, 29, 11, 15))
    expect(resizeEnd(start, end, 30)).toEqual(new Date(2026, 10, 27, 11, 0))
    expect(resizeEnd(start, end, -600)).toEqual(new Date(2026, 10, 27, 9, 15))
  })
})
