// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org background-job cap (S4.5, A11): an over-cap job is delayed to the
// first hour bucket with room (never dropped), the search stops at 24 hours,
// exempt jobs and orgless jobs are never counted nor delayed, scheduler-made
// jobs are counted when they start and never delayed.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import type { Queue } from "bullmq"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { hourBucket, hourBucketStart, jobBucketKey, jobsThisHour } from "~/modules/org/caps"
import { fairEnqueue } from "./fairness"
import { JobsTestAccess, registerJobWorker } from "./jobs"
import {
  countScheduledOrgJob,
  JOB_CAP_HORIZON_HOURS,
  OrgJobCapTestAccess,
  planOrgJobDelay,
} from "./org-job-cap"

const caps = new Map<string, number | null>()
OrgJobCapTestAccess.setReader(async (orgId) => caps.get(orgId) ?? null)

let n = 0
function freshOrg(limit: number | null): string {
  const orgId = `00000000-0000-4000-8000-${String(Date.now() % 1e9).padStart(9, "0")}${String(++n).padStart(3, "0")}`
  caps.set(orgId, limit)
  return orgId
}

async function clearBuckets(orgId: string, now: number): Promise<void> {
  const first = hourBucket(now)
  await redis.del(
    ...Array.from({ length: JOB_CAP_HORIZON_HOURS + 2 }, (_, i) => jobBucketKey(orgId, first + i)),
  )
}

const QUEUE = "app-example"
const used: string[] = []
afterEach(async () => {
  for (const orgId of used.splice(0)) await clearBuckets(orgId, Date.now())
})
afterAll(() => OrgJobCapTestAccess.setReader(null))

function plan(orgId: string | undefined, jobName = "nightly_summary", now = Date.now()) {
  return planOrgJobDelay({ orgId, queueName: QUEUE, jobName, dueMs: now, now })
}

describe("org job cap", () => {
  it("over the cap, a job is delayed to the start of the next hour, never dropped", async () => {
    const orgId = freshOrg(2)
    used.push(orgId)
    const now = Date.now()
    expect(await plan(orgId, "nightly_summary", now)).toBeNull()
    expect(await plan(orgId, "nightly_summary", now)).toBeNull()
    const delay = await plan(orgId, "nightly_summary", now)
    expect(delay).toBe(hourBucketStart(hourBucket(now) + 1) - now)
    // It counts in the hour it runs: the next hour now holds one.
    expect(Number(await redis.get(jobBucketKey(orgId, hourBucket(now) + 1)))).toBe(1)
    expect(await jobsThisHour(orgId, now)).toBe(2)
    // A later burst spreads hour by hour instead of landing at once.
    await plan(orgId, "nightly_summary", now)
    const third = await plan(orgId, "nightly_summary", now)
    expect(third).toBe(hourBucketStart(hourBucket(now) + 2) - now)
  })

  it("is bounded at 24 hours: with every bucket full the job goes at once (and is counted)", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const now = Date.now()
    const first = hourBucket(now)
    for (let i = 0; i < JOB_CAP_HORIZON_HOURS; i++) {
      await redis.set(jobBucketKey(orgId, first + i), "1", "EX", 3600 * 30)
    }
    expect(await plan(orgId, "nightly_summary", now)).toBeNull()
    expect(await jobsThisHour(orgId, now)).toBe(2)
  })

  it("exempt jobs and orgless jobs are never counted nor delayed; uncapped orgs cost nothing", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      expect(
        await planOrgJobDelay({
          orgId,
          queueName: "kernel-agent",
          jobName: "agent-reinvoke",
          dueMs: now,
          now,
        }),
      ).toBeNull()
      expect(
        await planOrgJobDelay({
          orgId,
          queueName: "app-mail",
          jobName: "gmail-write-back",
          dueMs: now,
          now,
        }),
      ).toBeNull()
    }
    expect(await jobsThisHour(orgId, now)).toBe(0)
    expect(await plan(undefined)).toBeNull()
    const free = freshOrg(null)
    expect(await plan(free, "nightly_summary", now)).toBeNull()
    expect(await redis.get(jobBucketKey(free, hourBucket(now)))).toBeNull()
  })

  it("every job a person triggered and waits on is exempt; background work stays capped", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const now = Date.now()
    // Fill this hour with one background job: anything capped now waits.
    expect(await plan(orgId, "nightly_summary", now)).toBeNull()
    const waiting: Array<[string, string, Record<string, unknown>]> = [
      ["kernel-agent", "routine-tick", { orgId, manual: true }], // a routine's "Run now"
      ["kernel-bulk", "imports-run", { orgId }], // an import a person started
      ["kernel-bulk", "org-export", { orgId }], // the archive an admin asked for
      ["kernel-bulk", "org-delete", { orgId }], // the operator's org deletion
      ["kernel-bulk", "mailbox-purge", { orgId }], // the erasure after a disconnect
      ["kernel-media", "files-thumbnail", { orgId }], // an upload's thumbnail
      ["kernel-media", "files-link-ingest", { orgId }], // a pasted link's preview
      ["kernel-media", "files-media-analysis", { orgId }], // an upload's analysis
      ["app-mail", "gmail-write-back", { orgId }],
      ["kernel-agent", "agent-reinvoke", { orgId }],
    ]
    for (const [queueName, jobName, data] of waiting) {
      expect(await planOrgJobDelay({ orgId, queueName, jobName, data, dueMs: now, now })).toBeNull()
    }
    expect(await jobsThisHour(orgId, now)).toBe(1)
    // The cron path's routine tick (no `manual`) is background work: delayed.
    expect(
      await planOrgJobDelay({
        orgId,
        queueName: "kernel-agent",
        jobName: "routine-tick",
        data: { orgId },
        dueMs: now,
        now,
      }),
    ).toBeGreaterThan(0)
  })

  it("fairEnqueue passes the payload: a manual routine tick is never delayed", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const added: Array<{ opts: { delay?: number } }> = []
    // The legacy kernel queue: kernel job names, no fairness stages.
    const queue = {
      name: "app-kernel",
      addBulk: async (jobs: Array<{ opts: { delay?: number } }>) => {
        added.push(...jobs)
        return jobs.map((_, i) => ({ id: String(i) }))
      },
    } as unknown as Queue
    const background = { name: "nightly_summary", data: { orgId }, opts: {} }
    const runNow = { name: "routine-tick", data: { orgId, manual: true }, opts: {} }
    await fairEnqueue(queue, [background, runNow, runNow])
    expect(added.map((j) => j.opts.delay)).toEqual([undefined, undefined, undefined])
  })

  it("a job already due later counts in its own hour", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const now = Date.now()
    const due = now + 3 * 3_600_000
    expect(
      await planOrgJobDelay({ orgId, queueName: QUEUE, jobName: "x", dueMs: due, now }),
    ).toBeNull()
    expect(Number(await redis.get(jobBucketKey(orgId, hourBucket(due))))).toBe(1)
    expect(await jobsThisHour(orgId, now)).toBe(0)
  })

  it("scheduler-made jobs are counted when they start, never delayed", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    await countScheduledOrgJob({ orgId, queueName: QUEUE, jobName: "nightly_summary" })
    await countScheduledOrgJob({ orgId, queueName: QUEUE, jobName: "nightly_summary" })
    expect(await jobsThisHour(orgId)).toBe(2)
    // The hour is full: the next enqueued job waits for the next hour.
    expect(await plan(orgId)).toBeGreaterThan(0)
  })

  it("fairEnqueue applies the delay; scheduled adds are counted at start instead", async () => {
    const orgId = freshOrg(1)
    used.push(orgId)
    const added: Array<{ opts: { delay?: number } }> = []
    const queue = {
      name: "plain-test-queue",
      addBulk: async (jobs: Array<{ opts: { delay?: number } }>) => {
        added.push(...jobs)
        return jobs.map((_, i) => ({ id: String(i) }))
      },
    } as unknown as Queue
    const entry = { name: "nightly_summary", data: { orgId }, opts: {} }
    await fairEnqueue(queue, [entry, entry])
    expect(added[0]?.opts.delay).toBeUndefined()
    expect(added[1]?.opts.delay).toBeGreaterThan(0)
    await fairEnqueue(queue, [entry], { scheduled: true })
    expect(added[2]?.opts.delay).toBeUndefined()
  })

  it("the dispatch counts a scheduler tick and a fan-out job when they start, nothing else", async () => {
    const orgId = crypto.randomUUID()
    caps.set(orgId, 5)
    used.push(orgId)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Capped org', ${`capped-${orgId.slice(0, 8)}`})`
    registerJobWorker("jobtest-capped", "tick", async () => {})
    const run = (repeatJobKey?: string, id?: string) =>
      JobsTestAccess.processJob(
        "jobtest-capped",
        "tick",
        { orgId },
        "app-jobtest-capped",
        repeatJobKey,
        id,
      ).catch(() => {})
    try {
      await run(`tick:${orgId}`)
      expect(await jobsThisHour(orgId)).toBe(1)
      await run(undefined, `fo.jobtest-capped.tick.${orgId}.1`)
      expect(await jobsThisHour(orgId)).toBe(2)
      // An enqueued job was counted at enqueue: its start adds nothing.
      await run(undefined, crypto.randomUUID())
      expect(await jobsThisHour(orgId)).toBe(2)
    } finally {
      forgetOrgApps(orgId)
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    }
  })
})
