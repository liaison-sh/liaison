// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail jobs already queued when an instance upgrades: a job the previous
// release left in Redis (its queue, job name and payload, written before mail
// ran as server code) is picked up after the upgrade and runs on the mail
// module, in this process, never on a sandbox. The rows below are written
// straight to the queue, as the previous release left them, with the payloads
// its handlers enqueued (unchanged since); this release's queue worker picks
// them up as it would after a deploy.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { getJobQueue } from "~/infra/jobs/jobs"
import { awaitOrgApps } from "~/modules/apps/init"
import * as executor from "~/modules/apps/sandbox/executor"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
/** An account id no mailbox has: each handler looks it up and stops there. */
const accountId = crypto.randomUUID()

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  // The org's apps set up in this process, as the first job for it does: its
  // mail handlers registered and the mail queue's worker running.
  await awaitOrgApps(orgId)
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

const queued: Array<{ remove(): Promise<unknown> }> = []
afterEach(async () => {
  for (const job of queued.splice(0)) await job.remove().catch(() => {})
})

/** Every mail job, with the payload the previous release enqueued it with. */
const PREVIOUS_RELEASE_JOBS: Array<[string, () => Record<string, unknown>]> = [
  ["gmail-initial-sync", () => ({ orgId, accountId })],
  ["gmail-incremental-sync", () => ({ orgId, accountId })],
  ["gmail-incremental-sync", () => ({ orgId })],
  ["gmail-watch-renewal", () => ({ orgId })],
  ["gmail-write-back", () => ({ orgId, accountId, conversationIds: [crypto.randomUUID()] })],
  ["gmail-attachment-backfill", () => ({ orgId, accountId, cursor: null })],
  ["imap-initial-sync", () => ({ orgId, accountId })],
  ["imap-incremental-sync", () => ({ orgId, accountId, chain: true })],
  ["imap-incremental-sync", () => ({ orgId })],
]

describe("mail jobs queued by the previous release", () => {
  it.each(PREVIOUS_RELEASE_JOBS)("%s runs on the mail module", async (jobName, payload) => {
    const quickjs = spyOn(executor, "executeInSandbox")
    const pool = spyOn(workerPool, "getWorkerPool")
    const settled: RunSettledInfo[] = []
    const off = onRunSettled((info) => {
      if (info.orgId === orgId && info.app === "mail") settled.push(info)
    })
    let state = ""
    try {
      const queue = getJobQueue("mail", jobName)
      const added = await queue.add(jobName, payload())
      queued.push(added)
      // This release's worker takes the row from Redis and runs it.
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        state = await queue.getJobState(added.id as string)
        if (state === "completed" || state === "failed") break
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      off()
      quickjs.mockRestore()
      pool.mockRestore()
    }
    expect(state).toBe("completed")
    expect(settled.map((s) => [s.entry, s.executor, s.ok])).toEqual([
      [`job:${jobName}`, "inprocess", true],
    ])
    expect(quickjs).not.toHaveBeenCalled()
    expect(pool).not.toHaveBeenCalled()
  })
})
