// SPDX-License-Identifier: FSL-1.1-ALv2
// Design audit 2026-09-30, finding 18: the embedding backfill re-enqueued
// itself under `…:${Date.now()}`, so two triggers started two chains racing on
// the one cursor. A chain step's id is now the org plus the cursor it starts
// from: triggers at the same position are one job.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  backfillStepId,
  clearBackfillCursor,
  EMBEDDING_BACKFILL_JOB,
  enqueueEmbeddingBackfill,
  runBackfillStep,
  writeBackfillCursor,
} from "./embedding-backfill"
import { closeAllQueues, getJobQueue, JobsTestAccess, registerJobWorker } from "./jobs"

const ORG = crypto.randomUUID()

async function backlogFor(orgId: string): Promise<number> {
  const queue = getJobQueue("kernel", EMBEDDING_BACKFILL_JOB)
  const jobs = await queue.getJobs(["wait", "prioritized", "delayed", "active"])
  return jobs.filter((j) => j?.data?.orgId === orgId).length
}

describe("embedding backfill: one chain per org", () => {
  beforeAll(() => {
    // Hold the jobs in the queue: this process registers the handler (so the
    // enqueue is accepted) but runs no worker.
    JobsTestAccess.stopHosting()
    registerJobWorker("kernel", EMBEDDING_BACKFILL_JOB, async () => {})
  })
  afterAll(async () => {
    const queue = getJobQueue("kernel", EMBEDDING_BACKFILL_JOB)
    for (const j of await queue.getJobs(["wait", "prioritized", "delayed"])) {
      if (j?.data?.orgId === ORG) await j.remove()
    }
    await clearBackfillCursor(ORG)
    JobsTestAccess.reenableJobWorkers()
    await closeAllQueues()
  })

  it("two triggers at the same cursor queue ONE step", async () => {
    await clearBackfillCursor(ORG)
    await enqueueEmbeddingBackfill(ORG)
    await new Promise((r) => setTimeout(r, 5))
    await enqueueEmbeddingBackfill(ORG)
    expect(await backlogFor(ORG)).toBe(1)
  })

  it("a step at a later cursor is a different step (the chain moves on)", async () => {
    await writeBackfillCursor(ORG, "2026-03-10T09:00:00.000Z|00000000-0000-0000-0000-000000000001")
    await enqueueEmbeddingBackfill(ORG)
    await enqueueEmbeddingBackfill(ORG)
    expect(await backlogFor(ORG)).toBe(2)
    expect(backfillStepId(ORG, null)).not.toBe(
      backfillStepId(ORG, "2026-03-10T09:00:00.000Z|00000000-0000-0000-0000-000000000001"),
    )
  })

  it("a step queues its continuation from the cursor it reached, not from a fresh Redis read", async () => {
    const reached = "2026-04-01T00:00:00.000Z|00000000-0000-0000-0000-00000000000a"
    // Another writer moved the persisted cursor meanwhile.
    await writeBackfillCursor(ORG, "2026-05-01T00:00:00.000Z|00000000-0000-0000-0000-00000000000b")
    await runBackfillStep({ orgId: ORG }, async () => ({
      embedded: 1,
      cursor: reached,
      done: false,
    }))
    const queue = getJobQueue("kernel", EMBEDDING_BACKFILL_JOB)
    expect(await queue.getDeduplicationJobId(backfillStepId(ORG, reached))).not.toBeNull()
  })
})
