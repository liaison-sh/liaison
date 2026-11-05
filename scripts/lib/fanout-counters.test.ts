// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type FanoutReport, fanoutVerdict } from "./fanout-counters"

function report(
  over: Partial<FanoutReport["totals"]> = {},
  quietP95: number | null = 500,
): FanoutReport {
  const totals = {
    epochs: 6,
    expected: 60,
    runs: 60,
    missed: 0,
    doubled: 0,
    coalesced: 0,
    skippedRunsFor: 0,
    notDue: 0,
    spreadMaxSlicePct: 10,
    spreadStarts: 60,
    ...over,
  }
  return {
    window: { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 0, 1, 1) },
    waitsWindow: { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 0, 1, 1) },
    generatedAt: Date.UTC(2026, 0, 1, 2),
    orgs: 10,
    schedulers: 12,
    fanoutSchedulers: 12,
    byJob: {},
    totals,
    missedRuns: [],
    doubledRuns: [],
    metrics: {},
    waits: {
      queues: ["kernel-agent"],
      perOrg: {},
      quiet: { count: 100, p95Ms: quietP95 },
      flood: { count: 10_000, p95Ms: 60_001 },
    },
    drain: null,
  }
}

describe("fanoutVerdict", () => {
  it("a clean report holds", () => {
    const v = fanoutVerdict(report(), { maxSlicePct: 20, quietP95Ms: 5_000, schedulers: 12 })
    expect(v.ok).toBe(true)
    expect(v.failures).toEqual([])
    expect(v.summary).toContain("Held.")
    expect(v.floodP95Ms).toBe(60_001)
  })

  it("any missed, doubled or coalesced run, a clumped spread, a slow quiet org or a scheduler change fails", () => {
    expect(fanoutVerdict(report({ missed: 1 })).failures).toEqual(["1 missed"])
    expect(fanoutVerdict(report({ doubled: 2 })).failures).toEqual(["2 doubled"])
    expect(fanoutVerdict(report({ coalesced: 1 })).ok).toBe(false)
    expect(fanoutVerdict(report({ spreadMaxSlicePct: 30 })).ok).toBe(false)
    expect(fanoutVerdict(report({}, 5_000)).ok).toBe(false)
    const v = fanoutVerdict(report(), { maxSlicePct: 20, quietP95Ms: 5_000, schedulers: 11 })
    expect(v.failures).toEqual(["12 schedulers (expected 11)"])
  })

  it("a window with nothing due is not a pass", () => {
    const v = fanoutVerdict(report({ expected: 0, runs: 0 }))
    expect(v.ok).toBe(false)
    expect(v.failures[0]).toContain("nothing measured")
  })
})
