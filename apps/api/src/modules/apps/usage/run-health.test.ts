// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"
import { type RunSettledInfo, runErrorKindOf } from "~/modules/apps/workers/run-settled"
import {
  cellRunHealth,
  flushRunHealth,
  processRunHealth,
  RunHealthKeys,
  RunHealthTestAccess,
  recordRunHealth,
  registerRunPoolGauge,
  runHealthLaneOf,
  runQueueWaitOf,
  samplePools,
} from "./run-health"
import { judgeRunHealth, type RunHealthThresholds } from "./run-health-checks"

const ORG = "00000000-0000-4000-8000-00000000a1e1"
const T: RunHealthThresholds = {
  timeoutsMin: 10,
  timeoutRate: 0.02,
  queueP95Ms: 2000,
  saturatedS: 60,
  p95Regression: 2,
}

function run(over: Partial<RunSettledInfo> = {}): RunSettledInfo {
  return {
    app: "tickets",
    orgId: ORG,
    entry: "tool:tickets_search",
    executor: "workerd",
    nested: false,
    ms: 120,
    ok: true,
    at: Date.now(),
    ...over,
  }
}

afterEach(() => RunHealthTestAccess.clear())

describe("lane and queue wait", () => {
  it("derives the lane from nesting, a reported lane, then the entry kind", () => {
    expect(runHealthLaneOf({ entry: "tool:x", nested: true })).toBe("nested")
    expect(runHealthLaneOf({ entry: "tool:x", nested: false })).toBe("interactive")
    expect(runHealthLaneOf({ entry: "attention:compute", nested: false })).toBe("interactive")
    expect(runHealthLaneOf({ entry: "job:sync", nested: false })).toBe("background")
    expect(runHealthLaneOf({ entry: "event:onCreate", nested: false })).toBe("background")
    expect(runHealthLaneOf({ entry: "webhook:inbound", nested: false })).toBe("background")
    expect(runHealthLaneOf({ entry: "tool:x", nested: false, lane: "background" })).toBe(
      "background",
    )
  })

  it("reads the queue wait from whichever field the executor set", () => {
    expect(runQueueWaitOf(run())).toBeUndefined()
    expect(runQueueWaitOf(run({ admissionMs: 40 }))).toBe(40)
    expect(runQueueWaitOf(run({ loader: { queueMs: 900 } as RunSettledInfo["loader"] }))).toBe(900)
    expect(
      runQueueWaitOf(run({ admissionMs: 10, loader: { queueMs: 5 } as RunSettledInfo["loader"] })),
    ).toBe(15)
  })

  it("classifies a thrown error by name, code and message prefix", () => {
    expect(
      runErrorKindOf(new Error("Queued sandbox request timed out waiting for a free worker")),
    ).toBe("queue_timeout")
    expect(runErrorKindOf(new Error("App execution timed out"))).toBe("timeout")
    const cancelled = new Error("gone")
    cancelled.name = "SandboxRequestCancelled"
    expect(runErrorKindOf(cancelled)).toBe("cancelled")
    expect(runErrorKindOf(Object.assign(new Error("busy"), { code: "custom_app_busy" }))).toBe(
      "tenant_busy",
    )
    expect(runErrorKindOf(new Error("Sandbox worker crashed"))).toBe("sandbox")
    expect(runErrorKindOf(new Error("Ticket not found"))).toBe("handler")
  })
})

describe("this process's view", () => {
  it("counts runs, errors, timeouts, percentiles, queue and bridge share per app and lane", () => {
    for (let i = 0; i < 18; i++) recordRunHealth(run({ ms: 80 }))
    recordRunHealth(run({ ms: 4_000, ok: false, errorKind: "timeout" }))
    recordRunHealth(
      run({
        ms: 1_000,
        ok: false,
        errorKind: "handler",
        loader: { bridgeMsTotal: 600, queueMs: 300 } as RunSettledInfo["loader"],
      }),
    )
    recordRunHealth(run({ entry: "job:sync", ms: 30_000 }))
    recordRunHealth(run({ executor: "inprocess" }))
    const v = processRunHealth()["15m"]
    expect(v.windowS).toBe(900)
    expect(v.total.runs).toBe(21)
    const inter = v.lanes.interactive
    expect(inter.runs).toBe(20)
    expect(inter.errors).toBe(2)
    expect(inter.timeouts).toBe(1)
    expect(inter.errorKinds).toEqual({ timeout: 1, handler: 1 })
    expect(inter.timeoutRate).toBe(0.05)
    expect(inter.p50Ms).toBe(100)
    expect(inter.p99Ms).toBe(5_000)
    expect(inter.queuedRuns).toBe(1)
    expect(inter.queueP95Ms).toBe(500)
    expect(inter.bridgeShare).toBe(0.6)
    expect(v.lanes.background.runs).toBe(1)
    expect(v.apps.map((a) => `${a.app}|${a.lane}`)).toEqual([
      "tickets|interactive",
      "tickets|background",
    ])
    expect(v.slowest[0]).toMatchObject({
      app: "tickets",
      entry: "job:sync",
      lane: "background",
      ms: 30_000,
    })
    expect(processRunHealth()["24h"].total.runs).toBe(21)
  })

  it("keeps memory bounded: past the series cap a lane folds into (other)", () => {
    for (let i = 0; i < 350; i++) recordRunHealth(run({ app: `app-${i}` }))
    const v = processRunHealth()["15m"]
    expect(v.total.runs).toBe(350)
    expect(v.apps.length).toBe(50)
    expect(v.appsTruncated).toBe(true)
    const all = processRunHealth()["15m"]
    expect(all.lanes.interactive.runs).toBe(350)
  })

  it("forgets runs older than the window", () => {
    recordRunHealth(run({ at: Date.now() - 20 * 60_000 }))
    recordRunHealth(run())
    expect(processRunHealth()["15m"].total.runs).toBe(1)
    expect(processRunHealth()["24h"].total.runs).toBe(2)
  })

  it("samples pool gauges: saturated seconds, occupancy and the current streak", () => {
    let saturated = true
    registerRunPoolGauge("test-pool", () => ({ busy: 4, capacity: 4, saturated }))
    const t0 = Date.now()
    for (let s = 0; s < 70; s++) samplePools(t0 + s * 1000)
    const v = processRunHealth(t0 + 69_000)["15m"]
    expect(v.pools["test-pool"]?.saturatedSec).toBe(70)
    expect(v.pools["test-pool"]?.occupancy).toBe(1)
    expect(v.pools["test-pool"]?.saturatedNowSec).toBe(69)
    saturated = false
    samplePools(t0 + 70_000)
    expect(processRunHealth(t0 + 70_000)["15m"].pools["test-pool"]?.saturatedNowSec).toBe(0)
  })
})

describe("the cell view (Redis)", () => {
  it("flushes counters and slow runs, readable cell-wide and per org", async () => {
    const org = randomUUID()
    const other = randomUUID()
    const at = Date.now()
    recordRunHealth(run({ orgId: org, at, ms: 2_500 }))
    recordRunHealth(run({ orgId: org, at, ok: false, errorKind: "queue_timeout", ms: 9_000 }))
    recordRunHealth(run({ orgId: other, at, app: "shopify" }))
    expect(RunHealthTestAccess.pendingKeys()).toContain(RunHealthKeys.minute(at, org))
    await flushRunHealth()
    const mine = await cellRunHealth({ orgId: org, now: at })
    expect(mine["15m"].total.runs).toBe(2)
    expect(mine["15m"].lanes.interactive.timeouts).toBe(1)
    expect(mine["15m"].apps.map((a) => a.app)).toEqual(["tickets"])
    expect(mine["24h"].slowest[0]?.ms).toBe(9_000)
    const cell = await cellRunHealth({ now: at })
    expect(cell["15m"].total.runs).toBeGreaterThanOrEqual(3)
    expect(cell["15m"].apps.some((a) => a.app === "shopify")).toBe(true)
    await redis.del(
      RunHealthKeys.minute(at, org),
      RunHealthKeys.hour(at, org),
      RunHealthKeys.slow(at, org),
      RunHealthKeys.minute(at, other),
      RunHealthKeys.hour(at, other),
      RunHealthKeys.slow(at, other),
    )
  })
})

describe("checks", () => {
  it("a burst of 30 interactive timeouts among 600 runs fires interactive_timeouts (critical)", () => {
    for (let i = 0; i < 570; i++) recordRunHealth(run({ ms: 150 }))
    for (let i = 0; i < 30; i++) {
      recordRunHealth(
        run({ app: i % 2 ? "projects" : "tickets", ms: 30_000, ok: false, errorKind: "timeout" }),
      )
    }
    const alerts = judgeRunHealth(processRunHealth(), T)
    const a = alerts.find((x) => x.check === "interactive_timeouts")
    expect(a?.severity).toBe("critical")
    expect(a?.value).toBe(30)
    expect(a?.subjects.sort()).toEqual(["projects", "tickets"])
  })

  it("a quiet day (a stray timeout, no queue) fires nothing", () => {
    for (let i = 0; i < 400; i++) recordRunHealth(run({ ms: 200 }))
    for (let i = 0; i < 3; i++)
      recordRunHealth(run({ ok: false, errorKind: "timeout", ms: 30_000 }))
    for (let i = 0; i < 100; i++) recordRunHealth(run({ entry: "job:sync", ms: 20_000 }))
    expect(judgeRunHealth(processRunHealth(), T)).toEqual([])
  })

  it("fires interactive_queue on a queue wait p95 above the threshold", () => {
    for (let i = 0; i < 25; i++) {
      recordRunHealth(run({ ms: 6_000, loader: { queueMs: 5_000 } as RunSettledInfo["loader"] }))
    }
    expect(judgeRunHealth(processRunHealth(), T).map((a) => a.check)).toContain("interactive_queue")
  })

  it("fires pool_saturated on a 60 s streak", () => {
    registerRunPoolGauge("busy", () => ({ busy: 2, capacity: 2, saturated: true }))
    const t0 = Date.now() - 61_000
    for (let s = 0; s <= 61; s++) samplePools(t0 + s * 1000)
    const alerts = judgeRunHealth(processRunHealth(t0 + 61_000), T)
    expect(alerts.find((a) => a.check === "pool_saturated")?.subjects).toEqual(["busy"])
  })

  it("fires interactive_p95 on a sustained regression against the 24 h window", () => {
    const old = Date.now() - 3 * 3_600_000
    for (let i = 0; i < 1000; i++) recordRunHealth(run({ at: old, ms: 200 }))
    for (let i = 0; i < 40; i++) recordRunHealth(run({ ms: 4_000 }))
    const a = judgeRunHealth(processRunHealth(), T).find((x) => x.check === "interactive_p95")
    expect(a?.value).toBe(5_000)
    expect(a?.severity).toBe("warning")
  })
})
