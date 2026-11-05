// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The load harness's job routes (lib/load-harness.ts), beside the signed sink
 * read under `/api/demo/harness`: a flood of synthetic jobs for one load org,
 * and the fan-out report a stress run judges the cron fan-out and the fair
 * queues by.
 *
 * Both are signed with the box's LOAD_HARNESS_KEY. Without the key, without a
 * signature, with a bad, stale or replayed one, or for an org that is not a
 * load org, they answer the same 404 as a route that does not exist, so a
 * scanner never learns the harness is on. The query string is not signed, so
 * neither reads one: the report's window and orgs travel in a signed POST body.
 */
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { buildFanoutReport } from "~/infra/jobs/fanout-report"
import { enqueueAppJobs } from "~/infra/jobs/jobs"
import {
  LOAD_SYNTHETIC_JOB,
  LOAD_SYNTHETIC_MAX_SLEEP_MS,
  type LoadSyntheticPayload,
  loadSyntheticOutstanding,
  registerLoadSyntheticWorker,
  releaseLoadSyntheticReservation,
  reserveLoadSyntheticJobs,
  resetLoadSyntheticOutstanding,
} from "~/infra/jobs/load-synthetic"
import { resolveJobQueue } from "~/infra/jobs/queue-classes"
import { isLoadOrg, verifyHarnessContext } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

const log = rootLogger.child({ module: "load-harness-routes" })

/** Most synthetic jobs one flood request enqueues. */
export const FLOOD_MAX_COUNT = 20_000
/** Jobs added per round trip. */
export const FLOOD_BATCH = 500
/** Most synthetic jobs one load org may have outstanding (enqueued, not finished). */
export const FLOOD_MAX_OUTSTANDING = 50_000
/** Most orgs one report covers. */
const REPORT_MAX_ORGS = 500
/** Longest report window (the per-org run counters live 24 h). */
const REPORT_MAX_WINDOW_MS = 24 * 3600_000

const floodSchema = z
  .object({
    orgId: z.string().uuid(),
    count: z.number().int().min(1).max(FLOOD_MAX_COUNT),
    sleepMs: z.number().int().min(0).max(LOAD_SYNTHETIC_MAX_SLEEP_MS),
    /** Forget the org's outstanding synthetic jobs first (jobs that left their queue unrun). */
    reset: z.boolean().optional(),
  })
  .strict()

const reportSchema = z
  .object({
    orgIds: z.array(z.string().uuid()).min(1).max(REPORT_MAX_ORGS),
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative(),
    floodOrgId: z.string().uuid().optional(),
    queues: z
      .array(z.string().regex(/^[a-z0-9-]{1,64}$/))
      .max(20)
      .optional(),
  })
  .strict()
  .refine((b) => b.toMs >= b.fromMs && b.toMs - b.fromMs <= REPORT_MAX_WINDOW_MS, {
    message: "the window must run forward and span at most 24 h",
  })

let enqueueJobs: typeof enqueueAppJobs = enqueueAppJobs

const notFound = () => new HTTPException(404, { message: "Not found" })

/** The signed body of a harness request, or the 404 every refusal is. */
async function signedBody(c: Parameters<typeof verifyHarnessContext>[0]): Promise<unknown> {
  if (!isDemoModeEnabled()) throw notFound()
  const harness = await verifyHarnessContext(c)
  if (harness.kind === "absent") throw notFound()
  if (harness.kind === "refused") {
    log.warn(
      { reason: harness.reason, path: c.req.path },
      "harness request with a refused signature",
    )
    throw notFound()
  }
  try {
    return JSON.parse(await c.req.text())
  } catch {
    throw new HTTPException(400, { message: "the body is not JSON" })
  }
}

export const harnessRoutes = new Hono<AppEnv>()
  /**
   * Enqueue `count` synthetic jobs (`kernel` / `load-synthetic`, the agent
   * class) for one load org, each holding a worker slot `sleepMs`. The org
   * comes from the signed body and must be a load org; a non-load org is a
   * 404. Refused with 409 when the org's outstanding synthetic jobs would pass
   * 50 000. `reset: true` first forgets the org's outstanding count.
   */
  .post("/flood", async (c) => {
    const parsed = floodSchema.safeParse(await signedBody(c))
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "bad body" })
    }
    const { orgId, count, sleepMs, reset } = parsed.data
    if (!(await isLoadOrg(orgId))) throw notFound()
    if (reset) await resetLoadSyntheticOutstanding(orgId)
    if (!(await reserveLoadSyntheticJobs(orgId, count, FLOOD_MAX_OUTSTANDING))) {
      return c.json(
        {
          error: {
            message: `the org has ${await loadSyntheticOutstanding(orgId)} synthetic jobs outstanding; at most ${FLOOD_MAX_OUTSTANDING}`,
            code: "flood_outstanding_cap",
          },
        },
        409,
      )
    }
    // The handler must be known locally before an enqueue (jobs.ts asserts it).
    registerLoadSyntheticWorker()
    let enqueued = 0
    try {
      while (enqueued < count) {
        const n = Math.min(FLOOD_BATCH, count - enqueued)
        const queuedAt = Date.now()
        const payload: LoadSyntheticPayload = { orgId, sleepMs, queuedAt }
        await enqueueJobs(
          "kernel",
          Array.from({ length: n }, () => ({ jobName: LOAD_SYNTHETIC_JOB, payload })),
        )
        enqueued += n
      }
    } catch (err) {
      await releaseLoadSyntheticReservation(orgId, count - enqueued)
      log.error({ err, orgId, enqueued, count }, "load harness flood stopped part way")
      throw new HTTPException(503, {
        message: `flood stopped after ${enqueued} of ${count} jobs: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    log.info({ orgId, count, sleepMs }, "load harness flood enqueued")
    return success(c, {
      orgId,
      enqueued,
      queue: resolveJobQueue("kernel", LOAD_SYNTHETIC_JOB).queueName,
    })
  })
  /**
   * The fan-out report (infra/jobs/fanout-report.ts) for the given load orgs
   * and window. Every org must be a load org, or the whole request is a 404.
   * A POST because its window and orgs must be signed (the query is not).
   */
  .post("/fanout-report", async (c) => {
    const parsed = reportSchema.safeParse(await signedBody(c))
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "bad body" })
    }
    const body = parsed.data
    const orgIds = [...new Set(body.orgIds)]
    const flags = await Promise.all(orgIds.map((o) => isLoadOrg(o)))
    if (flags.some((f) => !f)) throw notFound()
    if (body.floodOrgId && !orgIds.includes(body.floodOrgId)) {
      throw new HTTPException(400, { message: "floodOrgId must be one of orgIds" })
    }
    const report = await buildFanoutReport({
      orgIds,
      fromMs: body.fromMs,
      toMs: body.toMs,
      floodOrgId: body.floodOrgId,
      queues: body.queues ?? [resolveJobQueue("kernel", LOAD_SYNTHETIC_JOB).queueName],
    })
    return success(c, report)
  })

/** Test access to this module's seams. Production code never calls it. */
export const HarnessRoutesTestAccess = {
  /** Replace the enqueue; pass nothing to restore `enqueueAppJobs`. */
  setEnqueue(fn?: typeof enqueueAppJobs): void {
    enqueueJobs = fn ?? enqueueAppJobs
  },
}
