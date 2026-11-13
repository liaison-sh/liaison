// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  addWorkingTime,
  DEFAULT_WORKING_CALENDAR,
  resolveWorkingCalendar,
  type WorkingCalendar,
} from "./working-time"

const PARIS: WorkingCalendar = { ...DEFAULT_WORKING_CALENDAR, timezone: "Europe/Paris" }
/** A Paris wall time as an instant (Europe/Paris offset written out). */
const at = (iso: string) => new Date(iso)

describe("working time", () => {
  test("Friday 17:00 + 1 working day = Monday 17:00 (Paris)", () => {
    const d = addWorkingTime(at("2026-11-13T17:00:00+01:00"), 1, "working_days", PARIS)
    expect(d.toISOString()).toBe(at("2026-11-16T17:00:00+01:00").toISOString())
  })

  test("a deadline on the closing time moves to the next opening", () => {
    const d = addWorkingTime(at("2026-11-13T09:00:00+01:00"), 1, "working_days", PARIS)
    expect(d.toISOString()).toBe(at("2026-11-16T09:00:00+01:00").toISOString())
  })

  test("working hours skip nights and weekends; a start outside the window counts from the opening", () => {
    expect(
      addWorkingTime(at("2026-11-13T17:30:00+01:00"), 2, "working_hours", PARIS).toISOString(),
    ).toBe(at("2026-11-16T10:30:00+01:00").toISOString())
    expect(
      addWorkingTime(at("2026-11-14T11:00:00+01:00"), 3, "working_hours", PARIS).toISOString(),
    ).toBe(at("2026-11-16T12:00:00+01:00").toISOString())
    expect(
      addWorkingTime(at("2026-11-12T07:00:00+01:00"), 1, "working_hours", PARIS).toISOString(),
    ).toBe(at("2026-11-12T10:00:00+01:00").toISOString())
  })

  test("DST: a working day across the October change keeps its wall time", () => {
    // Paris leaves summer time on Sunday 2026-10-25 (+02:00 -> +01:00).
    const d = addWorkingTime(at("2026-10-23T15:00:00+02:00"), 1, "working_days", PARIS)
    expect(d.toISOString()).toBe(at("2026-10-26T15:00:00+01:00").toISOString())
    const days = addWorkingTime(at("2026-10-24T15:00:00+02:00"), 1, "days", PARIS)
    expect(days.toISOString()).toBe(at("2026-10-25T15:00:00+01:00").toISOString())
    const hours = addWorkingTime(at("2026-10-24T15:00:00+02:00"), 24, "hours", PARIS)
    expect(hours.toISOString()).toBe(at("2026-10-25T14:00:00+01:00").toISOString())
  })

  test("a custom calendar: Tuesday to Saturday, 08:00-12:00, New York", () => {
    const cal = resolveWorkingCalendar(
      {
        timezone: "Europe/Paris",
        businessHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
      },
      { timezone: "America/New_York", days: [2, 3, 4, 5, 6], start: "08:00", end: "12:00" },
    )
    expect(cal).toEqual({
      timezone: "America/New_York",
      days: [2, 3, 4, 5, 6],
      start: "08:00",
      end: "12:00",
    })
    // Saturday 11:00 + 2 working hours: 1 h on Saturday, then Tuesday 08:00 + 1 h.
    const d = addWorkingTime(at("2026-11-14T11:00:00-05:00"), 2, "working_hours", cal)
    expect(d.toISOString()).toBe(at("2026-11-17T09:00:00-05:00").toISOString())
    // 2 working days from Friday 10:00 = Tuesday 10:00 (Saturday, then Tuesday).
    const w = addWorkingTime(at("2026-11-13T10:00:00-05:00"), 2, "working_days", cal)
    expect(w.toISOString()).toBe(at("2026-11-17T10:00:00-05:00").toISOString())
  })

  test("the org calendar is the base; malformed values fall back", () => {
    expect(resolveWorkingCalendar({ timezone: "Europe/Paris", businessHours: null })).toEqual(PARIS)
    expect(
      resolveWorkingCalendar({
        timezone: "Mars/Base",
        businessHours: { start: "19:00", end: "08:00", days: [] },
      }),
    ).toEqual(DEFAULT_WORKING_CALENDAR)
  })
})
