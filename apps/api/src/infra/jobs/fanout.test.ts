// SPDX-License-Identifier: FSL-1.1-ALv2
// The pure parts of the cron fan-out (fanout.ts): epoch, gap, spread window,
// rank spread, ids.
import { describe, expect, it } from "bun:test"
import {
  FANOUT_MAX_WINDOW_MS,
  fanoutEpoch,
  fanoutJobId,
  fanoutSchedulerId,
  LEGACY_PER_ORG_SCHEDULER_RE,
  nextGapMs,
  parseFanoutJobId,
  retentionMs,
  spreadDelays,
  spreadWindowMs,
} from "./fanout"

const uuid = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${"0".repeat(12)}`
const orgs = (n: number, from = 0) => Array.from({ length: n }, (_, i) => uuid(from + i))

describe("fanout epoch", () => {
  it("is the tick's scheduled fire time (prevMillis)", () => {
    expect(
      fanoutEpoch({
        id: "repeat:app-cron-fanout:a:b:999",
        opts: { prevMillis: 1_700_000_000_000 },
      }),
    ).toBe(1_700_000_000_000)
  })

  it("is read from the scheduler job id when prevMillis is absent", () => {
    expect(fanoutEpoch({ id: "repeat:app-cron-fanout:tickets:slaCheck:1700000300000" })).toBe(
      1_700_000_300_000,
    )
  })

  it("throws on a job no scheduler minted", () => {
    expect(() => fanoutEpoch({ id: "12345" })).toThrow()
    expect(() => fanoutEpoch({ id: "repeat:x:notanumber" })).toThrow()
  })
})

describe("fanout gap and window", () => {
  it("measures the gap to the next fire in UTC", () => {
    const epoch = Date.UTC(2026, 9, 30, 10, 5, 0)
    expect(nextGapMs("*/5 * * * *", epoch)).toBe(300_000)
    expect(nextGapMs("0 6 * * *", Date.UTC(2026, 9, 30, 6, 0, 0))).toBe(86_400_000)
  })

  it("caps the window at 5 min and keeps 20 % of the gap free", () => {
    expect(spreadWindowMs(86_400_000, 1000)).toBe(FANOUT_MAX_WINDOW_MS)
    expect(FANOUT_MAX_WINDOW_MS).toBe(300_000)
    expect(spreadWindowMs(120_000, 1000)).toBe(96_000)
    expect(retentionMs(120_000)).toBe(600_000)
    expect(retentionMs(3_600_000)).toBe(7_200_000)
  })

  it("shrinks the window with the org count (2 s per org)", () => {
    expect(spreadWindowMs(300_000, 1)).toBe(2_000)
    expect(spreadWindowMs(300_000, 50)).toBe(100_000)
    expect(spreadWindowMs(86_400_000, 150)).toBe(300_000)
    expect(spreadWindowMs(300_000, 0)).toBe(0)
  })
})

describe("fanout spread", () => {
  it("spreads 50 orgs over the window: every delay in [0, W), at most 10 in any 10 % slice", () => {
    const W = 100_000
    const delays = spreadDelays(orgs(50), "invoicing", "deferred-retry", W)
    expect(delays.size).toBe(50)
    const slices = new Array(10).fill(0)
    for (const d of delays.values()) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(W)
      slices[Math.floor(d / (W / 10))]++
    }
    expect(Math.max(...slices)).toBeLessThanOrEqual(10)
  })

  it("is stable for the same set, whatever its order", () => {
    const a = spreadDelays(orgs(20), "tickets", "slaCheck", 40_000)
    const b = spreadDelays(orgs(20).reverse(), "tickets", "slaCheck", 40_000)
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
    // Another job of the same org lands elsewhere: one org's crons do not co-fire.
    const c = spreadDelays(orgs(20), "tickets", "followupCheck", 40_000)
    expect([...c.values()]).not.toEqual(orgs(20).map((o) => a.get(o)))
  })

  it("moves no other org by more than W/n when one org is added", () => {
    const W = 200_000
    const before = spreadDelays(orgs(40), "social", "dm-sync", W)
    const after = spreadDelays(orgs(41), "social", "dm-sync", W)
    for (const [org, d] of before) {
      expect(Math.abs((after.get(org) ?? -1) - d)).toBeLessThanOrEqual(W / 40)
    }
  })

  it("mints a job id with no ':' that round-trips its parts; recognises legacy per-org ids", () => {
    const org = uuid(7)
    const id = fanoutJobId("invoicing", "deferred-retry", org, 1_700_000_000_000)
    expect(id).toBe(`fo.invoicing.deferred-retry.${org}.1700000000000`)
    expect(id.includes(":")).toBe(false)
    expect(parseFanoutJobId(id)).toEqual({
      app: "invoicing",
      job: "deferred-retry",
      orgId: org,
      epoch: 1_700_000_000_000,
    })
    expect(parseFanoutJobId("n.abc")).toBeNull()
    expect(() => fanoutJobId("a.b", "c", org, 1)).toThrow()
    expect(fanoutSchedulerId("tickets", "slaCheck")).toBe("app-cron-fanout:tickets:slaCheck")
    expect(LEGACY_PER_ORG_SCHEDULER_RE.test(`deferred-retry-scheduler-${org}`)).toBe(true)
    expect(LEGACY_PER_ORG_SCHEDULER_RE.test("deferred-retry-scheduler")).toBe(false)
    expect(LEGACY_PER_ORG_SCHEDULER_RE.test(`routine:${org}`)).toBe(false)
  })
})
