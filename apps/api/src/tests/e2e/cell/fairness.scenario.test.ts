// SPDX-License-Identifier: FSL-1.1-ALv2
// Fair job queues across real `src/index.ts` processes (P4, S17/A7): one
// workspace flooding a queue cannot starve another, and a workspace alone gets
// the whole cell.
//
// Cell: one `api` and two `all` processes (job hosts; C, the slots they
// publish for a queue, is read from the cell, since the kernel slots follow
// the privileged pool size). Load orgs (settings.loadHarness, LOAD_HARNESS_KEY set) run the
// load harness's synthetic job (test-support/harness/fairness-routes.ts),
// which counts each run's wait and the org's peak concurrency in Redis.
//
// - kernel-agent: a flood org enqueues 10 000 jobs (200 ms each), then a quiet
//   org enqueues one per second for 50 s. The quiet org's first job waits at
//   most 2 s and its p95 stays under 5 s; the flood org completes at least one
//   job every second (never starved to zero). Redis CPU is printed, not asserted
//   (a shared test Redis).
// - A lone org with 500 jobs runs C at once (the cap applies only under
//   contention).
// - The same on an app queue (the probe app's job) with 2 000 flood jobs.
// - Discriminator: with the gate off in every process, the quiet org's p95
//   wait goes above 5 s (FIFO behind the flood).
// `kernel-bulk` is not asserted (C = 1, unprotected by design, A7).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { api, createRoleCell, type RoleCell, type RoleProcess } from "@liaison/test-helpers"

// Clear of the lanes (0-3), the helper tests (50-61, 99) and the other cell
// scenarios (70-78).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 79

const SLEEP_MS = 200
const CELL_ENV = {
  LIAISON_VERSION: "p4-cell-fairness",
  LOAD_HARNESS_KEY: "cell-fairness-load-harness-key-0123456789",
  JOB_ORG_FAIRNESS: "on",
}

type Target = "kernel" | "app"
interface OrgStats {
  runs: number
  inflight: number
  maxInflight: number
  waitsMs: number[]
  donePerSecond: Record<string, number>
}
interface FairState {
  stats: Record<string, OrgStats>
  queue: Record<string, unknown>
  waiting: number
  cellSlots: number
  redisCpuSeconds: number
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? Number.POSITIVE_INFINITY
}

describe("S17: fair job queues across processes", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let hosts: RoleProcess[]
  /** Fresh orgs per run, so a run never reads another's late counters. */
  let orgs: string[] = []
  const take = () => orgs.shift() as string

  const all = () => [apiA, ...hosts]
  const post = async (p: RoleProcess, path: string, body: unknown) => {
    const res = await api(p.url, `/api/_test/fairness${path}`, { method: "POST", body })
    expect(res.status).toBe(200)
    return res.body.data
  }
  const onEvery = async (path: string, body: unknown) => {
    for (const p of all()) await post(p, path, body)
  }
  const state = async (target: Target, orgs: string[]): Promise<FairState> => {
    const res = await api(
      apiA.url,
      `/api/_test/fairness/state?target=${target}&orgs=${orgs.join(",")}`,
    )
    expect(res.status).toBe(200)
    return res.body.data as FairState
  }
  const floodJobs = (orgId: string, target: Target, count: number) =>
    post(apiA, "/flood", { orgId, target, count, sleepMs: SLEEP_MS })

  async function seedLoadOrgs(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => crypto.randomUUID())
    for (const id of ids) {
      await cell.db.sql.unsafe(
        `INSERT INTO "${cell.schemaPrefix}kernel".organizations (id, name, slug, settings) VALUES ($1, 'Fairness', $2, '{"loadHarness": true}'::jsonb)`,
        [id, `fair-${id.slice(0, 12)}`],
      )
    }
    return ids
  }

  /**
   * Flood `target` for the flood org, then one quiet job a second for
   * `quietCount` s. The quiet waits (a job that never ran counts as waiting
   * until now), the flood's completions per second over that window and the
   * Redis CPU share.
   */
  async function floodAndQuiet(target: Target, floodCount: number, quietCount: number) {
    const flood = take()
    const quiet = take()
    await post(apiA, "/clear", { target, orgs: [] })
    const cpu0 = (await state(target, [])).redisCpuSeconds
    const t0 = Date.now()
    await floodJobs(flood, target, floodCount)
    const enqueuedAt: number[] = []
    const quietStart = Math.ceil(Date.now() / 1000)
    for (let i = 0; i < quietCount; i++) {
      const next = Date.now() + 1_000
      enqueuedAt.push(Date.now())
      await floodJobs(quiet, target, 1)
      await Bun.sleep(Math.max(0, next - Date.now()))
    }
    const quietEnd = Math.floor(Date.now() / 1000)
    // Let the last quiet jobs run (or not, with the gate off).
    const deadline = Date.now() + 6_000
    let s = await state(target, [flood, quiet])
    while (Date.now() < deadline && (s.stats[quiet]?.runs ?? 0) < quietCount) {
      await Bun.sleep(250)
      s = await state(target, [flood, quiet])
    }
    const q = s.stats[quiet] as OrgStats
    const now = Date.now()
    const waits = [...q.waitsMs, ...enqueuedAt.slice(q.waitsMs.length).map((t) => now - t)]
    const perSecond: number[] = []
    for (let sec = quietStart + 1; sec < quietEnd; sec++) {
      perSecond.push(s.stats[flood]?.donePerSecond[String(sec)] ?? 0)
    }
    const cpuPct = ((s.redisCpuSeconds - cpu0) * 100 * 1000) / (now - t0)
    await post(apiA, "/clear", { target, orgs: [flood, quiet] })
    return { firstWait: q.waitsMs[0], waits, p95: p95(waits), perSecond, cpuPct, queue: s.queue }
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "all", "all"], { serverEnv: CELL_ENV })
    ;[apiA, ...hosts] = cell.processes as [RoleProcess, RoleProcess, RoleProcess]
    orgs = await seedLoadOrgs(7)
    await onEvery("/register", {})
    await onEvery("/warm", { orgs })
    // Every host's slots in its instance record (one heartbeat).
    await Bun.sleep(11_000)
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("kernel-agent: a 10 000-job flood leaves the quiet org's p95 under 5 s and the flood progressing", async () => {
    const r = await floodAndQuiet("kernel", 10_000, 50)
    console.log(
      `[fairness] kernel-agent: quiet first ${r.firstWait} ms, p95 ${r.p95} ms; flood min ${Math.min(...r.perSecond)}/s; Redis CPU ${r.cpuPct.toFixed(1)} %; ${JSON.stringify(r.queue)}`,
    )
    expect(r.firstWait).toBeLessThanOrEqual(2_000)
    expect(r.p95).toBeLessThan(5_000)
    expect(Math.min(...r.perSecond)).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it("a lone org runs C jobs at once", async () => {
    const lone = take()
    await post(apiA, "/clear", { target: "kernel", orgs: [] })
    await floodJobs(lone, "kernel", 500)
    const deadline = Date.now() + 60_000
    let s = await state("kernel", [lone])
    while (Date.now() < deadline && (s.stats[lone]?.runs ?? 0) < 500) {
      await Bun.sleep(500)
      s = await state("kernel", [lone])
    }
    // C is what the job hosts publish for the queue.
    console.log(`[fairness] lone org: C ${s.cellSlots}, peak ${s.stats[lone]?.maxInflight}`)
    expect(s.cellSlots).toBeGreaterThanOrEqual(2)
    expect(s.stats[lone]?.runs).toBe(500)
    expect(s.stats[lone]?.maxInflight).toBe(s.cellSlots)
    await post(apiA, "/clear", { target: "kernel", orgs: [lone] })
  }, 90_000)

  it("an app queue: a 2 000-job flood leaves the quiet org's p95 under 5 s", async () => {
    const r = await floodAndQuiet("app", 2_000, 30)
    console.log(
      `[fairness] app queue: quiet first ${r.firstWait} ms, p95 ${r.p95} ms; flood min ${Math.min(...r.perSecond)}/s; Redis CPU ${r.cpuPct.toFixed(1)} %`,
    )
    expect(r.firstWait).toBeLessThanOrEqual(2_000)
    expect(r.p95).toBeLessThan(5_000)
    expect(Math.min(...r.perSecond)).toBeGreaterThanOrEqual(1)
  }, 150_000)

  it("discriminator: with the gate off the quiet org waits behind the flood (p95 above 5 s)", async () => {
    await onEvery("/toggle", { enabled: false })
    try {
      const r = await floodAndQuiet("kernel", 10_000, 15)
      console.log(`[fairness] gate off: quiet p95 ${r.p95} ms`)
      expect(r.p95).toBeGreaterThan(5_000)
    } finally {
      await onEvery("/toggle", { enabled: true })
    }
  }, 120_000)
})
