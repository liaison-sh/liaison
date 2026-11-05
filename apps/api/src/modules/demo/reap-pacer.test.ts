// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ReapPacer, type ReapPressure } from "~/modules/demo/reap-pacer"

const calm: ReapPressure = { poolBusy: false, dbProbeMs: 0.5, hostLoadPerCore: 0.2 }

describe("ReapPacer", () => {
  it("runs at full concurrency without rests on an idle box", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    for (let i = 0; i < 5; i++) expect(p.observe(calm)).toBe(false)
    expect(p.concurrency()).toBe(3)
    expect(p.restAfter(2000)).toBe(0)
  })

  it("each pressure signal alone drops to one purge at a time with a rest", () => {
    const signals: ReapPressure[] = [
      { ...calm, poolBusy: true },
      { ...calm, hostLoadPerCore: 0.9 },
      { ...calm, dbProbeMs: 40 },
    ]
    for (const s of signals) {
      const p = new ReapPacer({ maxConcurrency: 3 })
      expect(p.observe(s)).toBe(true)
      expect(p.concurrency()).toBe(1)
      // duty 0.5: a purge of 1 s earns a 1 s rest.
      expect(p.restAfter(1000)).toBe(1000)
    }
  })

  it("a probe five times the pass's floor is pressure even under the absolute bar", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    p.observe({ ...calm, dbProbeMs: 2 })
    expect(p.observe({ ...calm, dbProbeMs: 11 })).toBe(true)
  })

  it("sustained pressure bounds the reaper to its minimum duty, with a capped rest", () => {
    const p = new ReapPacer({ maxConcurrency: 3, minDuty: 0.1, maxRestMs: 30_000 })
    for (let i = 0; i < 20; i++) p.observe({ ...calm, poolBusy: true })
    expect(p.currentDuty()).toBeCloseTo(0.1)
    // busy 2 s, rests 18 s: a tenth of the wall clock.
    expect(p.restAfter(2000)).toBe(18_000)
    expect(p.restAfter(10_000)).toBe(30_000)
  })

  it("climbs back to full speed once the pressure is gone", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    for (let i = 0; i < 10; i++) p.observe({ ...calm, poolBusy: true })
    let n = 0
    while (p.concurrency() === 1 && n < 50) {
      p.observe(calm)
      n++
    }
    expect(p.concurrency()).toBe(3)
    expect(n).toBeLessThanOrEqual(10)
  })

  it("under sustained pressure the rest never takes the reaper below the backlog's drain rate", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    for (let i = 0; i < 20; i++) p.observe({ ...calm, poolBusy: true })
    // 100 purges left, 60 s left: 600 ms per purge. A 200 ms purge would earn
    // a 1.8 s rest at duty 0.1; the floor cuts it to the 400 ms left of its slot.
    p.schedule(100, 60_000)
    expect(p.restAfter(200)).toBe(400)
    expect(p.concurrency()).toBe(1)
    // Purges slower than the slot: no rest, and enough at once to keep up.
    expect(p.restAfter(1500)).toBe(0)
    expect(p.concurrency()).toBe(3)
    p.schedule(100, 100_000)
    expect(p.restAfter(1500)).toBe(0)
    expect(p.concurrency()).toBe(2)
    // Out of time: everything at once.
    p.schedule(10, 0)
    expect(p.concurrency()).toBe(3)
    expect(p.restAfter(100)).toBe(0)
  })

  it("a small backlog with time to spare still yields as before", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    for (let i = 0; i < 20; i++) p.observe({ ...calm, poolBusy: true })
    p.schedule(5, 480_000)
    expect(p.restAfter(2000)).toBe(18_000)
    expect(p.concurrency()).toBe(1)
  })

  it("an urgent pass (a workspace cap nearly full) does not yield at all", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    p.setUrgent(true)
    for (let i = 0; i < 20; i++) p.observe({ ...calm, poolBusy: true })
    expect(p.concurrency()).toBe(3)
    expect(p.restAfter(2000)).toBe(0)
  })

  it("unknown signals are not pressure", () => {
    const p = new ReapPacer({ maxConcurrency: 3 })
    expect(p.observe({ poolBusy: false, dbProbeMs: null, hostLoadPerCore: null })).toBe(false)
  })
})
