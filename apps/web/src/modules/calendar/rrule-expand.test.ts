// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { type CalendarEventLike, expandEvents } from "./rrule-expand"

function evt(overrides: Partial<CalendarEventLike>): CalendarEventLike {
  return {
    eventId: "e1",
    calendarId: "cal-1",
    title: "Event",
    start: { dateTime: "2026-07-01T09:00:00.000Z" },
    end: { dateTime: "2026-07-01T09:30:00.000Z" },
    allDay: false,
    recurrence: null,
    recurringEventId: null,
    originalStartTime: null,
    status: "confirmed",
    ...overrides,
  }
}

describe("expandEvents", () => {
  it("passes through a non-recurring event within the window unchanged", () => {
    const events = [evt({ eventId: "plain-1", title: "Plain" })]
    const result = expandEvents(
      events,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-02T00:00:00Z"),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe("Plain")
  })

  it("expands a weekly BYDAY-free RRULE across a month boundary with COUNT termination", () => {
    const master = evt({
      eventId: "master-1",
      title: "Weekly Sync",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"],
      start: { dateTime: "2026-07-20T10:00:00.000Z" },
      end: { dateTime: "2026-07-20T10:30:00.000Z" },
    })
    // Occurrences: 07-20, 07-27, 08-03, 08-10, 08-17, 08-24 (6 total, crosses month boundary).
    const result = expandEvents(
      [master],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-09-01T00:00:00Z"),
    )
    expect(result).toHaveLength(6)
    const lastStart = (result[result.length - 1]!.start as { dateTime: string }).dateTime
    expect(lastStart).toBe("2026-08-24T10:00:00.000Z")
  })

  it("exception replaces the occurrence at its originalStartTime; cancelled exception drops the occurrence entirely", () => {
    const master = evt({
      eventId: "master-2",
      title: "Daily Check-in",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
      start: { dateTime: "2026-07-01T08:00:00.000Z" },
      end: { dateTime: "2026-07-01T08:15:00.000Z" },
    })
    const movedException = evt({
      eventId: "exc-moved",
      title: "Check-in (moved)",
      recurringEventId: "master-2",
      originalStartTime: { dateTime: "2026-07-02T08:00:00.000Z" },
      start: { dateTime: "2026-07-02T14:00:00.000Z" },
      end: { dateTime: "2026-07-02T14:15:00.000Z" },
    })
    const cancelledException = evt({
      eventId: "exc-cancelled",
      recurringEventId: "master-2",
      originalStartTime: { dateTime: "2026-07-03T08:00:00.000Z" },
      status: "cancelled",
    })
    const result = expandEvents(
      [master, movedException, cancelledException],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-06T00:00:00Z"),
    )
    // 5 occurrences total, minus 1 cancelled = 4.
    expect(result).toHaveLength(4)
    const moved = result.find((r) => r.eventId === "exc-moved")
    expect(moved).toBeDefined()
    expect((moved!.start as { dateTime: string }).dateTime).toBe("2026-07-02T14:00:00.000Z")
    expect(result.find((r) => r.eventId === "exc-cancelled")).toBeUndefined()
    expect(
      result.find((r) => (r.start as { dateTime: string }).dateTime === "2026-07-03T08:00:00.000Z"),
    ).toBeUndefined()
  })

  it("an all-day event spanning multiple days is included when the window overlaps any of its days", () => {
    const allDay = evt({
      eventId: "allday-1",
      title: "Conference",
      allDay: true,
      start: { date: "2026-07-10" },
      end: { date: "2026-07-13" }, // Google end date is exclusive
    })
    const result = expandEvents(
      [allDay],
      new Date("2026-07-12T00:00:00Z"),
      new Date("2026-07-14T00:00:00Z"),
    )
    expect(result).toHaveLength(1)
  })

  it("a complex RRULE (several monthly weekdays) falls back to rendering only the master's own occurrence, flagged complex", () => {
    const complexMaster = evt({
      eventId: "complex-1",
      title: "Monday and Wednesday review",
      recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=MO,WE"],
      start: { dateTime: "2026-07-06T09:00:00.000Z" },
      end: { dateTime: "2026-07-06T09:15:00.000Z" },
    })
    const result = expandEvents(
      [complexMaster],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-31T00:00:00Z"),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.recurrenceComplex).toBe(true)
  })

  it("expands a weekly series on several weekdays", () => {
    const standup = evt({
      eventId: "mwf-1",
      title: "MWF Standup",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"],
      start: { dateTime: "2026-07-06T09:00:00.000Z" },
      end: { dateTime: "2026-07-06T09:15:00.000Z" },
    })
    const result = expandEvents(
      [standup],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-31T00:00:00Z"),
    )
    // Mon/Wed/Fri from 07-06 to 07-29.
    expect(result).toHaveLength(11)
    expect(result.every((r) => !r.recurrenceComplex)).toBe(true)
  })
})

// LIF-31: the week view showed ended series every week and cancelled or moved occurrences at
// their original slot (411 occurrences in one week instead of 14 on a real account).
describe("expandEvents on Google-shaped series", () => {
  const week = [new Date("2026-10-12T00:00:00Z"), new Date("2026-10-19T00:00:00Z")] as const

  it("stops a series at each RFC 5545 UNTIL form", () => {
    const series = [
      evt({
        eventId: "until-utc",
        recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20210602T215959Z"],
        start: { dateTime: "2021-01-04T09:00:00+01:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2021-01-04T10:00:00+01:00", timeZone: "Europe/Paris" },
      }),
      evt({
        eventId: "until-floating",
        recurrence: ["RRULE:FREQ=DAILY;UNTIL=20210602T235959"],
        start: { dateTime: "2021-01-04T09:00:00+01:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2021-01-04T10:00:00+01:00", timeZone: "Europe/Paris" },
      }),
      evt({
        eventId: "until-date",
        allDay: true,
        recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20210602"],
        start: { date: "2021-01-06" },
        end: { date: "2021-01-07" },
      }),
    ]
    expect(expandEvents(series, ...week)).toEqual([])
    const lastWeeks = expandEvents(
      series,
      new Date("2021-05-31T00:00:00Z"),
      new Date("2021-06-07T00:00:00Z"),
    )
    // Weekly Monday 05-31, daily 05-31..06-02, the all-day Wednesday 06-02.
    expect(lastWeeks.filter((o) => o.eventId === "until-utc")).toHaveLength(1)
    expect(lastWeeks.filter((o) => o.eventId === "until-floating")).toHaveLength(3)
    expect(lastWeeks.filter((o) => o.eventId === "until-date")).toHaveLength(1)
  })

  it("applies exceptions keyed on the master's Google id: cancelled vanish, moved show at their new time only", () => {
    const master = evt({
      eventId: "0b6f1c1e-5d1a-4f5e-9a8e-2f1d3c4b5a69",
      googleEventId: "abc123def456",
      title: "Weekly review",
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-10-05T10:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-05T10:30:00+02:00", timeZone: "Europe/Paris" },
    })
    const cancelled = evt({
      eventId: "exc-cancelled",
      recurringEventId: "abc123def456",
      originalStartTime: { dateTime: "2026-10-13T10:00:00+02:00", timeZone: "Europe/Paris" },
      status: "cancelled",
      start: null,
      end: null,
    })
    const movedLater = evt({
      eventId: "exc-moved",
      recurringEventId: "abc123def456",
      title: "Weekly review (moved)",
      originalStartTime: { dateTime: "2026-10-14T10:00:00+02:00", timeZone: "Europe/Paris" },
      start: { dateTime: "2026-10-14T16:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-14T16:30:00+02:00", timeZone: "Europe/Paris" },
    })
    // Moved out of the week: neither the old nor the new slot shows.
    const movedOut = evt({
      eventId: "exc-moved-out",
      recurringEventId: "abc123def456",
      originalStartTime: { dateTime: "2026-10-15T10:00:00+02:00", timeZone: "Europe/Paris" },
      start: { dateTime: "2026-10-22T10:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-22T10:30:00+02:00", timeZone: "Europe/Paris" },
    })
    // Moved into the week from the week before.
    const movedIn = evt({
      eventId: "exc-moved-in",
      recurringEventId: "abc123def456",
      originalStartTime: { dateTime: "2026-10-09T10:00:00+02:00", timeZone: "Europe/Paris" },
      start: { dateTime: "2026-10-17T12:00:00+02:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-17T12:30:00+02:00", timeZone: "Europe/Paris" },
    })
    const result = expandEvents([master, cancelled, movedLater, movedOut, movedIn], ...week)
    const at = (o: (typeof result)[number]) => new Date(o.start.dateTime as string).toISOString()
    expect(result.map(at).sort()).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-14T14:00:00.000Z",
      "2026-10-16T08:00:00.000Z",
      "2026-10-17T08:00:00.000Z",
      "2026-10-17T10:00:00.000Z",
      "2026-10-18T08:00:00.000Z",
    ])
    expect(result.find((o) => o.eventId === "exc-moved")).toBeDefined()
    expect(result.find((o) => o.eventId === "exc-moved-in")).toBeDefined()
  })

  it("matches a summer exception of a series that started in winter (wall-clock time across DST)", () => {
    const master = evt({
      eventId: "row-uuid-dst",
      googleEventId: "dstseries",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { dateTime: "2026-01-05T09:00:00+01:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-01-05T10:00:00+01:00", timeZone: "Europe/Paris" },
    })
    const cancelled = evt({
      eventId: "dst-cancelled",
      recurringEventId: "dstseries",
      originalStartTime: { dateTime: "2026-07-06T09:00:00+02:00", timeZone: "Europe/Paris" },
      status: "cancelled",
    })
    const july = expandEvents(
      [master, cancelled],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-15T00:00:00Z"),
    )
    expect(july.map((o) => new Date(o.start.dateTime as string).toISOString())).toEqual([
      "2026-07-13T07:00:00.000Z",
    ])
  })

  it("renders a DAILY series begun more than five years before the window", () => {
    const master = evt({
      eventId: "old-daily",
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2019-01-07T07:30:00Z" },
      end: { dateTime: "2019-01-07T07:45:00Z" },
    })
    expect(expandEvents([master], ...week)).toHaveLength(7)
  })

  it("gives all-day occurrences a date, not a UTC midnight dateTime", () => {
    const master = evt({
      eventId: "allday-weekly",
      allDay: true,
      recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { date: "2026-10-05" },
      end: { date: "2026-10-06" },
    })
    const [occ] = expandEvents([master], ...week)
    expect(occ?.start).toEqual({ date: "2026-10-12" })
    expect(occ?.end).toEqual({ date: "2026-10-13" })
  })
})
