// SPDX-License-Identifier: FSL-1.1-ALv2
// The job drain at shutdown (S9 step 5, A16, skeptic M3), on real Redis.
//
// Two hosts: this process's job module is host A (the one shutting down); a
// plain BullMQ Worker on the same queue stands for host B, another process. The
// job module keeps one host per process, so a second host in-process is not
// possible; to BullMQ a second Worker is exactly another process.
import { afterAll, describe, expect, it } from "bun:test"
import { Worker } from "bullmq"
import { FairnessTestAccess } from "~/infra/jobs/fairness"
import {
  enqueueAppJob,
  getJobQueue,
  JobsTestAccess,
  jobsBouncedWhileDraining,
  jobsClaimedWhileDraining,
  registerJobShutdownPhases,
  registerJobWorker,
} from "~/infra/jobs/jobs"
import { bullPrefix, redis, redisBullMQ } from "~/lib/redis"
import { beginShutdown, ShutdownTestAccess } from "~/lib/shutdown"
import { rememberOrgAppStates } from "~/modules/apps/org-apps"
import { waitFor } from "~/tests/helpers/wait-for"

type Mark = {
  host: "A" | "B"
  id: string
  kind: "start" | "end" | "abort"
  at: number
  /** The job's attemptsMade when its handler started (host B only). */
  attemptsMade?: number
}

const APP = "jobtest-drain"
const JOB = "work"

describe("job drain at shutdown", () => {
  const marks: Mark[] = []
  const mark = (host: Mark["host"], id: string, kind: Mark["kind"], attemptsMade?: number) =>
    marks.push({ host, id, kind, at: Date.now(), attemptsMade })
  const of = (id: string, kind?: Mark["kind"]) =>
    marks.filter((m) => m.id === id && (!kind || m.kind === kind))
  let hostB: Worker | null = null

  afterAll(async () => {
    await hostB?.close(true)
    ShutdownTestAccess.reset()
  })

  it("claims no new job once draining, finishes a short job, aborts then hands back a long one", async () => {
    registerJobWorker<{ id: string; ms: number }>(APP, JOB, async ({ id, ms }, ctx) => {
      mark("A", id, "start")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        ctx?.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          mark("A", id, "abort")
          reject(new Error("aborted for shutdown"))
        })
      })
      mark("A", id, "end")
    })
    const run = Date.now().toString(36)
    const short = `short-${run}`
    const long = `long-${run}`
    await enqueueAppJob(APP, JOB, { id: short, ms: 3_000 })
    // One attempt: a hand-back that spent it would fail the job instead.
    await enqueueAppJob(APP, JOB, { id: long, ms: 60_000 }, { attempts: 1 })
    await waitFor(() => of(short, "start").length === 1 && of(long, "start").length === 1, {
      label: "both jobs to start on A",
      timeoutMs: 15_000,
    })

    const exits: number[] = []
    ShutdownTestAccess.configure({
      exit: (code) => exits.push(code),
      edgeGraceMs: 0,
      budgets: { jobDrainMs: 5_000 },
    })
    registerJobShutdownPhases()
    const done = beginShutdown("test")

    // Host B comes up, as a new process would during a deploy.
    const queueName = getJobQueue(APP, JOB).name
    hostB = new Worker(
      queueName,
      async (job) => {
        const { id } = job.data as { id: string }
        mark("B", id, "start", job.attemptsMade)
        await Bun.sleep(20)
        mark("B", id, "end")
      },
      { connection: redisBullMQ, prefix: bullPrefix, concurrency: 5 },
    )
    const fresh = Array.from({ length: 5 }, (_, i) => `fresh-${run}-${i}`)
    for (const id of fresh) await enqueueAppJob(APP, JOB, { id, ms: 10 })

    await done
    await waitFor(
      () => fresh.every((id) => of(id, "end").length === 1) && of(long, "end").length === 1,
      { label: "B to run the new jobs and the handed-back one", timeoutMs: 20_000 },
    )

    // (a) the draining host claims none of the jobs enqueued after t0: a fetch
    // already in flight at t0 may bring one in, and it goes back unrun.
    expect(jobsClaimedWhileDraining()).toBe(0)
    expect(jobsBouncedWhileDraining()).toBeLessThanOrEqual(1)
    for (const id of fresh) {
      expect(of(id).filter((m) => m.host === "A")).toEqual([])
      expect(of(id, "start").length).toBe(1)
    }
    // (b) the 3 s job running at t0 completes once, on A, never handed back.
    expect(of(short, "start").map((m) => m.host)).toEqual(["A"])
    expect(of(short, "end").map((m) => m.host)).toEqual(["A"])
    // (c) the long job: A observed the abort before B started it (no overlap),
    // and it completed once, on B.
    const [abortA] = of(long, "abort")
    const [startB] = of(long, "start").filter((m) => m.host === "B")
    expect(abortA?.host).toBe("A")
    expect(startB).toBeDefined()
    expect(abortA?.at ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(startB?.at ?? 0)
    expect(of(long, "start").map((m) => m.host)).toEqual(["A", "B"])
    // Handed back unspent: B sees it as a first attempt.
    expect(startB?.attemptsMade).toBe(0)
    expect(of(long, "end").map((m) => m.host)).toEqual(["B"])
    expect(exits).toEqual([0])
  }, 60_000)

  it("a job whose handler ignores the abort is handed back at exit, unspent, across two drains", async () => {
    // Test 1's host B would take the job: this test brings its own.
    await hostB?.close()
    hostB = null
    const run = Date.now().toString(36)
    const stuck = `stuck-${run}`
    // A process that is about to exit: its job module, as the exit leaves it in
    // Redis, and a fresh one for the next process (no close, no hand-back).
    const freshProcess = () => {
      JobsTestAccess.forgetProcess()
      ShutdownTestAccess.reset()
      // Never settles: a handler that does not read ctx.signal, wedged until its
      // process exits.
      registerJobWorker<{ id: string }>(APP, JOB, async ({ id }) => {
        mark("A", id, "start")
        await new Promise<void>(() => {})
      })
    }
    const drain = async () => {
      const exits: number[] = []
      ShutdownTestAccess.configure({
        exit: (code) => exits.push(code),
        edgeGraceMs: 0,
        budgets: { jobDrainMs: 1_000 },
      })
      registerJobShutdownPhases()
      await beginShutdown("test")
      expect(exits).toEqual([0])
    }

    freshProcess()
    await enqueueAppJob(APP, JOB, { id: stuck }, { attempts: 1 })
    await waitFor(() => of(stuck, "start").length === 1, { label: "A1 starts", timeoutMs: 15_000 })
    await drain()

    // The next process of the deploy takes it, and is drained in its turn.
    freshProcess()
    await waitFor(() => of(stuck, "start").length === 2, { label: "A2 starts", timeoutMs: 15_000 })
    await drain()

    JobsTestAccess.forgetProcess()
    ShutdownTestAccess.reset()
    hostB = new Worker(
      getJobQueue(APP, JOB).name,
      async (job) => {
        const { id } = job.data as { id: string }
        mark("B", id, "start", job.attemptsMade)
        mark("B", id, "end")
      },
      { connection: redisBullMQ, prefix: bullPrefix },
    )
    const queue = getJobQueue(APP, JOB)
    await waitFor(
      async () =>
        of(stuck, "end").length === 1 && (await queue.getJobCounts("active")).active === 0,
      { label: "B completes it", timeoutMs: 15_000 },
    )
    // Nothing runs it again afterwards.
    await Bun.sleep(300)

    expect(of(stuck, "start").map((m) => m.host)).toEqual(["A", "A", "B"])
    expect(of(stuck, "end").map((m) => m.host)).toEqual(["B"])
    // Neither hand-back spent the job's only attempt nor counted as a stall.
    expect(of(stuck, "start")[2]?.attemptsMade).toBe(0)
    expect(await queue.getJobCounts("active", "failed")).toEqual({ active: 0, failed: 0 })
  }, 60_000)

  it("a drain-aborted job's and a handed-back job's fairness tokens are released", async () => {
    await hostB?.close()
    hostB = null
    JobsTestAccess.forgetProcess()
    ShutdownTestAccess.reset()
    const orgId = crypto.randomUUID()
    rememberOrgAppStates(orgId, [])
    JobsTestAccess.setOrgEnsure(async () => {})
    try {
      registerJobWorker<{ id: string; obey: boolean }>(APP, JOB, async ({ id, obey }, ctx) => {
        mark("A", id, "start")
        await new Promise<void>((_, reject) => {
          if (obey) ctx?.signal.addEventListener("abort", () => reject(new Error("aborted")))
        })
      })
      const run = Date.now().toString(36)
      const aborted = `fair-abort-${run}`
      const handed = `fair-handed-${run}`
      await enqueueAppJob(APP, JOB, { orgId, id: aborted, obey: true }, { attempts: 1 })
      await enqueueAppJob(APP, JOB, { orgId, id: handed, obey: false }, { attempts: 1 })
      await waitFor(() => of(aborted, "start").length === 1 && of(handed, "start").length === 1, {
        label: "both org jobs start",
        timeoutMs: 15_000,
      })
      const tokens = FairnessTestAccess.keys.tokKey(getJobQueue(APP, JOB).name, orgId)
      expect(await redis.zcard(tokens)).toBe(2)
      ShutdownTestAccess.configure({ exit: () => {}, edgeGraceMs: 0, budgets: { jobDrainMs: 500 } })
      registerJobShutdownPhases()
      await beginShutdown("test")
      expect(await redis.zcard(tokens)).toBe(0)
    } finally {
      JobsTestAccess.setOrgEnsure(undefined)
      JobsTestAccess.forgetProcess()
      ShutdownTestAccess.reset()
      await getJobQueue(APP, JOB).obliterate({ force: true })
    }
  }, 60_000)
})
