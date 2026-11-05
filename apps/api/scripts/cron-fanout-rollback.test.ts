// SPDX-License-Identifier: FSL-1.1-ALv2
// A rollback to a build from before the cron fan-out removes what that build
// cannot run: the fan-out schedulers and the queued fan-out kernel jobs on
// `kernel-cron`. Every other scheduler and job stays.
import { afterAll, describe, expect, it } from "bun:test"
import { Queue } from "bullmq"
import { KERNEL_QUEUE_CLASSES } from "~/infra/jobs/queue-classes"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { rollbackCronFanout } from "./cron-fanout-rollback"

const cron = new Queue(KERNEL_QUEUE_CLASSES.cron.queueName, {
  connection: redisBullMQ,
  prefix: bullPrefix,
})

describe("cron fan-out rollback", () => {
  afterAll(async () => {
    await cron.obliterate({ force: true })
    await cron.close()
  })

  it("removes the fan-out schedulers and queued fan-out jobs, keeps the rest (dry run first)", async () => {
    await cron.obliterate({ force: true })
    await cron.upsertJobScheduler(
      "app-cron-fanout:tickets:slaCheck",
      { pattern: "*/5 * * * *" },
      { name: "app-cron-fanout", data: { app: "tickets", job: "slaCheck" } },
    )
    await cron.upsertJobScheduler(
      "approval-expiry-sweep-scheduler",
      { pattern: "*/2 * * * *" },
      { name: "approval-expiry-sweep" },
    )
    await cron.add("attention-state-email-materialize-org", { orgId: "o" }, { delay: 600_000 })
    await cron.add("approval-expiry", { requestId: "r" }, { delay: 600_000 })

    const dry = await rollbackCronFanout({ apply: false })
    // The fan-out scheduler's next tick goes with its scheduler.
    expect(dry).toEqual({ schedulersRemoved: 1, jobsRemoved: 1, applied: false })
    expect(await cron.getJobScheduler("app-cron-fanout:tickets:slaCheck")).toBeDefined()

    const report = await rollbackCronFanout({ apply: true })
    expect(report).toEqual({ schedulersRemoved: 1, jobsRemoved: 1, applied: true })
    expect((await cron.getJobSchedulers(0, -1)).map((s) => s.key)).toEqual([
      "approval-expiry-sweep-scheduler",
    ])
    const left = (await cron.getDelayed()).map((j) => j.name).sort()
    expect(left).toEqual(["approval-expiry", "approval-expiry-sweep"])
  })
})
