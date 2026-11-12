// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The webhook inbox's jobs (modules/webhooks/inbox.ts):
 *
 * - `webhook-inbox-replay` {orgId, inboxId}: claims one due row and runs its
 *   handler again, exactly as the route did (handler-run.ts), then settles it;
 * - `webhook-inbox-sweep` (every minute): wakes every due row whose replay job
 *   was lost (a process that died between store and handle leaves its row
 *   `processing` until the lease ends, then it is due), and moves the previous
 *   release's queued `retry-webhook` jobs into the inbox;
 * - `webhook-inbox-retention` (hourly): deletes settled and dead rows past
 *   their windows.
 *
 * All three run on their own queue class (`webhook`, queue-classes.ts), never
 * on `kernel-cron`: a burst of replays waits behind itself only.
 *
 * Upgrade: the previous release kept a failed or capped delivery as a delayed
 * `retry-webhook` job. The leader drains those into the inbox when it takes
 * the lease (boot) and the sweep keeps draining what a previous-release
 * process still adds during a rolling deploy. A `retry-webhook` job that runs
 * anyway (it was already waiting) still runs unchanged (webhook-worker.ts).
 */
import { createHash } from "node:crypto"
import type { Job } from "bullmq"
import { registerSingleton } from "~/infra/leadership"
import { EffectInFlight, effectOnce } from "~/lib/effect-once"
import { rootLogger } from "~/lib/logger"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { isAppOffForPathOrg } from "~/modules/apps/org-apps"
import { resolveToolTimeoutMs } from "~/modules/apps/run-limits"
import { appRunHoldMs } from "~/modules/apps/usage/app-day-cap"
import { writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import {
  classifyHandlerResult,
  resolveWebhookUserActorId,
  runWebhookHandler,
  webhookRunHoldsTx,
} from "~/modules/webhooks/handler-run"
import {
  type ClaimedDelivery,
  claimForReplay,
  insertLegacyRetry,
  LEGACY_HASH_PREFIX,
  listDueDeliveries,
  pruneWebhookInbox,
  replayJobId,
  settleDelivery,
  WEBHOOK_INBOX_REPLAY_JOB,
  wakeAfterSettle,
} from "~/modules/webhooks/inbox"
import {
  enqueueAppJobs,
  getJobQueue,
  getLegacyKernelQueue,
  getPhysicalQueue,
  registerJobWorker,
  registerScheduledJob,
} from "./jobs"
import { withPinnedJobSlot } from "./pinned-jobs-gate"
import { KERNEL_QUEUE_CLASSES } from "./queue-classes"

const log = rootLogger.child({ module: "webhook-inbox-jobs" })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_NAME = /^[a-z][a-z0-9_-]*$/
const LEGACY_JOB = "retry-webhook"
const DRAIN_BATCH = 200

/** A handler status that asks for a retry: thrown inside the effect so its claim is released. */
class TransientHandlerStatus extends Error {
  constructor(readonly status: number) {
    super(`handler returned ${status}`)
    this.name = "TransientHandlerStatus"
  }
}

/** Run one replay of the inbox row named by the job. Exported for tests. */
export async function replayInboxDelivery(
  data: { orgId?: unknown; inboxId?: unknown },
  signal?: AbortSignal,
): Promise<void> {
  const { orgId, inboxId } = data ?? {}
  if (
    typeof orgId !== "string" ||
    !UUID.test(orgId) ||
    typeof inboxId !== "string" ||
    !UUID.test(inboxId)
  ) {
    log.warn({ data }, "Invalid webhook inbox replay job data — skipping")
    return
  }
  const row = await claimForReplay(orgId, inboxId)
  if (!row) return
  try {
    await runClaimed(row, signal)
  } catch (err) {
    // Anything the outcome handling did not settle: back to pending, woken
    // by its backoff (or by the sweep when even the settle failed).
    log.error({ err, inboxId, app: row.appName }, "webhook inbox replay failed")
    await wakeAfterSettle(
      row,
      await settleDelivery(row, { status: "failed", error: errorText(err) }).catch(() => null),
    )
  }
}

async function runClaimed(row: ClaimedDelivery, signal?: AbortSignal): Promise<void> {
  const { orgId, appName, endpointName } = row
  // An app turned Off (or removed) for the org since the delivery was stored:
  // dropped like a fresh delivery would be (S19, D24).
  if (await isAppOffForPathOrg(orgId, appName)) {
    log.info({ orgId, appName, endpointName }, "webhook replay dropped: the app is Off for the org")
    await settleDelivery(row, { status: "dropped", error: "the app is Off for the org" })
    return
  }
  const reg = webhookHandlers.get([orgId, appName, endpointName])
  if (!reg) {
    await fail(row, "no handler registered for the endpoint")
    return
  }
  // The org reached an app day cap: held until the next UTC day, no attempt spent.
  if (isManifestHandler(reg.handler)) {
    const holdMs = await appRunHoldMs({
      orgId,
      trusted: (reg.handler as ManifestHandlerRef).trusted === true,
    })
    if (holdMs !== null) {
      await wakeAfterSettle(row, await settleDelivery(row, { status: "held", holdMs }))
      return
    }
  }
  const userActorId = reg.requiresUserActor ? await resolveWebhookUserActorId(orgId) : null
  if (reg.requiresUserActor && !userActorId) {
    await fail(row, "no active org user to act as")
    return
  }
  const timeoutMs = resolveToolTimeoutMs(reg.timeoutMs)
  let outcome: Awaited<ReturnType<typeof runOnce>>
  try {
    const run = () =>
      runWebhookHandler({
        registration: reg,
        appName,
        orgId,
        scopes: row.scopes,
        userActorId,
        payload: row.payload,
        headers: row.headers,
        ...(timeoutMs ? { timeoutMs } : {}),
      })
    outcome = await runOnce(row, () =>
      // A handler whose transaction holds a jobs connection for its whole run
      // waits for admission first (infra/jobs/pinned-jobs-gate.ts); a sandboxed
      // one opens a short transaction per bridge call and holds none.
      webhookRunHoldsTx(reg, appName)
        ? withPinnedJobSlot(`webhook:${appName}`, run, signal)
        : run(),
    )
  } catch (err) {
    if (!(err instanceof EffectInFlight)) {
      log.warn(
        { err, orgId, appName, endpointName, inboxId: row.id },
        "webhook replay attempt failed",
      )
    }
    await fail(row, errorText(err))
    return
  }
  if (outcome && "rejected" in outcome) {
    await settleDelivery(row, { status: "rejected", error: outcome.rejected })
    return
  }
  await settleDelivery(row, { status: "done" })
}

/**
 * One run of the handler, read as done, rejected, or (thrown) to retry.
 *
 * A row of this release is fenced by its claim: only the claimer settles it,
 * and a claimer that died is replaced once its lease ends. A run that
 * committed and then lost its process before the settle is run again, which
 * the handler dedups on the provider's event id (as with any redelivery).
 *
 * A row moved in from a previous release's job runs under the effect-ledger
 * key that job used (`webhook:<app>:<endpoint>:<delivery id>`, its delivery id
 * being the row id): a job that ran anyway (it had already started when it was
 * moved) is not applied twice. A run that threw or returned a transient status
 * released the key.
 */
async function runOnce(
  row: ClaimedDelivery,
  run: () => Promise<unknown>,
): Promise<{ done: true } | { rejected: string }> {
  const attempt = async (): Promise<{ done: true } | { rejected: string }> => {
    const handled = classifyHandlerResult(await run())
    if (handled.kind === "transient") throw new TransientHandlerStatus(handled.status)
    return handled.kind === "rejected" ? { rejected: handled.message } : { done: true }
  }
  if (!row.legacy) return attempt()
  const out = await effectOnce(
    row.orgId,
    `webhook:${row.appName}:${row.endpointName}:${row.id}`,
    attempt,
    { onUnknown: async () => ({ outcome: "retry" }) },
  )
  if (out.status === "unknown") throw new Error("the delivery's effect is in an unknown state")
  return out.result
}

async function fail(row: ClaimedDelivery, error: string): Promise<void> {
  await wakeAfterSettle(row, await settleDelivery(row, { status: "failed", error }))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A stable row id for a legacy job without a delivery id (sha256 of its queue and job id). */
function legacyRowId(queueName: string, jobId: string): string {
  const h = createHash("sha256").update(`${queueName}:${jobId}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Move the previous release's delayed `retry-webhook` jobs (failed deliveries
 * in their backoff, deliveries held at an app day cap) into the inbox: the
 * row first, then the job removed, so a crash in between leaves both, and the
 * next drain finds the row already there (same id) and removes the job. A job
 * that started meanwhile cannot be removed; it runs as before and the row's
 * replay meets its effect-ledger key. Waiting jobs are left to the worker,
 * which runs them unchanged. A job whose data is not a valid delivery is left
 * too (the worker discards it, as before).
 */
export async function drainLegacyRetryJobs(now: number = Date.now()): Promise<{ moved: number }> {
  let moved = 0
  const queues = [getJobQueue("kernel", LEGACY_JOB), getLegacyKernelQueue()]
  for (const queue of queues) {
    const jobs = (await queue.getJobs(["delayed"], 0, DRAIN_BATCH - 1)) as Job[]
    for (const job of jobs) {
      if (!job || job.name !== LEGACY_JOB || !job.id) continue
      const d = (job.data ?? {}) as Record<string, unknown>
      if (
        typeof d.orgId !== "string" ||
        !UUID.test(d.orgId) ||
        typeof d.appName !== "string" ||
        !SAFE_NAME.test(d.appName) ||
        typeof d.endpointName !== "string" ||
        !SAFE_NAME.test(d.endpointName)
      ) {
        continue
      }
      const orgId = d.orgId
      const id =
        typeof d.deliveryId === "string" && UUID.test(d.deliveryId)
          ? d.deliveryId.toLowerCase()
          : legacyRowId(queue.name, job.id)
      const dueAt = job.timestamp + (job.opts?.delay ?? 0)
      const headers =
        d.headers && typeof d.headers === "object" ? (d.headers as Record<string, string>) : {}
      const done = await writeUnlessMoving(orgId, async () => {
        await insertLegacyRetry({
          id,
          orgId,
          appName: d.appName as string,
          endpointName: d.endpointName as string,
          deliveryHash: `${LEGACY_HASH_PREFIX}${queue.name}:${job.id}`,
          payload: d.payload ?? null,
          headers,
          dueInMs: Math.max(0, dueAt - now),
        })
        return true
      })
      if (done !== true) continue
      try {
        await job.remove()
        moved++
      } catch (err) {
        log.warn(
          { err, jobId: job.id },
          "legacy retry-webhook job not removed (it started); the ledger key dedups",
        )
      }
    }
  }
  if (moved > 0) log.info({ moved }, "legacy retry-webhook jobs moved into the webhook inbox")
  return { moved }
}

/**
 * Due rows one sweep wakes at most: a backlog (every held delivery comes due
 * at UTC midnight) drains over a few minutes instead of flooding the queue.
 */
export const SWEEP_MAX_WAKES = 100

/** One sweep: drain legacy jobs, then wake the due rows, oldest first. */
export async function sweepWebhookInbox(): Promise<{ woken: number; moved: number }> {
  const { moved } = await drainLegacyRetryJobs()
  const due = await listDueDeliveries(SWEEP_MAX_WAKES)
  if (due.length > 0) {
    await enqueueAppJobs(
      "kernel",
      due.map((r) => ({
        jobName: WEBHOOK_INBOX_REPLAY_JOB,
        payload: { orgId: r.orgId, inboxId: r.id },
        opts: { jobId: replayJobId(r.id, r.attempts) },
      })),
    )
  }
  return { woken: due.length, moved }
}

/** Register the inbox's jobs; call from startup, after the job runtime is up. */
export async function registerWebhookInboxJobs(): Promise<void> {
  registerJobWorker(
    "kernel",
    WEBHOOK_INBOX_REPLAY_JOB,
    (data: { orgId?: unknown; inboxId?: unknown }, ctx) => replayInboxDelivery(data, ctx?.signal),
  )
  await registerScheduledJob("kernel", "webhook-inbox-sweep", "* * * * *", async () => {
    const r = await sweepWebhookInbox()
    if (r.woken + r.moved > 0) log.info(r, "webhook_inbox_sweep")
  })
  await registerScheduledJob("kernel", "webhook-inbox-retention", "37 * * * *", async () => {
    log.info(await pruneWebhookInbox(), "webhook_inbox_retention")
  })
  // Boot drain: the leader moves the previous release's queued retries into
  // the inbox as soon as it holds the lease (registered while leading, the
  // hook runs at once), and again on each takeover.
  const drain = () => {
    drainLegacyRetryJobs().catch((err) =>
      log.error({ err }, "legacy retry-webhook drain failed; the sweep retries"),
    )
  }
  registerSingleton({ name: "webhook-inbox-legacy-drain", onAcquired: drain, onLost: () => {} })
  await removeCronLaneSchedulers()
}

/**
 * The inbox's schedulers as a build that ran them on `kernel-cron` left them:
 * removed, so the sweep does not tick twice a minute. Its replays already
 * queued there still run (a job host runs a kernel job by its name).
 */
async function removeCronLaneSchedulers(): Promise<void> {
  const cron = getPhysicalQueue(KERNEL_QUEUE_CLASSES.cron.queueName)
  for (const id of ["webhook-inbox-sweep-scheduler", "webhook-inbox-retention-scheduler"]) {
    try {
      await cron.removeJobScheduler(id)
    } catch (err) {
      log.warn(
        { err, schedulerId: id },
        "could not remove a webhook inbox scheduler from kernel-cron",
      )
    }
  }
}
