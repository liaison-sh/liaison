// SPDX-License-Identifier: FSL-1.1-ALv2
// The cron fan-out against real Redis and Postgres: one tick, one job per
// eligible org and epoch, never two, never none (fanout-runtime.ts).
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Worker } from "bullmq"
import { sql as drizzleSql, inArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { apps, connectedAccounts, organizations } from "~/db/schema/kernel"
import { bullPrefix, redis, redisBullMQ } from "~/lib/redis"
import { rememberOrgAppStates } from "~/modules/apps/org-apps"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { fanoutJobId, spreadDelays, spreadWindowMs } from "./fanout"
import { fanoutMarkerKey, fanoutPendingKey, fanoutTestState, readJobMetrics } from "./fanout-keys"
import { runsForCheckOf } from "./fanout-runs-for"
import {
  type FanoutTemplate,
  fanoutReconcileSources,
  legacySchedulerSweepSingleton,
  orgsMeetingRunsFor,
  reconcileAppCronFanout,
  rememberScheduledJobs,
  removeAppCronFanout,
  runAppCronFanoutTick,
  sweepLegacyPerOrgSchedulers,
  syncAppCronFanoutForApp,
  upsertAppCronFanout,
} from "./fanout-runtime"
import { closeAllQueues, getPhysicalQueue, JobsTestAccess, registerJobWorker } from "./jobs"

const rand = () => Math.random().toString(36).slice(2, 8)
const uuid = () => crypto.randomUUID()
const MIN = 60_000

/** A fresh app name per test: its queue `app-<name>` has no worker, so jobs stay put. */
function freshApp(job = "tick"): FanoutTemplate {
  const app = `fotest-${rand()}`
  rememberScheduledJobs(app, [job])
  return {
    app,
    job,
    cron: "*/5 * * * *",
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  }
}

/** A future 5-min boundary: every delay stays positive, nothing becomes due. */
const futureEpoch = (k = 0) => (Math.floor(Date.now() / (5 * MIN)) + 2 + k) * 5 * MIN
const ctx = (firedAt: number) => ({ signal: new AbortController().signal, firedAt })

async function jobsOf(app: string) {
  return getPhysicalQueue(`app-${app}`).getJobs(["delayed", "waiting", "completed", "active"])
}

const usedApps: string[] = []
afterEach(async () => {
  fanoutTestState.listOrgs = undefined
  fanoutTestState.afterAdd = undefined
  fanoutTestState.idMode = undefined
})
afterAll(async () => {
  for (const app of usedApps) await getPhysicalQueue(`app-${app}`).obliterate({ force: true })
  await closeAllQueues()
})

function withOrgs(t: FanoutTemplate, orgIds: string[]): FanoutTemplate {
  usedApps.push(t.app)
  fanoutTestState.listOrgs = async () => orgIds.map((orgId) => ({ orgId, status: null }))
  return t
}

describe("app-cron-fanout tick", () => {
  it("one tick enqueues one job per eligible org with ids fo.<app>.<job>.<org>.<epoch>", async () => {
    const orgs = [uuid(), uuid(), uuid()]
    const t = withOrgs(freshApp(), orgs)
    const epoch = futureEpoch()
    const res = await runAppCronFanoutTick(t, ctx(epoch))
    expect(res.enqueued).toBe(3)
    const ids = (await jobsOf(t.app)).map((j) => j.id).sort()
    expect(ids).toEqual(orgs.map((o) => fanoutJobId(t.app, t.job, o, epoch)).sort())
    const job = (await jobsOf(t.app))[0]
    expect(job?.name).toBe(t.job)
    expect(job?.data._fanout).toEqual({ app: t.app, job: t.job, epoch })
  })

  it("disabled and removed get none; no row and active get one; error gets one in the first epoch of an hour and none in the next", async () => {
    const t = freshApp()
    usedApps.push(t.app)
    const ids = { none: uuid(), active: uuid(), disabled: uuid(), removed: uuid(), error: uuid() }
    await withSystemDb("test-fanout-seed", async (db) => {
      await db
        .insert(organizations)
        .values(
          Object.entries(ids).map(([k, id]) => ({ id, name: `fo-${k}`, slug: `fo-${k}-${id}` })),
        )
      await db.insert(apps).values(
        (["active", "disabled", "removed", "error"] as const).map((status) => ({
          orgId: ids[status],
          name: t.app,
          version: "1.0.0",
          status,
        })),
      )
    })
    try {
      const e1 = futureEpoch()
      await runAppCronFanoutTick(t, ctx(e1))
      const e2 = e1 + 5 * MIN
      await runAppCronFanoutTick(t, ctx(e2))
      const got = new Set((await jobsOf(t.app)).map((j) => j.id))
      const has = (org: string, e: number) => got.has(fanoutJobId(t.app, t.job, org, e))
      expect(has(ids.none, e1)).toBe(true)
      expect(has(ids.active, e1)).toBe(true)
      expect(has(ids.disabled, e1) || has(ids.disabled, e2)).toBe(false)
      expect(has(ids.removed, e1) || has(ids.removed, e2)).toBe(false)
      expect(has(ids.error, e1)).toBe(true)
      expect(has(ids.error, e2)).toBe(false)
      expect((await readJobMetrics())[`fanout_skip_error:${t.app}:${t.job}`]).toBeGreaterThan(0)
    } finally {
      await withSystemDb("test-fanout-clean", async (db) => {
        await db.delete(apps).where(inArray(apps.orgId, Object.values(ids)))
        await db.delete(organizations).where(inArray(organizations.id, Object.values(ids)))
      })
    }
  })

  it("the same tick run twice enqueues once (markers)", async () => {
    const t = withOrgs(freshApp(), [uuid(), uuid()])
    const epoch = futureEpoch()
    await runAppCronFanoutTick(t, ctx(epoch))
    const again = await runAppCronFanoutTick(t, ctx(epoch))
    expect(again.enqueued).toBe(0)
    expect(again.deduped).toBe(2)
    expect(await jobsOf(t.app)).toHaveLength(2)
  })

  it("the same tick run twice after the markers expired and the first jobs completed enqueues once", async () => {
    // Discriminator: a deduplication id (the seam) frees itself once the job
    // finished, so the same epoch runs twice; the job id never does.
    for (const mode of ["job-id", "deduplication"] as const) {
      fanoutTestState.idMode = mode
      const org = uuid()
      const t = withOrgs(freshApp(), [org])
      const epoch = futureEpoch()
      await runAppCronFanoutTick(t, ctx(epoch))
      const queue = getPhysicalQueue(`app-${t.app}`)
      const [first] = await queue.getJobs(["delayed"])
      if (!first) throw new Error("no job enqueued")
      // The job ran (moved to completed) and the markers expired.
      await first.promote()
      const worker = new Worker(`app-${t.app}`, null, {
        connection: redisBullMQ,
        prefix: bullPrefix,
        autorun: false,
      })
      try {
        const token = `t-${rand()}`
        const running = await worker.getNextJob(token)
        if (!running) throw new Error("the promoted job was not fetched")
        await running.moveToCompleted("done", token, false)
      } finally {
        await worker.close()
      }
      await redis.del(
        fanoutMarkerKey(t.app, t.job, org, epoch),
        fanoutPendingKey(t.app, t.job, org),
      )
      await runAppCronFanoutTick(t, ctx(epoch))
      const all = await queue.getJobs(["delayed", "waiting", "completed"])
      expect(all.length).toBe(mode === "job-id" ? 1 : 2)
    }
  })

  it("a tick that dies after the add and before the markers enqueues nothing more on re-run", async () => {
    const orgs = [uuid(), uuid(), uuid()]
    const t = withOrgs(freshApp(), orgs)
    const epoch = futureEpoch()
    fanoutTestState.afterAdd = () => {
      throw new Error("crash between add and markers")
    }
    await expect(runAppCronFanoutTick(t, ctx(epoch))).rejects.toThrow("crash")
    fanoutTestState.afterAdd = undefined
    await runAppCronFanoutTick(t, ctx(epoch))
    expect(await jobsOf(t.app)).toHaveLength(3)
  })

  it("an org whose previous epoch job has not started is coalesced", async () => {
    const t = withOrgs(freshApp(), [uuid()])
    const e1 = futureEpoch()
    await runAppCronFanoutTick(t, ctx(e1))
    // The pending mark about to expire while its job still waits: the
    // coalescing tick extends it, or a later tick would add a second job.
    const [org] = (await jobsOf(t.app)).map((j) => j.data.orgId as string)
    await redis.pexpire(fanoutPendingKey(t.app, t.job, org as string), 1_000)
    const next = await runAppCronFanoutTick(t, ctx(e1 + 5 * MIN))
    expect(next.coalesced).toBe(1)
    expect(next.enqueued).toBe(0)
    expect(await jobsOf(t.app)).toHaveLength(1)
    expect(await redis.pttl(fanoutPendingKey(t.app, t.job, org as string))).toBeGreaterThan(60_000)
  })

  it("app Off for one epoch, then On: the next epoch runs (the pending mark is freed at start)", async () => {
    const org = uuid()
    const t = withOrgs(freshApp(), [org])
    const e1 = futureEpoch()
    await runAppCronFanoutTick(t, ctx(e1))
    // The epoch's job starts while the app is Off for the org: skipped, but it started.
    let ran = 0
    registerJobWorker(t.app, t.job, async () => {
      ran++
    })
    rememberOrgAppStates(org, [{ app: t.app, status: "disabled" }])
    JobsTestAccess.setOrgEnsure(async () => {})
    try {
      await JobsTestAccess.processJob(
        t.app,
        t.job,
        { orgId: org, _fanout: { app: t.app, job: t.job, epoch: e1 } },
        `app-${t.app}`,
        undefined,
        fanoutJobId(t.app, t.job, org, e1),
      )
    } finally {
      JobsTestAccess.setOrgEnsure(undefined)
    }
    expect(ran).toBe(0)
    expect(await redis.get(fanoutPendingKey(t.app, t.job, org))).toBeNull()
    const next = await runAppCronFanoutTick(t, ctx(e1 + 5 * MIN))
    expect(next.enqueued).toBe(1)
  })

  it("a job with _fanout data but a non-fo. id deletes no pending key", async () => {
    const org = uuid()
    const t = withOrgs(freshApp(), [org])
    const e1 = futureEpoch()
    await runAppCronFanoutTick(t, ctx(e1))
    JobsTestAccess.setOrgEnsure(async () => {})
    try {
      await JobsTestAccess.processJob(
        t.app,
        t.job,
        { orgId: org, _fanout: { app: t.app, job: t.job, epoch: e1 } },
        `app-${t.app}`,
        undefined,
        "12345",
      ).catch(() => {})
    } finally {
      JobsTestAccess.setOrgEnsure(undefined)
    }
    expect(await redis.get(fanoutPendingKey(t.app, t.job, org))).toBe(String(e1))
  })

  it("zero eligible orgs: nothing enqueued", async () => {
    const t = withOrgs(freshApp(), [])
    const res = await runAppCronFanoutTick(t, ctx(futureEpoch()))
    expect(res).toEqual({
      enqueued: 0,
      deduped: 0,
      coalesced: 0,
      skippedOff: 0,
      skippedError: 0,
      skippedRunsFor: 0,
    })
    expect(await jobsOf(t.app)).toHaveLength(0)
  })

  it("delays are the rank spread from the epoch and every delay < W", async () => {
    const orgs = Array.from({ length: 20 }, uuid)
    const t = withOrgs(freshApp(), orgs)
    const epoch = futureEpoch()
    await runAppCronFanoutTick(t, ctx(epoch))
    const W = spreadWindowMs(5 * MIN, orgs.length)
    const want = spreadDelays(orgs, t.app, t.job, W)
    for (const job of await jobsOf(t.app)) {
      const offset = job.timestamp + (job.opts.delay ?? 0) - epoch
      const expected = want.get(job.data.orgId) ?? -1
      expect(Math.abs(offset - expected)).toBeLessThan(50)
      expect(offset).toBeLessThan(W)
    }
  })

  it("a tick for an app this process does not know enqueues nothing and counts", async () => {
    const before = (await readJobMetrics()).fanout_skip_unknown_app ?? 0
    const t = withOrgs(freshApp(), [uuid()])
    rememberScheduledJobs(t.app, null)
    const res = await runAppCronFanoutTick(t, ctx(futureEpoch()))
    expect(res.enqueued).toBe(0)
    expect(await jobsOf(t.app)).toHaveLength(0)
    expect((await readJobMetrics()).fanout_skip_unknown_app).toBe(before + 1)
  })
})

describe("fan-out schedulers", () => {
  const kernelCron = () => getPhysicalQueue("kernel-cron")
  async function schedulersOf(app: string) {
    return (await kernelCron().getJobSchedulers(0, -1)).filter((s) =>
      (s.key ?? s.id ?? "").startsWith(`app-cron-fanout:${app}:`),
    )
  }
  const desc = (name: string, jobs: Record<string, string>) => ({
    name,
    jobs: Object.fromEntries(Object.entries(jobs).map(([j, schedule]) => [j, { schedule }])),
  })
  const cleanup: string[] = []
  afterAll(async () => {
    for (const app of cleanup) await syncAppCronFanoutForApp(app, null)
    fanoutReconcileSources.inTreeApps = original.inTreeApps
    fanoutReconcileSources.activeAppNames = original.activeAppNames
    fanoutReconcileSources.installedDescriptor = original.installedDescriptor
  })
  const original = { ...fanoutReconcileSources }

  it("a re-upsert of an unchanged scheduler keeps its fired, not yet run tick; a changed one is replaced", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    await upsertAppCronFanout([desc(app, { a: "0 3 * * *" })])
    const tickOf = async () =>
      (await kernelCron().getJobs(["delayed", "waiting"], 0, -1)).filter(
        (j) => j?.repeatJobKey === `app-cron-fanout:${app}:a`,
      )
    const [tick] = await tickOf()
    expect(tick).toBeDefined()
    // 03:00 fired: the tick waits for a worker when a process boots (or the upkeep runs).
    await tick?.promote()
    await upsertAppCronFanout([desc(app, { a: "0 3 * * *" })])
    expect((await tickOf()).map((j) => j.id)).toEqual([tick?.id])
    expect(await kernelCron().getJobState(tick?.id as string)).toBe("waiting")
    // A changed pattern does replace the scheduler.
    await upsertAppCronFanout([desc(app, { a: "0 4 * * *" })])
    expect((await kernelCron().getJobScheduler(`app-cron-fanout:${app}:a`))?.pattern).toBe(
      "0 4 * * *",
    )
  })

  it("the scheduler count does not grow with the org count (S15): one per scheduled (app, job)", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    const apps = [desc(app, { a: "*/5 * * * *", b: "0 6 * * *" }), { name: "nojobs" }]
    await upsertAppCronFanout(apps)
    const before = await kernelCron().getJobSchedulersCount()
    // Ticks for 1 org, then 300: schedulers stay as they are.
    for (const n of [1, 300]) {
      fanoutTestState.listOrgs = async () =>
        Array.from({ length: n }, () => ({ orgId: uuid(), status: null }))
      usedApps.push(app)
      await runAppCronFanoutTick(
        { app, job: "a", cron: "*/5 * * * *", attempts: 3, backoff: { type: "fixed", delay: 1 } },
        ctx(futureEpoch(n)),
      )
    }
    expect(await kernelCron().getJobSchedulersCount()).toBe(before)
    expect(await schedulersOf(app)).toHaveLength(2)
  })

  it("the fan-out scheduler template carries 5 attempts, fixed 2 s, and the manifest pattern", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    await upsertAppCronFanout([desc(app, { a: "*/5 * * * *" })])
    const [s] = await schedulersOf(app)
    expect(s?.pattern).toBe("*/5 * * * *")
    expect(s?.template?.opts?.attempts).toBe(5)
    expect(s?.template?.opts?.backoff).toEqual({ type: "fixed", delay: 2000 })
    expect(s?.template?.data).toMatchObject({ app, job: "a", cron: "*/5 * * * *" })
  })

  it("two concurrent syncs leave one scheduler per (app, job) and one delayed tick each", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    const apps = [desc(app, { a: "*/5 * * * *", b: "*/10 * * * *" })]
    await Promise.all([upsertAppCronFanout(apps), upsertAppCronFanout(apps)])
    expect(await schedulersOf(app)).toHaveLength(2)
    const ticks = (await kernelCron().getJobs(["delayed"])).filter((j) =>
      (j.repeatJobKey ?? "").startsWith(`app-cron-fanout:${app}:`),
    )
    expect(ticks).toHaveLength(2)
  })

  it("a process booting with a stale catalog removes no scheduler", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    await upsertAppCronFanout([desc(app, { a: "*/5 * * * *", b: "*/10 * * * *" })])
    // An older release: the app declares only `a`, or the process lacks the app.
    await upsertAppCronFanout([desc(app, { a: "*/5 * * * *" })])
    await upsertAppCronFanout([])
    expect(await schedulersOf(app)).toHaveLength(2)
  })

  it("an activation that adds a cron job upserts its scheduler; the switch drops a job the version lost", async () => {
    const app = `fosync-${rand()}`
    cleanup.push(app)
    await syncAppCronFanoutForApp(app, desc(app, { a: "*/5 * * * *" }))
    await syncAppCronFanoutForApp(app, desc(app, { a: "*/5 * * * *", b: "0 * * * *" }))
    expect((await schedulersOf(app)).map((s) => s.key).sort()).toEqual([
      `app-cron-fanout:${app}:a`,
      `app-cron-fanout:${app}:b`,
    ])
    await syncAppCronFanoutForApp(app, desc(app, { b: "0 * * * *" }))
    expect((await schedulersOf(app)).map((s) => s.key)).toEqual([`app-cron-fanout:${app}:b`])
  })

  it("uninstall removes the app's fan-out schedulers", async () => {
    const app = `fosync-${rand()}`
    const other = `fosync-${rand()}`
    cleanup.push(app, other)
    await upsertAppCronFanout([desc(app, { a: "*/5 * * * *" }), desc(other, { a: "*/5 * * * *" })])
    await removeAppCronFanout(app)
    expect(await schedulersOf(app)).toHaveLength(0)
    expect(await schedulersOf(other)).toHaveLength(1)
  })

  it("the reconcile removes schedulers of an app with no active version and keeps every job of an installed app, known or not", async () => {
    const gone = `fosync-${rand()}`
    const live = `fosync-${rand()}`
    const inTree = `fosync-${rand()}`
    const unreadable = `fosync-${rand()}`
    cleanup.push(gone, live, inTree, unreadable)
    await upsertAppCronFanout([
      desc(gone, { a: "*/5 * * * *" }),
      desc(live, { a: "*/5 * * * *", dropped: "*/5 * * * *" }),
      desc(inTree, { a: "*/5 * * * *" }),
      desc(unreadable, { a: "*/5 * * * *" }),
    ])
    const kernelBefore = (await kernelCron().getJobSchedulers(0, -1)).filter(
      (s) => !(s.key ?? "").startsWith("app-cron-fanout:"),
    ).length
    fanoutReconcileSources.inTreeApps = async () => [desc(inTree, { a: "*/5 * * * *" })]
    fanoutReconcileSources.activeAppNames = async () => new Set([live, unreadable])
    // This leader's manifest of `live` knows only `a` (an older release).
    fanoutReconcileSources.installedDescriptor = async (name) =>
      name === live ? desc(live, { a: "*/5 * * * *" }) : null
    await reconcileAppCronFanout()
    expect(await schedulersOf(gone)).toHaveLength(0)
    // `dropped` is a job this (possibly older) leader does not know: kept.
    expect((await schedulersOf(live)).map((s) => s.key).sort()).toEqual([
      `app-cron-fanout:${live}:a`,
      `app-cron-fanout:${live}:dropped`,
    ])
    expect(await schedulersOf(inTree)).toHaveLength(1)
    expect(await schedulersOf(unreadable)).toHaveLength(1)
    const kernelAfter = (await kernelCron().getJobSchedulers(0, -1)).filter(
      (s) => !(s.key ?? "").startsWith("app-cron-fanout:"),
    ).length
    expect(kernelAfter).toBe(kernelBefore)
  })
})

describe("legacy per-org schedulers (upgrade)", () => {
  async function seedLegacy() {
    const app = `folegacy-${rand()}`
    usedApps.push(app)
    const queue = getPhysicalQueue(`app-${app}`)
    const org = uuid()
    const ids = {
      legacy: `deferred-retry-scheduler-${org}`,
      orgless: "deferred-retry-scheduler",
      routine: `routine:${uuid()}`,
    }
    for (const id of Object.values(ids)) {
      await queue.upsertJobScheduler(id, { pattern: "0 3 * * *" }, { name: "deferred-retry" })
    }
    return { app, queue, org, ids }
  }
  const keys = async (queue: ReturnType<typeof getPhysicalQueue>) =>
    (await queue.getJobSchedulers(0, -1)).map((s) => s.key).sort()

  it("the sweep removes every legacy per-org id on app queues and leaves fan-out, kernel and routine:<uuid> schedulers", async () => {
    const { queue, ids } = await seedLegacy()
    const fanApp = `fosync-${rand()}`
    await upsertAppCronFanout([{ name: fanApp, jobs: { a: { schedule: "*/5 * * * *" } } }])
    const kernelBefore = await getPhysicalQueue("kernel-cron").getJobSchedulersCount()
    expect(await sweepLegacyPerOrgSchedulers()).toBeGreaterThanOrEqual(1)
    expect(await keys(queue)).toEqual([ids.orgless, ids.routine].sort())
    expect(await getPhysicalQueue("kernel-cron").getJobSchedulersCount()).toBe(kernelBefore)
    await syncAppCronFanoutForApp(fanApp, null)
  })

  it("the sweep stops at abort", async () => {
    const { queue, ids } = await seedLegacy()
    const abort = new AbortController()
    abort.abort()
    expect(await sweepLegacyPerOrgSchedulers({ signal: abort.signal })).toBe(0)
    expect(await keys(queue)).toContain(ids.legacy)
  })

  it("a legacy tick reaching a worker becomes the fan-out job of its org and epoch; its scheduler removed, its handler not run", async () => {
    const { app, queue, org, ids } = await seedLegacy()
    let ran = 0
    registerJobWorker(app, "deferred-retry", async () => {
      ran++
    })
    const epoch = futureEpoch()
    const before = (await readJobMetrics()).legacy_tick_converted ?? 0
    await JobsTestAccess.processJob(
      app,
      "deferred-retry",
      { orgId: org },
      `app-${app}`,
      ids.legacy,
      `repeat:${ids.legacy}:${epoch}`,
    )
    expect(ran).toBe(0)
    expect(await keys(queue)).not.toContain(ids.legacy)
    const converted = await queue.getJob(fanoutJobId(app, "deferred-retry", org, epoch))
    expect(converted?.data).toEqual({
      orgId: org,
      _fanout: { app, job: "deferred-retry", epoch },
    })
    expect((await readJobMetrics()).legacy_tick_converted).toBe(before + 1)
    // The fan-out tick of the same epoch adds no second job for the org.
    rememberScheduledJobs(app, ["deferred-retry"])
    fanoutTestState.listOrgs = async () => [{ orgId: org, status: null }]
    await runAppCronFanoutTick(
      {
        app,
        job: "deferred-retry",
        cron: "0 3 * * *",
        attempts: 3,
        backoff: { type: "fixed", delay: 1000 },
      },
      ctx(epoch),
    )
    const all = (await queue.getJobs(["delayed", "wait", "active", "completed"], 0, -1)).filter(
      (j) => j?.data?.orgId === org && String(j.id).startsWith("fo."),
    )
    expect(all.map((j) => j.id)).toEqual([fanoutJobId(app, "deferred-retry", org, epoch)])
  })

  it("the sweep turns a legacy scheduler's due tick into its fan-out job before removing it", async () => {
    const app = `folegacy-${rand()}`
    usedApps.push(app)
    const queue = getPhysicalQueue(`app-${app}`)
    const org = uuid()
    const id = `deferred-retry-scheduler-${org}`
    await queue.upsertJobScheduler(id, { every: 60_000 }, { name: "deferred-retry" })
    const next = (await queue.getJobScheduler(id))?.next as number
    await Bun.sleep(Math.max(0, next - Date.now() + 20))
    await sweepLegacyPerOrgSchedulers()
    expect(await keys(queue)).not.toContain(id)
    expect(await queue.getJob(fanoutJobId(app, "deferred-retry", org, next))).toBeDefined()
  })

  it("the sweep does not block the next singleton's onAcquired", async () => {
    let stopped = false
    const hooks = legacySchedulerSweepSingleton(
      ({ signal }) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            stopped = true
            resolve(0)
          })
        }),
    )
    const started = Date.now()
    await hooks.onAcquired()
    expect(Date.now() - started).toBeLessThan(100)
    await hooks.onLost()
    await new Promise((r) => setTimeout(r, 0))
    expect(stopped).toBe(true)
  })
})

describe("runsFor: the tick runs only orgs that meet the job's precondition", () => {
  it("a connection counts when active and not a demo fixture; rows by where; a failed check runs everyone", async () => {
    const t = freshApp("sync")
    usedApps.push(t.app)
    const schema = `app_${t.app.replace(/-/g, "_")}`
    const ids = {
      live: uuid(),
      fixture: uuid(),
      errored: uuid(),
      otherApp: uuid(),
      rowOpen: uuid(),
      rowDone: uuid(),
      bare: uuid(),
    }
    const all = Object.values(ids)
    // First: a user without an org creates one, which truncates the org tables.
    const user = await minimal.person((await createTestOrg()).id)
    await withSystemDb("test-runs-for-seed", async (db) => {
      await db
        .insert(organizations)
        .values(
          Object.entries(ids).map(([k, id]) => ({ id, name: `rf-${k}`, slug: `rf-${k}-${id}` })),
        )
    })
    const account = (orgId: string, over: Partial<typeof connectedAccounts.$inferInsert> = {}) => ({
      orgId,
      appName: t.app,
      connectionName: "box",
      ownerType: "org",
      providerType: "credentials",
      identifier: `acct-${orgId}`,
      createdBy: user.id,
      ...over,
    })
    await withSystemDb("test-runs-for-seed", async (db) => {
      await db
        .insert(connectedAccounts)
        .values([
          account(ids.live),
          account(ids.fixture, { metadata: { demo: true } }),
          account(ids.errored, { status: "error" }),
          account(ids.otherApp, { appName: "someone-else" }),
        ])
      await db.execute(drizzleSql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`))
      await db.execute(
        drizzleSql.raw(
          `CREATE TABLE "${schema}"."parked" (id uuid primary key default gen_random_uuid(), org_id uuid not null, status text, ref_number text)`,
        ),
      )
      await db.execute(
        drizzleSql.raw(
          `INSERT INTO "${schema}"."parked" (org_id, status) VALUES ('${ids.rowOpen}', 'open'), ('${ids.rowDone}', 'resolved')`,
        ),
      )
    })
    try {
      const byConnection = runsForCheckOf(t.app, { connection: "box" })!
      expect([...(await orgsMeetingRunsFor(t.app, byConnection, all))]).toEqual([ids.live])

      const byRows = runsForCheckOf(t.app, {
        rows: { entity: "parked", where: { status: { in: ["open", "blocked"] }, refNumber: null } },
      })!
      expect([...(await orgsMeetingRunsFor(t.app, byRows, all))]).toEqual([ids.rowOpen])
      const notNull = runsForCheckOf(t.app, {
        rows: { entity: "parked", where: { status: { not: null } } },
      })!
      expect(new Set(await orgsMeetingRunsFor(t.app, notNull, all))).toEqual(
        new Set([ids.rowOpen, ids.rowDone]),
      )

      // The tick: either condition is enough; everyone else is skipped, counted.
      fanoutTestState.listOrgs = async () => all.map((orgId) => ({ orgId, status: null }))
      const both = runsForCheckOf(t.app, {
        connection: "box",
        rows: { entity: "parked", where: { status: "open" } },
      })
      const epoch = futureEpoch()
      const res = await runAppCronFanoutTick({ ...t, runsFor: both }, ctx(epoch))
      expect(res.enqueued).toBe(2)
      expect(res.skippedRunsFor).toBe(all.length - 2)
      const got = new Set((await jobsOf(t.app)).map((j) => j.id))
      expect(got).toEqual(
        new Set([ids.live, ids.rowOpen].map((o) => fanoutJobId(t.app, t.job, o, epoch))),
      )

      // A check that cannot run (no such table) runs every org, never none.
      const broken = runsForCheckOf(t.app, { rows: { entity: "missing" } })
      const res2 = await runAppCronFanoutTick({ ...t, runsFor: broken }, ctx(epoch + 5 * MIN))
      expect(res2.enqueued + res2.coalesced).toBe(all.length)
      expect(res2.skippedRunsFor).toBe(0)
    } finally {
      await withSystemDb("test-runs-for-clean", async (db) => {
        await db.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
        await db.delete(connectedAccounts).where(inArray(connectedAccounts.orgId, all))
        await db.delete(organizations).where(inArray(organizations.id, all))
      })
    }
  })
})
