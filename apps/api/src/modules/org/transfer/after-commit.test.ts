// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A source agent that dies after the control plane committed leaves the org
// without its carried jobs and schedulers. They are staged on the target before
// the commit, and the freeze resolver's pass resumes the after-commit steps
// from there once the control plane says committed (and not before, and not
// for an aborted move).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as dsql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { getJobQueue, registerJobWorker, transferredJobId } from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { resultRows } from "~/modules/org/purge/rows"
import { seedMcpConnection } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  RESUME_AFTER_MS,
  readStagedCarry,
  resumeStagedAfterCommit,
  runAfterCommit,
  stageCarry,
} from "./after-commit"

beforeAll(async () => {
  await acquireTestLock()
  registerJobWorker("kernel", "load-synthetic", async () => {}, { txMode: "session" })
})
afterAll(async () => {
  await releaseTestLock()
})

function carried(orgId: string) {
  return {
    jobs: [
      {
        queue: getJobQueue("kernel", "load-synthetic").name,
        id: "j1",
        name: "load-synthetic",
        data: { orgId, marker: "carried" },
        delayMs: 3_600_000,
        attempts: 3,
        backoff: null,
        priority: null,
        dedupId: null,
      },
    ],
    schedulers: [],
  }
}

describe("resuming the after-commit steps", () => {
  it("a committed move's staged jobs are re-added by the resume, once", async () => {
    const orgId = randomUUID()
    const transferId = randomUUID()
    const queue = getJobQueue("kernel", "load-synthetic")
    await stageCarry({ orgId, transferId, ...carried(orgId) })
    const asked: string[] = []
    const deps = (state: string, at = Date.now() + RESUME_AFTER_MS + 1_000) => ({
      askControl: async (_o: string, t: string) => {
        asked.push(t)
        return state
      },
      now: () => at,
    })
    try {
      // Too early: the source agent is most likely still on it.
      expect(await resumeStagedAfterCommit(deps("committed", Date.now()))).not.toContain(transferId)
      // Not committed: left alone.
      expect(await resumeStagedAfterCommit(deps("frozen"))).not.toContain(transferId)
      expect(await queue.getJob(transferredJobId(transferId, "j1"))).toBeUndefined()
      // Committed: the jobs exist on this instance.
      expect(await resumeStagedAfterCommit(deps("committed"))).toContain(transferId)
      const job = await queue.getJob(transferredJobId(transferId, "j1"))
      expect(job?.data).toMatchObject({ orgId, marker: "carried" })
      expect((await readStagedCarry(transferId))?.done).toBe(true)
      // Done: not run again.
      expect(await resumeStagedAfterCommit(deps("committed"))).not.toContain(transferId)
      await job?.remove()
    } finally {
      await redis.del(`org-transfer:carry:${transferId}`)
      await redis.srem("org-transfer:carry:index", transferId)
    }
  })

  it("an aborted move's staged set is dropped, nothing is re-added", async () => {
    const orgId = randomUUID()
    const transferId = randomUUID()
    await stageCarry({ orgId, transferId, ...carried(orgId) })
    const resumed = await resumeStagedAfterCommit({
      askControl: async () => "aborted",
      now: () => Date.now() + RESUME_AFTER_MS + 1_000,
    })
    expect(resumed).not.toContain(transferId)
    expect(await readStagedCarry(transferId)).toBeNull()
    expect(
      await getJobQueue("kernel", "load-synthetic").getJob(transferredJobId(transferId, "j1")),
    ).toBeUndefined()
  })

  it("a resume after a failed step runs only what is not done yet", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg({ name: "Resume Org" })
    const transferId = randomUUID()
    const queue = getJobQueue("kernel", "load-synthetic")
    const schedulerId = `xfer-test-sched-${transferId}`
    const connection = () =>
      seedMcpConnection({
        orgId,
        userId: adminUserId,
        clientId: "test-client",
        label: "Desk",
        refreshTokenHash: randomUUID(),
      })
    const revoked = async (id: string) =>
      withSystemDb("test-mcp-revoked", async (db) => {
        const [row] = resultRows<{ r: boolean }>(
          await db.execute(
            dsql`SELECT revoked_at IS NOT NULL AS r FROM kernel.mcp_connections WHERE id = ${id}::uuid`,
          ),
        )
        return row?.r
      })
    const carriedConnection = await connection()
    const input = {
      orgId,
      transferId,
      ...carried(orgId),
      schedulers: [
        {
          queue: queue.name,
          id: schedulerId,
          name: "load-synthetic",
          pattern: null,
          every: 3_600_000,
          tz: null,
          data: { orgId },
          opts: {},
        },
      ],
    }
    await stageCarry(input)
    let gmailRuns = 0
    try {
      // The source's own run: the Gmail step fails.
      const first = await runAfterCommit(input, {
        steps: {
          rewatchGmail: async () => {
            gmailRuns++
            throw new Error("gmail down")
          },
        },
      })
      expect("error" in first.gmail).toBe(true)
      expect(first.jobs).toEqual({ jobs: 1, schedulers: 1 })
      expect(await revoked(carriedConnection)).toBe(true)
      // After the commit, here: the job ran and was evicted, an admin deleted
      // the schedule, a person connected an MCP client again.
      await (await queue.getJob(transferredJobId(transferId, "j1")))?.remove()
      await queue.removeJobScheduler(schedulerId)
      const fresh = await connection()
      // The resume: only the Gmail step runs again.
      const second = await runAfterCommit(input, {
        resume: true,
        steps: {
          rewatchGmail: async () => {
            gmailRuns++
            return { accounts: 0, rewatch: false }
          },
        },
      })
      expect(second.jobs).toEqual({ skipped: true })
      expect(second.mcp).toEqual({ skipped: true })
      expect(second.gmail).toEqual({ accounts: 0, rewatch: false })
      expect(gmailRuns).toBe(2)
      expect(await queue.getJob(transferredJobId(transferId, "j1"))).toBeUndefined()
      expect(await queue.getJobScheduler(schedulerId)).toBeFalsy()
      expect(await revoked(fresh)).toBe(false)
      expect((await readStagedCarry(transferId))?.done).toBe(true)
    } finally {
      await queue.removeJobScheduler(schedulerId).catch(() => {})
      await (await queue.getJob(transferredJobId(transferId, "j1")))?.remove().catch(() => {})
      await redis.del(
        `org-transfer:carry:${transferId}`,
        `org-transfer:carry:${transferId}:steps`,
        `org-transfer:carry:${transferId}:added`,
      )
      await redis.srem("org-transfer:carry:index", transferId)
    }
  }, 60_000)

  it("a job step that stopped midway re-adds only the jobs it had not added", async () => {
    const orgId = randomUUID()
    const transferId = randomUUID()
    const queue = getJobQueue("kernel", "load-synthetic")
    const two = carried(orgId)
    const second = { ...(two.jobs[0] as (typeof two.jobs)[number]), id: "j2" }
    const input = { orgId, transferId, jobs: [...two.jobs, second], schedulers: [] }
    await stageCarry(input)
    try {
      // j1 was added (and marked) before the source agent died.
      await redis.sadd(`org-transfer:carry:${transferId}:added`, `job:${queue.name}:j1`)
      const report = await runAfterCommit(input, { resume: true })
      expect(report.jobs).toEqual({ jobs: 1, schedulers: 0 })
      expect(await queue.getJob(transferredJobId(transferId, "j1"))).toBeUndefined()
      expect(await queue.getJob(transferredJobId(transferId, "j2"))).toBeTruthy()
    } finally {
      await (await queue.getJob(transferredJobId(transferId, "j2")))?.remove().catch(() => {})
      await redis.del(
        `org-transfer:carry:${transferId}`,
        `org-transfer:carry:${transferId}:steps`,
        `org-transfer:carry:${transferId}:added`,
      )
      await redis.srem("org-transfer:carry:index", transferId)
    }
  })
})
