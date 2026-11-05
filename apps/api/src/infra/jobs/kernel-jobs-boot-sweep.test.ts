// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot one-shots that must run once per cell, not once per process, are
// singleton hooks: they run when this process takes the leader lease.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Put the `void sweepNodeLeases()` back in registerKernelJobs: the sweep
//    runs before any lease is held.
//  * Drop the boot-acquisition skip in registerLegacyKernelQueueSingleton: the
//    migration runs twice for one acquisition.
//  * Stop awaiting the boot run: registration resolves before the migration.
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import { Queue } from "bullmq"
import { closeAllQueues } from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import { registerLegacyKernelQueueSingleton } from "~/infra/jobs/legacy-kernel-queue"
import { isLeader, LeadershipTestAccess, startLeadership, stopLeadership } from "~/infra/leadership"
import { redis } from "~/lib/redis"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const leaseKeys: string[] = []

function leaseOpts() {
  const key = `boot-singleton-test:${crypto.randomUUID()}`
  leaseKeys.push(key)
  return { key, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 }
}

afterEach(async () => {
  await LeadershipTestAccess.reset()
  if (leaseKeys.length > 0) await redis.del(...leaseKeys)
  leaseKeys.length = 0
})

describe("registerKernelJobs — node lease sweep at boot", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("node lease sweep runs on acquire, not at registerKernelJobs", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue(
      {} as Awaited<ReturnType<Queue["upsertJobScheduler"]>>,
    )
    const nodesJobs = await import("~/modules/nodes/jobs")
    const sweep = spyOn(nodesJobs, "sweepNodeLeases").mockResolvedValue({
      requeued: 0,
      interrupted: 0,
      settledRuns: 0,
      staleSessions: 0,
    })
    try {
      await registerKernelJobs()
      await sleep(100)
      expect(sweep).toHaveBeenCalledTimes(0)

      await startLeadership({ role: "all", lease: leaseOpts() })
      expect(isLeader()).toBe(true)
      const deadline = Date.now() + 2_000
      while (sweep.mock.calls.length === 0 && Date.now() < deadline) await sleep(10)
      expect(sweep).toHaveBeenCalledTimes(1)
    } finally {
      upsert.mockRestore()
      sweep.mockRestore()
    }
  }, 30_000)
})

describe("legacy app-kernel migration as a singleton", () => {
  function fakeMigration() {
    const runs: Array<{ done: boolean }> = []
    const migrate = async () => {
      const run = { done: false }
      runs.push(run)
      await sleep(50)
      run.done = true
    }
    return { runs, migrate }
  }

  it("leading at boot: the registration awaits one run, and the hook does not repeat it", async () => {
    await startLeadership({ role: "all", lease: leaseOpts() })
    expect(isLeader()).toBe(true)
    const { runs, migrate } = fakeMigration()
    await registerLegacyKernelQueueSingleton(migrate)
    expect(runs.map((r) => r.done)).toEqual([true])
    await sleep(100)
    expect(runs).toHaveLength(1)

    // A later acquisition runs it again.
    await stopLeadership()
    await startLeadership({ role: "all", lease: leaseOpts() })
    const deadline = Date.now() + 2_000
    while (runs.length < 2 && Date.now() < deadline) await sleep(10)
    expect(runs).toHaveLength(2)
  })

  it("not leading at boot: nothing runs until this process takes the lease", async () => {
    const { runs, migrate } = fakeMigration()
    await registerLegacyKernelQueueSingleton(migrate)
    await sleep(100)
    expect(runs).toHaveLength(0)

    await startLeadership({ role: "all", lease: leaseOpts() })
    const deadline = Date.now() + 2_000
    while (runs.length < 1 && Date.now() < deadline) await sleep(10)
    expect(runs).toHaveLength(1)
  })
})
