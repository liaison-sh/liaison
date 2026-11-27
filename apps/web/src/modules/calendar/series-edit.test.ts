// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import type { CalendarEventDto } from "./calendar-api"
import { eventTabEntityId, parseEventTabEntityId } from "./event-tabs"
import { buildRepeat, parseRepeat } from "./recurrence-rule"
import { expandEvents } from "./rrule-expand"
import { occurrenceView, scopeTarget, seriesContextOf, seriesTimes } from "./series-edit"

const weekly: CalendarEventDto = {
  eventId: "m1",
  googleEventId: "g-m1",
  calendarId: "c1",
  title: "Standup",
  start: { dateTime: "2026-10-06T09:00:00.000Z", timeZone: "UTC" },
  end: { dateTime: "2026-10-06T09:30:00.000Z", timeZone: "UTC" },
  allDay: false,
  recurrence: ["RRULE:FREQ=WEEKLY"],
  recurringEventId: null,
  originalStartTime: null,
  status: "confirmed",
}
const at = { dateTime: "2026-10-20T09:00:00.000Z" }

describe("series editing", () => {
  it("names one occurrence of a series in the tab id, and reads it back", () => {
    const id = eventTabEntityId(weekly, at)
    expect(id).toBe("m1~20261020T090000Z")
    expect(parseEventTabEntityId(id)).toEqual({
      eventId: "m1",
      occurrence: { dateTime: "2026-10-20T09:00:00.000Z" },
    })
    expect(
      parseEventTabEntityId(eventTabEntityId({ ...weekly, allDay: true }, { date: "2026-10-20" })),
    ).toEqual({ eventId: "m1", occurrence: { date: "2026-10-20" } })
    // A one-off event keeps its own id.
    expect(eventTabEntityId({ ...weekly, recurrence: null }, at)).toBe("m1")
  })

  it("shows the series at the occurrence, with its length", () => {
    const shown = occurrenceView(weekly, at)
    expect(shown.start?.dateTime).toBe("2026-10-20T09:00:00.000Z")
    expect(shown.end?.dateTime).toBe("2026-10-20T09:30:00.000Z")
    const allDay = {
      ...weekly,
      allDay: true,
      start: { date: "2026-10-06" },
      end: { date: "2026-10-08" },
    }
    expect(occurrenceView(allDay, { date: "2026-10-20" })).toMatchObject({
      start: { date: "2026-10-20" },
      end: { date: "2026-10-22" },
    })
  })

  it("moves the whole series by what the occurrence moved, or not at all", () => {
    const same = {
      start: "2026-10-20T09:00:00.000Z",
      end: "2026-10-20T09:30:00.000Z",
      allDay: false,
    }
    expect(seriesTimes(weekly, at, same)).toEqual({})
    const later = {
      start: "2026-10-20T10:00:00.000Z",
      end: "2026-10-20T11:00:00.000Z",
      allDay: false,
    }
    expect(seriesTimes(weekly, at, later)).toEqual({
      start: "2026-10-06T10:00:00.000Z",
      end: "2026-10-06T11:00:00.000Z",
      allDay: false,
    })
  })

  it("targets the series, an occurrence by its original start, or an edited occurrence by id", () => {
    const ctx = seriesContextOf(weekly, at)
    expect(ctx).toEqual({ kind: "master", occurrence: at })
    expect(scopeTarget(weekly, ctx!, "following")).toEqual({
      eventId: "m1",
      scope: "following",
      occurrenceStart: "2026-10-20T09:00:00.000Z",
    })
    expect(scopeTarget(weekly, ctx!, "series")).toEqual({ eventId: "m1", scope: "series" })
    const exception = { ...weekly, eventId: "x1", recurrence: null, recurringEventId: "g-m1" }
    expect(seriesContextOf(exception, null)).toEqual({ kind: "exception" })
    expect(scopeTarget(exception, { kind: "exception" }, "following")).toEqual({
      eventId: "x1",
      scope: "following",
    })
    expect(seriesContextOf({ ...weekly, recurrence: null }, at)).toBeNull()
  })
})

describe("repeat rule editor", () => {
  it("round-trips interval, weekdays and both endings", () => {
    for (const line of [
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
      "RRULE:FREQ=DAILY;COUNT=5",
      "RRULE:FREQ=MONTHLY",
      "RRULE:FREQ=YEARLY;INTERVAL=3",
    ]) {
      expect(buildRepeat(parseRepeat([line])!, false)).toEqual([line])
    }
    const until = parseRepeat(["RRULE:FREQ=WEEKLY;UNTIL=20261231T235959Z"])
    expect(until?.end).toEqual({ kind: "until", date: "2026-12-31" })
    expect(buildRepeat(until!, true)).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261231"])
  })

  it("leaves a rule it cannot show alone", () => {
    expect(parseRepeat(["RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR"])).toBeNull()
    expect(parseRepeat(["RRULE:FREQ=MONTHLY;BYDAY=2TU"])).toBeNull()
    expect(parseRepeat(null)?.freq).toBe("none")
  })
})

describe("declined look", () => {
  it("marks occurrences the account declined", () => {
    const declined = {
      ...weekly,
      attendees: [{ email: "me@x.example", self: true, responseStatus: "declined" }],
    }
    const occ = expandEvents([declined], new Date("2026-10-05"), new Date("2026-10-15"))
    expect(occ.length).toBeGreaterThan(0)
    expect(occ.every((o) => o.declined === true)).toBe(true)
    expect(
      expandEvents([weekly], new Date("2026-10-05"), new Date("2026-10-15"))[0]?.declined,
    ).toBeUndefined()
  })
})
