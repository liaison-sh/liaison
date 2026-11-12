// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B5 — YouTube daily unit budget. With a small cap B, after reserving the
// discovery slice the budget pauses the lowest-priority watches first on
// projected exhaustion and reports a deferred count — total consumed never
// silently exceeds B (§9 #3).

import { describe, expect, test } from "bun:test"
import { nextYoutubeQuotaReset, planWatchBudget, QuotaBudget, youtubeQuotaDay } from "./quota"

describe("QuotaBudget (B5)", () => {
  test("tracks consumed units and reports remaining against the cap", () => {
    const b = new QuotaBudget(300)
    b.consume(100) // discovery search
    expect(b.remaining()).toBe(200)
    b.consume(50)
    expect(b.remaining()).toBe(150)
    expect(b.consumed()).toBe(150)
  })
})

describe("planWatchBudget (B5 lowest-priority-first deferral)", () => {
  test("pauses the lowest-priority watches first and reports the deferred count; total ≤ B", () => {
    // Cap 300; discovery already cost 100; each watch poll costs 1 unit but the
    // budget reserves a safety slice so only a bounded number of watches run.
    const watches = [
      { id: "w-high", priority: 90 },
      { id: "w-mid", priority: 50 },
      { id: "w-low", priority: 10 },
    ]
    // Remaining 200 after discovery; per-watch cost 100 (e.g. expensive search-poll)
    // → only 2 of 3 can run; the lowest-priority one is deferred.
    const plan = planWatchBudget({
      remaining: 200,
      perWatchUnits: 100,
      watches,
    })
    expect(plan.toPoll.map((w) => w.id)).toEqual(["w-high", "w-mid"])
    expect(plan.deferred.map((w) => w.id)).toEqual(["w-low"])
    expect(plan.deferredCount).toBe(1)
    expect(plan.toPoll.length * 100).toBeLessThanOrEqual(200)
  })

  test("when everything fits, nothing is deferred", () => {
    const plan = planWatchBudget({
      remaining: 1000,
      perWatchUnits: 1,
      watches: [
        { id: "a", priority: 1 },
        { id: "b", priority: 2 },
      ],
    })
    expect(plan.deferredCount).toBe(0)
    expect(plan.toPoll.length).toBe(2)
  })

  test("a zero remaining budget defers every watch (no silent overflow)", () => {
    const plan = planWatchBudget({
      remaining: 0,
      perWatchUnits: 1,
      watches: [{ id: "a", priority: 5 }],
    })
    expect(plan.toPoll.length).toBe(0)
    expect(plan.deferredCount).toBe(1)
  })
})

describe("YouTube quota day (Pacific midnight, Google's reset clock)", () => {
  test("daylight time: the day turns at 07:00 UTC", () => {
    expect(youtubeQuotaDay(new Date("2026-10-20T06:59:59.000Z"))).toBe("2026-10-19")
    expect(youtubeQuotaDay(new Date("2026-10-20T07:00:00.000Z"))).toBe("2026-10-20")
    expect(nextYoutubeQuotaReset(new Date("2026-10-20T14:11:00.000Z")).toISOString()).toBe(
      "2026-10-21T07:00:00.000Z",
    )
  })
  test("standard time: the day turns at 08:00 UTC", () => {
    expect(youtubeQuotaDay(new Date("2026-12-01T07:59:59.000Z"))).toBe("2026-11-30")
    expect(youtubeQuotaDay(new Date("2026-12-01T08:00:00.000Z"))).toBe("2026-12-01")
    expect(nextYoutubeQuotaReset(new Date("2026-12-01T12:00:00.000Z")).toISOString()).toBe(
      "2026-12-02T08:00:00.000Z",
    )
  })
  test("switch days: the reset before each switch keeps the previous offset", () => {
    // 2026: DST starts Sunday March 8, ends Sunday November 1.
    expect(nextYoutubeQuotaReset(new Date("2026-03-07T20:00:00.000Z")).toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    )
    expect(nextYoutubeQuotaReset(new Date("2026-03-08T20:00:00.000Z")).toISOString()).toBe(
      "2026-03-09T07:00:00.000Z",
    )
    expect(nextYoutubeQuotaReset(new Date("2026-10-31T20:00:00.000Z")).toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    )
    expect(nextYoutubeQuotaReset(new Date("2026-11-01T20:00:00.000Z")).toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    )
  })
})
