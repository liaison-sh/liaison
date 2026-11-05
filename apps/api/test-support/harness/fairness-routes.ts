// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell seam for the fair-queue scenario (P4 T12, S17): floods of the load
// harness's synthetic job (infra/jobs/load-synthetic.ts) on the `kernel-agent`
// class queue, or on an app queue (the probe app `fairness-probe`, job `work`,
// same handler), and the per-org counters they leave.
//
// `POST /register` registers both handlers in this process; `POST /flood`
// enqueues `count` jobs for one org through `enqueueAppJobs` (the fair
// enqueue), 500 per batch; `GET /state?orgs=` reads each org's counters, the
// queue's /diag fairness counters and Redis `used_cpu_*`; `POST /toggle` turns
// this process's gate on or off (the discriminator); `POST /clear` drops a
// queue's jobs and its fairness keys between runs. Mounted only when
// `qaSeedRoutesEnabled`; never part of the production image.

import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { FairnessTestAccess, readQueueFairness } from "~/infra/jobs/fairness"
import { enqueueAppJobs, getJobQueue, registerJobWorker } from "~/infra/jobs/jobs"
import {
  LOAD_SYNTHETIC_JOB,
  LoadSyntheticTestAccess,
  readLoadSyntheticStats,
  registerLoadSyntheticWorker,
  runLoadSynthetic,
} from "~/infra/jobs/load-synthetic"
import { loadHarnessEnabled } from "~/lib/load-harness"
import { REDIS_PREFIX, redis, redisBullMQ } from "~/lib/redis"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { awaitOrgApps } from "~/modules/apps/init"

const PROBE_APP = "fairness-probe"
const PROBE_JOB = "work"

let registered = false
function register(): void {
  if (registered) return
  registered = true
  // A box with the harness key registered it at boot (src/index.ts).
  if (!loadHarnessEnabled()) registerLoadSyntheticWorker()
  registerJobWorker<{ orgId: string; sleepMs: number; queuedAt: number }>(
    PROBE_APP,
    PROBE_JOB,
    async (p, ctx) => runLoadSynthetic(p, ctx?.signal ?? new AbortController().signal),
    { txMode: "session", concurrency: 4 },
  )
}

const target = z.enum(["kernel", "app"])
function route(t: z.infer<typeof target>): { app: string; job: string } {
  return t === "kernel"
    ? { app: "kernel", job: LOAD_SYNTHETIC_JOB }
    : { app: PROBE_APP, job: PROBE_JOB }
}

async function redisCpuSeconds(): Promise<number> {
  const info = await redis.info("cpu")
  const get = (k: string) => Number(new RegExp(`${k}:([0-9.]+)`).exec(info)?.[1] ?? 0)
  return get("used_cpu_sys") + get("used_cpu_user")
}

export const fairnessTestRoutes = new Hono<AppEnv>()

fairnessTestRoutes.post("/register", async (c) => {
  register()
  return success(c, { registered: true })
})

fairnessTestRoutes.post(
  "/warm",
  zValidator("json", z.object({ orgs: z.array(z.string().uuid()).max(20) })),
  async (c) => {
    for (const orgId of c.req.valid("json").orgs) await awaitOrgApps(orgId)
    return success(c, { warmed: true })
  },
)

fairnessTestRoutes.post(
  "/flood",
  zValidator(
    "json",
    z.object({
      orgId: z.string().uuid(),
      target,
      count: z.number().int().min(1).max(20_000),
      sleepMs: z.number().int().min(0).max(2_000),
    }),
  ),
  async (c) => {
    register()
    const { orgId, count, sleepMs } = c.req.valid("json")
    const { app, job } = route(c.req.valid("json").target)
    for (let i = 0; i < count; i += 500) {
      const n = Math.min(500, count - i)
      const queuedAt = Date.now()
      await enqueueAppJobs(
        app,
        Array.from({ length: n }, () => ({
          jobName: job,
          payload: { orgId, sleepMs, queuedAt },
          opts: { attempts: 1 },
        })),
      )
    }
    return success(c, { enqueued: count })
  },
)

fairnessTestRoutes.get("/state", async (c) => {
  const orgs = (c.req.query("orgs") ?? "").split(",").filter(Boolean)
  const t = target.parse(c.req.query("target") ?? "kernel")
  const { app, job } = route(t)
  const stats = Object.fromEntries(
    await Promise.all(orgs.map(async (o) => [o, await readLoadSyntheticStats(o)] as const)),
  )
  const queue = getJobQueue(app, job)
  return success(c, {
    stats,
    queue: await readQueueFairness(queue.name),
    waiting: await queue.getJobCountByTypes("wait", "prioritized", "delayed", "active"),
    /** C: the worker slots every live job host publishes for this queue. */
    cellSlots: await FairnessTestAccess.cellQueueConcurrency(queue.name),
    redisCpuSeconds: await redisCpuSeconds(),
  })
})

fairnessTestRoutes.post(
  "/toggle",
  zValidator("json", z.object({ enabled: z.boolean() })),
  async (c) => {
    FairnessTestAccess.setEnabled(c.req.valid("json").enabled)
    return success(c, { enabled: c.req.valid("json").enabled })
  },
)

fairnessTestRoutes.post(
  "/clear",
  zValidator("json", z.object({ target, orgs: z.array(z.string().uuid()) })),
  async (c) => {
    register()
    const { app, job } = route(c.req.valid("json").target)
    const queue = getJobQueue(app, job)
    await queue.obliterate({ force: true })
    const keys = await redisBullMQ.keys(`${REDIS_PREFIX}fair:*${queue.name}*`)
    if (keys.length > 0) await redisBullMQ.del(...keys)
    for (const o of c.req.valid("json").orgs) await LoadSyntheticTestAccess.forget(o)
    return success(c, { cleared: true })
  },
)
