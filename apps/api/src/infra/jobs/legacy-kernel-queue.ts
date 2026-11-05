// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Empty the pre-class `app-kernel` queue onto the kernel class queues, without
// losing a job.
//
// What the legacy queue can hold at deploy time, and where each goes:
//   - job SCHEDULERS (every kernel cron, per-routine schedulers): re-created on
//     the class queue under the same id, then removed from `app-kernel`. A
//     scheduler the boot registration already put on its class queue keeps the
//     fresh definition (a cron whose pattern changed in this release must not
//     be overwritten by the old one); only the legacy copy goes.
//   - DELAYED jobs WITH A LOGICAL ID (approval expiries, sliding consolidation
//     deadlines, routine one-shots): re-added on the class queue with the time
//     they have left and their logical id as the deduplication id, then
//     removed. Moving them matters because a later re-arm, dedup or
//     `removeAppJob` of the same logical id looks at the class queue.
//   - DELAYED jobs with an auto-generated (numeric) id, and WAITING /
//     prioritized / stalled jobs: left in place. Nothing can address them by
//     id, so nothing needs them on a class queue, and the job host keeps a
//     one-slot drain worker on `app-kernel` that runs each by its name when it
//     is due (jobs.ts). Leaving them is also what makes a crash harmless: an
//     id-less job moved add-then-remove could run twice.
//
// ORDER IS ADD-THEN-REMOVE: a crash in between leaves a job in both queues,
// never in neither. The class-queue copy carries the logical id as its
// deduplication id, so the next boot's retry collapses into it instead of
// adding a second one (the migration runs before any worker starts, so the
// copy is still pending then). Leader only, under a Redis lock, safe to run on
// every boot: once the legacy queue is empty it is two cheap reads.
import { randomUUID } from "node:crypto"
import type { Job } from "bullmq"
import { isLeader, registerSingleton } from "~/infra/leadership"
import { jobsLogger as log } from "~/lib/logger"
import { redisBullMQ } from "~/lib/redis"
import { schedulerPriority } from "./fairness"
import {
  type EnqueueOptions,
  enqueueAppJobs,
  getJobQueue,
  getLegacyKernelQueue,
  isJobWorkerRegistered,
} from "./jobs"
import { decodeLegacyJobId } from "./legacy-job-ids"
import { KERNEL_JOBS, kernelJobSpec, LEGACY_KERNEL_QUEUE } from "./queue-classes"
import { queueKey } from "./queue-health"

const LOCK_TTL_MS = 120_000
const BATCH = 100

export interface LegacyMigrationResult {
  schedulersMoved: number
  delayedMoved: number
  /** Delayed jobs or schedulers left in `app-kernel` (no logical id, or unknown name): the drain worker runs them. */
  left: number
}

function isSchedulerTick(job: Job): boolean {
  return Boolean(job.repeatJobKey) || String(job.id ?? "").startsWith("repeat:")
}

async function moveSchedulers(): Promise<{ moved: number; left: number }> {
  const legacy = getLegacyKernelQueue()
  const schedulers = await legacy.getJobSchedulers(0, -1)
  let moved = 0
  let left = 0
  for (const s of schedulers) {
    if (!KERNEL_JOBS[s.name]) {
      left++
      log.warn(
        { schedulerId: s.key, jobName: s.name },
        "Legacy kernel scheduler has no class; left",
      )
      continue
    }
    const target = getJobQueue("kernel", s.name)
    if (!(await target.getJobScheduler(s.key))) {
      const priority = schedulerPriority(target.name, kernelJobSpec(s.name).priority)
      await target.upsertJobScheduler(
        s.key,
        {
          ...(s.pattern ? { pattern: s.pattern } : {}),
          ...(s.every ? { every: s.every } : {}),
          ...(s.tz ? { tz: s.tz } : {}),
          ...(s.endDate ? { endDate: s.endDate } : {}),
          ...(s.limit ? { limit: s.limit } : {}),
        },
        {
          name: s.name,
          data: s.template?.data,
          opts: { ...(s.template?.opts ?? {}), ...(priority ? { priority } : {}) },
        },
      )
    }
    await legacy.removeJobScheduler(s.key)
    moved++
  }
  return { moved, left }
}

async function moveDelayedJobs(now: number): Promise<{ moved: number; left: number }> {
  const legacy = getLegacyKernelQueue()
  const delayed = await legacy.getDelayed(0, -1)
  let moved = 0
  let left = 0
  for (let i = 0; i < delayed.length; i += BATCH) {
    const movable: Job[] = []
    for (const job of delayed.slice(i, i + BATCH)) {
      if (!job || isSchedulerTick(job)) continue
      // No logical id, or no class/handler: the drain worker runs it in place.
      if (
        !decodeLegacyJobId(job.id) ||
        !KERNEL_JOBS[job.name] ||
        !isJobWorkerRegistered("kernel", job.name)
      ) {
        left++
        continue
      }
      movable.push(job)
    }
    if (movable.length === 0) continue
    await enqueueAppJobs(
      "kernel",
      movable.map((job) => {
        const jobId = decodeLegacyJobId(job.id)!
        const backoff = job.opts.backoff
        const opts: EnqueueOptions = {
          delay: Math.max(0, job.timestamp + (job.delay ?? 0) - now),
          ...(job.opts.attempts ? { attempts: job.opts.attempts } : {}),
          ...(backoff && typeof backoff === "object" && backoff.type
            ? { backoff: { type: backoff.type, delay: backoff.delay ?? 1000 } }
            : {}),
          jobId,
        }
        return { jobName: job.name, payload: job.data, opts }
      }),
    )
    for (const job of movable) {
      await job.remove()
      moved++
    }
  }
  return { moved, left }
}

/**
 * Move the legacy queue's schedulers and delayed jobs to the class queues.
 * Never throws: a failure is logged and the next boot tries again, while the
 * drain worker keeps running whatever stays behind.
 */
export async function migrateLegacyKernelQueue(
  now: number = Date.now(),
): Promise<LegacyMigrationResult | null> {
  if (!isLeader()) return null
  const lockKey = queueKey(LEGACY_KERNEL_QUEUE, "class-migration-lock")
  const token = randomUUID()
  try {
    const got = await redisBullMQ.set(lockKey, token, "PX", LOCK_TTL_MS, "NX")
    if (got !== "OK") return null
    try {
      const schedulers = await moveSchedulers()
      const delayed = await moveDelayedJobs(now)
      const result = {
        schedulersMoved: schedulers.moved,
        delayedMoved: delayed.moved,
        left: schedulers.left + delayed.left,
      }
      if (result.schedulersMoved + result.delayedMoved + result.left > 0) {
        log.info(result, "Legacy app-kernel queue migrated to the kernel queue classes")
      }
      return result
    } finally {
      if ((await redisBullMQ.get(lockKey)) === token) await redisBullMQ.del(lockKey)
    }
  } catch (err) {
    log.error({ err }, "Legacy app-kernel queue migration failed; the drain worker still runs it")
    return null
  }
}

/**
 * Make the migration the `legacy-kernel-queue` singleton: it runs whenever this
 * process takes the leader lease. When the process already leads (it took the
 * lease at boot), the run is awaited here, so the boot path moves the legacy
 * schedulers before it releases the job workers; the hook does not run it a
 * second time for that same acquisition.
 */
export async function registerLegacyKernelQueueSingleton(
  migrate: () => Promise<unknown> = () => migrateLegacyKernelQueue(),
): Promise<void> {
  const boot = isLeader() ? migrate() : null
  let bootAcquisition = boot !== null
  registerSingleton({
    name: "legacy-kernel-queue",
    onAcquired: () => {
      if (bootAcquisition) {
        bootAcquisition = false
        return
      }
      void migrate()
    },
    onLost: () => {},
  })
  if (boot) await boot
}
