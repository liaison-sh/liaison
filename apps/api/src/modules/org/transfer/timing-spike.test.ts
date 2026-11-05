// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Timing spike for one org's move, local half: a lively-seeded org on database
// A, moved to database B on the same machine by the real source and target
// agents, under a scripted write load (5 writes/s) until the freeze. Measures
// every step of the write gap against its budget (ceilings.ts), plus the
// per-row scan and apply rates that `estimate.ts` uses, the re-key time of an
// apply, the jobs export and the replay-mark SCAN.
//
// Off unless LIAISON_TRANSFER_TIMING=1 (it seeds a whole world and takes
// minutes). The report is written as JSON to LIAISON_TRANSFER_TIMING_OUT.
//
//   LIAISON_TRANSFER_TIMING=1 LIAISON_TRANSFER_TIMING_OUT=/path/out.json \
//     bun run scripts/test-run.ts unit --file "$PWD/apps/api/src/modules/org/transfer/timing-spike.test.ts"
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { MeiliSearch } from "meilisearch"
import postgres from "postgres"
import { createPool } from "~/db/connection"
import { PrivilegedDbTestAccess } from "~/db/privileged"
import { exportOrgJobs } from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { env } from "~/lib/env"
import { redisBullMQ } from "~/lib/redis"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import { seedProcessedPendingEvents } from "~/seed/factories/org/platform-rows"
import { seedLivelyWorld } from "~/seed/tiers/lively/seed-lively"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { SpikeControl } from "../../../../test-support/org-transfer/timing-spike-control"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { type MoveReport, runSourceMove } from "./agent-source"
import { lineTargetChannel, type TargetChannel } from "./agent-target"
import { estimateTransfer } from "./estimate"
import { exportOrg, scanFingerprint, WEBHOOK_REPLAY_MARK } from "./export"
import { importOrg } from "./import"
import { generateTransferKeys } from "./rekey"

const ENABLED = process.env.LIAISON_TRANSFER_TIMING === "1"
const OUT = process.env.LIAISON_TRANSFER_TIMING_OUT ?? ""
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]
const WRITES_PER_SECOND = 5

const hex = () => randomBytes(32).toString("hex")
const KEYS_A = { encryption: env.ENCRYPTION_KEY, byok: hex() }
const KEYS_B = { encryption: hex(), byok: hex() }
const KEYS_C = { encryption: hex(), byok: hex() }

const superA = process.env.DATABASE_URL_SUPERUSER as string
const dbA = new URL(superA).pathname.slice(1)
const dbB = `${dbA}_spike_b`
const dbC = `${dbA}_spike_c`
const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const PREFIX_B = `${process.env.REDIS_PREFIX ?? ""}spikeb:`
const INDEX_A = `test_spike_a_${randomUUID().slice(0, 8)}`
const INDEX_B_PREFIX = `test_spike_b_${randomUUID().slice(0, 6)}_`
const INDEX_B = `${INDEX_B_PREFIX}${searchClientModule.effectiveIndexName().slice((env.MEILI_INDEX_PREFIX ?? "").length)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const spies: Array<{ mockRestore: () => void }> = []
let A: postgres.Sql
let C: postgres.Sql
let poolC: ReturnType<typeof createPool>
let installRoot = ""
const children: Array<{ kill: () => void }> = []

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number

async function timed<T>(fn: () => Promise<T>): Promise<{ v: T; ms: number }> {
  const t0 = performance.now()
  const v = await fn()
  return { v, ms: ms(t0) }
}

function childEnv(db = dbB, apps = "b"): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    out[k] = /^postgres(ql)?:\/\//.test(v) && v.includes(`/${dbA}`) ? withDb(v, db) : v
  }
  out.MIGRATION_DATABASE_URL = withDb(superA, db)
  out.ENCRYPTION_KEY = KEYS_B.encryption
  out.BYOK_ENCRYPTION_KEY = KEYS_B.byok
  out.REDIS_PREFIX = PREFIX_B
  out.MEILI_INDEX_PREFIX = INDEX_B_PREFIX
  out.LIAISON_APPS_DIR = join(installRoot, apps)
  return out
}

/** Install the catalog apps into database `db` (a child process with that database's environment). */
async function installInto(db: string, apps: string): Promise<void> {
  mkdirSync(join(installRoot, apps), { recursive: true })
  const child = spawn(
    "bun",
    ["run", "test-support/org-transfer/timing-spike-install.ts", ...CATALOG_DEMO_APPS],
    { cwd: join(import.meta.dir, "../../../.."), env: childEnv(db, apps), stdio: "inherit" },
  )
  const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)))
  if (code !== 0) throw new Error(`installing the apps into ${db} failed (${code})`)
}

function startTarget(): TargetChannel {
  const child = spawn(
    "bun",
    ["run", "src/cli/index.ts", "org", "transfer", "agent", "--role", "target"],
    {
      cwd: join(import.meta.dir, "../../../.."),
      env: childEnv(),
      stdio: ["pipe", "pipe", "inherit"],
    },
  )
  children.push({ kill: () => child.kill("SIGKILL") })
  return lineTargetChannel(
    (line) => {
      child.stdin.write(`${line}\n`)
    },
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
    async () => {
      child.stdin.end()
    },
  )
}

async function createFrom(admin: postgres.Sql, name: string, tpl: string) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE liaison_tpl_${tpl}`)
  for (const r of ["liaison_app", "liaison_admin", "liaison_rls", "liaison_schema_admin"]) {
    await admin.unsafe(`GRANT ALL ON DATABASE ${name} TO ${r}`)
  }
}

async function onC<T>(fn: () => Promise<T>): Promise<T> {
  PrivilegedDbTestAccess.usePool({ db: poolC.db, acquireTimeoutMs: 10_000 })
  try {
    return await fn()
  } finally {
    PrivilegedDbTestAccess.usePool(null)
  }
}

/** The replay-mark SCAN exactly as `exportOrg` runs it (export.ts `readReplayMarks`). */
async function scanReplayMarks(orgId: string): Promise<{ keys: number; calls: number }> {
  let cursor = "0"
  let calls = 0
  let keys = 0
  do {
    const [next, found] = await redisBullMQ.scan(
      cursor,
      "MATCH",
      `*${WEBHOOK_REPLAY_MARK}${orgId}:*`,
      "COUNT",
      5000,
    )
    cursor = next
    calls += 1
    keys += found.length
  } while (cursor !== "0")
  return { keys, calls }
}

/**
 * Copy the catalog apps' table definitions from database A into `db` (the apps
 * create their tables when an org first uses them; a target needs them to
 * pass the move's column fingerprint check). Runs pg_dump/psql in the
 * database container.
 */
async function copyAppSchemas(db: string): Promise<void> {
  const u = new URL(superA)
  const container = process.env.LIAISON_TRANSFER_TIMING_PG_CONTAINER ?? "saas-core-postgres-1"
  const exec = (cmd: string) =>
    new Promise<void>((resolve, reject) => {
      const c = spawn("sh", ["-c", cmd], {
        env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
        stdio: ["ignore", "ignore", "inherit"],
      })
      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} -> ${code}`))))
    })
  const user = decodeURIComponent(u.username)
  const dump = `docker exec -e PGPASSWORD ${container} pg_dump -U ${user} -s --no-owner ${CATALOG_DEMO_APPS.map((a) => `-n app_${a}`).join(" ")} ${dbA}`
  const load = `docker exec -i -e PGPASSWORD ${container} psql -q -v ON_ERROR_STOP=1 -U ${user} ${db}`
  await exec(`${dump} | ${load}`)
}

/** One move A -> B under the scripted write load (updates of existing rows, no-op values) until the freeze. */
async function runMove(orgId: string, adminUserId: string): Promise<Record<string, unknown>> {
  const pick = async (q: string) => (await A.unsafe<{ id: string }[]>(q)).map((r) => r.id)
  const msgs = await pick(
    `SELECT id::text FROM kernel.pending_events WHERE org_id = '${orgId}' LIMIT 500`,
  )
  const tickets = await pick(
    `SELECT id::text FROM app_tickets.tickets WHERE org_id = '${orgId}' LIMIT 500`,
  )
  let writes = 0
  const writer = setInterval(() => {
    writes += 1
    const m = msgs[writes % Math.max(msgs.length, 1)]
    const t = tickets.length ? tickets[writes % tickets.length] : null
    if (t && writes % 2 === 0)
      void A`UPDATE app_tickets.tickets SET id = id WHERE id = ${t}::uuid`.catch(() => {})
    else if (m)
      void A`UPDATE kernel.pending_events SET attempts = attempts WHERE id = ${m}::uuid`.catch(
        () => {},
      )
    else void A`UPDATE kernel.users SET name = name WHERE id = ${adminUserId}`.catch(() => {})
  }, 1000 / WRITES_PER_SECOND)
  const events: Array<{ at: number; what: string }> = []
  const stamp = (what: string) => events.push({ at: performance.now(), what })
  let writesAtFreeze = 0
  const control = new SpikeControl()
  const raw = startTarget()
  const target: TargetChannel = {
    call: async (cmd, args, lines) => {
      stamp(`${cmd}:start`)
      try {
        return await raw.call(cmd, args, lines)
      } finally {
        stamp(`${cmd}:end`)
      }
    },
    close: () => raw.close(),
  }
  let mv: MoveReport
  stamp("move:start")
  try {
    mv = await runSourceMove({
      sql: A as never,
      orgId,
      transferId: randomUUID(),
      target,
      control: control.for(),
      instanceKeys: KEYS_A,
      ackInstances: [],
      heartbeatMs: 200,
      storageIdentity: () => ({ objects: "spike-cell-a|bucket", search: "spike-cell-a|index" }),
      progress: (e) => stamp(`progress:${String(e.event)}:${String(e.phase ?? "")}`),
      hooks: {
        afterFreeze: async () => {
          writesAtFreeze = writes
          clearInterval(writer)
          stamp("freeze")
        },
      },
    })
  } finally {
    clearInterval(writer)
    await raw.call("bye").catch(() => {})
    await raw.close()
  }
  stamp("move:end")
  const t0 = events[0]?.at ?? 0
  return {
    outcome: mv.outcome,
    reason: mv.reason,
    writeGapMs: mv.writeGapMs,
    timings: mv.timings,
    pass: mv.pass,
    jobs: mv.jobs,
    writesIssued: writes,
    writesAtFreeze,
    writeRatePerSecond: WRITES_PER_SECOND,
    events: events.map((e) => ({ t: Math.round(e.at - t0), what: e.what })),
  }
}

const d = describe.skipIf(!ENABLED)

beforeAll(async () => {
  if (!ENABLED) return
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "xfer-spike-"))
  mkdirSync(join(installRoot, "a"))
  mkdirSync(join(installRoot, "b"))
  process.env.LIAISON_APPS_DIR = join(installRoot, "a")
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_A))
  IndexWriterTestAccess.resetRebuildCache()
  for (const name of [INDEX_A, INDEX_B]) {
    await meili.deleteIndex(name).catch(() => {})
    const created = await meili.createIndex(name, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const s = await meili.index(name).updateSettings({ filterableAttributes: ["org_id"] })
    await meili.tasks.waitForTask(s.taskUid)
  }
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  const [{ c }] = await admin<{ c: string }[]>`SELECT shobj_description(oid, 'pg_database') AS c
    FROM pg_database WHERE datname = ${dbA}`
  const tpl = /template=([0-9a-f]+)/.exec(c ?? "")?.[1]
  if (!tpl) throw new Error(`the test database ${dbA} names no template`)
  await createFrom(admin, dbB, tpl)
  await createFrom(admin, dbC, tpl)
  await admin.end()
  A = postgres(superA, { max: 4, onnotice: () => {} })
  C = postgres(withDb(superA, dbC), { max: 2, onnotice: () => {} })
  poolC = createPool(4, withDb(env.DATABASE_URL, dbC))
  await installInto(dbB, "b")
  await installInto(dbC, "c")
  await createTestOrg({ email: `sp-${randomUUID().slice(0, 8)}@spike.test` })
}, 300_000)

afterAll(async () => {
  if (!ENABLED) return
  for (const c of children) c.kill()
  for (const s of spies) s.mockRestore()
  for (const name of [INDEX_A, INDEX_B]) await meili.deleteIndex(name).catch(() => {})
  await C?.end({ timeout: 5 })
  await A?.end({ timeout: 5 })
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbC} WITH (FORCE)`)
  await admin.end()
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
})

d("transfer timing spike (local half)", () => {
  it("measures the gap steps and the per-row rates", async () => {
    const report: Record<string, unknown> = {}
    // ── seed: one lively org, not marked as a demo org ──
    DemoModeTestAccess.set(false)
    const { orgId, adminUserId } = await minimal.secondOrg({ name: "Spike org" })
    const seeded = await timed(async () => {
      for (const app of CATALOG_DEMO_APPS) await installFromDist(app, orgId)
      return seedLivelyWorld({ existingOrg: { orgId, adminUserId }, log: () => {} })
    })
    DemoModeTestAccess.set(null)
    report.seedMs = seeded.ms
    report.seedComplete = seeded.v.complete

    await copyAppSchemas(dbB)
    await copyAppSchemas(dbC)

    // ── size ──
    const est = await timed(() => estimateTransfer(A as never, orgId))
    report.estimateMs = est.ms
    report.rows = est.v.rows
    report.bytes = est.v.bytes
    report.tableCount = est.v.tables.length
    report.topTables = [...est.v.tables].sort((a, b) => b.rows - a.rows).slice(0, 8)

    // ── scan: (pk, xmin) of the whole closure, quiet ──
    const scans: number[] = []
    for (let i = 0; i < 5; i++)
      scans.push((await timed(() => scanFingerprint(A as never, orgId))).ms)
    report.scanMs = scans
    report.scanMedianMs = median(scans)

    // ── jobs export and replay-mark SCAN ──
    const jobsMs: number[] = []
    for (let i = 0; i < 5; i++) jobsMs.push((await timed(() => exportOrgJobs(orgId))).ms)
    report.jobsExportMs = jobsMs
    const dbsize = await redisBullMQ.dbsize()
    const scanMs: number[] = []
    let scanInfo = { keys: 0, calls: 0 }
    for (let i = 0; i < 5; i++) {
      const r = await timed(() => scanReplayMarks(orgId))
      scanMs.push(r.ms)
      scanInfo = r.v
    }
    report.replayScan = { realKeyspace: dbsize, ms: scanMs, ...scanInfo }
    // A large keyspace (the production Redis holds queues, sessions and rate counters).
    const synth = `${process.env.REDIS_PREFIX ?? ""}spikescan:`
    for (let off = 0; off < 200_000; off += 10_000) {
      const p = redisBullMQ.pipeline()
      for (let i = 0; i < 10_000; i++) p.set(`${synth}${off + i}`, "1", "EX", 900)
      await p.exec()
    }
    const bigSize = await redisBullMQ.dbsize()
    const bigMs: number[] = []
    let bigInfo = { keys: 0, calls: 0 }
    for (let i = 0; i < 3; i++) {
      const r = await timed(() => scanReplayMarks(orgId))
      bigMs.push(r.ms)
      bigInfo = r.v
    }
    report.replayScanBig = { keyspace: bigSize, ms: bigMs, ...bigInfo }
    for (let off = 0; off < 200_000; off += 10_000) {
      const p = redisBullMQ.pipeline()
      for (let i = 0; i < 10_000; i++) p.unlink(`${synth}${off + i}`)
      await p.exec()
    }

    // ── the real move of the lively org, under 5 writes/s until the freeze ──
    report.move = await runMove(orgId, adminUserId)

    // ── scale ladder: a second org grown with synthetic event rows ──
    const big = await minimal.secondOrg({ name: "Spike scale org" })
    const grow = async (n: number) => {
      await seedProcessedPendingEvents(big.orgId, n, 600)
      await A`ANALYZE kernel.pending_events`
    }
    const ladder: Array<Record<string, unknown>> = []
    let extra = 0
    for (const target of [0, 20_000, 100_000, 400_000]) {
      if (target > extra) await grow(target - extra)
      extra = target
      const rows = (await estimateTransfer(A as never, big.orgId)).rows
      const scans2: number[] = []
      for (let i = 0; i < 3; i++)
        scans2.push((await timed(() => scanFingerprint(A as never, big.orgId))).ms)
      ladder.push({ extraRows: extra, rows, scanMs: scans2, scanMedianMs: median(scans2) })
    }
    report.ladder = ladder

    // Pass 1 of the biggest into database C, then deltas of growing size.
    const transferC = randomUUID()
    const keysC = generateTransferKeys()
    const exportC = (since?: Awaited<ReturnType<typeof exportOrg>>["fingerprint"]) =>
      exportOrg({
        sql: A as never,
        orgId: big.orgId,
        transferId: transferC,
        instanceKeys: KEYS_A,
        transferKeys: keysC,
        search: false,
        ...(since ? { since } : {}),
      })
    const importC = (lines: string[]) =>
      onC(() => importOrg({ sql: C as never, lines, transferKeys: keysC, ownKeys: KEYS_C }))
    const full = await timed(() => exportC())
    const fullImport = await timed(() => importC(full.v.lines))
    report.pass1 = {
      rows: ladder[ladder.length - 1]?.rows,
      exportMs: full.ms,
      importMs: fullImport.ms,
      importRekeyMs: fullImport.v.rekeyMs,
      bundleBytes: full.v.lines.reduce((s, l) => s + l.length + 1, 0),
    }
    let since = full.v.fingerprint
    const ids = await A<{ id: string }[]>`SELECT id::text FROM kernel.pending_events
      WHERE org_id = ${big.orgId} ORDER BY id`
    const deltas: Array<Record<string, unknown>> = []
    let off = 0
    for (const n of [0, 5, 100, 1000, 5000, 20000, 50000]) {
      if (n > 0) {
        const pick = ids.slice(off, off + n).map((r) => r.id)
        off += n
        // A no-op update still gives each row a new xmin: the scan sees it as changed.
        await A`UPDATE kernel.pending_events SET attempts = attempts WHERE id = ANY(${pick}::uuid[])`
      }
      const ex = await timed(() => exportC(since))
      const im = await timed(() => importC(ex.v.lines))
      deltas.push({
        updated: n,
        changedRows: Object.values(im.v.rows).reduce((s, x) => s + x, 0),
        exportMs: ex.ms,
        importMs: im.ms,
        rekeyMs: im.v.rekeyMs,
        bundleBytes: ex.v.lines.reduce((s, l) => s + l.length + 1, 0),
      })
      since = ex.v.fingerprint
    }
    report.deltas = deltas

    // The same move at the biggest size.
    report.moveBig = await runMove(big.orgId, big.adminUserId)
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2))
    expect((report.move as { outcome: string }).outcome).toBe("committed")
    expect((report.moveBig as { outcome: string }).outcome).toBe("committed")
  }, 3_300_000)
})
