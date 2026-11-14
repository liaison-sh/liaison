// SPDX-License-Identifier: FSL-1.1-ALv2
// S19: boot is flat in the org count, and an org's first touch is bounded.
//
// For N = 10 and N = 300 orgs (seeded once per size by boot-flat-seed.ts:
// each org set up, with an admin, an MCP connection with a stored tool list, a
// recurring and an event routine), real `src/index.ts` processes boot over the
// cell's data, one at a time:
//
// - an `api` and a `worker`, 3 boots each: time to ready (the process's own
//   "Process ready" line, the instant `/readyz` turns 200, so the poll interval
//   adds nothing), RSS at ready after a forced GC (SIGUSR2, test-only), apps
//   the boot itself registered by ready (none), and for the api the database
//   transactions its boot ran (`/diag` pools);
// - first touch: one api touches up to 50 orgs one at a time with an
//   authenticated request (stamp matching), a fresh api touches up to 50 at
//   once (H2 burst); then the same two with another build id, so every stamp
//   mismatches and the persistent half runs.
//
// Asserts: ready(300) ≤ 1.2 × ready(10) (median, api and worker); RSS(300) −
// RSS(10) ≤ 50 MB, each the lowest of its boots: allocator noise only ever
// adds to an RSS (a boot can retain 100 MB more pages than its twin after the
// same forced GC, with no work logged), so the floor is the boot's footprint
// and a median of 3 still lets two noisy boots through; boot
// transactions(300) ≤ 1.2 × transactions(10) + 20; no app registered by the
// boot itself; first-touch p95 ≤ 2 s matching, ≤ 10 s
// mismatching, serial and burst. A failing burst is reported, never relaxed. The
// two latency bounds are for a dedicated machine: a hosted CI runner sets
// BOOT_FLAT_LATENCY_FACTOR (the gate workflow does) and gets that multiple of
// them; every flatness check stays exact.
//
// Which registrations the boot caused: every org setup logs what started it
// ("Org setup started", with the outbox event or job it is for and when that
// was queued), and every "App registered" line names its org. A registration
// counts as queued work, not boot work, only when every setup started for its
// org in that process was for an event or job queued before the boot began
// (the seed's own events, which a booting worker drains). Anything else,
// including a registration without an org or a setup with no trigger, counts
// against the boot. The queued-work registrations are reported, not asserted.
//
// The numbers go to `BOOT_FLAT_EVIDENCE` (default: a file in the OS temp dir).
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  api,
  createRoleCell,
  jsonLogLines,
  type ProcessRole,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"

// A private worker id clear of the lanes (0-3), the helper tests (50-61, 99)
// and the other cell scenarios (70, 71).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 72
const SIZES = [10, 300] as const
const BOOTS = 3
const TOUCHES = 50
/** The seed's and the matching boots' build id; the mismatching ones use others. */
const BUILD = "boot-flat-a"
const MONITOR_TOKEN = "boot-flat-monitor-token"
const MB = 1024

interface QueuedSetupRegistration {
  app: string
  orgId: string
  /** The queued outbox event or job the org's setup was for. */
  trigger: { kind: string; id: string; queuedAt: number }
}

interface BootSample {
  /** Spawn to the process's own "Process ready" line. */
  readyMs: number
  /** Spawn to the harness seeing `/readyz` 200 (polled every 250 ms): reported only. */
  probedReadyMs: number
  rssKb: number
  /** Apps the boot itself registered by ready: 0 when boot sets up no org. */
  appsRegisteredByBoot: number
  /** Apps registered by ready for work queued before the boot (reported, not asserted). */
  queuedSetupRegistrations: QueuedSetupRegistration[]
  /** Transactions on every pool by ready (api only; a worker serves no /diag). */
  transactions: number | null
}

interface TouchRun {
  latenciesMs: number[]
  p50: number
  p95: number
}

interface SizeResult {
  orgs: number
  api: { boots: BootSample[]; readyMs: number; rssKb: number; transactions: number }
  worker: { boots: BootSample[]; readyMs: number; rssKb: number }
  touch: {
    matchSerial: TouchRun
    matchBurst: TouchRun
    mismatchSerial: TouchRun
    mismatchBurst: TouchRun
  }
}

const results = new Map<number, SizeResult>()
const scratch = mkdtempSync(path.join(tmpdir(), "liaison-boot-flat-"))

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? Number.NaN
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? Number.NaN
}

function isTrigger(t: unknown): t is QueuedSetupRegistration["trigger"] {
  if (t === null || typeof t !== "object") return false
  const r = t as Record<string, unknown>
  return typeof r.kind === "string" && typeof r.id === "string" && typeof r.queuedAt === "number"
}

/**
 * The process's app registrations so far, split by cause: queued work from
 * before `bootAt` (epoch ms), or the boot (see the header).
 */
function registrationsByCause(
  lines: Record<string, unknown>[],
  bootAt: number,
): { byBoot: number; queued: QueuedSetupRegistration[] } {
  const starts = new Map<string, unknown[]>()
  for (const l of lines) {
    if (l.msg !== "Org setup started" || typeof l.orgId !== "string") continue
    starts.set(l.orgId, [...(starts.get(l.orgId) ?? []), l.trigger])
  }
  let byBoot = 0
  const queued: QueuedSetupRegistration[] = []
  for (const l of lines) {
    if (l.msg !== "App registered") continue
    const orgId = typeof l.orgId === "string" ? l.orgId : null
    const triggers = orgId ? (starts.get(orgId) ?? []) : []
    const first = triggers[0]
    if (
      orgId !== null &&
      isTrigger(first) &&
      triggers.every((t) => isTrigger(t) && t.queuedAt < bootAt)
    ) {
      queued.push({ app: String(l.app), orgId, trigger: first })
    } else {
      byBoot++
    }
  }
  return { byBoot, queued }
}

/** Spawn to the process's own "Process ready" line (epoch ms on one machine clock). */
function readyAt(p: RoleProcess): number {
  const line = jsonLogLines(p).find((l) => l.msg === "Process ready")
  if (!line || typeof line.readyAt !== "number") {
    throw new Error(`${p.role} on :${p.port} answered /readyz 200 without a "Process ready" line`)
  }
  return line.readyAt
}

async function rssKb(p: RoleProcess): Promise<number> {
  // A forced full GC first (the server's test-only SIGUSR2 hook), so the
  // sample is the live heap, not garbage waiting for a collection.
  p.proc.kill("SIGUSR2")
  await Bun.sleep(500)
  const ps = Bun.spawn({ cmd: ["ps", "-o", "rss=", "-p", String(p.proc.pid)], stdout: "pipe" })
  const out = (await new Response(ps.stdout).text()).trim()
  await ps.exited
  const kb = Number(out)
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`ps rss for ${p.proc.pid}: "${out}"`)
  return kb
}

async function bootTransactions(p: RoleProcess): Promise<number> {
  const res = await fetch(`${p.url}/diag`, {
    headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
  })
  if (res.status !== 200) throw new Error(`/diag on :${p.port} answered ${res.status}`)
  const body = (await res.json()) as { pools: Record<string, { transactions: number }> }
  return Object.values(body.pools).reduce((sum, g) => sum + g.transactions, 0)
}

async function bootOnce(cell: RoleCell, role: ProcessRole): Promise<BootSample> {
  const bootAt = Date.now()
  const t0 = performance.now()
  const p = await cell.spawn(role)
  const probedReadyMs = performance.now() - t0
  try {
    const readyMs = readyAt(p) - bootAt
    const transactions = role === "api" ? await bootTransactions(p) : null
    const { byBoot, queued } = registrationsByCause(jsonLogLines(p), bootAt)
    return {
      readyMs,
      probedReadyMs,
      rssKb: await rssKb(p),
      appsRegisteredByBoot: byBoot,
      queuedSetupRegistrations: queued,
      transactions,
    }
  } finally {
    await p.kill()
  }
}

/** One authenticated, manifest-derived request per org: the org's first touch in `p`. */
async function touch(p: RoleProcess, org: { orgId: string; token: string }): Promise<number> {
  const t0 = performance.now()
  const res = await api(p.url, "/api/agent/app-skills", { token: org.token })
  const ms = performance.now() - t0
  if (res.status !== 200) {
    throw new Error(
      `first touch of ${org.orgId} on :${p.port}: ${res.status} ${JSON.stringify(res.body)}`,
    )
  }
  const skills = res.body.data as Array<{ appName: string }>
  if (skills.length === 0) throw new Error(`first touch of ${org.orgId}: no app skills listed`)
  return ms
}

function run(latenciesMs: number[]): TouchRun {
  return { latenciesMs, p50: median(latenciesMs), p95: p95(latenciesMs) }
}

async function touchSerial(
  cell: RoleCell,
  build: string,
  orgs: Array<{ orgId: string; token: string }>,
): Promise<TouchRun> {
  const p = await cell.spawn("api", { LIAISON_VERSION: build })
  try {
    const ms: number[] = []
    for (const org of orgs) ms.push(await touch(p, org))
    return run(ms)
  } finally {
    await p.kill()
  }
}

async function touchBurst(
  cell: RoleCell,
  build: string,
  orgs: Array<{ orgId: string; token: string }>,
): Promise<TouchRun> {
  const p = await cell.spawn("api", { LIAISON_VERSION: build })
  try {
    return run(await Promise.all(orgs.map((org) => touch(p, org))))
  } finally {
    await p.kill()
  }
}

function sample<T>(xs: T[], k: number): T[] {
  const copy = [...xs]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
  }
  return copy.slice(0, k)
}

async function measure(n: number): Promise<SizeResult> {
  // 10 spawns, the worker's whole port block: 3 api + 3 worker boots and 4
  // first-touch apis.
  const cell = await createRoleCell(CELL_WORKER, [], {
    serverEnv: { LIAISON_VERSION: BUILD, MONITOR_TOKEN },
  })
  try {
    const out = path.join(scratch, `orgs-${n}.json`)
    const seed = await cell.runOneShot(["src/tests/e2e/cell/boot-flat-seed.ts", String(n), out])
    if (seed.exitCode !== 0)
      throw new Error(`seed of ${n} orgs failed: ${seed.stderr.slice(-4000)}`)
    const orgs = JSON.parse(readFileSync(out, "utf8")) as Array<{ orgId: string; token: string }>
    expect(orgs.length).toBe(n)

    const apiBoots: BootSample[] = []
    for (let i = 0; i < BOOTS; i++) apiBoots.push(await bootOnce(cell, "api"))
    const workerBoots: BootSample[] = []
    for (let i = 0; i < BOOTS; i++) workerBoots.push(await bootOnce(cell, "worker"))

    // Every first touch is the org's first in its process: each run has its own
    // fresh api. The mismatching runs use two other builds, so the second does
    // not find the stamps the first wrote.
    const matchSerial = await touchSerial(cell, BUILD, sample(orgs, TOUCHES))
    const matchBurst = await touchBurst(cell, BUILD, sample(orgs, TOUCHES))
    const mismatchSerial = await touchSerial(cell, "boot-flat-b", sample(orgs, TOUCHES))
    const mismatchBurst = await touchBurst(cell, "boot-flat-c", sample(orgs, TOUCHES))

    return {
      orgs: n,
      api: {
        boots: apiBoots,
        readyMs: median(apiBoots.map((b) => b.readyMs)),
        rssKb: Math.min(...apiBoots.map((b) => b.rssKb)),
        transactions: median(apiBoots.map((b) => b.transactions ?? Number.NaN)),
      },
      worker: {
        boots: workerBoots,
        readyMs: median(workerBoots.map((b) => b.readyMs)),
        rssKb: Math.min(...workerBoots.map((b) => b.rssKb)),
      },
      touch: { matchSerial, matchBurst, mismatchSerial, mismatchBurst },
    }
  } finally {
    await cell.teardown()
  }
}

const LATENCY_FACTOR = Math.max(1, Number(process.env.BOOT_FLAT_LATENCY_FACTOR) || 1)

describe("S19: boot flat in the org count, first touch bounded", () => {
  afterAll(() => {
    const evidence =
      process.env.BOOT_FLAT_EVIDENCE ?? path.join(tmpdir(), "liaison-boot-flat-evidence.json")
    writeFileSync(
      evidence,
      JSON.stringify(
        { measuredAt: new Date().toISOString(), sizes: [...results.values()] },
        null,
        2,
      ),
    )
    console.log(`boot-flat evidence: ${evidence}`)
    rmSync(scratch, { recursive: true, force: true })
  })

  for (const n of SIZES) {
    it(
      `${n} orgs: boots set up no org; first touches within bounds`,
      async () => {
        const r = await measure(n)
        results.set(n, r)
        console.log(
          `boot-flat N=${n}: api ready ${Math.round(r.api.readyMs)} ms, rss ${Math.round(r.api.rssKb / MB)} MB, ` +
            `tx ${r.api.transactions}; worker ready ${Math.round(r.worker.readyMs)} ms, rss ${Math.round(r.worker.rssKb / MB)} MB ` +
            `(per boot: api ${r.api.boots.map((b) => Math.round(b.rssKb / MB)).join("/")}, ` +
            `worker ${r.worker.boots.map((b) => Math.round(b.rssKb / MB)).join("/")} MB); ` +
            `touch p95 match ${Math.round(r.touch.matchSerial.p95)}/${Math.round(r.touch.matchBurst.p95)} ms, ` +
            `mismatch ${Math.round(r.touch.mismatchSerial.p95)}/${Math.round(r.touch.mismatchBurst.p95)} ms (serial/burst)`,
        )
        const boots = [...r.api.boots, ...r.worker.boots]
        console.log(
          `boot-flat N=${n}: apps registered for work queued before the boot ` +
            `${boots.map((b) => b.queuedSetupRegistrations.length).join(",")} (api x${BOOTS}, worker x${BOOTS}; not asserted)`,
        )
        for (const b of boots) expect(b.appsRegisteredByBoot).toBe(0)
        expect(r.touch.matchSerial.p95).toBeLessThanOrEqual(2_000 * LATENCY_FACTOR)
        expect(r.touch.matchBurst.p95).toBeLessThanOrEqual(2_000 * LATENCY_FACTOR)
        expect(r.touch.mismatchSerial.p95).toBeLessThanOrEqual(10_000 * LATENCY_FACTOR)
        expect(r.touch.mismatchBurst.p95).toBeLessThanOrEqual(10_000 * LATENCY_FACTOR)
      },
      45 * 60_000,
    )
  }

  it("boot time, memory and boot transactions do not grow with the org count", () => {
    const small = results.get(SIZES[0])
    const large = results.get(SIZES[1])
    expect(small).toBeDefined()
    expect(large).toBeDefined()
    if (!small || !large) return
    expect(large.api.readyMs).toBeLessThanOrEqual(1.2 * small.api.readyMs)
    expect(large.worker.readyMs).toBeLessThanOrEqual(1.2 * small.worker.readyMs)
    expect(large.api.rssKb - small.api.rssKb).toBeLessThanOrEqual(50 * MB)
    expect(large.worker.rssKb - small.worker.rssKb).toBeLessThanOrEqual(50 * MB)
    expect(large.api.transactions).toBeLessThanOrEqual(1.2 * small.api.transactions + 20)
  })
})
