// SPDX-License-Identifier: FSL-1.1-ALv2
// A job enqueued from inside a transaction must not reach the queue before COMMIT: its worker
// reads the rows the transaction writes, and on another connection it sees none of them yet
// (a calendar push job ran before its event row committed and pushed nothing). `afterCommit`
// adds the job once the transaction has committed, and never when it rolls back.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Queue } from "bullmq"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { FairnessTestAccess } from "~/infra/jobs/fairness"
import { enqueueAppJob, registerJobWorker, unregisterAppJobHandlers } from "~/infra/jobs/jobs"
import { waitFor } from "~/tests/helpers/wait-for"

const APP = "commit-probe"
const JOB = "probe"
const created: string[] = []

/** What the queue saw: for each add, whether the row was visible to another connection. */
let seen: Array<{ slug: string; visible: boolean }> = []
let pendingReads: Promise<void>[] = []
let addBulk: ReturnType<typeof spyOn>

/** Read on a connection of its own (not the writer's, and holding no privileged slot). */
async function orgVisible(slug: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM kernel.organizations WHERE slug = ${slug}`
  return rows.length > 0
}

/** One transaction that writes a row and enqueues a job naming it; `fail` rolls it back. */
async function writeAndEnqueue(afterCommit: boolean, fail = false): Promise<string> {
  const slug = `commit-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  created.push(slug)
  const run = withSystemDb("commit-probe-write", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Commit Probe', ${slug})
    `)
    await enqueueAppJob(APP, JOB, { slug }, { jobId: `probe:${slug}`, afterCommit })
    if (fail) throw new Error("roll back")
  })
  if (fail) await expect(run).rejects.toThrow("roll back")
  else await run
  // A deferred add starts when the transaction settles and reaches the queue a few awaits later.
  if (!fail) await waitFor(() => addBulk.mock.calls.length > 0, { timeoutMs: 5_000 })
  await Promise.all(pendingReads)
  return slug
}

beforeAll(() => {
  FairnessTestAccess.setEnabled(false)
  registerJobWorker(APP, JOB, async () => {})
})

afterEach(() => {
  addBulk?.mockRestore()
})

afterAll(async () => {
  FairnessTestAccess.setEnabled(undefined)
  unregisterAppJobHandlers(APP)
  await withSystemDb("commit-probe-cleanup", async (tx) => {
    for (const slug of created) {
      await tx.execute(drizzleSql`DELETE FROM kernel.organizations WHERE slug = ${slug}`)
    }
  })
})

function spyOnQueue(): void {
  seen = []
  pendingReads = []
  addBulk = spyOn(Queue.prototype, "addBulk").mockImplementation((async (
    entries: Array<{ data: { slug: string } }>,
  ) => {
    const read = (async () => {
      for (const e of entries)
        seen.push({ slug: e.data.slug, visible: await orgVisible(e.data.slug) })
    })()
    pendingReads.push(read)
    await read
    return entries.map((_, i) => ({ id: String(i) }))
  }) as never)
}

describe("enqueueAppJob inside a transaction", () => {
  it("without afterCommit, the job is added before COMMIT and cannot see the row", async () => {
    spyOnQueue()
    const slug = await writeAndEnqueue(false)
    expect(seen).toEqual([{ slug, visible: false }])
  })

  it("with afterCommit, the job is added only after COMMIT and sees the row", async () => {
    spyOnQueue()
    const slug = await writeAndEnqueue(true)
    expect(seen).toEqual([{ slug, visible: true }])
  })

  it("with afterCommit, a rolled back transaction adds no job", async () => {
    spyOnQueue()
    await writeAndEnqueue(true, true)
    // Give a wrongly queued add the time it would take to reach the queue.
    await new Promise((r) => setTimeout(r, 200))
    expect(addBulk).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it("with afterCommit outside any transaction, the job is added at once", async () => {
    spyOnQueue()
    await enqueueAppJob(APP, JOB, { slug: "none" }, { jobId: "probe:none", afterCommit: true })
    await Promise.all(pendingReads)
    expect(addBulk).toHaveBeenCalledTimes(1)
  })
})
