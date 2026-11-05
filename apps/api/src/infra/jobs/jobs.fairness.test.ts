// SPDX-License-Identifier: FSL-1.1-ALv2
// The fairness gate wired into the job worker (jobs.ts + fairness.ts), on real
// Redis and this process's real BullMQ workers: an over-cap job waits unrun,
// every exit gives its token back, a sub-run chain passes the cap as nested.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { bullPrefix, REDIS_PREFIX, redis, redisBullMQ } from "~/lib/redis"
import { rememberOrgAppStates } from "~/modules/apps/org-apps"
import { waitFor } from "~/tests/helpers/wait-for"
import {
  FAIR_TIER,
  FairnessTestAccess,
  readQueueFairness,
  readWaitP95Ms,
  recordJobWait,
} from "./fairness"
import {
  closeAllQueues,
  enqueueAppJob,
  getJobQueue,
  JobsTestAccess,
  registerJobWorker,
  registerScheduledJob,
  removeAppJob,
  upsertJobScheduler,
} from "./jobs"

const K = FairnessTestAccess.keys
const uuid = () => crypto.randomUUID()

/** An org that exists here, with every app On; its setup is a no-op. */
function anOrg(): string {
  const orgId = uuid()
  rememberOrgAppStates(orgId, [])
  return orgId
}

/** Another org with a due job waiting on `queue`: the gate sees contention. */
async function contend(queue: string): Promise<() => Promise<void>> {
  const other = uuid()
  const id = `contend-${other}`
  // The job's hash with no list entry: waiting to the gate, out of every worker's reach.
  const jobKey = `${bullPrefix}:${queue}:${id}`
  await redisBullMQ.hset(jobKey, "name", "contend", "timestamp", Date.now())
  await redis.zadd(K.qKey(queue, other), Date.now() - 1_000, id)
  await redis.zadd(K.orgsKey(queue), Date.now() - 1_000, other)
  return async () => {
    await redisBullMQ.del(jobKey)
    await redis.del(K.qKey(queue, other))
    await redis.zrem(K.orgsKey(queue), other)
  }
}

JobsTestAccess.setOrgEnsure(async () => {})

afterEach(() => {
  FairnessTestAccess.reset()
})
afterAll(async () => {
  JobsTestAccess.setOrgEnsure(undefined)
  JobsTestAccess.reenableJobWorkers()
  await closeAllQueues()
})

describe("the worker's fairness gate", () => {
  it("an over-cap job is delayed with attemptsMade unchanged and its handler not called; the release promotes it", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const orgId = anOrg()
    const started: number[] = []
    let releaseFirst: () => void = () => {}
    const held = new Promise<void>((r) => {
      releaseFirst = r
    })
    registerJobWorker<{ i: number }>("jobtest-fair", "work", async ({ i }) => {
      started.push(i)
      if (i === 1) await held
    })
    await enqueueAppJob("jobtest-fair", "work", { orgId, i: 1 }, { jobId: `fair-1-${orgId}` })
    await waitFor(() => started.includes(1), { label: "job 1 to start" })
    await enqueueAppJob("jobtest-fair", "work", { orgId, i: 2 }, { jobId: `fair-2-${orgId}` })
    const queue = getJobQueue("jobtest-fair", "work")
    await waitFor(async () => (await redis.zcard(K.parkKey(queue.name, orgId))) === 1, {
      label: "job 2 to be parked",
    })
    const parked = await JobsTestAccess.findJob("jobtest-fair", "work", `fair-2-${orgId}`)
    expect(await parked?.getState()).toBe("delayed")
    expect(parked?.attemptsMade).toBe(0)
    expect(started).toEqual([1])
    releaseFirst()
    await waitFor(() => started.includes(2), { label: "job 2 promoted", timeoutMs: 2_000 })
    await waitFor(async () => (await redis.zcard(K.tokKey(queue.name, orgId))) === 0, {
      label: "every token released",
    })
  })

  it("a job parked for 30 s starts when its org's running job ends, by promotion", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    FairnessTestAccess.setParkDelayMs(30_000)
    const orgId = anOrg()
    const started: number[] = []
    let releaseFirst: () => void = () => {}
    const held = new Promise<void>((r) => {
      releaseFirst = r
    })
    registerJobWorker<{ i: number }>("jobtest-fair-promo", "work", async ({ i }) => {
      started.push(i)
      if (i === 1) await held
    })
    const queue = getJobQueue("jobtest-fair-promo", "work").name
    await enqueueAppJob(
      "jobtest-fair-promo",
      "work",
      { orgId, i: 1 },
      { jobId: `promo-1-${orgId}` },
    )
    await waitFor(() => started.includes(1), { label: "job 1 to start" })
    const promotedBefore = (await readQueueFairness(queue)).promoted
    await enqueueAppJob(
      "jobtest-fair-promo",
      "work",
      { orgId, i: 2 },
      { jobId: `promo-2-${orgId}` },
    )
    await waitFor(async () => (await redis.zcard(K.parkKey(queue, orgId))) === 1, {
      label: "job 2 to be parked",
    })
    const t0 = Date.now()
    releaseFirst()
    await waitFor(() => started.includes(2), { label: "job 2 promoted", timeoutMs: 5_000 })
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect((await readQueueFairness(queue)).promoted).toBe(promotedBefore + 1)
  }, 20_000)

  it("scheduler-minted jobs take their class tier start, replaced by the next upsert", async () => {
    const cron = "0 0 1 1 *"
    // A YIELD (10) kernel cron and a routine tick (5).
    await registerScheduledJob("kernel", "audit-log-retention", cron, async () => {})
    const cronQueue = getJobQueue("kernel", "audit-log-retention")
    const sched = await cronQueue.getJobScheduler("audit-log-retention-scheduler")
    expect(sched?.template?.opts?.priority).toBe(FAIR_TIER[10])
    await cronQueue.removeJobScheduler("audit-log-retention-scheduler")
    const id = `routine:${uuid()}`
    await upsertJobScheduler("kernel", "routine-tick", cron, { schedulerId: id, orgId: uuid() })
    const agentQueue = getJobQueue("kernel", "routine-tick")
    expect((await agentQueue.getJobScheduler(id))?.template?.opts?.priority).toBe(FAIR_TIER[5])
    await agentQueue.removeJobScheduler(id)
  })

  it("a chain of 3 sub-runs at cap 2 completes (with nested minting off it is stuck)", async () => {
    // A chain holds one kernel-agent slot per waiting level: plan the slots
    // against production's default privileged pool (15, 4 agent slots), as
    // sub-agent-smoke does, not the runner's 8-connection pool (1 agent slot,
    // where the child would queue behind its own parent). The agent worker
    // binds afresh at that plan.
    await closeAllQueues()
    JobsTestAccess.setKernelSlotPool(15)
    FairnessTestAccess.setCellConcurrency(4)
    const queue = getJobQueue("kernel", "agent-subrun").name
    const release = await contend(queue)
    const waiters = new Map<string, () => void>()
    const finished = new Set<string>()
    let giveUp: () => void = () => {}
    const abandoned = new Promise<void>((r) => {
      giveUp = r
    })
    type Step = { orgId: string; depth: number; tag: string }
    const step = async ({ orgId, depth, tag }: Step) => {
      if (depth < 2) {
        const child = uuid()
        const childDone = new Promise<void>((r) => waiters.set(child, r))
        await enqueueAppJob(
          "kernel",
          "agent-subrun",
          { orgId, depth: depth + 1, tag: child },
          { attempts: 1 },
        )
        await Promise.race([childDone, abandoned])
      }
      finished.add(tag)
      waiters.get(tag)?.()
    }
    registerJobWorker<Step>("kernel", "agent-reinvoke", step)
    registerJobWorker<Step>("kernel", "agent-subrun", step)
    try {
      const orgA = anOrg()
      const rootA = uuid()
      await enqueueAppJob("kernel", "agent-reinvoke", { orgId: orgA, depth: 0, tag: rootA })
      await waitFor(() => finished.has(rootA), { label: "the nested chain", timeoutMs: 8_000 })

      FairnessTestAccess.setNestedMinting(false)
      const orgB = anOrg()
      const rootB = uuid()
      await enqueueAppJob("kernel", "agent-reinvoke", { orgId: orgB, depth: 0, tag: rootB })
      await Bun.sleep(3_000)
      expect(finished.has(rootB)).toBe(false)
      expect(await redis.zcard(K.parkKey(queue, orgB))).toBe(1)
      giveUp()
      await waitFor(() => finished.has(rootB), {
        label: "the stuck chain to unwind",
        timeoutMs: 8_000,
      })
    } finally {
      giveUp()
      await release()
      JobsTestAccess.setKernelSlotPool(undefined)
    }
  }, 30_000)

  it("a sub-run enqueued outside any job (a chat parent) is not nested", async () => {
    const orgId = anOrg()
    const queue = getJobQueue("kernel", "agent-subrun")
    const id = await enqueueAppJob(
      "kernel",
      "agent-subrun",
      { orgId, depth: 9, tag: "chat" },
      { delay: 3_600_000, attempts: 1 },
    )
    expect(id.startsWith("n.")).toBe(false)
    const job = await queue.getJob(id)
    expect(job?.opts.priority).toBeGreaterThan(1)
    await job?.remove()
    await redis.del(K.qKey(queue.name, orgId))
    await redis.zrem(K.orgsKey(queue.name), orgId)
  })

  it("a removed job leaves no turn record behind", async () => {
    const orgId = anOrg()
    registerJobWorker("jobtest-fair-rm", "later", async () => {})
    const queue = getJobQueue("jobtest-fair-rm", "later").name
    await enqueueAppJob("jobtest-fair-rm", "later", { orgId }, { jobId: "rm-1", delay: 3_600_000 })
    expect(await redis.zcard(K.qKey(queue, orgId))).toBe(1)
    await removeAppJob("jobtest-fair-rm", "later", "rm-1")
    expect(await redis.zcard(K.qKey(queue, orgId))).toBe(0)
  })

  it("isLoadOrg throwing records the job's wait as not load", async () => {
    const queue = `app-jobtest-wait-${uuid().slice(0, 8)}`
    const orgId = uuid()
    const perOrg = async () =>
      (await redisBullMQ.keys(`${REDIS_PREFIX}jobs:wait:${queue}:${orgId}:*`)).length
    FairnessTestAccess.setLoadOrgCheck(async () => {
      throw new Error("flag unreadable")
    })
    await recordJobWait(queue, orgId, 1_234)
    expect(await readWaitP95Ms(queue)).toBe(2_000)
    expect(await perOrg()).toBe(0)
    FairnessTestAccess.setLoadOrgCheck(async () => true)
    await recordJobWait(queue, orgId, 10)
    expect(await perOrg()).toBe(1)
  })

  it("a handed-back job's token is released at hand-back", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const orgId = anOrg()
    let started = false
    registerJobWorker("jobtest-fair-hb", "slow", async () => {
      started = true
      await new Promise<void>(() => {})
    })
    await enqueueAppJob("jobtest-fair-hb", "slow", { orgId }, { jobId: `hb-${orgId}` })
    await waitFor(() => started, { label: "the job to start" })
    const queue = getJobQueue("jobtest-fair-hb", "slow").name
    expect(await redis.zcard(K.tokKey(queue, orgId))).toBe(1)
    await closeAllQueues()
    expect(await redis.zcard(K.tokKey(queue, orgId))).toBe(0)
    JobsTestAccess.stopHosting()
    registerJobWorker("jobtest-fair-hb", "slow", async () => {})
    const job = await JobsTestAccess.findJob("jobtest-fair-hb", "slow", `hb-${orgId}`)
    await job?.remove()
  }, 20_000)
})
