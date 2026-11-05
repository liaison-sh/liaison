// SPDX-License-Identifier: FSL-1.1-ALv2
// The cron fan-out across real `src/index.ts` processes (P4, S15/S16): one
// scheduler per (app, job), one run per (eligible org, epoch), never two and
// never none, across a job host killed right after a tick's add.
//
// Cell: one `api` and two `all` processes (job hosts that also serve the test
// routes; a `worker` process has no /api to register the probe through). The
// probe app job (test-support/harness/fanout-routes.ts) fires every 5 s over
// 50 orgs, Off in one, and counts each run per (org, epoch) in Redis.
//
// - The tick of one epoch exits its process after the add, before its markers
//   (LIAISON_TEST_FANOUT_EXIT_AFTER_ADD): the stalled tick re-runs on the other
//   host and adds nothing new, since every job id names the org and the epoch.
// - Discriminator: with deduplication ids in place of job ids (the seam), the
//   same cut runs at least one (org, epoch) twice: the re-run tick finds the
//   first runs finished and their deduplication ids free.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { api, createRoleCell, type RoleCell, type RoleProcess } from "@liaison/test-helpers"

// Clear of the lanes (0-3), the helper tests (50-61, 99) and the other cell
// scenarios (70-77).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 78

const EVERY_MS = 5_000
/** min(0.8 x 5 s, 5 min, 49 orgs x 2 s) */
const WINDOW_MS = 4_000
const CELL_ENV = {
  LIAISON_VERSION: "p4-cell-fanout",
  LIVE_INSTANCE_TTL_MS: "6000",
  LIVE_INSTANCE_HEARTBEAT_MS: "2000",
  LIAISON_TEST_FANOUT_EXIT_AFTER_ADD: "true",
}
/** A process killed mid-job: its tick is re-run after up to two stalled checks (30 s each). */
const RECOVERY_MS = 120_000

interface ProbeState {
  runs: Record<string, number>
  starts: string[]
  metrics: Record<string, number>
  schedulers: string[]
  ticksInFlight: number
  exitArmed: boolean
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 500,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

/** Runs per epoch: epoch -> (org -> count). */
function byEpoch(runs: Record<string, number>): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>()
  for (const [k, n] of Object.entries(runs)) {
    const i = k.lastIndexOf(":")
    const epoch = Number(k.slice(i + 1))
    const m = out.get(epoch) ?? new Map<string, number>()
    m.set(k.slice(0, i), n)
    out.set(epoch, m)
  }
  return out
}

describe("S15/S16: the cron fan-out runs each org once per epoch across a killed job host", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let hosts: RoleProcess[]
  const orgs: string[] = []
  let offOrg: string

  const live = () => hosts.filter((h) => h.proc.exitCode === null && !h.proc.killed)
  const call = async (path: string, body?: unknown) => {
    const target = live()[0]
    if (!target) throw new Error("no live job host")
    const res = await api(target.url, `/api/_test/fanout${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body }),
    })
    expect(res.status).toBe(200)
    return res.body.data
  }
  const state = async (): Promise<ProbeState> => (await call("/state")) as ProbeState
  const onEvery = async (path: string, body: unknown) => {
    for (const p of [apiA, ...live()]) {
      const res = await api(p.url, `/api/_test/fanout${path}`, { method: "POST", body })
      expect(res.status).toBe(200)
    }
  }

  /** Set every org up in each job host ahead of the measure, 10 per request. */
  async function warm(): Promise<void> {
    for (const h of live()) {
      for (let i = 0; i < orgs.length; i += 10) {
        const res = await api(h.url, "/api/_test/fanout/warm", {
          method: "POST",
          body: { orgs: orgs.slice(i, i + 10) },
        })
        expect(res.status).toBe(200)
      }
    }
  }

  async function seedOrgs(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => crypto.randomUUID())
    for (const id of ids) {
      await cell.db.sql.unsafe(
        `INSERT INTO "${cell.schemaPrefix}kernel".organizations (id, name, slug) VALUES ($1, 'Fanout', $2)`,
        [id, `fo-${id.slice(0, 12)}`],
      )
    }
    return ids
  }

  /** When the last probe run scheduled and unscheduled its scheduler. */
  const probeWindow = { t0: 0, tStop: 0 }

  /** Run the probe for `epochs` epochs, cutting the tick of the `cutAt`-th; the settled state. */
  async function runProbe(epochs: number, cutAt: number): Promise<ProbeState> {
    await call("/reset", {})
    await call("/schedule", { everyMs: EVERY_MS })
    const t0 = Date.now()
    probeWindow.t0 = t0
    await Bun.sleep(cutAt * EVERY_MS - EVERY_MS / 2)
    const running = live()
    await call("/arm-exit", {})
    // The next probe tick's host exits right after its add.
    const exited = await Promise.race(running.map((h) => h.proc.exited.then(() => h)))
    expect(exited.proc.exitCode).toBe(137)
    await Bun.sleep(Math.max(0, t0 + epochs * EVERY_MS - Date.now()))
    await call("/unschedule", {})
    probeWindow.tStop = Date.now()
    // The cut tick re-run (the stalled check hands it back) and every epoch's runs done.
    const settled = await until(
      async () => ((await state()).ticksInFlight === 0 ? true : undefined),
      RECOVERY_MS,
    )
    if (!settled) throw new Error(`the cut tick never re-ran: ${JSON.stringify(await state())}`)
    await Bun.sleep(WINDOW_MS + 2_000)
    return state()
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "all", "all"], { serverEnv: CELL_ENV })
    ;[apiA, ...hosts] = cell.processes as [RoleProcess, RoleProcess, RoleProcess]
    orgs.push(...(await seedOrgs(50)))
    offOrg = orgs[0] as string
    await cell.db.sql.unsafe(
      `INSERT INTO "${cell.schemaPrefix}kernel".apps (org_id, name, version, status) VALUES ($1, 'fanout-probe', '1.0.0', 'disabled')`,
      [offOrg],
    )
    await onEvery("/register", {})
    await warm()
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it(
    "12 epochs over 50 orgs, one cut after its add: each eligible org runs once per epoch, the Off org never, spread over the window",
    async () => {
      const before = await state()
      const s = await runProbe(12, 4)
      const epochs = byEpoch(s.runs)
      // The exact epoch set: every tick from the first (within one interval of
      // scheduling) to the last before the scheduler went, none missing.
      const sorted = [...epochs.keys()].sort((a, b) => a - b)
      const first = sorted[0] as number
      const last = sorted[sorted.length - 1] as number
      expect(first).toBeLessThanOrEqual(probeWindow.t0 + EVERY_MS)
      expect(last).toBeGreaterThanOrEqual(probeWindow.tStop - EVERY_MS - 1_000)
      const expected = Array.from(
        { length: (last - first) / EVERY_MS + 1 },
        (_, i) => first + i * EVERY_MS,
      )
      expect(sorted).toEqual(expected)
      expect(sorted.length).toBeGreaterThanOrEqual(12)
      const eligible = orgs.filter((o) => o !== offOrg)
      const order = [...epochs.keys()].sort((a, b) => a - b)
      const delta = (k: string) => (s.metrics[k] ?? 0) - (before.metrics[k] ?? 0)
      for (const [epoch, perOrg] of epochs) {
        const missed = eligible.filter((o) => !perOrg.has(o))
        const doubled = [...perOrg].filter(([, n]) => n !== 1)
        expect({ epoch, missed, doubled }).toEqual({
          epoch,
          missed: [],
          doubled: [],
          // On a failure: which epoch, and whether the next tick coalesced.
          ...(missed.length + doubled.length > 0
            ? { index: order.indexOf(epoch), coalesced: delta("fanout_coalesced") }
            : {}),
        })
        expect(perOrg.has(offOrg)).toBe(false)
      }
      // Start offsets from the epoch: no 10 % slice of the window holds more than 20 %.
      const offsets = s.starts.map((x) => Number(x.slice(x.lastIndexOf(":") + 1)))
      const slices = new Array(11).fill(0)
      for (const o of offsets) slices[Math.min(10, Math.max(0, Math.floor(o / (WINDOW_MS / 10))))]++
      expect(Math.max(...slices)).toBeLessThanOrEqual(Math.ceil(0.2 * offsets.length))
      expect((s.metrics.legacy_tick_dropped ?? 0) - (before.metrics.legacy_tick_dropped ?? 0)).toBe(
        0,
      )

      // One scheduler per (app, job): 50 more orgs add none.
      const count = (await state()).schedulers.length
      orgs.push(...(await seedOrgs(50)))
      await Bun.sleep(2 * EVERY_MS)
      expect((await state()).schedulers.length).toBe(count)
    },
    12 * EVERY_MS + RECOVERY_MS + 120_000,
  )

  it(
    "discriminator: with deduplication ids the same cut runs an (org, epoch) twice",
    async () => {
      hosts.push(await cell.spawn("all"))
      await onEvery("/register", {})
      await warm()
      await onEvery("/id-mode", { mode: "deduplication" })
      const s = await runProbe(6, 2)
      const doubled = Object.entries(s.runs).filter(([, n]) => n > 1)
      expect(doubled.length).toBeGreaterThan(0)
    },
    6 * EVERY_MS + RECOVERY_MS + 120_000,
  )
})
