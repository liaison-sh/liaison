// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  API_EVENT_HANDLER_SLOTS,
  DEFAULT_KERNEL_NEED,
  describePlan,
  judgeAgainstLimit,
  memoryRegistrationConcurrency,
  PINNED_JOBS_WANTED,
  type PlanInput,
  planPools,
} from "~/db/pool-plan"

/** Split logins, compose topology (2 api + 1 worker), default kernel classes. */
function input(over: Partial<PlanInput>): PlanInput {
  return {
    role: "api",
    split: true,
    cellMax: 200,
    apiReplicas: 2,
    workerReplicas: 1,
    overrides: {},
    kernel: DEFAULT_KERNEL_NEED,
    ...over,
  }
}

const sizes = (p: ReturnType<typeof planPools>) => [
  p.pools.main,
  p.pools.request,
  p.pools.privileged,
  p.pools.jobs,
  p.pools.privilegedJobs,
]

describe("planPools", () => {
  it("compose default (200, 2 api + 1 worker, split): api 26, worker 34, overlap 172 fits", () => {
    expect(PINNED_JOBS_WANTED).toBe(5)
    const api = planPools(input({ role: "api" }))
    const worker = planPools(input({ role: "worker" }))
    // The api's jobs pool: its event handlers (2) plus one for short transactions.
    expect(sizes(api)).toEqual([5, 6, 10, 3, 2])
    expect(api.perProcess).toBe(26)
    expect(api.pinnedJobSlots).toBe(API_EVENT_HANDLER_SLOTS)
    expect(sizes(worker)).toEqual([5, 7, 15, 5, 2])
    expect(worker.perProcess).toBe(34)
    expect(worker.pinnedJobSlots).toBe(3)
    for (const p of [api, worker]) {
      expect(p.available).toBe(172)
      expect(p.steady).toBe(86)
      expect(p.overlap).toBe(172)
      expect(p.verdict).toBe("ok")
      expect(p.unallocated).toBe(0)
      expect(Object.values(p.source).every((s) => s === "planned")).toBe(true)
    }
  })

  it("a budget of 400 fills worker jobs, then privileged-jobs, then the api pools to their caps", () => {
    const api = planPools(input({ role: "api", cellMax: 400 }))
    const worker = planPools(input({ role: "worker", cellMax: 400 }))
    expect(sizes(api)).toEqual([5, 25, 20, 3, 2])
    expect(api.perProcess).toBe(55)
    expect(sizes(worker)).toEqual([5, 7, 15, 7, 5])
    expect(worker.perProcess).toBe(39)
    expect(worker.pinnedJobSlots).toBe(5)
    expect(api.pinnedJobSlots).toBe(API_EVENT_HANDLER_SLOTS)
    expect(api.unallocated).toBe(37)
  })

  it("unsplit logins count three physical pools", () => {
    const api = planPools(input({ role: "api", split: false }))
    const worker = planPools(input({ role: "worker", split: false }))
    expect(api.physical).toEqual(["main", "privileged", "jobs"])
    // Unsplit, a handler and its privileged twin share the jobs pool: 2 x 2 + 1.
    expect([api.pools.main, api.pools.privileged, api.pools.jobs]).toEqual([9, 12, 5])
    expect(api.pinnedJobSlots).toBe(API_EVENT_HANDLER_SLOTS)
    expect(api.pools.request).toBe(api.pools.main)
    expect(api.pools.privilegedJobs).toBe(api.pools.jobs)
    expect(api.perProcess).toBe(26)
    expect([worker.pools.main, worker.pools.privileged, worker.pools.jobs]).toEqual([7, 15, 12])
    expect(worker.perProcess).toBe(34)
    expect(worker.pinnedJobSlots).toBe(5)
  })

  it("unsplit, an api's request growth lands on the main pool it is", () => {
    const api = planPools(input({ role: "api", split: false, cellMax: 400 }))
    expect([api.pools.main, api.pools.request, api.pools.privileged]).toEqual([25, 25, 20])
    expect(api.perProcess).toBe(50)
  })

  it("no budget: legacy sizes equal today's env resolution", () => {
    const legacy = (split: boolean, overrides: PlanInput["overrides"]) =>
      planPools(input({ cellMax: undefined, split, overrides }))
    const none = legacy(true, {})
    expect(none.mode).toBe("legacy")
    expect(sizes(none)).toEqual([5, 20, 20, 20, 20])
    expect(Object.values(none.source).every((s) => s === "legacy")).toBe(true)
    expect(none.verdict).toBe("ok")
    expect(sizes(legacy(true, { pool: 8 }))).toEqual([5, 8, 8, 8, 8])
    expect(sizes(legacy(true, { pool: 3, privileged: 12, jobs: 4 }))).toEqual([3, 3, 12, 4, 4])
    const unsplit = legacy(false, { pool: 25, privileged: 15, jobs: 30 })
    expect(sizes(unsplit)).toEqual([25, 25, 15, 30, 30])
    expect(unsplit.physical).toEqual(["main", "privileged", "jobs"])
    expect(unsplit.perProcess).toBe(70)
  })

  it("an override wins and is marked override; DB_JOBS_POOL_MAX alone sizes both jobs pools", () => {
    const p = planPools(input({ role: "api", overrides: { privileged: 14, jobs: 3 } }))
    expect(p.pools.privileged).toBe(14)
    expect(p.source.privileged).toBe("override")
    expect(p.pools.jobs).toBe(3)
    expect(p.pools.privilegedJobs).toBe(3)
    expect(p.source.privilegedJobs).toBe("override")
    expect(p.source.request).toBe("planned")
    const own = planPools(input({ role: "api", overrides: { jobs: 3, privilegedJobs: 1 } }))
    expect(own.pools.privilegedJobs).toBe(1)
  })

  it("steady above the budget refuses, naming every pool", () => {
    const p = planPools(input({ role: "api", cellMax: 100 }))
    expect(p.available).toBe(72)
    expect(p.steady).toBe(84)
    expect(p.verdict).toBe("refuse")
    const text = describePlan(p)
    for (const name of ["main=5", "request=6", "privileged=10", "jobs=3", "privileged-jobs=2"]) {
      expect(text).toContain(name)
    }
  })

  it("overlap above the budget with steady inside warns, and refuses under DB_CELL_STRICT", () => {
    const p = planPools(input({ role: "worker", cellMax: 150 }))
    expect(sizes(p)).toEqual([5, 7, 15, 3, 2])
    expect(p.steady).toBe(84)
    expect(p.overlap).toBe(168)
    expect(p.available).toBe(122)
    expect(p.verdict).toBe("warn")
    expect(planPools(input({ role: "worker", cellMax: 150, strict: true })).verdict).toBe("refuse")
  })

  it("the api privileged pool never drops below 10 unless overridden", () => {
    for (const cellMax of [60, 100, 200, 1000]) {
      expect(planPools(input({ role: "api", cellMax })).pools.privileged).toBeGreaterThanOrEqual(10)
    }
    expect(planPools(input({ role: "api", overrides: { privileged: 4 } })).pools.privileged).toBe(4)
  })

  it("worker privileged = kernel need + 4; a raised kernel need raises it and the request floor", () => {
    expect(DEFAULT_KERNEL_NEED).toEqual({ total: 11, requestSlots: 7 })
    expect(planPools(input({ role: "worker" })).pools.privileged).toBe(15)
    // JOB_QUEUE_CONCURRENCY "agent=8": total 15, agent + cron 11.
    const raised = planPools(input({ role: "worker", kernel: { total: 15, requestSlots: 11 } }))
    expect(raised.pools.privileged).toBe(19)
    expect(raised.pools.request).toBe(11)
  })

  it("surplus stops at the useful maxima (1000: api request 25, privileged 20)", () => {
    const api = planPools(input({ role: "api", cellMax: 1000 }))
    expect(api.pools.request).toBe(25)
    expect(api.pools.privileged).toBe(20)
    expect(api.unallocated).toBeGreaterThan(0)
  })

  it("role all: one process, maxima under a large budget, clamped toward its floors under a small one", () => {
    const big = planPools(input({ role: "all", cellMax: 1000 }))
    expect(sizes(big)).toEqual([5, 25, 15, 30, 30])
    expect(big.steady).toBe(105)
    expect(big.overlap).toBe(105)
    const small = planPools(input({ role: "all", cellMax: 60 }))
    // available 32, floors 5 + 7 + 15 + 3 + 2 = 32
    expect(sizes(small)).toEqual([5, 7, 15, 3, 2])
    expect(small.verdict).toBe("ok")
    const legacyAll = planPools(
      input({
        role: "all",
        cellMax: undefined,
        split: false,
        overrides: { pool: 25, privileged: 15, jobs: 30 },
      }),
    )
    expect([legacyAll.pools.main, legacyAll.pools.privileged, legacyAll.pools.jobs]).toEqual([
      25, 15, 30,
    ])
  })

  it("cli and one-shot processes get 2 per pool and never refuse", () => {
    for (const role of ["cli", "oneshot"] as const) {
      for (const cellMax of [undefined, 20, 200]) {
        const p = planPools(input({ role, cellMax }))
        expect(sizes(p)).toEqual([2, 2, 2, 2, 2])
        expect(p.verdict).toBe("ok")
      }
    }
  })

  it("judges an observed server limit like the budget, and sums each login for a pooler", () => {
    const api = planPools(input({ role: "api" }))
    // An external database at 100 with 3 superuser slots: 97 - 13 = 84 < steady 86.
    expect(judgeAgainstLimit(api, 97)).toEqual({ verdict: "refuse", available: 84 })
    expect(judgeAgainstLimit(api, 197).verdict).toBe("ok")
    expect(judgeAgainstLimit(api, 180).verdict).toBe("warn")
    // request login: request + jobs; privileged login: main + privileged + privileged-jobs.
    expect(api.logins).toEqual({ request: 9, privileged: 17 })
  })
})

describe("memoryRegistrationConcurrency", () => {
  it("takes at most half the privileged pool, between 1 and 8", () => {
    // The api floor (10): 5 org setups at once leave 5 for auth checks and card loads.
    expect(memoryRegistrationConcurrency(10)).toBe(5)
    expect(memoryRegistrationConcurrency(12)).toBe(6)
    expect(memoryRegistrationConcurrency(60)).toBe(8)
    expect(memoryRegistrationConcurrency(2)).toBe(1)
  })
})
