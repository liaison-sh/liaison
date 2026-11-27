// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  addDays,
  formFromEvent,
  nextHalfHour,
  timesPayload,
  validateForm,
  withAllDay,
} from "./event-form"

describe("event form", () => {
  it("rounds a new event's start up to the next half hour", () => {
    expect(nextHalfHour(new Date(2026, 10, 27, 14, 57, 12)).getMinutes()).toBe(0)
    expect(nextHalfHour(new Date(2026, 10, 27, 14, 57, 12)).getHours()).toBe(15)
    expect(nextHalfHour(new Date(2026, 10, 27, 14, 5)).getMinutes()).toBe(30)
    expect(nextHalfHour(new Date(2026, 10, 27, 14, 30)).getMinutes()).toBe(30)
  })

  it("adds calendar days without a time zone (month and year ends)", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })

  it("all-day on and off keeps the day; an all-day save sends dates with an exclusive end", () => {
    const timed = formFromEvent(null, { start: new Date(2026, 11, 3, 22, 30) }, [])
    const on = withAllDay(timed, true)
    expect([on.startDate, on.endDate]).toEqual(["2026-12-03", "2026-12-03"])
    expect(timesPayload(on)).toEqual({ start: "2026-12-03", end: "2026-12-04", allDay: true })
    const off = withAllDay(on, false)
    expect(off.startLocal.slice(0, 10)).toBe("2026-12-03")
    expect(validateForm({ ...off, title: "x" })).toBeNull()
  })

  it("an end equal to the start is refused for a timed event", () => {
    const f = formFromEvent(
      null,
      { start: new Date(2026, 0, 1, 9), end: new Date(2026, 0, 1, 9) },
      [],
    )
    expect(validateForm({ ...f, title: "x" })).toBe("calendar.endBeforeStart")
  })
})
