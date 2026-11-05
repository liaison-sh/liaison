// SPDX-License-Identifier: FSL-1.1-ALv2
// The turn deadline (turn-deadline.ts) on a fake clock: a progress deadline
// restarts at every completed step and stops only a step that makes no
// progress, or the turn at its ceiling; a wall deadline is one limit.
import { describe, expect, test } from "bun:test"
import {
  createTurnDeadline,
  type DeadlineTimers,
  TURN_PROGRESS_CEILING_MS,
} from "~/modules/agent/runtime/turn-deadline"

/** A clock that only moves when the test says so. */
function fakeClock(): DeadlineTimers & { advance: (ms: number) => void } {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id as number)
    },
    advance: (ms) => {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
  }
}

const STEP = 300_000

describe("a progress deadline", () => {
  test("a turn of many fast steps runs past 300 s in total", () => {
    const clock = fakeClock()
    let stopped = 0
    const d = createTurnDeadline({
      mode: "progress",
      limitMs: STEP,
      onExpire: () => stopped++,
      timers: clock,
    })
    // 30 steps of 40 s each: 20 minutes minus a little, never 300 s without a step.
    for (let i = 0; i < 29; i++) {
      clock.advance(40_000)
      d.stepCompleted()
    }
    expect(stopped).toBe(0)
    expect(d.expiredBy).toBeNull()
    d.clear()
    clock.advance(TURN_PROGRESS_CEILING_MS)
    expect(stopped).toBe(0)
  })

  test("a step stuck longer than the limit stops the turn, once", () => {
    const clock = fakeClock()
    let stopped = 0
    const d = createTurnDeadline({
      mode: "progress",
      limitMs: STEP,
      onExpire: () => stopped++,
      timers: clock,
    })
    clock.advance(100_000)
    d.stepCompleted()
    clock.advance(STEP - 1)
    expect(stopped).toBe(0)
    clock.advance(1)
    expect(stopped).toBe(1)
    expect(d.expiredBy).toBe("step")
    expect(d.describe()).toBe("this run's limit is 300s without progress in one step")
    d.stepCompleted()
    clock.advance(TURN_PROGRESS_CEILING_MS)
    expect(stopped).toBe(1)
  })

  test("a turn that keeps progressing stops at the ceiling", () => {
    const clock = fakeClock()
    let stopped = 0
    const d = createTurnDeadline({
      mode: "progress",
      limitMs: STEP,
      onExpire: () => stopped++,
      timers: clock,
    })
    for (let elapsed = 0; elapsed < TURN_PROGRESS_CEILING_MS - 60_000; elapsed += 60_000) {
      clock.advance(60_000)
      d.stepCompleted()
    }
    expect(stopped).toBe(0)
    clock.advance(60_000)
    expect(stopped).toBe(1)
    expect(d.expiredBy).toBe("ceiling")
    expect(d.describe()).toBe("this run's limit is 1200s")
  })
})

describe("a wall deadline (an explicit budget)", () => {
  test("completed steps do not extend it", () => {
    const clock = fakeClock()
    let stopped = 0
    const d = createTurnDeadline({
      mode: "wall",
      limitMs: 120_000,
      onExpire: () => stopped++,
      timers: clock,
    })
    for (let i = 0; i < 3; i++) {
      clock.advance(39_000)
      d.stepCompleted()
    }
    expect(stopped).toBe(0)
    clock.advance(3_000)
    expect(stopped).toBe(1)
    expect(d.expiredBy).toBe("wall")
    expect(d.describe()).toBe("this run's limit is 120s")
  })
})
