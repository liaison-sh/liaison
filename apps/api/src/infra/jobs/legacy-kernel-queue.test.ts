// SPDX-License-Identifier: FSL-1.1-ALv2
// The kernel moved from one shared `app-kernel` queue to class queues. What
// production holds in `app-kernel` at deploy time (on 2026-09-30: 18 cron
// schedulers, approval-expiry and consolidation jobs delayed under their
// logical ids, and at times thousands of waiting search jobs) must all still
// run: schedulers and delayed jobs move, waiting jobs drain by name.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Queue } from "bullmq"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import {
  closeAllQueues,
  getJobQueue,
  getLegacyKernelQueue,
  JobsTestAccess,
  registerJobWorker,
} from "./jobs"
import { decodeLegacyJobId } from "./legacy-job-ids"
import { migrateLegacyKernelQueue } from "./legacy-kernel-queue"
import { LEGACY_KERNEL_QUEUE } from "./queue-classes"

/** The id an older build gave a job with a logical id containing ':'. */
const legacyId = (logical: string) => `job-${Buffer.from(logical).toString("base64url")}`

describe("legacy app-kernel migration", () => {
  // A raw handle on the legacy queue, as the previous build wrote to it.
  const legacy = new Queue(LEGACY_KERNEL_QUEUE, { connection: redisBullMQ, prefix: bullPrefix })

  // The migration runs only in the process that leads (it returns early otherwise).
  beforeAll(async () => {
    await startLeadership({
      role: "all",
      lease: {
        key: `legacy-kernel-queue-test:${crypto.randomUUID()}`,
        ttlMs: 3_000,
        renewMs: 1_000,
        pollMs: 250,
      },
    })
  })

  beforeEach(async () => {
    JobsTestAccess.stopHosting()
    await legacy.obliterate({ force: true })
    for (const name of ["approval-expiry-sweep", "approval-expiry"]) {
      await getJobQueue("kernel", name).obliterate({ force: true })
    }
  })
  afterAll(async () => {
    await LeadershipTestAccess.reset()
    await legacy.obliterate({ force: true })
    await legacy.close()
    JobsTestAccess.reenableJobWorkers()
    await closeAllQueues()
  })

  it("decodes the ids older builds minted", () => {
    expect(decodeLegacyJobId(legacyId("approval-expiry:abc"))).toBe("approval-expiry:abc")
    expect(decodeLegacyJobId("plain-id")).toBe("plain-id")
    expect(decodeLegacyJobId("12345")).toBeUndefined()
  })

  it("moves schedulers and delayed jobs to their class queue, keeping ids and due times", async () => {
    registerJobWorker("kernel", "approval-expiry-sweep", async () => {})
    registerJobWorker("kernel", "approval-expiry", async () => {})
    await legacy.upsertJobScheduler(
      "approval-expiry-sweep-scheduler",
      { pattern: "*/2 * * * *" },
      { name: "approval-expiry-sweep", data: { __scheduledJitterSeed: "x" } },
    )
    const now = Date.now()
    await legacy.add(
      "approval-expiry",
      { orgId: "o1", requestId: "r1" },
      { jobId: legacyId("approval-expiry:r1"), delay: 600_000, timestamp: now },
    )
    // A job whose app is gone stays where it is, for the drain worker.
    await legacy.add("no-such-kernel-job", {}, { delay: 600_000 })
    // So does a delayed job with an auto id: nothing addresses it by id, and
    // moving it add-then-remove could run it twice after a crash.
    await legacy.add("approval-expiry", { orgId: "o1", requestId: "auto" }, { delay: 600_000 })

    const result = await migrateLegacyKernelQueue(now)
    expect(result).toEqual({ schedulersMoved: 1, delayedMoved: 1, left: 2 })

    const cron = getJobQueue("kernel", "approval-expiry-sweep")
    expect(await cron.getJobScheduler("approval-expiry-sweep-scheduler")).toMatchObject({
      name: "approval-expiry-sweep",
      pattern: "*/2 * * * *",
    })
    expect(await getLegacyKernelQueue().getJobSchedulers(0, -1)).toEqual([])

    const moved = await JobsTestAccess.findJob("kernel", "approval-expiry", "approval-expiry:r1")
    expect(moved?.data).toEqual({ orgId: "o1", requestId: "r1" })
    const dueAt = (moved?.timestamp ?? 0) + (moved?.delay ?? 0)
    expect(Math.abs(dueAt - (now + 600_000))).toBeLessThan(5_000)
    expect(await legacy.getJob(legacyId("approval-expiry:r1"))).toBeUndefined()
    expect(await legacy.getDelayedCount()).toBe(2)

    // Idempotent: a second boot moves nothing twice.
    expect(await migrateLegacyKernelQueue()).toEqual({
      schedulersMoved: 0,
      delayedMoved: 0,
      left: 2,
    })
  })

  it("a crash between add and remove does not double a moved job on the next boot", async () => {
    registerJobWorker("kernel", "approval-expiry", async () => {})
    const now = Date.now()
    const addLegacy = () =>
      legacy.add(
        "approval-expiry",
        { orgId: "o1", requestId: "r2" },
        { jobId: legacyId("approval-expiry:r2"), delay: 600_000, timestamp: now },
      )
    await addLegacy()
    await migrateLegacyKernelQueue(now)
    // The crash: the legacy copy is back, as if its remove never ran.
    await addLegacy()
    await migrateLegacyKernelQueue(now)
    const target = getJobQueue("kernel", "approval-expiry")
    const copies = (await target.getDelayed(0, -1)).filter((j) => j.data?.requestId === "r2")
    expect(copies).toHaveLength(1)
    expect(await legacy.getDelayedCount()).toBe(0)
  })

  it("keeps a scheduler the boot registration already put on the class queue", async () => {
    registerJobWorker("kernel", "approval-expiry-sweep", async () => {})
    const cron = getJobQueue("kernel", "approval-expiry-sweep")
    await cron.upsertJobScheduler(
      "approval-expiry-sweep-scheduler",
      { pattern: "*/3 * * * *" },
      { name: "approval-expiry-sweep" },
    )
    await legacy.upsertJobScheduler(
      "approval-expiry-sweep-scheduler",
      { pattern: "*/2 * * * *" },
      { name: "approval-expiry-sweep" },
    )
    await migrateLegacyKernelQueue()
    expect((await cron.getJobScheduler("approval-expiry-sweep-scheduler"))?.pattern).toBe(
      "*/3 * * * *",
    )
    expect(await legacy.getJobSchedulers(0, -1)).toEqual([])
  })
})

describe("legacy app-kernel drain", () => {
  const legacy = new Queue(LEGACY_KERNEL_QUEUE, { connection: redisBullMQ, prefix: bullPrefix })
  afterAll(async () => {
    await legacy.obliterate({ force: true })
    await legacy.close()
    await closeAllQueues()
  })

  it("a job host runs a job still WAITING in app-kernel by its name", async () => {
    await legacy.obliterate({ force: true })
    JobsTestAccess.reenableJobWorkers()
    const ran = new Promise<unknown>((resolve) => {
      registerJobWorker("kernel", "attention-digest-urgent", async (p) => resolve(p))
    })
    expect(JobsTestAccess.getWorkerForQueue(LEGACY_KERNEL_QUEUE)).toBeDefined()
    await legacy.add("attention-digest-urgent", { from: "before-the-split" })
    const payload = await Promise.race([
      ran,
      new Promise((r) => setTimeout(() => r("timeout"), 5_000)),
    ])
    expect(payload).toEqual({ from: "before-the-split" })
  })
})
