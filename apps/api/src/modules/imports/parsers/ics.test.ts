// SPDX-License-Identifier: FSL-1.1-ALv2
// The iCalendar (RFC 5545) reader an ICS import runs host-side: folded lines,
// escaped text, all-day and UTC dates, TZID as an IANA name or a VTIMEZONE of
// its own, recurrence lines kept, overrides split from their series, alarms
// ignored.
import { describe, expect, it } from "bun:test"
import { parseIcs } from "~/modules/imports/parsers/ics"

const wrap = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fabrikam//Test//EN", body, "END:VCALENDAR"].join(
    "\r\n",
  )

describe("parseIcs", () => {
  it("unfolds lines and unescapes text", () => {
    const { events, errors } = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "UID:evt-1@fabrikam.example",
          "DTSTART:20250310T090000Z",
          "DTEND:20250310T100000Z",
          "SUMMARY:Quarterly review\\, part one",
          "DESCRIPTION:Line one\\nLine two that is folded",
          "  and continues here",
          "LOCATION:Room 4\\; east wing",
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "ACTION:DISPLAY",
          "END:VALARM",
          "ATTENDEE;CN=Ann Example:mailto:ann@fabrikam.example",
          "ORGANIZER;CN=Bob:mailto:bob@fabrikam.example",
          "STATUS:CONFIRMED",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    )
    expect(errors).toEqual([])
    expect(events).toEqual([
      {
        externalRef: "evt-1@fabrikam.example",
        title: "Quarterly review, part one",
        description: "Line one\nLine two that is folded and continues here",
        location: "Room 4; east wing",
        start: { dateTime: "2025-03-10T09:00:00.000Z" },
        end: { dateTime: "2025-03-10T10:00:00.000Z" },
        allDay: false,
        status: "confirmed",
        attendees: [{ email: "ann@fabrikam.example", name: "Ann Example" }],
        organizerEmail: "bob@fabrikam.example",
      },
    ])
  })

  it("reads an all-day event and a DURATION", () => {
    const { events } = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "UID:day",
          "DTSTART;VALUE=DATE:20250401",
          "DTEND;VALUE=DATE:20250403",
          "SUMMARY:Trade show",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:dur",
          "DTSTART:20250401T080000Z",
          "DURATION:PT1H30M",
          "SUMMARY:Standup",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    )
    expect(events.map((e) => [e.externalRef, e.allDay, e.start, e.end])).toEqual([
      ["day", true, { date: "2025-04-01" }, { date: "2025-04-03" }],
      [
        "dur",
        false,
        { dateTime: "2025-04-01T08:00:00.000Z" },
        { dateTime: "2025-04-01T09:30:00.000Z" },
      ],
    ])
  })

  it("converts an IANA TZID and a custom VTIMEZONE to UTC, summer and winter", () => {
    const { events } = parseIcs(
      wrap(
        [
          "BEGIN:VTIMEZONE",
          "TZID:Romance Standard Time",
          "BEGIN:STANDARD",
          "DTSTART:16010101T030000",
          "TZOFFSETFROM:+0200",
          "TZOFFSETTO:+0100",
          "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
          "END:STANDARD",
          "BEGIN:DAYLIGHT",
          "DTSTART:16010101T020000",
          "TZOFFSETFROM:+0100",
          "TZOFFSETTO:+0200",
          "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
          "END:DAYLIGHT",
          "END:VTIMEZONE",
          "BEGIN:VEVENT",
          "UID:iana",
          "DTSTART;TZID=Europe/Paris:20250715T090000",
          "DTEND;TZID=Europe/Paris:20250715T100000",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:custom-summer",
          "DTSTART;TZID=Romance Standard Time:20250715T090000",
          "DTEND;TZID=Romance Standard Time:20250715T100000",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:custom-winter",
          "DTSTART;TZID=Romance Standard Time:20250115T090000",
          "DTEND;TZID=Romance Standard Time:20250115T100000",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    )
    expect(events.map((e) => [e.externalRef, e.start])).toEqual([
      ["iana", { dateTime: "2025-07-15T07:00:00.000Z", timeZone: "Europe/Paris" }],
      [
        "custom-summer",
        { dateTime: "2025-07-15T07:00:00.000Z", timeZone: "Romance Standard Time" },
      ],
      [
        "custom-winter",
        { dateTime: "2025-01-15T08:00:00.000Z", timeZone: "Romance Standard Time" },
      ],
    ])
  })

  it("keeps the recurrence lines, and an override becomes its own event excluded from the series", () => {
    const { events } = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "UID:weekly",
          "DTSTART:20250106T090000Z",
          "DTEND:20250106T093000Z",
          "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
          "EXDATE:20250113T090000Z",
          "SUMMARY:Weekly sync",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:weekly",
          "RECURRENCE-ID:20250120T090000Z",
          "DTSTART:20250120T100000Z",
          "DTEND:20250120T103000Z",
          "SUMMARY:Weekly sync (moved)",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:weekly",
          "RECURRENCE-ID;TZID=Europe/Paris;RANGE=THISANDFUTURE:20250127T100000",
          "DTSTART;TZID=Europe/Paris:20250127T110000",
          "DTEND;TZID=Europe/Paris:20250127T113000",
          "SUMMARY:Weekly sync (later)",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    )
    expect(events.map((e) => [e.externalRef, e.title, e.recurrence ?? null])).toEqual([
      [
        "weekly",
        "Weekly sync",
        [
          "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
          "EXDATE:20250113T090000Z",
          "EXDATE:20250120T090000Z",
          // RANGE belongs to RECURRENCE-ID only; EXDATE takes none.
          "EXDATE;TZID=Europe/Paris:20250127T100000",
        ],
      ],
      ["weekly#20250120T090000Z", "Weekly sync (moved)", null],
      ["weekly#20250127T100000", "Weekly sync (later)", null],
    ])
    expect(events[1]!.originalStartTime).toEqual({ dateTime: "2025-01-20T09:00:00.000Z" })
  })

  it("reports an event without a UID or a start, and keeps the rest", () => {
    const { events, errors } = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "DTSTART:20250101T090000Z",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:nostart",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:ok",
          "DTSTART:20250101T090000Z",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    )
    expect(events.map((e) => e.externalRef)).toEqual(["ok"])
    expect(errors).toHaveLength(2)
  })
})
