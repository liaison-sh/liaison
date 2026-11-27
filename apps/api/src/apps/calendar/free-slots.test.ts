// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type BusyEventLike,
  busyFromEvents,
  busyFromGoogle,
  DEFAULT_WORKING_HOURS,
  eventBlocks,
  findFreeSlots,
  mergeIntervals,
} from "~/apps/calendar/free-slots"

const PARIS = "Europe/Paris"
const at = (iso: string) => Date.parse(iso)

function event(over: Partial<BusyEventLike>): BusyEventLike {
  return {
    eventId: "e1",
    start: { dateTime: "2026-12-01T09:00:00+01:00" },
    end: { dateTime: "2026-12-01T10:00:00+01:00" },
    allDay: false,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    originalStartTime: null,
    attendees: [],
    ...over,
  }
}

const base = {
  // Tuesday 1 and Wednesday 2 December 2026, Paris time.
  windowStart: new Date("2026-12-01T00:00:00+01:00"),
  windowEnd: new Date("2026-12-03T00:00:00+01:00"),
  durationMinutes: 30,
  timeZone: PARIS,
  workingHours: DEFAULT_WORKING_HOURS,
  busy: [],
  notBefore: new Date("2026-01-01T00:00:00Z"),
  stepMinutes: 30,
  maxResults: 10,
  maxPerDay: 3,
}

describe("findFreeSlots", () => {
  it("offers the first working-hours slots of each day, in the zone", () => {
    const slots = findFreeSlots(base)
    expect(slots.map((s) => s.start)).toEqual([
      "2026-12-01T09:00:00+01:00",
      "2026-12-01T09:30:00+01:00",
      "2026-12-01T10:00:00+01:00",
      "2026-12-02T09:00:00+01:00",
      "2026-12-02T09:30:00+01:00",
      "2026-12-02T10:00:00+01:00",
    ])
    expect(slots[0]?.end).toBe("2026-12-01T09:30:00+01:00")
  })

  it("skips busy intervals of every participant and keeps slots inside working hours", () => {
    const slots = findFreeSlots({
      ...base,
      windowEnd: new Date("2026-12-02T00:00:00+01:00"),
      durationMinutes: 60,
      busy: [
        { start: at("2026-12-01T08:00:00Z"), end: at("2026-12-01T10:15:00Z") }, // 09:00-11:15
        { start: at("2026-12-01T11:00:00Z"), end: at("2026-12-01T16:30:00Z") }, // 12:00-17:30
      ],
    })
    // 11:30-12:30 overlaps the second interval; only 17:30-18:00 is left after it (too short).
    expect(slots.map((s) => s.start)).toEqual([])
    const half = findFreeSlots({
      ...base,
      windowEnd: new Date("2026-12-02T00:00:00+01:00"),
      busy: [{ start: at("2026-12-01T08:00:00Z"), end: at("2026-12-01T16:30:00Z") }],
    })
    expect(half.map((s) => s.start)).toEqual(["2026-12-01T17:30:00+01:00"])
  })

  it("leaves out weekends and the past", () => {
    const slots = findFreeSlots({
      ...base,
      // Saturday 5 to Monday 7 December.
      windowStart: new Date("2026-12-05T00:00:00+01:00"),
      windowEnd: new Date("2026-12-08T00:00:00+01:00"),
      notBefore: new Date("2026-12-07T15:10:00+01:00"),
      maxPerDay: 1,
    })
    expect(slots.map((s) => s.start)).toEqual(["2026-12-07T15:30:00+01:00"])
  })

  it("keeps working hours on the wall clock across a daylight saving change", () => {
    const slots = findFreeSlots({
      ...base,
      // Friday 27 March and Monday 30 March 2026: Paris moves to +02:00 on Sunday 29.
      windowStart: new Date("2026-03-27T00:00:00+01:00"),
      windowEnd: new Date("2026-03-31T00:00:00+02:00"),
      maxPerDay: 1,
    })
    expect(slots.map((s) => s.start)).toEqual([
      "2026-03-27T09:00:00+01:00",
      "2026-03-30T09:00:00+02:00",
    ])
  })

  it("answers in another zone's working hours", () => {
    const slots = findFreeSlots({ ...base, timeZone: "America/New_York", maxResults: 1 })
    expect(slots[0]?.start).toBe("2026-12-01T09:00:00-05:00")
  })
})

describe("busyFromEvents", () => {
  const self = new Set(["me@example.com"])

  it("blocks timed events, frees declined ones and events marked free", () => {
    expect(eventBlocks(event({}), self)).toBe(true)
    expect(eventBlocks(event({ transparency: "transparent" }), self)).toBe(false)
    expect(
      eventBlocks(
        event({ attendees: [{ email: "me@example.com", responseStatus: "declined" }] }),
        self,
      ),
    ).toBe(false)
    expect(eventBlocks(event({ eventType: "workingLocation" }), self)).toBe(false)
  })

  it("reads all-day events as free unless marked busy, as whole days in the zone", () => {
    const day = event({ allDay: true, start: { date: "2026-12-01" }, end: { date: "2026-12-02" } })
    expect(eventBlocks(day, self)).toBe(false)
    const busy = busyFromEvents(
      [{ ...day, transparency: "opaque" }],
      base.windowStart,
      base.windowEnd,
      PARIS,
      self,
    )
    expect(busy).toEqual([
      { start: at("2026-12-01T00:00:00+01:00"), end: at("2026-12-02T00:00:00+01:00") },
    ])
  })

  it("expands a series and frees a cancelled occurrence", () => {
    const series = event({
      eventId: "g-master",
      start: { dateTime: "2026-11-30T10:00:00+01:00", timeZone: PARIS },
      end: { dateTime: "2026-11-30T10:30:00+01:00", timeZone: PARIS },
      recurrence: ["RRULE:FREQ=DAILY"],
    })
    const cancelled = event({
      eventId: "x1",
      status: "cancelled",
      recurringEventId: "g-master",
      originalStartTime: { dateTime: "2026-12-01T10:00:00+01:00" },
    })
    const busy = busyFromEvents([series, cancelled], base.windowStart, base.windowEnd, PARIS, self)
    expect(busy).toEqual([
      { start: at("2026-12-02T10:00:00+01:00"), end: at("2026-12-02T10:30:00+01:00") },
    ])
  })
})

describe("busyFromGoogle and mergeIntervals", () => {
  it("reads Google's busy list and its per-calendar errors", () => {
    expect(
      busyFromGoogle({
        busy: [
          { start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" },
          { start: "2026-12-01T09:30:00Z", end: "2026-12-01T11:00:00Z" },
        ],
      }),
    ).toEqual({
      busy: [{ start: at("2026-12-01T09:00:00Z"), end: at("2026-12-01T11:00:00Z") }],
      error: null,
    })
    expect(busyFromGoogle({ errors: [{ reason: "notFound" }] }).error).toBe("notFound")
    expect(busyFromGoogle(undefined).error).toBe("notFound")
  })

  it("merges touching intervals and drops empty ones", () => {
    expect(
      mergeIntervals([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 9, end: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 7 },
    ])
  })
})
