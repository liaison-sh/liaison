// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { expandRecurrence, parseIcalDateTime } from "./calendar-recurrence"

const PARIS = "Europe/Paris"

function starts(
  series: { start: unknown; end: unknown; recurrence: string[] },
  from: string,
  to: string,
): string[] {
  const { complex, occurrences } = expandRecurrence(series, new Date(from), new Date(to))
  expect(complex).toBe(false)
  return occurrences.map((o) => o.start.toISOString())
}

function timed(startIso: string, minutes: number, recurrence: string[], timeZone = PARIS) {
  const end = new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString()
  return {
    start: { dateTime: startIso, timeZone },
    end: { dateTime: end, timeZone },
    recurrence,
  }
}

describe("parseIcalDateTime", () => {
  it("reads the three RFC 5545 UNTIL forms and extended ISO", () => {
    expect(parseIcalDateTime("20210602T215959Z")?.toISOString()).toBe("2021-06-02T21:59:59.000Z")
    // Floating: wall time in the series' zone (Paris is UTC+2 in June).
    expect(parseIcalDateTime("20210602T215959", PARIS)?.toISOString()).toBe(
      "2021-06-02T19:59:59.000Z",
    )
    expect(parseIcalDateTime("20210602T215959")?.toISOString()).toBe("2021-06-02T21:59:59.000Z")
    expect(parseIcalDateTime("20210602")?.toISOString()).toBe("2021-06-02T00:00:00.000Z")
    expect(parseIcalDateTime("20210602", null, "end")?.toISOString()).toBe(
      "2021-06-02T23:59:59.999Z",
    )
    expect(parseIcalDateTime("2021-06-02T21:59:59Z")?.toISOString()).toBe(
      "2021-06-02T21:59:59.000Z",
    )
    expect(parseIcalDateTime("not a date")).toBeNull()
  })
})

describe("expandRecurrence", () => {
  it("stops a series at a basic-format UTC UNTIL", () => {
    const series = timed("2021-01-04T09:00:00+01:00", 30, [
      "RRULE:FREQ=WEEKLY;UNTIL=20210602T215959Z",
    ])
    expect(starts(series, "2026-10-12T00:00:00Z", "2026-10-19T00:00:00Z")).toEqual([])
    expect(starts(series, "2021-05-24T00:00:00Z", "2021-06-14T00:00:00Z")).toEqual([
      "2021-05-24T07:00:00.000Z",
      "2021-05-31T07:00:00.000Z",
    ])
  })

  it("keeps the last day of a date-only UNTIL and reads a floating UNTIL in the series' zone", () => {
    const allDay = {
      start: { date: "2021-05-19" },
      end: { date: "2021-05-20" },
      recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20210602"],
    }
    expect(starts(allDay, "2021-05-01T00:00:00Z", "2021-07-01T00:00:00Z")).toEqual([
      "2021-05-19T00:00:00.000Z",
      "2021-05-26T00:00:00.000Z",
      "2021-06-02T00:00:00.000Z",
    ])
    // 09:00 Paris on 06-02 is after a floating UNTIL of 08:59:59 Paris: excluded.
    const floating = timed("2021-05-19T09:00:00+02:00", 30, [
      "RRULE:FREQ=WEEKLY;UNTIL=20210602T085959",
    ])
    expect(starts(floating, "2021-05-01T00:00:00Z", "2021-07-01T00:00:00Z")).toEqual([
      "2021-05-19T07:00:00.000Z",
      "2021-05-26T07:00:00.000Z",
    ])
  })

  it("keeps the wall-clock time across a daylight-saving change", () => {
    // 09:00 Paris is 08:00Z in winter and 07:00Z in summer.
    const series = timed("2026-01-05T09:00:00+01:00", 60, ["RRULE:FREQ=WEEKLY"])
    expect(starts(series, "2026-07-06T00:00:00Z", "2026-07-07T00:00:00Z")).toEqual([
      "2026-07-06T07:00:00.000Z",
    ])
  })

  it("places an occurrence in a skipped hour after the gap, and a repeated hour at its first instance", () => {
    // New York springs forward at 02:00 on 2025-03-09: 02:30 does not exist and becomes 03:30
    // EDT (07:30Z), the wall time read with the offset before the change.
    const newYork = timed("2025-03-08T02:30:00-05:00", 30, ["RRULE:FREQ=DAILY"], "America/New_York")
    expect(starts(newYork, "2025-03-08T00:00:00Z", "2025-03-11T00:00:00Z")).toEqual([
      "2025-03-08T07:30:00.000Z",
      "2025-03-09T07:30:00.000Z",
      "2025-03-10T06:30:00.000Z",
    ])
    // Paris falls back at 03:00 on 2025-10-26: 02:30 happens twice; the first (CEST) counts.
    const paris = timed("2025-10-25T02:30:00+02:00", 30, ["RRULE:FREQ=DAILY"])
    expect(starts(paris, "2025-10-25T00:00:00Z", "2025-10-28T00:00:00Z")).toEqual([
      "2025-10-25T00:30:00.000Z",
      "2025-10-26T00:30:00.000Z",
      "2025-10-27T01:30:00.000Z",
    ])
    // London falls back at 02:00 on 2025-10-26: 01:30 BST (00:30Z) comes first.
    const london = timed("2025-10-25T01:30:00+01:00", 30, ["RRULE:FREQ=DAILY"], "Europe/London")
    expect(starts(london, "2025-10-25T00:00:00Z", "2025-10-28T00:00:00Z")).toEqual([
      "2025-10-25T00:30:00.000Z",
      "2025-10-26T00:30:00.000Z",
      "2025-10-27T01:30:00.000Z",
    ])
  })

  it("renders a DAILY series begun years before the window", () => {
    const series = timed("2015-03-02T08:30:00+01:00", 15, ["RRULE:FREQ=DAILY"])
    const week = starts(series, "2026-10-12T00:00:00Z", "2026-10-19T00:00:00Z")
    expect(week).toHaveLength(7)
    expect(week[0]).toBe("2026-10-12T06:30:00.000Z")
  })

  it("counts COUNT from the first occurrence even when the walk jumps ahead", () => {
    const ended = timed("2015-03-02T08:30:00+01:00", 15, ["RRULE:FREQ=DAILY;COUNT=10"])
    expect(starts(ended, "2026-10-12T00:00:00Z", "2026-10-19T00:00:00Z")).toEqual([])
    // MO,WE,FR from a Wednesday: occurrence 1 is that Wednesday, 300 is 100 weeks later.
    const weekly = timed("2024-01-03T10:00:00+01:00", 30, [
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=300",
    ])
    const all = starts(weekly, "2023-12-01T00:00:00Z", "2030-01-01T00:00:00Z")
    expect(all).toHaveLength(300)
    const last = all[all.length - 1] as string
    expect(starts(weekly, last, "2030-01-01T00:00:00Z")).toEqual([last])
  })

  it("honours INTERVAL, multi-day BYDAY, monthly ordinal weekdays and month days", () => {
    const biweekly = timed("2026-10-05T14:00:00+02:00", 60, ["RRULE:FREQ=WEEKLY;INTERVAL=2"])
    expect(starts(biweekly, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([
      "2026-10-05T12:00:00.000Z",
      "2026-10-19T12:00:00.000Z",
    ])
    const standup = timed("2026-10-05T09:30:00+02:00", 15, [
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    ])
    expect(starts(standup, "2026-10-12T00:00:00Z", "2026-10-19T00:00:00Z")).toHaveLength(5)
    const secondTuesday = timed("2026-01-13T11:00:00+01:00", 60, ["RRULE:FREQ=MONTHLY;BYDAY=2TU"])
    expect(starts(secondTuesday, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-11-10T10:00:00.000Z",
    ])
    const lastDay = {
      start: { date: "2026-01-31" },
      end: { date: "2026-02-01" },
      recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"],
    }
    expect(starts(lastDay, "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual([
      "2026-02-28T00:00:00.000Z",
      "2026-03-31T00:00:00.000Z",
    ])
    // Monthly on the 31st skips the months without one.
    const on31 = { ...lastDay, recurrence: ["RRULE:FREQ=MONTHLY"] }
    expect(starts(on31, "2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z")).toEqual([
      "2026-03-31T00:00:00.000Z",
      "2026-05-31T00:00:00.000Z",
    ])
  })

  it("expands yearly all-day series and drops EXDATE instances", () => {
    const birthday = {
      start: { date: "1990-04-12" },
      end: { date: "1990-04-13" },
      recurrence: ["RRULE:FREQ=YEARLY"],
    }
    expect(starts(birthday, "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z")).toEqual([
      "2026-04-12T00:00:00.000Z",
    ])
    const series = timed("2026-10-05T09:00:00+02:00", 30, [
      "RRULE:FREQ=DAILY;COUNT=5",
      "EXDATE;TZID=Europe/Paris:20261006T090000,20261008T090000",
    ])
    expect(starts(series, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([
      "2026-10-05T07:00:00.000Z",
      "2026-10-07T07:00:00.000Z",
      "2026-10-09T07:00:00.000Z",
    ])
  })

  it("flags rules outside the supported subset as complex", () => {
    for (const rule of [
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU",
      "RRULE:FREQ=DAILY;BYHOUR=9",
      "RRULE:FREQ=HOURLY",
    ]) {
      const result = expandRecurrence(
        timed("2026-10-05T09:00:00+02:00", 30, [rule]),
        new Date("2026-10-01T00:00:00Z"),
        new Date("2026-11-01T00:00:00Z"),
      )
      expect(result).toEqual({ complex: true, occurrences: [] })
    }
  })
})
