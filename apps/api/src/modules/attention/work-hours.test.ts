// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isOutsideWorkWindow, nextWorkWindowStart } from "./work-hours"

const MON_FRI = [1, 2, 3, 4, 5]
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]

describe("isOutsideWorkWindow", () => {
  it("Monday 10:00 UTC inside Mon–Fri 09:00–17:00 is inside", () => {
    // 2026-05-11 is a Monday
    expect(
      isOutsideWorkWindow(new Date("2026-05-11T10:00:00Z"), {
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(false)
  })

  it("Monday 22:00 UTC outside Mon–Fri 09:00–17:00 is outside", () => {
    expect(
      isOutsideWorkWindow(new Date("2026-05-11T22:00:00Z"), {
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(true)
  })

  it("Saturday 10:00 UTC is outside Mon–Fri schedule", () => {
    // 2026-05-16 is a Saturday
    expect(
      isOutsideWorkWindow(new Date("2026-05-16T10:00:00Z"), {
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(true)
  })

  it("identical start/end = all 24 h on the selected day", () => {
    expect(
      isOutsideWorkWindow(new Date("2026-05-11T03:00:00Z"), {
        workHoursStart: "00:00",
        workHoursEnd: "00:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(false)
  })

  it("identical start/end with all 7 days = always inside", () => {
    expect(
      isOutsideWorkWindow(new Date("2026-05-16T22:00:00Z"), {
        workHoursStart: "00:00",
        workHoursEnd: "00:00",
        workDays: ALL_DAYS,
        timezone: "UTC",
      }),
    ).toBe(false)
  })

  it("midnight-crossing 22:00–08:00 on Monday: Mon 23:00 = inside", () => {
    expect(
      isOutsideWorkWindow(new Date("2026-05-11T23:00:00Z"), {
        workHoursStart: "22:00",
        workHoursEnd: "08:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(false)
  })

  it("midnight-crossing 22:00–08:00 with Mon–Fri: Sat 03:00 = inside (belongs to Fri window)", () => {
    // 2026-05-16 03:00 UTC = Saturday — early-morning tail belongs to Friday's
    // 22:00-anchored window, so this should be inside.
    expect(
      isOutsideWorkWindow(new Date("2026-05-16T03:00:00Z"), {
        workHoursStart: "22:00",
        workHoursEnd: "08:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(false)
  })

  it("midnight-crossing 22:00–08:00 with Mon–Fri: Sun 03:00 = outside (Sat tail not a workday)", () => {
    // 2026-05-17 03:00 UTC = Sunday — yesterday is Saturday which is not in
    // workDays, so this is outside.
    expect(
      isOutsideWorkWindow(new Date("2026-05-17T03:00:00Z"), {
        workHoursStart: "22:00",
        workHoursEnd: "08:00",
        workDays: MON_FRI,
        timezone: "UTC",
      }),
    ).toBe(true)
  })

  it("tz-aware: Mon 23:00 NY (= Tue 04:00 UTC) on Mon–Fri 09:00–17:00 NY = outside", () => {
    expect(
      isOutsideWorkWindow(new Date("2026-05-12T04:00:00Z"), {
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: MON_FRI,
        timezone: "America/New_York",
      }),
    ).toBe(true)
  })
})

describe("nextWorkWindowStart", () => {
  it("returns now when inside the window", () => {
    const now = new Date("2026-05-11T10:00:00Z")
    const out = nextWorkWindowStart(now, {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: MON_FRI,
      timezone: "UTC",
    })
    expect(out.toISOString()).toBe(now.toISOString())
  })

  it("Monday 22:00 UTC outside 09:00–17:00 returns Tuesday 09:00 UTC", () => {
    const out = nextWorkWindowStart(new Date("2026-05-11T22:00:00Z"), {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: MON_FRI,
      timezone: "UTC",
    })
    expect(out.toISOString()).toBe("2026-05-12T09:00:00.000Z")
  })

  it("Saturday 10:00 UTC on Mon–Fri returns Monday 09:00 UTC", () => {
    const out = nextWorkWindowStart(new Date("2026-05-16T10:00:00Z"), {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: MON_FRI,
      timezone: "UTC",
    })
    expect(out.toISOString()).toBe("2026-05-18T09:00:00.000Z")
  })

  it("Friday 22:00 UTC on Mon–Fri returns the following Monday 09:00 UTC", () => {
    // 2026-05-15 is a Friday; 22:00 is outside the window and Sat/Sun skipped.
    const out = nextWorkWindowStart(new Date("2026-05-15T22:00:00Z"), {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: MON_FRI,
      timezone: "UTC",
    })
    expect(out.toISOString()).toBe("2026-05-18T09:00:00.000Z")
  })

  it("far-east tz (Pacific/Kiritimati UTC+14): Sat 02:00 UTC outside Mon–Fri 09:00–17:00 returns Mon 09:00 local", () => {
    // 2026-05-16 02:00 UTC = Sat 16:00 local Kiritimati (UTC+14) — outside.
    // Next Mon 09:00 local = Sun 2026-05-17 19:00 UTC.
    const out = nextWorkWindowStart(new Date("2026-05-16T02:00:00Z"), {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: MON_FRI,
      timezone: "Pacific/Kiritimati",
    })
    expect(out.toISOString()).toBe("2026-05-17T19:00:00.000Z")
  })

  it("Sunday 06:00 UTC outside 22:00–08:00 Mon–Fri returns Monday 22:00 UTC", () => {
    // 2026-05-17 06:00 UTC = Sunday — Sat tail is not a workday, so we wait
    // for Monday's 22:00 window opener.
    const out = nextWorkWindowStart(new Date("2026-05-17T06:00:00Z"), {
      workHoursStart: "22:00",
      workHoursEnd: "08:00",
      workDays: MON_FRI,
      timezone: "UTC",
    })
    expect(out.toISOString()).toBe("2026-05-18T22:00:00.000Z")
  })
})
