// SPDX-License-Identifier: FSL-1.1-ALv2
// A long timer (ctx.timers.wakeIn past 15 min) hops: the worker puts its job
// back as delayed until `_wakeAt`, at most 15 min at a time, then runs it.
import { describe, expect, it } from "bun:test"
import { TIMER_HOP_MAX_MS, timerHoldUntil } from "~/infra/jobs/jobs"

describe("timerHoldUntil", () => {
  const now = 1_800_000_000_000

  it("runs a job that carries no wake time, or a malformed one", () => {
    expect(timerHoldUntil({ page: 1 }, now)).toBeNull()
    expect(timerHoldUntil(null, now)).toBeNull()
    expect(timerHoldUntil({ _wakeAt: "soon" }, now)).toBeNull()
    expect(timerHoldUntil({ _wakeAt: Number.POSITIVE_INFINITY }, now)).toBeNull()
  })

  it("runs a timer that is due, or due within a second", () => {
    expect(timerHoldUntil({ _wakeAt: now - 5 }, now)).toBeNull()
    expect(timerHoldUntil({ _wakeAt: now + 1_000 }, now)).toBeNull()
  })

  it("holds a timer not yet due: until it is due, 15 min at most per hop", () => {
    expect(timerHoldUntil({ _wakeAt: now + 60_000 }, now)).toBe(now + 60_000)
    expect(timerHoldUntil({ _wakeAt: now + 7_200_000 }, now)).toBe(now + TIMER_HOP_MAX_MS)
    // A two-hour timer: eight hops, then it runs.
    let t = now
    let hops = 0
    for (let next = timerHoldUntil({ _wakeAt: now + 7_200_000 }, t); next !== null; hops++) {
      t = next
      next = timerHoldUntil({ _wakeAt: now + 7_200_000 }, t)
    }
    expect(hops).toBe(8)
    expect(t).toBe(now + 7_200_000)
  })
})
