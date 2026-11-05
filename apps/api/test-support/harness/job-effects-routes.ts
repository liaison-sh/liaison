// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell seam for the S11 scenario (P3 T19): a job, run by the real BullMQ job
// host, that drives one audited effect door and can be cut mid-way.
//
// `test-effects:run` takes `{ kind, org, key, phase, waitMs }` and calls the
// door that kind's production job calls:
//
//   digest-mail   sendEmailOnce (infra/email.ts), the digest jobs' door
//   webhook-retry processWebhookRetry (infra/jobs/webhook-worker.ts), with a
//                 host handler registered here as the app's endpoint
//   app-effect    the sandbox bridge's ctx.effects steps (bridge/effects.ts),
//                 claim / complete / release, as an app job (invoicing) runs them
//
// The effect itself counts into Redis (`effect:test:job:<kind>:<key>`), every
// attempt. The webhook retry's handler applies a database write as well, in
// the handler's own transaction (as a real handler does): its committed count
// (`applied`) is what a kill inside the handler rolls back. For a
// load org, the digest mail goes to the effect sink instead, which the scenario
// reads. `phase` says where the run waits `waitMs`, so the scenario can stop
// the process there: `mid` inside the effect (claimed, not stored), `after`
// once the door returned and before the job completes. Each run appends the
// door's outcome to `effect:test:job-outcomes:<kind>:<key>`.
//
// Registered per process (`POST /api/_test/job-effects/register`): a process
// runs the job only once it is registered there. Mounted only when
// `qaSeedRoutesEnabled`; never part of the production image.

import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appSequences, organizations } from "~/db/schema/kernel"
import { type EmailProvider, sendEmailOnce } from "~/infra/email"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { processWebhookRetry } from "~/infra/jobs/webhook-worker"
import { sinkCount } from "~/lib/effect-sink"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { loadOrgSettingsFragment, rememberLoadOrg } from "~/lib/load-harness"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { webhookHandlers } from "~/modules/apps/app-registries"
import { createEffectsMethods } from "~/modules/apps/sandbox/bridge/effects"
import { allocateSequence } from "~/modules/sequences/allocate"

const APP = "test-effects"
const JOB = "run"
const WEBHOOK_APP = "kernel"
const WEBHOOK_ENDPOINT = "test-effect-retry"

const kinds = ["digest-mail", "webhook-retry", "app-effect"] as const
type Kind = (typeof kinds)[number]

const runSchema = z.object({
  kind: z.enum(kinds),
  org: z.string().uuid(),
  key: z.string().min(1).max(120),
  phase: z.enum(["mid", "after", "none"]),
  waitMs: z.number().int().min(0).max(120_000),
})
type Run = z.infer<typeof runSchema>

const countKey = (kind: Kind, key: string) => `effect:test:job:${kind}:${key}`
const outcomesKey = (kind: Kind, key: string) => `effect:test:job-outcomes:${kind}:${key}`

/** The effect: counted, then (phase `mid`) the run waits inside the claim. */
async function effect(run: Run): Promise<void> {
  await redis.incr(countKey(run.kind, run.key))
  if (run.phase === "mid") await Bun.sleep(run.waitMs)
}

/** The webhook handler's write, counted in its own transaction (`applied`). */
const appliedKey = (key: string) => `kernel:test-effect-applied:${key}`

/**
 * The webhook retry's handler: an attempt is counted, then the delivery is
 * applied in the handler's transaction and (phase `mid`, first attempt) the
 * run waits before that transaction commits. A kill there rolls the write back.
 */
async function webhookEffect(run: Run, tx: RlsClient): Promise<void> {
  const attempt = await redis.incr(countKey(run.kind, run.key))
  await allocateSequence(tx, { orgId: run.org, callingAppId: "kernel", key: appliedKey(run.key) })
  // Only the first attempt waits: the one the scenario cuts.
  if (run.phase === "mid" && attempt === 1) await Bun.sleep(run.waitMs)
}

/** How many times the webhook handler's write committed. */
async function appliedCount(org: string, key: string): Promise<number> {
  const rows = await withSystemDb("test-effects:applied", (tx) =>
    tx
      .select({ value: appSequences.value })
      .from(appSequences)
      .where(
        and(
          eq(appSequences.orgId, org),
          eq(appSequences.appId, "kernel"),
          eq(appSequences.key, appliedKey(key)),
        ),
      )
      .limit(1),
  )
  return rows[0]?.value ?? 0
}

/** A mail provider whose send is the counted effect. */
function countingProvider(run: Run): EmailProvider {
  return { send: () => effect(run), verify: async () => true }
}

async function door(run: Run): Promise<string> {
  switch (run.kind) {
    case "digest-mail":
      return sendEmailOnce(run.org, countingProvider(run), {
        to: "digest@example.com",
        subject: "Digest",
        html: "<p>digest</p>",
        idempotencyKey: run.key,
      })
    case "webhook-retry": {
      // The endpoint's handler is this run's effect (registered per process,
      // as the app's own registration would be).
      webhookHandlers.set([run.org, WEBHOOK_APP, WEBHOOK_ENDPOINT], {
        handler: async (_payload: unknown, ctx: { db: RlsClient }) => webhookEffect(run, ctx.db),
        verify: async () => ({ valid: true, replayKey: run.key }),
        appName: WEBHOOK_APP,
        orgId: run.org,
      })
      await processWebhookRetry({
        orgId: run.org,
        appName: WEBHOOK_APP,
        endpointName: WEBHOOK_ENDPOINT,
        payload: {},
        deliveryId: run.key,
      })
      return "returned"
    }
    case "app-effect": {
      // The guest side of `appEffectOnce` (@liaison/app-sdk/effects), step by
      // step through the host methods an app's sandbox calls.
      const fx = createEffectsMethods({ appName: "invoicing", orgId: run.org })
      const claim = JSON.parse(await fx.effects_claim(`einv:${run.key}:submit`, "{}")) as {
        state: string
      }
      if (claim.state !== "claimed") return claim.state
      try {
        await effect(run)
      } catch (err) {
        await fx.effects_release(`einv:${run.key}:submit`)
        throw err
      }
      await fx.effects_complete(`einv:${run.key}:submit`, JSON.stringify({ deposited: true }))
      return "ran"
    }
  }
}

let registered = false

/** Register the job's handler in THIS process (its job host then runs it). */
export function registerJobEffectsWorker(): void {
  if (registered) return
  registered = true
  registerJobWorker<Run>(APP, JOB, async (payload) => {
    const run = runSchema.parse(payload)
    const outcome = await door(run)
    await redis.rpush(outcomesKey(run.kind, run.key), outcome)
    if (run.phase === "after") await Bun.sleep(run.waitMs)
  })
}

export const jobEffectsTestRoutes = new Hono<AppEnv>()

jobEffectsTestRoutes.use("*", async (_c, next) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  await next()
})

/** POST /api/_test/job-effects/register — host the job in this process. */
jobEffectsTestRoutes.post("/register", async (c) => {
  registerJobEffectsWorker()
  return success(c, { registered: true })
})

/** POST /api/_test/job-effects/enqueue — one run, on the shared queue. */
jobEffectsTestRoutes.post("/enqueue", zValidator("json", runSchema), async (c) => {
  registerJobEffectsWorker()
  const run = c.req.valid("json")
  // Room for the in-flight waits and stall recoveries of a cut run.
  const id = await enqueueAppJob(APP, JOB, run, {
    attempts: 20,
    backoff: { type: "fixed", delay: 1_000 },
  })
  return success(c, { id })
})

/** POST /api/_test/job-effects/load-org — flag an org as a load org (needs LOAD_HARNESS_KEY). */
jobEffectsTestRoutes.post(
  "/load-org",
  zValidator("json", z.object({ org: z.string().uuid() })),
  async (c) => {
    const { org } = c.req.valid("json")
    // Throws while the harness is off, so a box without the key never gains a flagged org.
    const flag = JSON.stringify(loadOrgSettingsFragment())
    await withSystemDb("test-effects:load-org", (tx) =>
      tx
        .update(organizations)
        .set({
          settings: drizzleSql`COALESCE(${organizations.settings}, '{}'::jsonb) || ${flag}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org)),
    )
    rememberLoadOrg(org)
    return success(c, { ok: true })
  },
)

/**
 * GET /api/_test/job-effects/state?kind=&key=&org= — the effect's count (for
 * the webhook retry: its committed writes), its attempts, sink count and outcomes.
 */
jobEffectsTestRoutes.get("/state", async (c) => {
  const kind = z.enum(kinds).parse(c.req.query("kind"))
  const key = z.string().min(1).parse(c.req.query("key"))
  const org = c.req.query("org")
  const attempts = Number((await redis.get(countKey(kind, key))) ?? 0)
  return success(c, {
    count: kind === "webhook-retry" && org ? await appliedCount(org, key) : attempts,
    attempts,
    sink: org && kind === "digest-mail" ? await sinkCount(org, "mail", key) : 0,
    outcomes: await redis.lrange(outcomesKey(kind, key), 0, -1),
  })
})
