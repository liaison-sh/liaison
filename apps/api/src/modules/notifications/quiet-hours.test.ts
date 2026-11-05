// SPDX-License-Identifier: FSL-1.1-ALv2
// Quiet hours as people say them, converted to the stored work window. Each case
// is checked against the router's own `isOutsideWorkWindow`, so "quiet" here
// means what delivery will actually do.
import { describe, expect, it } from "bun:test"
import { isOutsideWorkWindow } from "~/modules/attention/work-hours"
import { describeQuietHours, quietHoursToWorkWindow, type WorkWindow } from "./quiet-hours"

function convert(input: Parameters<typeof quietHoursToWorkWindow>[0]): WorkWindow {
  const r = quietHoursToWorkWindow(input)
  if (!r.ok) throw new Error(r.message)
  return r.value
}

/** Is `local` (YYYY-MM-DDTHH:MM, Paris wall clock in winter, UTC+1) quiet? */
function quietAt(w: WorkWindow, local: string): boolean {
  const utc = new Date(`${local}:00+01:00`)
  return isOutsideWorkWindow(utc, {
    workHoursStart: w.start,
    workHoursEnd: w.end,
    workDays: w.days.map((d) => (d === 0 ? 7 : d)), // ISO weekdays
    timezone: w.timezone ?? "Europe/Paris",
  })
}

// 2026-11-02 is a Monday.
const MON = "2026-11-02"
const WED = "2026-11-04"
const FRI = "2026-11-06"
const SAT = "2026-11-07"
const SUN = "2026-11-08"

describe("quietHoursToWorkWindow", () => {
  it("21:00-08:00 on weekdays and all weekend is work 08:00-21:00 Mon-Fri, not the inverse", () => {
    const w = convert({ from: "21:00", to: "08:00", allWeekend: true, timezone: "Europe/Paris" })
    expect(w).toEqual({
      start: "08:00",
      end: "21:00",
      days: [1, 2, 3, 4, 5],
      timezone: "Europe/Paris",
    })
    expect(quietAt(w, `${WED}T22:30`)).toBe(true)
    expect(quietAt(w, `${WED}T07:30`)).toBe(true)
    expect(quietAt(w, `${WED}T12:00`)).toBe(false)
    expect(quietAt(w, `${MON}T08:00`)).toBe(false)
    expect(quietAt(w, `${FRI}T21:30`)).toBe(true)
    expect(quietAt(w, `${SAT}T12:00`)).toBe(true)
    expect(quietAt(w, `${SUN}T15:00`)).toBe(true)
  })

  it("allDayOn names the same weekend as allWeekend", () => {
    expect(convert({ from: "21:00", to: "08:00", allDayOn: ["sat", "sun"] })).toEqual(
      convert({ from: "21:00", to: "08:00", allWeekend: true }),
    )
  })

  it("without whole days, every day keeps its daytime window", () => {
    const w = convert({ from: "22:00", to: "07:00" })
    expect(w.days).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(quietAt(w, `${SAT}T12:00`)).toBe(false)
    expect(quietAt(w, `${SAT}T23:00`)).toBe(true)
  })

  it("a quiet period after midnight (01:00-06:00) gives a work window that crosses midnight", () => {
    const w = convert({ from: "01:00", to: "06:00" })
    expect(w).toMatchObject({ start: "06:00", end: "01:00" })
    expect(quietAt(w, `${WED}T00:30`)).toBe(false) // the tail of Tuesday's window
    expect(quietAt(w, `${WED}T03:00`)).toBe(true)
    expect(quietAt(w, `${WED}T06:00`)).toBe(false)
    expect(quietAt(w, `${WED}T23:59`)).toBe(false)
  })

  it("a daytime quiet period (lunch, 12:00-14:00) is quiet only then", () => {
    const w = convert({ from: "12:00", to: "14:00" })
    expect(w).toMatchObject({ start: "14:00", end: "12:00" })
    expect(quietAt(w, `${WED}T13:00`)).toBe(true)
    expect(quietAt(w, `${WED}T15:00`)).toBe(false)
    expect(quietAt(w, `${WED}T09:00`)).toBe(false)
  })

  it("refuses an empty period and a week that is quiet all day every day", () => {
    expect(quietHoursToWorkWindow({ from: "08:00", to: "08:00" }).ok).toBe(false)
    expect(
      quietHoursToWorkWindow({
        from: "21:00",
        to: "08:00",
        allDayOn: ["mon", "tue", "wed", "thu", "fri"],
        allWeekend: true,
      }).ok,
    ).toBe(false)
  })
})

describe("describeQuietHours", () => {
  it("reads the stored window back in the quiet form the user used", () => {
    const text = describeQuietHours({
      start: "08:00",
      end: "21:00",
      days: [1, 2, 3, 4, 5],
      timezone: "Europe/Paris",
      explicit: true,
    })
    expect(text).toContain("21:00 to 08:00 on Mon-Fri")
    expect(text).toContain("all day on Sat, Sun")
    expect(text).toContain("Europe/Paris")
  })

  it("reads the default quiet hours back when the user never set any (rule 8)", () => {
    const text = describeQuietHours({
      start: "08:00",
      end: "20:00",
      days: [1, 2, 3, 4, 5],
      timezone: "UTC",
      explicit: false,
    })
    expect(text).toContain("the default")
    expect(text).toContain("20:00 to 08:00 on Mon-Fri, and all day on Sat, Sun")
    expect(text).not.toContain("none set")
  })
})
