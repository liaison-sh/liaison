// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Job, Queue } from "bullmq"
import { sql } from "~/db"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  areJobWorkersDisabled,
  bindCatalogAppQueues,
  closeAllQueues,
  createAppQueue,
  deferJobWorkersUntilBootComplete,
  disableJobWorkers,
  enqueueAppJob,
  enqueueAppJobForServer,
  JobsTestAccess,
  jobsHeldAppDayCapCount,
  jobsDroppedOrgMissingCount,
  jobWorkerCount,
  listOrgQueuedJobs,
  OrgUnderMaintenanceJobError,
  registerJobWorker,
  registerScheduledJob,
  removeOrgJobSchedulers,
  removeScheduledJob,
  setJobsLeadership,
  startDeferredJobWorkers,
  upsertJobScheduler,
} from "~/infra/jobs/jobs"
import { JobRetryLaterError } from "~/lib/failure-severity"
import { jobsLogger } from "~/lib/logger"
import { armOrgMaintenance, disarmOrgMaintenance } from "~/middleware/org-maintenance"
import { NoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"
import { AppDayCapHeldJobError } from "~/modules/apps/usage/app-day-cap"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { waitFor } from "~/tests/helpers/wait-for"

describe("job dispatch", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("registered handler is called with job payload", async () => {
    let receivedPayload: unknown = null
    registerJobWorker("jobtest", "known-job", async (payload) => {
      receivedPayload = payload
    })

    await enqueueAppJob("jobtest", "known-job", { foo: "bar" })

    // Wait for BullMQ to process
    await waitFor(() => receivedPayload !== null, { label: "the job to run" })
    expect(receivedPayload).toEqual({ foo: "bar" })
  })

  // Regression — a BullMQ Worker re-emits its blocking-connection's errors as
  // its OWN `'error'` event. EventEmitter semantics make an `'error'` emission
  // with no listener *throw* (an uncaught/unhandled error). Without an
  // `worker.on("error", …)` listener, the blocking client being torn down with
  // a pending BZPOPMIN during `closeAllQueues()` — or any transient Redis blip
  // ("Connection is closed", flushed by ioredis on close) — floats as an
  // unhandled error: in the flat unit run that's the suite-failing "Unhandled
  // error between tests" (`1 error`, exit 1); in prod it can crash the process
  // on a Redis reconnect. `registerJobWorker` must attach the listener so the
  // error is handled (logged), not fatal.
  // Regression — a sliding deadline re-armed on every event (the agent-memory
  // episode quiet close) must actually SLIDE. BullMQ ignores an `add` whose
  // jobId already exists, so without `replaceDelayed` the second arm is a no-op
  // and the job keeps firing at the FIRST arm's deadline.
  it("replaceDelayed re-arms a still-delayed job so its deadline slides to the newest arm", async () => {
    registerJobWorker("jobtest-rearm", "sliding", async () => {})
    const queue = createAppQueue("jobtest-rearm")
    const jobId = `sliding-deadline-${Date.now()}`

    await enqueueAppJob("jobtest-rearm", "sliding", { n: 1 }, { jobId, delay: 600_000 })
    const first = await JobsTestAccess.findJob("jobtest-rearm", "sliding", jobId)
    expect(await first?.getState()).toBe("delayed")
    const firstDeadline = (first?.timestamp ?? 0) + (first?.delay ?? 0)

    await new Promise((r) => setTimeout(r, 25))

    // Re-arm with the SAME id and the same delay, later in wall-clock time.
    await enqueueAppJob(
      "jobtest-rearm",
      "sliding",
      { n: 2 },
      { jobId, delay: 600_000, replaceDelayed: true },
    )
    const second = await JobsTestAccess.findJob("jobtest-rearm", "sliding", jobId)
    expect(await second?.getState()).toBe("delayed")
    const secondDeadline = (second?.timestamp ?? 0) + (second?.delay ?? 0)

    // The deadline moved forward, and the job carries the NEWEST payload.
    expect(secondDeadline).toBeGreaterThan(firstDeadline)
    expect(second?.data).toEqual({ n: 2 })

    // Exactly one job for this id — the re-arm replaced, it did not stack.
    expect(await queue.getDelayedCount()).toBe(1)
    await second?.remove()
  })

  it("registerJobWorker attaches an 'error' listener so connection errors don't float (M-?)", () => {
    registerJobWorker("jobtest-err", "noop", async () => {})
    const worker = JobsTestAccess.getWorker("jobtest-err")
    expect(worker).toBeDefined()
    // A listener must be attached — otherwise the next line would THROW
    // (EventEmitter: emit('error') with zero listeners re-throws the error).
    expect(worker!.listenerCount("error")).toBeGreaterThan(0)
    // Emitting an 'error' must NOT throw / escape now that a listener handles it.
    // Without the fix this throws synchronously and fails the test.
    expect(() => worker!.emit("error", new Error("Connection is closed"))).not.toThrow()
  })

  it("workers are named after the process", async () => {
    registerJobWorker("jobtest-named", "noop", async () => {})
    const queue = createAppQueue("jobtest-named")
    // getWorkers() reports `name` = the queue and `rawname` = the Redis client
    // name, `<queue client>:w:<worker name>`. The Worker's blocking connection
    // sets it asynchronously.
    const rawNames = async () => (await queue.getWorkers()).map((w) => String(w.rawname ?? ""))
    await waitFor(async () => (await rawNames()).some((n) => n.endsWith(`:w:${INSTANCE_ID}`)), {
      label: "the named worker to show in getWorkers()",
    })
    expect((await rawNames()).filter((n) => n.includes(INSTANCE_ID)).length).toBeGreaterThan(0)
  })

  it("unregistered job name throws before reaching BullMQ (M-13)", async () => {
    // enqueueAppJob now validates the handler exists before enqueuing
    // so unregistered jobs are rejected synchronously
    await expect(enqueueAppJob("jobtest", "ghost-job", {}, { attempts: 1 })).rejects.toThrow(
      'No handler registered for job "jobtest:ghost-job"',
    )
  })
})

// A scheduled job of an app whose connection the workspace never connected (or
// disconnected) used to throw "No connected account" on every tick: logged as a
// "Job handler error", retried, then "exhausted all retries", in every such
// workspace. With no account there is nothing to do, so the run is a quiet
// no-op. A failure with an account (an expired token, a provider error) still
// fails loudly and is retried.
describe("job whose connection has no connected account", () => {
  it("is a no-op, also when the error crossed the sandbox as a plain message", async () => {
    let calls = 0
    registerJobWorker("jobtest", "no-account-typed", async () => {
      calls++
      throw new NoConnectedAccountError("google-calendar")
    })
    registerJobWorker("jobtest", "no-account-sandboxed", async () => {
      calls++
      // What a sandboxed handler's rejection carries back: only the message.
      throw new Error('Error: No connected account for connection "google-calendar"')
    })
    await expect(
      JobsTestAccess.processJob("jobtest", "no-account-typed", {}),
    ).resolves.toBeUndefined()
    await expect(
      JobsTestAccess.processJob("jobtest", "no-account-sandboxed", {}),
    ).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it("still fails loudly when an account exists but the call fails", async () => {
    registerJobWorker("jobtest", "account-call-fails", async () => {
      throw new Error("Token refresh failed (400): invalid_grant")
    })
    await expect(JobsTestAccess.processJob("jobtest", "account-call-fails", {})).rejects.toThrow(
      "Token refresh failed",
    )
  })
})

// A job that asks to run later (the search rebuild finding its lock held) did
// nothing wrong: it is retried like any failure but logs at warn, so the
// watchdog does not page an expected wait. A real failure still logs at error.
describe("job that asks to run later", () => {
  it("logs at warn with its reason and still throws so the queue retries it", async () => {
    registerJobWorker("jobtest", "retry-later", async () => {
      throw new JobRetryLaterError("lock is held; retrying later", "lock_held")
    })
    registerJobWorker("jobtest", "real-failure", async () => {
      throw new Error("boom")
    })
    const warn = spyOn(jobsLogger, "warn")
    const error = spyOn(jobsLogger, "error")
    try {
      await expect(JobsTestAccess.processJob("jobtest", "retry-later", {})).rejects.toBeInstanceOf(
        JobRetryLaterError,
      )
      const deferred = warn.mock.calls.find((c) => c[1] === "Job deferred: retrying later")
      expect(deferred?.[0]).toMatchObject({ reason: "retry_later", waitingOn: "lock_held" })
      expect(error.mock.calls.some((c) => c[1] === "Job handler error")).toBe(false)

      await expect(JobsTestAccess.processJob("jobtest", "real-failure", {})).rejects.toThrow("boom")
      expect(error.mock.calls.some((c) => c[1] === "Job handler error")).toBe(true)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})

// An app job of an org at an app day cap (modules/apps/usage/app-day-cap.ts):
// back on its queue as delayed until the next UTC day, its data kept and no
// attempt spent, so the cap never turns into a failed or dropped job.
describe("job held by an app day cap", () => {
  it("is moved to delayed with its data, no attempt spent", async () => {
    let runs = 0
    registerJobWorker("jobtest-capheld", "capped", async () => {
      runs++
      throw new AppDayCapHeldJobError("org-at-cap", 600_000, "appRunsPerDay")
    })
    const heldBefore = jobsHeldAppDayCapCount()
    const jobId = await enqueueAppJob("jobtest-capheld", "capped", { marker: "m-1" })
    await waitFor(() => runs > 0 && jobsHeldAppDayCapCount() > heldBefore, {
      label: "the capped job to be held",
    })
    const job = await JobsTestAccess.findJob("jobtest-capheld", "capped", jobId)
    try {
      expect(await job?.getState()).toBe("delayed")
      expect(job?.data).toMatchObject({ marker: "m-1" })
      expect(job?.attemptsMade ?? -1).toBe(0)
      // Held until the error's delay, not BullMQ's retry backoff.
      expect((job?.timestamp ?? 0) + (job?.delay ?? 0)).toBeGreaterThan(Date.now() + 500_000)
      expect(runs).toBe(1)
    } finally {
      await job?.remove()
    }
  })
})

// Regression — the per-org migration maintenance gate (armOrgMaintenance/
// disarmOrgMaintenance) only ever blocked HTTP traffic via maintenance.ts;
// a routine tick, webhook delivery or event-routine job reaches the worker
// directly (never through Hono middleware) and opened its transaction
// unguarded, writing the very rows the migration is rekeying.
// A shutdown force-closes the workers. A job still running used to stay ACTIVE
// under a lock nobody renewed, holding its deduplication id: the next boot's
// request for the same job (the search rebuild after a restart) was merged into
// the dead one and nothing ran until BullMQ's stalled check, about a minute on.
describe("shutdown hands running jobs back", () => {
  afterAll(async () => {
    JobsTestAccess.reenableJobWorkers()
    await closeAllQueues()
  })

  it("a job running at shutdown is queued again, its dedup id still pointing at it", async () => {
    let started = false
    let release: () => void = () => {}
    registerJobWorker("jobtest", "slow-at-shutdown", async () => {
      started = true
      await new Promise<void>((r) => {
        release = r
      })
    })
    const logicalId = `slow-${crypto.randomUUID()}`
    await enqueueAppJob("jobtest", "slow-at-shutdown", {}, { jobId: logicalId })
    await waitFor(() => started, { label: "the job to start" })
    const job = await JobsTestAccess.findJob("jobtest", "slow-at-shutdown", logicalId)
    expect(await job?.getState()).toBe("active")

    await closeAllQueues()
    release()

    // Read it through a fresh queue handle, as the next boot would.
    JobsTestAccess.stopHosting()
    registerJobWorker("jobtest", "slow-at-shutdown", async () => {})
    const after = await JobsTestAccess.findJob("jobtest", "slow-at-shutdown", logicalId)
    expect(after?.id).toBe(job?.id)
    // Waiting, or delayed by a second when a fetch already in flight caught it
    // during the close (the start gate puts it back): never active and lost.
    expect(["waiting", "delayed"]).toContain(String(await after?.getState()))
    // A second request is still merged into it (one job, not two).
    await enqueueAppJob("jobtest", "slow-at-shutdown", {}, { jobId: logicalId })
    const queue = createAppQueue("jobtest")
    const waiting = (await queue.getJobs(["wait", "delayed", "active"])).filter(
      (j) => j?.opts.deduplication?.id === logicalId,
    )
    expect(waiting.map((j) => j.id)).toEqual([job?.id])
    await after?.remove()
  }, 30_000)
})

describe("job worker org-maintenance gate", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await closeAllQueues()
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.ORG_MAINTENANCE_FLAG_PATH
  })

  function useTempFlagPath(): void {
    const d = mkdtempSync(join(tmpdir(), "liaison-jobs-org-maint-"))
    dirs.push(d)
    process.env.ORG_MAINTENANCE_FLAG_PATH = join(d, "maintenance-orgs.json")
  }

  it("never runs the handler for an org-scoped job while that org is armed", async () => {
    useTempFlagPath()
    const orgId = "11111111-1111-1111-1111-111111111111"
    armOrgMaintenance(orgId)

    let ran = false
    registerJobWorker("jobtest-maint", "armed-org-job", async () => {
      ran = true
    })
    const worker = JobsTestAccess.getWorker("jobtest-maint")
    let failureErrorName: string | undefined
    worker?.on("failed", (_job, err) => {
      failureErrorName = err.name
    })

    try {
      await enqueueAppJob(
        "jobtest-maint",
        "armed-org-job",
        { orgId },
        { attempts: 1, backoff: { type: "fixed", delay: 0 } },
      )
      // Wait for BullMQ to attempt (and fail) the job.
      await waitFor(() => failureErrorName !== undefined, { label: "the job to fail" })
      expect(ran).toBe(false)
      expect(failureErrorName).toBe(new OrgUnderMaintenanceJobError(orgId, "x", "y").name)
    } finally {
      disarmOrgMaintenance(orgId)
    }
  })

  it("runs the handler normally once the org is disarmed", async () => {
    useTempFlagPath()
    const orgId = "22222222-2222-2222-2222-222222222222"
    // An org that exists (a deleted org's job is dropped before it runs).
    rememberOrgAppStates(orgId, [])
    // The org has no database row: stub its setup, which would only log FK errors.
    JobsTestAccess.setOrgEnsure(async () => {})
    armOrgMaintenance(orgId)
    disarmOrgMaintenance(orgId)

    let ran = false
    registerJobWorker("jobtest-maint", "disarmed-org-job", async () => {
      ran = true
    })

    try {
      await enqueueAppJob("jobtest-maint", "disarmed-org-job", { orgId })
      await waitFor(() => ran, { label: "the job to run" })
      expect(ran).toBe(true)
    } finally {
      JobsTestAccess.setOrgEnsure(undefined)
    }
  })
})

// Regression — post-deploy warm-up window (Fabrikam staging residue). The
// production entrypoint registers kernel job workers BEFORE per-org app
// registration; jobs left in Redis across a restart (routine-tick,
// agent-reinvoke, knowledge indexing…) then ran sandbox tool calls against
// empty app registries and failed with "Entity … not found in app schema".
// The boot gate makes workers created during boot start paused, released by
// startDeferredJobWorkers() once registries are warm.
describe("job worker boot gate", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("gated worker stays paused until startDeferredJobWorkers, then drains the backlog", async () => {
    deferJobWorkersUntilBootComplete()
    try {
      let ran = false
      registerJobWorker("jobtest-gate", "gated-job", async () => {
        ran = true
      })
      const worker = JobsTestAccess.getWorker("jobtest-gate")
      expect(worker).toBeDefined()
      expect(worker!.isRunning()).toBe(false)

      // Backlog enqueued while the gate is closed must NOT be processed yet.
      await enqueueAppJob("jobtest-gate", "gated-job", {})
      await new Promise((r) => setTimeout(r, 500))
      expect(ran).toBe(false)

      startDeferredJobWorkers()
      expect(worker!.isRunning()).toBe(true)
      await waitFor(() => ran, { label: "the backlog to drain" })
      expect(ran).toBe(true)
    } finally {
      // Never leave the global gate closed for other test files/describes.
      startDeferredJobWorkers()
    }
  })

  // Regression — spawn-agent registers a placeholder kernel worker at module
  // scope, which runs during the entrypoint's IMPORT graph, before index.ts
  // can close the gate. That worker was born autorun:true and drained the
  // Redis backlog against a half-empty handler map ("No handler registered
  // for job: app-kernel:search-index-upsert"), burning retry attempts on
  // every restart. Closing the gate must therefore also PAUSE workers that
  // already exist, not just defer future ones.
  it("closing the gate pauses a worker that was already created while the gate was open", async () => {
    // Gate open (default / restored by previous test): worker autoruns.
    let ran = 0
    registerJobWorker("jobtest-pregate", "pregate-job", async () => {
      ran++
    })
    const worker = JobsTestAccess.getWorker("jobtest-pregate")!
    expect(worker.isRunning()).toBe(true)

    deferJobWorkersUntilBootComplete()
    try {
      // BullMQ pause() resolves once the worker stops taking new jobs.
      await waitFor(() => worker.isPaused(), { label: "the worker to pause" })
      expect(worker.isPaused()).toBe(true)

      const before = ran
      await enqueueAppJob("jobtest-pregate", "pregate-job", {})
      await new Promise((r) => setTimeout(r, 500))
      expect(ran).toBe(before)

      startDeferredJobWorkers()
      await waitFor(() => ran > before, { label: "the backlog to drain" })
      expect(ran).toBe(before + 1)
    } finally {
      startDeferredJobWorkers()
    }
  })

  it("leadership gate keeps workers paused off-leader and resumes them on-leader (HA singleton gate)", async () => {
    deferJobWorkersUntilBootComplete()
    try {
      let ran = 0
      registerJobWorker("jobtest-leader", "leader-job", async () => {
        ran++
      })
      // This test deliberately ENDS with an unprocessed job in the queue (the
      // final off-leader enqueue) and this file never takes the redis-clearing
      // test lock, so a previous run's leftover would drain here and inflate
      // `ran`. Drain the backlog before asserting counts.
      await createAppQueue("jobtest-leader").drain(true)
      const worker = JobsTestAccess.getWorker("jobtest-leader")!

      // Not the leader: opening the boot gate must NOT start the worker.
      setJobsLeadership(false)
      startDeferredJobWorkers()
      expect(worker.isRunning()).toBe(false)

      // Backlog enqueued while off-leader must NOT be processed.
      await enqueueAppJob("jobtest-leader", "leader-job", {})
      await new Promise((r) => setTimeout(r, 400))
      expect(ran).toBe(0)

      // Becoming leader resumes the worker; it drains the backlog.
      setJobsLeadership(true)
      expect(worker.isRunning()).toBe(true)
      await waitFor(() => ran > 0, { label: "the backlog to drain" })
      expect(ran).toBe(1)

      // Losing leadership pauses it again: a new job is NOT processed.
      setJobsLeadership(false)
      await waitFor(() => worker.isPaused(), { label: "the worker to pause" })
      expect(worker.isPaused()).toBe(true)
      await enqueueAppJob("jobtest-leader", "leader-job", {})
      await new Promise((r) => setTimeout(r, 400))
      expect(ran).toBe(1)
    } finally {
      // Restore the global gates so later tests/describes see the defaults.
      setJobsLeadership(true)
      startDeferredJobWorkers()
    }
  })

  it("workers created after the gate opens autorun as before", () => {
    registerJobWorker("jobtest-postgate", "noop", async () => {})
    expect(JobsTestAccess.getWorker("jobtest-postgate")!.isRunning()).toBe(true)
  })
})

// Regression — a SEED process (the demo seed script run inside the app
// container) pulls the app import graph, which registers the `app-kernel`
// worker at module scope. That process then STOLE jobs from the running app:
// its log carried `"service":"jobs","worker":"app-kernel"` lines and
// "No handler registered for job: app-kernel:search-index-upsert ... Job
// exhausted all retries", so the tickets and knowledge documents it had just
// seeded never reached the search index. The boot gate is not enough (it
// creates the worker, merely paused, and any later open re-arms it): a
// non-job-host process must be incapable of owning a worker.
describe("disableJobWorkers — a non-job-host process owns no worker", () => {
  afterEach(() => {
    JobsTestAccess.reenableJobWorkers()
  })

  it("creates NO worker, leaves the enqueued job in the queue, and cannot be re-armed", async () => {
    const queue = createAppQueue("jobtest-disabled")
    await queue.drain(true)

    disableJobWorkers()
    expect(areJobWorkersDisabled()).toBe(true)

    let ran = false
    registerJobWorker("jobtest-disabled", "stolen-job", async () => {
      ran = true
    })
    // No worker at all — not a paused one.
    expect(JobsTestAccess.getWorker("jobtest-disabled")).toBeUndefined()
    expect(jobWorkerCount()).toBe(0)

    // The handler is still registered, so the script can enqueue…
    await enqueueAppJob("jobtest-disabled", "stolen-job", {})
    // …and opening the boot gate must NOT hand this process a worker.
    startDeferredJobWorkers()
    expect(jobWorkerCount()).toBe(0)

    await new Promise((r) => setTimeout(r, 500))
    expect(ran).toBe(false)
    // The job is still in the queue, untouched, for the real app process.
    const counts = await queue.getJobCounts()
    expect(counts).toMatchObject({ active: 0, completed: 0, failed: 0 })
    // BullMQ 6 has no `paused` state: a job in a paused queue counts as waiting.
    expect(counts.waiting + counts.delayed + counts.prioritized).toBe(1)
    await queue.drain(true)
  })

  it("closes a worker that already existed when the process disables workers", async () => {
    registerJobWorker("jobtest-disable-late", "noop", async () => {})
    expect(JobsTestAccess.getWorker("jobtest-disable-late")).toBeDefined()

    disableJobWorkers()

    expect(JobsTestAccess.getWorker("jobtest-disable-late")).toBeUndefined()
    expect(jobWorkerCount()).toBe(0)
  })
})

describe("enqueueAppJob — pre-enqueue validation", () => {
  it("rejects unregistered job names before enqueuing", async () => {
    await expect(enqueueAppJob("test-validation", "nonexistent-job", {})).rejects.toThrow(
      'No handler registered for job "test-validation:nonexistent-job"',
    )
  })
})

describe("enqueueAppJob — jobId dedup", () => {
  beforeAll(() => {
    registerJobWorker("test-dedup", "sync-job", async () => {})
  })

  it("passes jobId to BullMQ when provided", async () => {
    const id = await enqueueAppJob(
      "test-dedup",
      "sync-job",
      { accountId: "a1" },
      {
        jobId: "sync:a1",
      },
    )

    expect(id).toBe("sync:a1")
  })

  it("deduplicates jobs with the same jobId while the first is still pending", async () => {
    const queue = createAppQueue("test-dedup")
    const jobId = `sync:a2:${Date.now()}`
    // Delayed, so the worker cannot finish it between the two enqueues.
    await enqueueAppJob("test-dedup", "sync-job", { accountId: jobId }, { jobId, delay: 60_000 })

    const id2 = await enqueueAppJob(
      "test-dedup",
      "sync-job",
      { accountId: jobId },
      { jobId, delay: 60_000 },
    )

    expect(id2).toBe(jobId)

    const jobs = await queue.getJobs(["active", "wait", "completed", "delayed", "prioritized"])
    const matchingJobs = jobs.filter(
      (job) => job.name === "sync-job" && job.data?.accountId === jobId,
    )
    expect(matchingJobs).toHaveLength(1)
    await matchingJobs[0]?.remove()
  })

  // The id frees up once its job has finished: a finished job must never
  // swallow a new enqueue (what the old get-state-then-add dance protected).
  it("a jobId whose job has completed enqueues a fresh job", async () => {
    const ran: string[] = []
    registerJobWorker("test-dedup-done", "sync-job", async (p: { n: string }) => {
      ran.push(p.n)
    })
    const jobId = `sync:done:${Date.now()}`
    await enqueueAppJob("test-dedup-done", "sync-job", { n: "first" }, { jobId })
    const deadline = Date.now() + 5_000
    while (ran.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    await enqueueAppJob("test-dedup-done", "sync-job", { n: "second" }, { jobId })
    while (ran.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(ran).toEqual(["first", "second"])
  })

  it("generates unique jobId when none provided", async () => {
    const id = await enqueueAppJob("test-dedup", "sync-job", { accountId: "a3" })

    expect(id).toBeTruthy()
    expect(id).not.toBe("sync:a3")
  })
})

// E1 — BullMQ retention. `enqueueAppJob` already carries its own per-call
// removeOnComplete/removeOnFail (untouched by this change); the gap was the
// two scheduler paths, which upsert scheduler templates with no retention of
// their own and so accumulated a completed (or failed) job in Redis forever
// per cron tick. `createAppQueue` now sets `defaultJobOptions` so every job
// produced on that queue — including scheduler-template jobs — is bounded.
// The worker registered above picks the job up at once. Closing the queues
// while its completion is still in flight rejects BullMQ's own pending
// command with ioredis "Connection is closed", outside any test: the suite
// then failed on an "Unhandled error between tests" about one run in two.
async function untilSettled(job: Job): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const state = await job.getState()
    if (state === "completed" || state === "failed" || state === "unknown") return
    await Bun.sleep(100)
  }
}

describe("createAppQueue — default retention (E1)", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("sets removeOnComplete/removeOnFail defaults on the underlying BullMQ queue", () => {
    const queue = createAppQueue("test-retention-defaults")
    expect(queue.defaultJobOptions).toEqual({
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    })
  })

  it("scheduler-produced jobs pick up the queue defaultJobOptions (no per-scheduler retention set)", async () => {
    registerJobWorker("test-retention-sched", "tick", async () => {})
    await registerScheduledJob("test-retention-sched", "tick", "0 0 * * *", async () => {})
    const queue = createAppQueue("test-retention-sched")
    // Force a run of the scheduler's next tick by adding a job under the same
    // template name/data shape the scheduler would produce, then inspect the
    // resolved opts BullMQ assigns from defaultJobOptions.
    const job = await queue.add("tick", {})
    expect(job.opts.removeOnComplete).toEqual({ count: 100 })
    expect(job.opts.removeOnFail).toEqual({ count: 500 })
    await untilSettled(job)
  })

  it("enqueueAppJob's own retention opts still win over the queue defaults", async () => {
    registerJobWorker("test-retention-adhoc", "job", async () => {})
    await enqueueAppJob("test-retention-adhoc", "job", {}, { jobId: "adhoc-1" })
    const job = await JobsTestAccess.findJob("test-retention-adhoc", "job", "adhoc-1")
    expect(job!.opts.removeOnComplete).toBe(100)
    expect(job!.opts.removeOnFail).toBe(1000)
    await untilSettled(job!)
  })
})

describe("registerScheduledJob — tz + schedulerId (T4.0)", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("registerScheduledJob passes tz + schedulerId to upsertJobScheduler", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
    try {
      await registerScheduledJob("testsched", "test-tz-job", "0 8 * * 1-5", async () => {}, {
        tz: "America/Toronto",
        schedulerId: "test-tz-job:abc",
      })
      expect(upsert).toHaveBeenCalledWith(
        "test-tz-job:abc",
        { pattern: "0 8 * * 1-5", tz: "America/Toronto" },
        expect.objectContaining({ name: "test-tz-job" }),
      )
    } finally {
      upsert.mockRestore()
    }
  })

  it("defaults schedulerId to ${jobName}-scheduler when not provided (back-compat)", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
    try {
      await registerScheduledJob("testsched", "default-id-job", "*/5 * * * *", async () => {})
      expect(upsert).toHaveBeenCalledWith(
        "default-id-job-scheduler",
        { pattern: "*/5 * * * *" },
        expect.objectContaining({ name: "default-id-job" }),
      )
    } finally {
      upsert.mockRestore()
    }
  })

  it("merges opts.data into the scheduled job payload", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
    try {
      await registerScheduledJob("testsched", "data-job", "* * * * *", async () => {}, {
        data: { routineId: "r1" },
      })
      const [, , templateOpts] = upsert.mock.calls[0]!
      // Exactly the given data: no jitter seed, no org (a cron is one scheduler
      // for every org; an app's manifest schedule fans out, fanout.ts).
      expect((templateOpts as any).data).toEqual({ routineId: "r1" })
    } finally {
      upsert.mockRestore()
    }
  })

  it("removeScheduledJob delegates to queue.removeJobScheduler with the supplied id", async () => {
    const remove = spyOn(Queue.prototype, "removeJobScheduler").mockResolvedValue(true as any)
    try {
      await removeScheduledJob("kernel", "routine-tick", "routine:abc")
      expect(remove).toHaveBeenCalledWith("routine:abc")
    } finally {
      remove.mockRestore()
    }
  })

  it("an explicit schedulerId wins over the default", async () => {
    const upsert = spyOn(Queue.prototype, "upsertJobScheduler").mockResolvedValue({} as any)
    try {
      await registerScheduledJob("invoicing", "deferred-retry", "*/5 * * * *", async () => {}, {
        schedulerId: "explicit-id",
      })
      expect(upsert).toHaveBeenCalledWith(
        "explicit-id",
        { pattern: "*/5 * * * *" },
        expect.anything(),
      )
    } finally {
      upsert.mockRestore()
    }
  })
})

describe("job caller-scope resolution", () => {
  const resolve = (snapshotScopes: string[], userScopes: string[]) =>
    JobsTestAccess.resolveJobScopes({
      appName: "mail",
      jobName: "gmail-incremental-sync",
      hasDeclaredScopes: true,
      snapshotScopes,
      userScopes,
    })

  it("runs with the held scope only when the snapshot carries one the user lacks", () => {
    const result = resolve(["mail:sync", "mail:send"], ["mail:sync", "tickets:read"])
    expect(result.scopes).toEqual(["mail:sync"])
    expect(result.droppedScopes).toEqual(["mail:send"])
  })

  it("keeps the user's narrower child when the snapshot is a wildcard branch", () => {
    const result = resolve(["mail:*"], ["mail:read", "tickets:write"])
    expect(result.scopes).toEqual(["mail:read"])
    // The wildcard itself is not held verbatim, so it is reported as narrowed.
    expect(result.droppedScopes).toEqual(["mail:*"])
    expect(result.scopes).not.toContain("tickets:write")
  })

  it("never grants more than the snapshot even when the user holds more", () => {
    const result = resolve(["mail:sync"], ["mail:sync", "mail:send", "shopify:*"])
    expect(result.scopes).toEqual(["mail:sync"])
    expect(result.droppedScopes).toEqual([])
  })

  it("a fully disjoint snapshot still fails with the existing error", () => {
    expect(() => resolve(["mail:sync"], ["tickets:read"])).toThrow(
      "Job requested scopes not held by user: mail:gmail-incremental-sync",
    )
  })

  it("an undeclared snapshot still falls back to the app scope namespace", () => {
    const result = JobsTestAccess.resolveJobScopes({
      appName: "mail",
      jobName: "gmail-incremental-sync",
      hasDeclaredScopes: false,
      snapshotScopes: [],
      userScopes: ["mail:read"],
    })
    expect(result.scopes).toEqual(["mail:*"])
    expect(result.droppedScopes).toEqual([])
  })
})

// A deleted org's schedulers kept firing: each tick refused to run ("app not
// installed for that org"), retried and exhausted its attempts, for ever. The
// org's deletion now removes them, and a job of an org that no longer exists is
// dropped at dispatch, without an error, taking its scheduler with it.
describe("a deleted org's jobs and schedulers", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("a job for an org that no longer exists is dropped without an error, with its scheduler", async () => {
    const orgId = crypto.randomUUID()
    let ran = false
    registerJobWorker("jobtest-gone", "gone-tick", async () => {
      ran = true
    })
    const schedulerId = `gone-tick:${orgId}`
    await upsertJobScheduler("jobtest-gone", "gone-tick", "0 3 * * *", { orgId, schedulerId })
    const queue = createAppQueue("jobtest-gone")
    expect(await queue.getJobScheduler(schedulerId)).toBeDefined()
    const dropped = jobsDroppedOrgMissingCount()

    await JobsTestAccess.processJob(
      "jobtest-gone",
      "gone-tick",
      { orgId },
      "app-jobtest-gone",
      schedulerId,
    )

    expect(ran).toBe(false)
    expect(jobsDroppedOrgMissingCount()).toBe(dropped + 1)
    expect(await queue.getJobScheduler(schedulerId)).toBeUndefined()
  })

  it("a queued job of a DELETING org is dropped without running, like a deleted org's", async () => {
    const orgId = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug, deleting_at)
      VALUES (${orgId}, 'Deleting org', ${`deleting-${orgId.slice(0, 8)}`}, now())`
    forgetOrgApps(orgId)
    let ran = false
    registerJobWorker("jobtest-deleting", "work", async () => {
      ran = true
    })
    const dropped = jobsDroppedOrgMissingCount()
    try {
      await JobsTestAccess.processJob("jobtest-deleting", "work", { orgId }, "app-jobtest-deleting")
      expect(ran).toBe(false)
      expect(jobsDroppedOrgMissingCount()).toBe(dropped + 1)
    } finally {
      forgetOrgApps(orgId)
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    }
  })

  it("listOrgQueuedJobs names a queue it could read only in part", async () => {
    const orgId = crypto.randomUUID()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await enqueueAppJobForServer("jobtest-scan", "work", { orgId }, { delay: 600_000 }))
    }
    try {
      const full = await listOrgQueuedJobs(orgId)
      expect(full.jobs).toHaveLength(3)
      const queue = full.jobs[0]?.queue ?? ""
      expect(full.truncatedQueues).not.toContain(queue)
      const cut = await listOrgQueuedJobs(orgId, { scan: 2 })
      expect(cut.jobs).toHaveLength(2)
      expect(cut.truncatedQueues).toContain(queue)
    } finally {
      const queue = createAppQueue("jobtest-scan")
      for (const id of ids) await (await queue.getJob(id))?.remove()
    }
  })

  it("removeOrgJobSchedulers removes the org's schedulers on every queue, and only those", async () => {
    const orgA = crypto.randomUUID()
    const orgB = crypto.randomUUID()
    const noop = async () => {}
    // Ids carrying the org (a routine's, a pre-fan-out per-org app cron's).
    registerJobWorker("jobtest-gone-a", "tick", noop)
    const perOrgA = `tick-scheduler-${orgA}`
    const perOrgB = `tick-scheduler-${orgB}`
    await upsertJobScheduler("jobtest-gone-a", "tick", "0 4 * * *", {
      orgId: orgA,
      schedulerId: perOrgA,
    })
    await upsertJobScheduler("jobtest-gone-a", "tick", "0 4 * * *", {
      orgId: orgB,
      schedulerId: perOrgB,
    })
    // An explicit id that does not carry the org: matched by its job data.
    registerJobWorker("jobtest-gone-b", "explicit", noop)
    await upsertJobScheduler("jobtest-gone-b", "explicit", "0 5 * * *", {
      orgId: orgA,
      schedulerId: `explicit-${crypto.randomUUID()}`,
    })

    expect(await removeOrgJobSchedulers(orgA)).toBe(2)

    const a = await createAppQueue("jobtest-gone-a").getJobSchedulers(0, -1)
    const b = await createAppQueue("jobtest-gone-b").getJobSchedulers(0, -1)
    expect(a.map((s) => s.key)).not.toContain(perOrgA)
    expect(a.map((s) => s.key)).toContain(perOrgB)
    expect(b.filter((s) => (s.template?.data as { orgId?: string })?.orgId === orgA)).toEqual([])
    await removeOrgJobSchedulers(orgB)
  })

  it("refuses an id that is not an org uuid", async () => {
    await expect(removeOrgJobSchedulers("")).rejects.toThrow("not an org uuid")
  })
})

// A3: a worker binds every catalog app queue at boot, before any org is
// registered here, and the dispatcher sets the job's org up BEFORE it looks up
// the org's handler. A job for an org this process never registered therefore
// runs, instead of failing "No handler registered" ahead of the org setup.
describe("catalog app queues and ensure-before-lookup dispatch (A3)", () => {
  afterEach(() => {
    JobsTestAccess.setOrgEnsure(undefined)
  })

  afterAll(async () => {
    await closeAllQueues()
  })

  it("a job for an org this process never registered runs after setup", async () => {
    const orgId = crypto.randomUUID()
    // An org that exists, with no app turned Off.
    rememberOrgAppStates(orgId, [])
    const ensured: string[] = []
    let received: unknown = null
    // The org's setup is what registers the app's handler (as `awaitOrgApps`
    // does for an org first touched by a job).
    JobsTestAccess.setOrgEnsure(async (id) => {
      ensured.push(id)
      registerJobWorker("jobtest-lazy-org", "first-touch", async (payload) => {
        received = payload
      })
    })
    expect(JobsTestAccess.getHandler("jobtest-lazy-org", "first-touch")).toBeUndefined()

    await JobsTestAccess.processJob(
      "jobtest-lazy-org",
      "first-touch",
      { orgId, n: 1 },
      "app-jobtest-lazy-org",
    )

    expect(ensured).toEqual([orgId])
    expect((received as { n?: number } | null)?.n).toBe(1)
  })

  // An idle workspace whose app is Off must not be set up in the worker by a
  // job that will be skipped anyway: the Off check reads the org's persisted
  // app rows, before the setup.
  it("a job of an app that is Off for the org is skipped without setting the org up", async () => {
    const orgId = crypto.randomUUID()
    rememberOrgAppStates(orgId, [{ app: "jobtest-off-app", status: "disabled" }])
    const ensured: string[] = []
    let ran = false
    registerJobWorker("jobtest-off-app", "tick", async () => {
      ran = true
    })
    JobsTestAccess.setOrgEnsure(async (id) => {
      ensured.push(id)
    })

    await JobsTestAccess.processJob("jobtest-off-app", "tick", { orgId }, "app-jobtest-off-app")

    expect(ensured).toEqual([])
    expect(ran).toBe(false)
  })

  it("a job whose handler the org setup does not register still fails 'No handler registered'", async () => {
    const orgId = crypto.randomUUID()
    rememberOrgAppStates(orgId, [])
    const ensured: string[] = []
    JobsTestAccess.setOrgEnsure(async (id) => {
      ensured.push(id)
    })

    await expect(
      JobsTestAccess.processJob(
        "jobtest-lazy-none",
        "undeclared",
        { orgId },
        "app-jobtest-lazy-none",
      ),
    ).rejects.toThrow("No handler registered for job: app-jobtest-lazy-none:undeclared")
    expect(ensured).toEqual([orgId])
  })

  it("bindCatalogAppQueues creates one Worker per app with jobs", () => {
    JobsTestAccess.reenableJobWorkers()
    const before = jobWorkerCount()

    bindCatalogAppQueues([
      { name: "jobtest-catalog-with", jobs: { sync: { schedule: "0 * * * *" } } },
      { name: "jobtest-catalog-without" },
      { name: "jobtest-catalog-empty", jobs: {} },
      { name: "kernel", jobs: { tick: {} } },
    ])

    expect(jobWorkerCount()).toBe(before + 1)
    const worker = JobsTestAccess.getWorkerForQueue("app-jobtest-catalog-with")
    expect(worker).toBeDefined()
    expect(JobsTestAccess.getWorkerForQueue("app-jobtest-catalog-without")).toBeUndefined()
    expect(JobsTestAccess.getWorkerForQueue("app-jobtest-catalog-empty")).toBeUndefined()

    // Idempotent: a second bind (or the org's later registration) adds none.
    bindCatalogAppQueues([{ name: "jobtest-catalog-with", jobs: { sync: {} } }])
    expect(jobWorkerCount()).toBe(before + 1)
  })
})
