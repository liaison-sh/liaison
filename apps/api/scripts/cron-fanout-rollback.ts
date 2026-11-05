// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Roll the cron fan-out back: remove the `app-cron-fanout:*` schedulers and the
 * queued fan-out kernel jobs from `kernel-cron`, which a build from before the
 * fan-out cannot run.
 *
 * WHY. Since the fan-out, an app's manifest `schedule` is one scheduler per
 * (app, job) on `kernel-cron` (infra/jobs/fanout.ts), and the state
 * materializer enqueues one `attention-state-email-materialize-org` job per
 * org. A previous build has no handler for either: every tick would fail and
 * retry. It re-creates its own per-org schedulers when it sets each org up, so
 * nothing else is needed. The per-org jobs already queued on `app-<name>`
 * queues run on the previous build as ordinary jobs of that app.
 *
 * HOW TO RUN IT, in this order:
 *   1. Deploy the previous image (no process of the new one left: a new
 *      process re-creates the fan-out schedulers every 10 minutes).
 *   2. With the NEW image (the only one that has this script), dry run, then
 *      apply, against the production Redis:
 *        bun apps/api/scripts/cron-fanout-rollback.ts            # report only
 *        bun apps/api/scripts/cron-fanout-rollback.ts --apply
 */
import { Queue } from "bullmq"
import { APP_CRON_FANOUT_JOB } from "~/infra/jobs/fanout"
import { KERNEL_QUEUE_CLASSES } from "~/infra/jobs/queue-classes"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { STATE_MATERIALIZER_ORG_JOB } from "~/modules/attention/state-materializer"

export interface FanoutRollbackReport {
  schedulersRemoved: number
  jobsRemoved: number
  applied: boolean
}

const FANOUT_JOB_NAMES = new Set([APP_CRON_FANOUT_JOB, STATE_MATERIALIZER_ORG_JOB])

export async function rollbackCronFanout(opts: { apply: boolean }): Promise<FanoutRollbackReport> {
  const queue = new Queue(KERNEL_QUEUE_CLASSES.cron.queueName, {
    connection: redisBullMQ,
    prefix: bullPrefix,
  })
  const report: FanoutRollbackReport = { schedulersRemoved: 0, jobsRemoved: 0, applied: false }
  try {
    for (const s of await queue.getJobSchedulers(0, -1)) {
      if (!s.key.startsWith(`${APP_CRON_FANOUT_JOB}:`)) continue
      report.schedulersRemoved++
      if (opts.apply) await queue.removeJobScheduler(s.key)
    }
    for (const job of await queue.getJobs(["wait", "prioritized", "delayed", "paused"], 0, -1)) {
      if (!job || !FANOUT_JOB_NAMES.has(job.name)) continue
      // A fan-out scheduler's next tick goes with its scheduler above.
      if (job.repeatJobKey?.startsWith(`${APP_CRON_FANOUT_JOB}:`)) continue
      report.jobsRemoved++
      if (opts.apply) await job.remove()
    }
    report.applied = opts.apply
    return report
  } finally {
    await queue.close()
  }
}

if (import.meta.main) {
  const report = await rollbackCronFanout({ apply: process.argv.includes("--apply") })
  console.log(JSON.stringify(report))
  process.exit(0)
}
