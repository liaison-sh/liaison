// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { occurrenceColor } from "./event-colors"
import { isSpanning } from "./layout"
import type { ExpandedOccurrence } from "./rrule-expand"
import { shortcutFor } from "./shortcuts"
import { hourLabelIn, isKnownZone } from "./time-zones"
import { msUntilNextDay } from "./today"

const occ = (start: string, end: string, allDay = false): ExpandedOccurrence => ({
  eventId: "e",
  calendarId: "c",
  title: null,
  start: allDay ? { date: start } : { dateTime: start },
  end: allDay ? { date: end } : { dateTime: end },
  allDay,
  recurrenceComplex: false,
})

describe("isSpanning", () => {
  it("keeps a short overnight event in the grid and puts a day-long one in the band", () => {
    expect(isSpanning(occ("2026-07-15T22:00:00", "2026-07-16T02:00:00"))).toBe(false)
    expect(isSpanning(occ("2026-07-15T09:00:00", "2026-07-16T10:00:00"))).toBe(true)
    expect(isSpanning(occ("2026-07-15", "2026-07-16", true))).toBe(true)
  })
})

describe("shortcuts", () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
    shortcutFor({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      ...extra,
    })
  it("maps Google's letters and ignores modifiers and fields", () => {
    expect(key("t")).toBe("today")
    expect(key("j")).toBe("next")
    expect(key("k")).toBe("previous")
    expect(key("w")).toBe("week")
    expect(key("?")).toBe("help")
    expect(key("c", { metaKey: true })).toBeNull()
    const input = document.createElement("input")
    document.body.append(input)
    expect(key("t", { target: input })).toBeNull()
    input.remove()
  })
})

describe("time zones and colours", () => {
  it("labels an hour in another zone, with minutes when the offset has them", () => {
    expect(isKnownZone("Asia/Kolkata")).toBe(true)
    expect(isKnownZone("Mars/Base")).toBe(false)
    const label = hourLabelIn(new Date(2026, 6, 15), 9, "Asia/Kolkata", "en")
    expect(label).toMatch(/:30/)
  })
  it("prefers the event's own colour over its calendar's", () => {
    expect(occurrenceColor({ calendarId: "c", colorId: "2" }, { c: "#000000" })).toBe("#33b679")
    expect(occurrenceColor({ calendarId: "c" }, { c: "#000000" })).toBe("#000000")
  })
  it("waits until just after the next local midnight", () => {
    const ms = msUntilNextDay(new Date(2026, 6, 15, 23, 0, 0))
    expect(ms).toBeGreaterThan(3_600_000)
    expect(ms).toBeLessThan(3_601_000)
  })
})
