// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { isSpanning, layoutDayColumns, layoutWeekSegments, occurrenceDaySpan } from "./layout"
import type { ExpandedOccurrence } from "./rrule-expand"

function occ(overrides: Partial<ExpandedOccurrence>): ExpandedOccurrence {
  return {
    eventId: "e1",
    calendarId: "cal-1",
    title: "Event",
    start: { dateTime: "2026-07-15T09:00:00" },
    end: { dateTime: "2026-07-15T09:30:00" },
    allDay: false,
    recurrenceComplex: false,
    ...overrides,
  }
}

describe("occurrenceDaySpan", () => {
  it("all-day end.date is exclusive", () => {
    const span = occurrenceDaySpan(
      occ({ allDay: true, start: { date: "2026-07-10" }, end: { date: "2026-07-12" } }),
    )!
    expect(span.first.getDate()).toBe(10)
    expect(span.last.getDate()).toBe(11)
  })

  it("timed event ending exactly at midnight does not bleed into the next day", () => {
    const span = occurrenceDaySpan(
      occ({ start: { dateTime: "2026-07-10T22:00:00" }, end: { dateTime: "2026-07-11T00:00:00" } }),
    )!
    expect(span.last.getDate()).toBe(10)
  })

  it("multi-day timed event spans its days and isSpanning is true", () => {
    const o = occ({
      start: { dateTime: "2026-07-10T22:00:00" },
      end: { dateTime: "2026-07-12T02:00:00" },
    })
    const span = occurrenceDaySpan(o)!
    expect(span.first.getDate()).toBe(10)
    expect(span.last.getDate()).toBe(12)
    expect(isSpanning(o)).toBe(true)
  })
})

describe("layoutWeekSegments", () => {
  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 6, 12 + i)) // Sun 12 – Sat 18 July

  it("clamps a segment crossing the week boundary and marks continuation", () => {
    const segs = layoutWeekSegments(week, [
      occ({ allDay: true, start: { date: "2026-07-10" }, end: { date: "2026-07-21" } }),
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0]!.startCol).toBe(0)
    expect(segs[0]!.endCol).toBe(6)
    expect(segs[0]!.continuesLeft).toBe(true)
    expect(segs[0]!.continuesRight).toBe(true)
  })

  it("overlapping spans get distinct lanes; disjoint spans share lane 0", () => {
    const segs = layoutWeekSegments(week, [
      occ({
        eventId: "a",
        allDay: true,
        start: { date: "2026-07-12" },
        end: { date: "2026-07-15" },
      }),
      occ({
        eventId: "b",
        allDay: true,
        start: { date: "2026-07-14" },
        end: { date: "2026-07-16" },
      }),
      occ({
        eventId: "c",
        allDay: true,
        start: { date: "2026-07-17" },
        end: { date: "2026-07-18" },
      }),
    ])
    const byId = Object.fromEntries(segs.map((s) => [s.occ.eventId, s]))
    expect(byId.a!.lane).not.toBe(byId.b!.lane)
    // c does not overlap a (a ends col 2 = Jul 14; c starts col 5) — shares a's lane
    expect(byId.c!.lane).toBe(byId.a!.lane)
  })
})

describe("layoutDayColumns", () => {
  const day = new Date(2026, 6, 15)

  it("non-overlapping events each get full width", () => {
    const blocks = layoutDayColumns(day, [
      occ({
        eventId: "a",
        start: { dateTime: "2026-07-15T09:00:00" },
        end: { dateTime: "2026-07-15T10:00:00" },
      }),
      occ({
        eventId: "b",
        start: { dateTime: "2026-07-15T11:00:00" },
        end: { dateTime: "2026-07-15T12:00:00" },
      }),
    ])
    expect(blocks.every((b) => b.cols === 1)).toBe(true)
  })

  it("overlapping events split into side-by-side columns", () => {
    const blocks = layoutDayColumns(day, [
      occ({
        eventId: "a",
        start: { dateTime: "2026-07-15T09:00:00" },
        end: { dateTime: "2026-07-15T10:30:00" },
      }),
      occ({
        eventId: "b",
        start: { dateTime: "2026-07-15T10:00:00" },
        end: { dateTime: "2026-07-15T11:00:00" },
      }),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.cols).toBe(2)
    expect(blocks[0]!.col).not.toBe(blocks[1]!.col)
  })

  it("spanning and all-day events are excluded; minutes are clamped and minimum-height", () => {
    const blocks = layoutDayColumns(day, [
      occ({
        eventId: "allday",
        allDay: true,
        start: { date: "2026-07-15" },
        end: { date: "2026-07-16" },
      }),
      occ({
        eventId: "multi",
        start: { dateTime: "2026-07-14T22:00:00" },
        end: { dateTime: "2026-07-15T02:00:00" },
      }),
      occ({
        eventId: "zero",
        start: { dateTime: "2026-07-15T09:00:00" },
        end: { dateTime: "2026-07-15T09:00:00" },
      }),
    ])
    const ids = blocks.map((b) => b.occ.eventId)
    expect(ids).not.toContain("allday")
    expect(ids).not.toContain("multi")
    const zero = blocks.find((b) => b.occ.eventId === "zero")!
    expect(zero.endMin - zero.startMin).toBeGreaterThanOrEqual(20)
  })
})
