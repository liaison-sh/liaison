// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DEFECT D8. Turning LIAISON_DEMO_MODE off did not turn the demo box back into a
// normal box.
//
// The `demo-reset` registration was gated, which reads like enough, but
// `registerScheduledJob` calls `upsertJobScheduler`, and BullMQ PERSISTS a
// scheduler in Redis. A deployment that had once run with the flag on therefore
// kept enqueuing `demo-reset` every night, three attempts each time, against a
// handler no longer registered, for ever. No generic pruner covers a kernel cron
// (the fan-out reconcile only touches `app-cron-fanout:*`).
//
// The claim "a fresh non demo deployment is clean" was true as stated. The
// TRANSITION is what this file is about, and it is asserted against Redis itself
// rather than against the shape of the code.
//
// THE MUTATION THAT PROVES IT BITES: drop the `removeScheduledJob` call from
// `syncDemoResetScheduler`'s non demo branch (which is exactly the code that
// shipped). The last two tests fail: the scheduler is still listed and still
// carries its cron.
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { getJobQueue, upsertJobScheduler } from "~/infra/jobs/jobs"
import { DEMO_RESET_SCHEDULER_ID, syncDemoResetScheduler } from "~/infra/jobs/kernel-jobs"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"

async function schedulerIds(): Promise<string[]> {
  const schedulers = await getJobQueue("kernel", "demo-reset").getJobSchedulers(0, 1000)
  return schedulers.map((s) => String(s.key ?? s.id))
}

/** Put the scheduler a demo box leaves behind into Redis, without the handler. */
async function leaveAnOrphanBehind(): Promise<void> {
  await upsertJobScheduler("kernel", "demo-reset", "15 3 * * *", {
    schedulerId: DEMO_RESET_SCHEDULER_ID,
  })
}

describe("the demo reset scheduler survives the flag being turned off", () => {
  beforeEach(async () => {
    await getJobQueue("kernel", "demo-reset").removeJobScheduler(DEMO_RESET_SCHEDULER_ID)
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await getJobQueue("kernel", "demo-reset").removeJobScheduler(DEMO_RESET_SCHEDULER_ID)
  })

  it("is there while the box is the demo box", async () => {
    await leaveAnOrphanBehind()
    expect(await schedulerIds()).toContain(DEMO_RESET_SCHEDULER_ID)
  })

  it("is REMOVED when the box boots with demo mode off", async () => {
    await leaveAnOrphanBehind()
    DemoModeTestAccess.set(false)
    await syncDemoResetScheduler()
    expect(await schedulerIds()).not.toContain(DEMO_RESET_SCHEDULER_ID)
  })

  it("stops enqueuing, which is the thing that was actually wrong", async () => {
    await leaveAnOrphanBehind()
    DemoModeTestAccess.set(false)
    await syncDemoResetScheduler()
    // Nothing left to fire from: BullMQ has no template, so no next run exists.
    const still = await getJobQueue("kernel", "demo-reset").getJobScheduler(DEMO_RESET_SCHEDULER_ID)
    expect(still ?? null).toBeNull()
  })

  it("is a no-op on a box that never had one, so a fresh deployment is untouched", async () => {
    DemoModeTestAccess.set(false)
    await syncDemoResetScheduler()
    await syncDemoResetScheduler()
    expect(await schedulerIds()).not.toContain(DEMO_RESET_SCHEDULER_ID)
  })
})
