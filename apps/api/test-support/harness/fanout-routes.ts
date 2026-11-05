// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell seam for the cron fan-out scenario (P4 T7, S15/S16): a probe app job
// fanned out over every org by the real tick (infra/jobs/fanout-runtime.ts).
//
// The probe app `fanout-probe` has one scheduled job, `tick`. Its handler counts
// each run in Redis per (org, epoch) (`fanout:probe:runs`) and records the
// run's start offset from the epoch (`fanout:probe:starts`). Registered per
// process (`POST /register`): the handler, the app's scheduled job in this
// process's fan-out catalog, and the app in the reconcile's in-tree list (so a
// leader change does not remove its scheduler). `POST /schedule` upserts its
// fan-out scheduler with a fixed interval; `POST /arm-exit` makes the next
// probe tick that adds its jobs exit its process (needs
// LIAISON_TEST_FANOUT_EXIT_AFTER_ADD); `POST /warm` sets orgs up in this
// process ahead of the measure; `POST /id-mode` switches this process to
// deduplication ids (the discriminator). Mounted only when
// `qaSeedRoutesEnabled`; never part of the production image.

import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { APP_CRON_FANOUT_JOB, fanoutSchedulerId } from "~/infra/jobs/fanout"
import { fanoutTestState, readJobMetrics } from "~/infra/jobs/fanout-keys"
import {
  fanoutExitAfterAddKey,
  fanoutReconcileSources,
  rememberScheduledJobs,
  upsertFanoutTemplate,
} from "~/infra/jobs/fanout-runtime"
import { getPhysicalQueue, registerJobWorker } from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { awaitOrgApps } from "~/modules/apps/init"

const APP = "fanout-probe"
const JOB = "tick"
const RUNS_KEY = "fanout:probe:runs"
const STARTS_KEY = "fanout:probe:starts"
const DESCRIPTOR = { name: APP, jobs: { [JOB]: { schedule: "* * * * *" } } }

let registered = false
function registerProbe(): void {
  if (registered) return
  registered = true
  rememberScheduledJobs(APP, [JOB])
  const inTree = fanoutReconcileSources.inTreeApps
  fanoutReconcileSources.inTreeApps = async () => [...(await inTree()), DESCRIPTOR]
  registerJobWorker<{ orgId: string; _fanout?: { epoch?: number } }>(APP, JOB, async (p) => {
    const epoch = p._fanout?.epoch
    if (typeof epoch !== "number") throw new Error("fanout-probe: a run without its epoch")
    await redis
      .multi()
      .hincrby(RUNS_KEY, `${p.orgId}:${epoch}`, 1)
      .rpush(STARTS_KEY, `${p.orgId}:${epoch}:${Date.now() - epoch}`)
      .exec()
  })
}

export const fanoutTestRoutes = new Hono<AppEnv>()

fanoutTestRoutes.post("/register", async (c) => {
  registerProbe()
  return success(c, { registered: true })
})

fanoutTestRoutes.post(
  "/schedule",
  zValidator("json", z.object({ everyMs: z.number().int().min(1000) })),
  async (c) => {
    registerProbe()
    await upsertFanoutTemplate({
      app: APP,
      job: JOB,
      cron: "* * * * *",
      everyMs: c.req.valid("json").everyMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    })
    return success(c, { scheduled: true })
  },
)

fanoutTestRoutes.post("/unschedule", async (c) => {
  await getPhysicalQueue("kernel-cron").removeJobScheduler(fanoutSchedulerId(APP, JOB))
  return success(c, { unscheduled: true })
})

/** POST /warm — set the orgs up in this process now, so the first epochs measure the fan-out, not first-touch setup. */
fanoutTestRoutes.post(
  "/warm",
  zValidator("json", z.object({ orgs: z.array(z.string().uuid()).max(500) })),
  async (c) => {
    for (const org of c.req.valid("json").orgs) await awaitOrgApps(org)
    return success(c, { warmed: true })
  },
)

fanoutTestRoutes.post("/arm-exit", async (c) => {
  await redis.set(fanoutExitAfterAddKey(APP), "1")
  return success(c, { armed: true })
})

fanoutTestRoutes.post(
  "/id-mode",
  zValidator("json", z.object({ mode: z.enum(["job-id", "deduplication"]) })),
  async (c) => {
    fanoutTestState.idMode = c.req.valid("json").mode
    return success(c, { mode: fanoutTestState.idMode })
  },
)

fanoutTestRoutes.post("/reset", async (c) => {
  await redis.del(RUNS_KEY, STARTS_KEY)
  return success(c, { reset: true })
})

/**
 * GET /state — runs per `<org>:<epoch>`, start offsets, the job counters, the
 * `kernel-cron` scheduler ids, and how many probe ticks are not finished.
 */
fanoutTestRoutes.get("/state", async (c) => {
  const runs = await redis.hgetall(RUNS_KEY)
  const starts = await redis.lrange(STARTS_KEY, 0, -1)
  const schedulers = (await getPhysicalQueue("kernel-cron").getJobSchedulers(0, -1)).map(
    (s) => s.key,
  )
  // The probe's ticks not finished: queued, or held by a process (a killed
  // process's tick stays active until the stalled check hands it back).
  const ticks = await getPhysicalQueue("kernel-cron").getJobs(
    ["active", "wait", "prioritized", "delayed"],
    0,
    -1,
  )
  const ticksInFlight = ticks.filter(
    (j) => j?.name === APP_CRON_FANOUT_JOB && (j.data as { app?: unknown })?.app === APP,
  ).length
  return success(c, {
    runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, Number(v)])),
    starts,
    metrics: await readJobMetrics(),
    schedulers,
    fanoutSchedulers: schedulers.filter((k) => k.startsWith(`${APP_CRON_FANOUT_JOB}:`)).length,
    ticksInFlight,
    exitArmed: (await redis.exists(fanoutExitAfterAddKey(APP))) === 1,
  })
})
