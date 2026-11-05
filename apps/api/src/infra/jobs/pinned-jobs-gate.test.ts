// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pinned-job admission (pinned-jobs-gate.ts): whole-run jobs-pool holders wait
// for a slot, FIFO, before their transaction opens, so more of them than the
// jobs pool fits queue instead of failing on the acquire timeout.

import { afterAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { createPool } from "~/db/connection"
import { PINNED_JOBS_WANTED, planPools } from "~/db/pool-plan"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { dispatchAppJobWithContext, type JobContextDeps } from "~/infra/jobs/job-context"
import { PinnedJobsGate } from "~/infra/jobs/pinned-jobs-gate"

const ROOT = path.resolve(import.meta.dir, "../../../../..")
const ORG = "00000000-0000-0000-0000-0000000005a1"
const CTX = { actorType: "system" as const, orgId: ORG, purpose: "job" as const, scopes: [] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The pinned slots the planner gives a jobs pool of `jobs`. */
function pinnedSlotsFor(jobs: number, split: boolean): number {
  return planPools({
    role: "worker",
    split,
    overrides: { jobs },
    kernel: { total: 11, requestSlots: 7 },
  }).pinnedJobSlots
}

describe("pinned-job admission", () => {
  const pool = createPool(4)
  afterAll(async () => {
    await pool.client.end()
  })
  const deps = (gate: PinnedJobsGate): JobContextDeps => ({
    withRlsContext: (ctx, fn) => withRlsContext(ctx, fn, { db: pool.db, acquireTimeoutMs: 2_000 }),
    createRlsSession: (ctx) => createRlsSession(ctx, { db: pool.db, acquireTimeoutMs: 2_000 }),
    pinned: gate,
  })

  it("runs twelve 2 s ambient jobs and four event handlers on a jobs pool of 4 with no acquire timeout; ungated they time out", async () => {
    // 16 holders of 2 s on 4 connections with a 2 s acquire timeout: ungated,
    // the ones queued behind the first wave fail on the acquire.
    const HOLD_MS = 2_000
    // Its own pool: a timed-out acquire stays queued in the driver and would
    // take connections from the gated half.
    const control = createPool(4)
    const ungated = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        withRlsContext(CTX, () => sleep(HOLD_MS), { db: control.db, acquireTimeoutMs: 2_000 }),
      ),
    )
    await control.client.end({ timeout: 5 })
    const reasons = ungated.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.join("\n")).toContain("acquire timed out")

    const gate = new PinnedJobsGate(pinnedSlotsFor(4, true))
    expect(gate.max).toBe(2)
    const job = () =>
      dispatchAppJobWithContext(
        async (payload: { _tx: { execute: (q: unknown) => Promise<unknown> } }) => {
          await payload._tx.execute(drizzleSql`SELECT 1`)
          await sleep(HOLD_MS)
        },
        {},
        CTX,
        "ambient",
        deps(gate),
      )
    const handler = () =>
      gate.run("event:test", () =>
        withRlsContext(CTX, () => sleep(HOLD_MS), { db: pool.db, acquireTimeoutMs: 2_000 }),
      )
    const results = await Promise.allSettled([
      ...Array.from({ length: 12 }, job),
      ...Array.from({ length: 4 }, handler),
    ])
    expect(results.filter((r) => r.status === "rejected")).toEqual([])
    expect(gate.state().peak).toBe(2)
    expect(gate.state().held).toBe(0)
  }, 60_000)

  it("work started inside a run without awaiting it goes through admission once the run has ended", async () => {
    const gate = new PinnedJobsGate(1)
    let detached!: Promise<void>
    let ran = false
    let nestedRanAtOnce = false
    await gate.run("outer", async () => {
      // Awaited nested work re-enters the held slot at once.
      await gate.run("nested", async () => {
        nestedRanAtOnce = true
      })
      detached = (async () => {
        await sleep(50)
        await gate.run("detached", async () => {
          ran = true
        })
      })()
    })
    expect(nestedRanAtOnce).toBe(true)
    let release!: () => void
    const blocker = gate.run("blocker", () => new Promise<void>((r) => (release = r)))
    await sleep(120)
    expect(ran).toBe(false)
    expect(gate.state()).toMatchObject({ held: 1, waiting: 1 })
    release()
    await Promise.all([blocker, detached])
    expect(ran).toBe(true)
    expect(gate.state()).toMatchObject({ held: 0, waiting: 0 })
  })

  it("lets session-mode jobs run while the gate is full", async () => {
    const gate = new PinnedJobsGate(1)
    let release!: () => void
    const holding = gate.run("holder", () => new Promise<void>((r) => (release = r)))
    const waiting = gate.run("waiter", async () => {})
    await sleep(10)
    expect(gate.state()).toMatchObject({ held: 1, waiting: 1 })
    let ran = false
    await dispatchAppJobWithContext(
      async (payload: { _session: unknown }) => {
        ran = payload._session !== undefined
      },
      {},
      CTX,
      "session",
      deps(gate),
    )
    expect(ran).toBe(true)
    expect(gate.state()).toMatchObject({ held: 1, waiting: 1 })
    release()
    await Promise.all([holding, waiting])
  })

  it("an aborted wait leaves without taking or releasing a slot", async () => {
    const gate = new PinnedJobsGate(1)
    let release!: () => void
    const holding = gate.run("holder", () => new Promise<void>((r) => (release = r)))
    const abort = new AbortController()
    let ran = false
    const aborted = gate.run(
      "aborted",
      async () => {
        ran = true
      },
      abort.signal,
    )
    await sleep(10)
    abort.abort(new Error("handed back"))
    await expect(aborted).rejects.toThrow("handed back")
    expect(gate.state()).toMatchObject({ held: 1, waiting: 0 })
    release()
    await holding
    expect(gate.state()).toMatchObject({ held: 0, waiting: 0, peak: 1 })
    await gate.run("next", async () => {})
    expect(ran).toBe(false)
    expect(gate.state().held).toBe(0)
  })

  it("unsplit pool of 4: holders with a nested privileged read complete behind the gate, and time out without it", async () => {
    // Unsplit, jobs and privileged-jobs are one pool: a holder plus its nested
    // privileged read take two of its connections.
    const holder = () =>
      withRlsContext(
        CTX,
        async () => {
          await sleep(200)
          await withPrivilegedDb(ORG, "nested-read", (tx) => tx.execute(drizzleSql`SELECT 1`), {
            db: pool.db,
            acquireTimeoutMs: 1_500,
          })
        },
        { db: pool.db, acquireTimeoutMs: 1_500 },
      )
    const gate = new PinnedJobsGate(pinnedSlotsFor(4, false))
    expect(gate.max).toBe(1)
    const gated = await Promise.allSettled(
      Array.from({ length: 4 }, () => gate.run("ambient-job", holder)),
    )
    expect(gated.filter((r) => r.status === "rejected")).toEqual([])

    const ungated = await Promise.allSettled(Array.from({ length: 4 }, holder))
    const reasons = ungated.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.join("\n")).toContain("acquire timed out")
  }, 30_000)

  it("PINNED_JOBS_WANTED is what the catalog's atomic job queues can start at once", () => {
    // Σ over catalog app queues with an ambient (`atomic: true`) job of
    // min(5, the queue's concurrency): bindCatalogAppQueues binds each at 5.
    // Event-subscription handlers run in the publishing process, not on a
    // queue, so they add no queue slots; they take the gate all the same.
    const QUEUE_CONCURRENCY = 5
    const dirs = [path.join(ROOT, "bundled-apps"), path.join(ROOT, "apps/api/src/apps")]
    let wanted = 0
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        let manifest: { jobs?: Record<string, { atomic?: boolean }> }
        try {
          manifest = JSON.parse(readFileSync(path.join(dir, name, "app.manifest.json"), "utf8"))
        } catch {
          continue
        }
        const atomic = Object.values(manifest.jobs ?? {}).some((j) => j?.atomic === true)
        if (atomic) wanted += Math.min(5, QUEUE_CONCURRENCY)
      }
    }
    expect(wanted).toBe(PINNED_JOBS_WANTED)
  })
})
