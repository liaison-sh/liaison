// SPDX-License-Identifier: FSL-1.1-ALv2
// Design audit 2026-09-30, findings 17, 18 and 1 (the metric half): enqueue
// must fail loudly before Redis (noeviction, shared with sessions) runs out of
// memory, must cost one round trip, and each queue must report the age of its
// oldest runnable job so an alert can fire on a stuck cron.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Queue } from "bullmq"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import {
  BackpressureTestAccess,
  getBackpressureState,
  QueueBackpressureError,
} from "./backpressure"
import { closeAllQueues, enqueueAppJob, JobsTestAccess, registerJobWorker } from "./jobs"
import { readQueueHealth } from "./queue-health"

const fresh = (usedRatio: number, depths: Record<string, number> = {}) => ({
  at: Date.now(),
  usedMemory: Math.round(usedRatio * 1_000_000),
  maxMemory: 1_000_000,
  depths: new Map(Object.entries(depths)),
})

// Nothing here needs a job to RUN, only to be accepted or refused, so this
// file registers handlers without hosting workers: no Worker is created, and
// none is torn down mid-poll between blocks (a worker force-closed while
// blocked on Redis rejects "Connection is closed" into whatever test runs next).
beforeAll(() => JobsTestAccess.stopHosting())
afterAll(async () => {
  await closeAllQueues()
  JobsTestAccess.reenableJobWorkers()
})

describe("enqueue backpressure", () => {
  afterEach(() => BackpressureTestAccess.reset())

  it("refuses every enqueue past the hard Redis memory ratio, before touching Redis", async () => {
    registerJobWorker("bp-app", "job", async () => {})
    registerJobWorker("kernel", "local-claim-lapse-sweep", async () => {})
    const add = spyOn(Queue.prototype, "add")
    try {
      BackpressureTestAccess.setSample(fresh(0.95))
      await expect(enqueueAppJob("bp-app", "job", {})).rejects.toBeInstanceOf(
        QueueBackpressureError,
      )
      await expect(
        enqueueAppJob("kernel", "local-claim-lapse-sweep", {}, { delay: 60_000 }),
      ).rejects.toBeInstanceOf(QueueBackpressureError)
      expect(add).not.toHaveBeenCalled()
    } finally {
      add.mockRestore()
    }
  })

  it("sheds bulk work first: past the soft ratio a bulk job is refused, a cron job is not", async () => {
    registerJobWorker("kernel", "search-embedding-backfill", async () => {})
    registerJobWorker("kernel", "local-claim-lapse-sweep", async () => {})
    BackpressureTestAccess.setSample(fresh(0.8))
    await expect(
      enqueueAppJob("kernel", "search-embedding-backfill", {}, { delay: 60_000 }),
    ).rejects.toThrow(/kernel-bulk refused a job \(redis-memory\)/)
    const id = await enqueueAppJob(
      "kernel",
      "local-claim-lapse-sweep",
      {},
      { delay: 60_000, jobId: `bp-cron-${Date.now()}` },
    )
    expect(id).toContain("bp-cron-")
    await (await JobsTestAccess.findJob("kernel", "local-claim-lapse-sweep", id))?.remove()
  })

  it("refuses a queue whose backlog is past the depth limit", async () => {
    registerJobWorker("bp-deep", "job", async () => {})
    BackpressureTestAccess.setSample(fresh(0.1, { "app-bp-deep": 10_000_000 }))
    await expect(enqueueAppJob("bp-deep", "job", {})).rejects.toThrow(/queue-depth/)
  })

  it("samples real Redis (INFO memory + backlog) for the queues it has seen", async () => {
    registerJobWorker("bp-sample", "job", async () => {})
    await enqueueAppJob("bp-sample", "job", {}, { delay: 60_000, jobId: "bp-sample-1" })
    await BackpressureTestAccess.refreshNow()
    const state = getBackpressureState()
    expect(state.sampledAt).not.toBeNull()
    expect(state.refusedSinceBoot).toBe(0)
    // Past the depth limit on the next enqueue only if the sample says so:
    // one delayed job is nowhere near it.
    await enqueueAppJob("bp-sample", "job", {}, { delay: 60_000, jobId: "bp-sample-2" })
    for (const id of ["bp-sample-1", "bp-sample-2"]) {
      await (await JobsTestAccess.findJob("bp-sample", "job", id))?.remove()
    }
  })
})

describe("enqueue with a jobId is one round trip", () => {
  it("never reads the job or its state before adding it", async () => {
    registerJobWorker("rt-app", "job", async () => {})
    const id = `rt-${Date.now()}`
    const getJob = spyOn(Queue.prototype, "getJob")
    try {
      await enqueueAppJob("rt-app", "job", {}, { jobId: id, delay: 60_000 })
      await enqueueAppJob("rt-app", "job", {}, { jobId: id, delay: 60_000 })
      expect(getJob).not.toHaveBeenCalled()
    } finally {
      getJob.mockRestore()
    }
    await (await JobsTestAccess.findJob("rt-app", "job", id))?.remove()
  })
})

describe("queue health", () => {
  const QUEUE = "kernel-cron-health-probe"
  const probe = new Queue(QUEUE, { connection: redisBullMQ, prefix: bullPrefix })
  afterAll(async () => {
    await probe.obliterate({ force: true })
    await probe.close()
  })

  it("reports backlog and the age of the oldest runnable job, from when it became runnable", async () => {
    await probe.obliterate({ force: true })
    const now = Date.now()
    await probe.add("a", {}, { timestamp: now - 300_000 })
    await probe.add("b", {}, { timestamp: now - 10_000 })
    // Created long ago but only runnable in the future: not waiting yet.
    await probe.add("c", {}, { timestamp: now - 900_000, delay: 3_600_000 })
    const [h] = await readQueueHealth(redisBullMQ, [QUEUE], now)
    expect(h).toMatchObject({ queue: QUEUE, waiting: 2, delayed: 1, active: 0 })
    expect(h!.oldestWaitingAgeSec).toBe(300)
    expect(h!.stale).toBe(h!.oldestWaitingAgeSec! > h!.alertAfterSec)
  })

  it("finds the oldest prioritized job of a kernel class's priority band", async () => {
    const cron = new Queue("kernel-cron", { connection: redisBullMQ, prefix: bullPrefix })
    const now = Date.now()
    const job = await cron.add(
      "audit-log-retention",
      {},
      { priority: 10, timestamp: now - 400_000 },
    )
    try {
      const [h] = await readQueueHealth(redisBullMQ, ["kernel-cron"], now)
      expect(h!.prioritized).toBeGreaterThanOrEqual(1)
      expect(h!.oldestWaitingAgeSec).toBeGreaterThanOrEqual(400)
      // Cron alert threshold is two minutes: a job 400 s old is stale.
      expect(h!.stale).toBe(true)
    } finally {
      await job.remove()
      await cron.close()
    }
  })
})
