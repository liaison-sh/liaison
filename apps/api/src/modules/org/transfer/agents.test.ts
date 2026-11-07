// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The transfer agents driving whole moves between two instances. Instance A is this test namespace (database,
// Redis prefix, search index); instance B is a second database cloned from the
// same migrated template, its own Redis prefix, search index and keys, and its
// target agent is a REAL child process (`liaison org transfer agent --role
// target`) driven over its stdin/stdout, as over ssh. The control plane is a
// fake with the real lease rules: heartbeats renew a 15 s lease, freeze and
// commit are compare-and-sets on the lease, a lapsed lease aborts.
//
// Pinned:
//   - a committed move under writes: the closure equal on B (secrets open with
//     B's keys), B serves the org, A is `moved`; every gap step timed under its
//     ceiling; the org's queued job and scheduler re-added on B exactly once
//     and gone from A; Gmail re-watched only after the commit; MCP connections
//     revoked with one attention event; search equal on both;
//   - an org with its own custom app moves (installed on B in the precopy);
//   - a step past its ceiling aborts before the commit: A serves again, B has
//     nothing, the control plane `aborted`;
//   - the control plane aborting mid-freeze (operator `--abort`) unfreezes A;
//   - a commit whose reply is lost is settled by asking: committed;
//   - the agent killed while frozen with the control plane unreachable: the
//     org stays frozen (resolver: unreachable); once reachable, the lapsed
//     lease is `aborted` and both resolvers settle it (A serves, B purged).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import {
  MOVE_LEASE_SECONDS,
  type MoveAgentPhase,
  type MoveState,
} from "@liaison/control-plane-contract"
import { Queue } from "bullmq"
import { MeiliSearch } from "meilisearch"
import postgres from "postgres"
import { withSystemDb } from "~/db/privileged"
import * as searchClientModule from "~/infra/search/client"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { installAppFromTarball, uninstallApp } from "~/modules/apps/install-service"
import {
  CONTROL_ASK_AFTER_MS,
  RESOLVER_INTERVAL_MS,
  resolveOverdueMoves,
} from "~/modules/org/transfer-state/resolver"
import { readMovingOrgs } from "~/modules/org/transfer-state/state"
import { IndexWriterTestAccess, writeIndexAndWait } from "~/modules/search/index-writer"
import { insertAppRow } from "~/seed/factories/app-tables"
import { seedControlPlaneMessage, seedMcpConnection } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  AgentKilled,
  type MoveReport,
  ROUTING_SETTLE_MS,
  runSourceMove,
  type SourceMoveOptions,
} from "./agent-source"
import { lineTargetChannel, type TargetChannel } from "./agent-target"
import { GAP_STEPS } from "./ceilings"
import { loadClosure, orgPredicate, rel } from "./closure"
import type { MoveControl, MoveDecision } from "./control"
import {
  assertIncomingPurgeSafe,
  assertMovedPurgeSafe,
  clearStorageProbe,
  PROBE_SEARCH_ORG_ID,
  probeVisibleHere,
  recordPeerStorage,
  storageIdentity,
  writeStorageProbe,
} from "./storage-identity"

const hex = () => randomBytes(32).toString("hex")
const KEYS_A = { encryption: env.ENCRYPTION_KEY, byok: hex() }
const KEYS_B = { encryption: hex(), byok: hex() }

const superA = process.env.DATABASE_URL_SUPERUSER as string
const dbA = new URL(superA).pathname.slice(1)
const dbB = `${dbA}_agent_b`
const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const PREFIX_B = `${process.env.REDIS_PREFIX ?? ""}xferb:`
const INDEX_A = `test_xfer_agent_a_${randomUUID().slice(0, 8)}`
const INDEX_B_PREFIX = `test_xfer_agent_b_${randomUUID().slice(0, 6)}_`
const INDEX_B = `${INDEX_B_PREFIX}${searchClientModule.effectiveIndexName().slice((env.MEILI_INDEX_PREFIX ?? "").length)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const spies: Array<{ mockRestore: () => void }> = []
const TEST_QUEUE = "xfer-agent-test"
const SRC = join(import.meta.dir, "../../..")
let A: postgres.Sql
let B: postgres.Sql
let installRoot = ""
const children: Array<{ kill: () => void }> = []

// ── the fake control plane (the lease rules it enforces) ──
class FakeControl {
  state: MoveState = "planned"
  leaseUntil = 0
  offset = 0
  reachable = true
  /** The next commit is recorded but its reply is lost. */
  loseCommitReply = false
  calls: string[] = []
  now = () => Date.now() + this.offset
  private lapse() {
    if ((this.state === "draining" || this.state === "frozen") && this.now() > this.leaseUntil) {
      this.state = "aborted"
    }
  }
  private reply(): MoveDecision {
    return {
      ok: true,
      state: this.state,
      leaseUntil: this.leaseUntil ? new Date(this.leaseUntil).toISOString() : null,
    }
  }
  private down(): MoveDecision | null {
    return this.reachable ? null : { ok: false, code: "unreachable", error: "down" }
  }
  for(): MoveControl {
    return {
      heartbeat: async (phase: MoveAgentPhase) => {
        this.calls.push(`heartbeat:${phase}`)
        const d = this.down()
        if (d) return d
        this.lapse()
        if (["committed", "finalized", "aborted", "failed"].includes(this.state))
          return this.reply()
        this.leaseUntil = this.now() + MOVE_LEASE_SECONDS * 1000
        const order = ["planned", "precopy", "draining"]
        if (order.indexOf(phase) > order.indexOf(this.state)) this.state = phase
        return this.reply()
      },
      status: async () => {
        this.calls.push("status")
        const d = this.down()
        if (d) return d
        this.lapse()
        return this.reply()
      },
      freeze: async () => {
        this.calls.push("freeze")
        const d = this.down()
        if (d) return d
        this.lapse()
        if (this.now() > this.leaseUntil) return { ok: false, code: "lease_expired" }
        this.state = "frozen"
        return this.reply()
      },
      commit: async () => {
        this.calls.push("commit")
        const d = this.down()
        if (d) return d
        this.lapse()
        if (this.state === "aborted") return { ok: false, code: "aborted", state: "aborted" }
        if (this.state === "committed") return this.reply()
        if (this.state !== "frozen") return { ok: false, code: "bad_state" }
        this.state = "committed"
        this.leaseUntil = 0
        if (this.loseCommitReply) {
          this.loseCommitReply = false
          return { ok: false, code: "unreachable", error: "reply lost" }
        }
        return this.reply()
      },
      abort: async () => {
        this.calls.push("abort")
        const d = this.down()
        if (d) return d
        if (this.state === "committed")
          return { ok: false, code: "already_committed", state: "committed" }
        this.state = "aborted"
        return { ok: true, state: "aborted", leaseUntil: null }
      },
    }
  }
}

// ── instance B's target agent: a child process ──
let childExtra: Record<string, string> = {}
function childEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    out[k] = /^postgres(ql)?:\/\//.test(v) && v.includes(`/${dbA}`) ? withDb(v, dbB) : v
  }
  out.MIGRATION_DATABASE_URL = withDb(superA, dbB)
  out.ENCRYPTION_KEY = KEYS_B.encryption
  out.BYOK_ENCRYPTION_KEY = KEYS_B.byok
  out.REDIS_PREFIX = PREFIX_B
  out.MEILI_INDEX_PREFIX = INDEX_B_PREFIX
  out.LIAISON_APPS_DIR = join(installRoot, "b")
  return { ...out, ...childExtra }
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

async function move(
  orgId: string,
  control: FakeControl,
  extra: Partial<SourceMoveOptions> = {},
  wrap?: (t: TargetChannel) => TargetChannel,
): Promise<MoveReport> {
  const raw = startTarget()
  const target = wrap ? wrap(raw) : raw
  try {
    return await runSourceMove({
      sql: A as never,
      orgId,
      transferId: extra.transferId ?? randomUUID(),
      target,
      control: control.for(),
      instanceKeys: KEYS_A,
      ackInstances: [],
      heartbeatMs: 200,
      routingSettleMs: 0,
      // This test process and the target's child process share one object store
      // and one search host; the source names a different identity.
      storageIdentity: () => ({ objects: "test-cell-a|bucket", search: "test-cell-a|index" }),
      // For the same reason the target's probe is visible here: these moves
      // stand for two cells whose stores differ.
      probeVisible: async () => [],
      ...extra,
    })
  } finally {
    await raw.call("bye").catch(() => {})
    await raw.close()
  }
}

async function orgState(sql: postgres.Sql, orgId: string) {
  const [r] = await sql<{ s: string | null; t: string | null }[]>`
    SELECT transfer_state AS s, transfer_id::text AS t FROM kernel.organizations WHERE id = ${orgId}`
  return r ?? null
}

async function closureRows(sql: postgres.Sql, orgId: string): Promise<Record<string, number>> {
  const closure = await loadClosure(sql as never)
  const out: Record<string, number> = {}
  for (const t of closure.tables) {
    const [r] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
    )
    if ((r?.n ?? 0) > 0) out[t.name] = r!.n
  }
  return out
}

/** A fresh org on A (its own slug, an admin with a secret) to move. */
async function sourceOrg(): Promise<{ orgId: string; userId: string }> {
  const { orgId } = await minimal.secondOrg({ name: `Move ${randomUUID().slice(0, 6)}` })
  const [user] = await A<
    { id: string }[]
  >`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
  const totp = encryptSecret("JBSWY3DPEHPK3PXP", KEYS_A.encryption, CryptoContext.totpSecret)
  await A`UPDATE kernel.users SET totp_secret = ${totp} WHERE id = ${user!.id}`
  return { orgId, userId: user!.id }
}

beforeAll(async () => {
  await acquireTestLock()
  // The fault-injection runs below need a server marked as a test one.
  env.LIAISON_TEST_CELL = true
  installRoot = mkdtempSync(join(tmpdir(), "xfer-agents-"))
  mkdirSync(join(installRoot, "a"))
  mkdirSync(join(installRoot, "b"))
  process.env.LIAISON_APPS_DIR = join(installRoot, "a")
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_A))
  IndexWriterTestAccess.resetRebuildCache()
  for (const name of [INDEX_A, INDEX_B]) {
    await meili.deleteIndex(name).catch(() => {})
    const created = await meili.createIndex(name, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const settings = await meili.index(name).updateSettings({ filterableAttributes: ["org_id"] })
    await meili.tasks.waitForTask(settings.taskUid)
  }
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  const [{ c }] = await admin<{ c: string }[]>`SELECT shobj_description(oid, 'pg_database') AS c
    FROM pg_database WHERE datname = ${dbA}`
  const tpl = /template=([0-9a-f]+)/.exec(c ?? "")?.[1]
  if (!tpl) throw new Error(`the test database ${dbA} names no template`)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${dbB} TEMPLATE liaison_tpl_${tpl}`)
  for (const r of ["liaison_app", "liaison_admin", "liaison_rls", "liaison_schema_admin"]) {
    await admin.unsafe(`GRANT ALL ON DATABASE ${dbB} TO ${r}`)
  }
  await admin.end()
  A = postgres(superA, { max: 4, onnotice: () => {} })
  B = postgres(withDb(superA, dbB), { max: 2, onnotice: () => {} })
  await copyExtraAppSchemas()
  // The instance's first org (registration); every moved org is a second org.
  await createTestOrg({ email: `xa-${randomUUID().slice(0, 8)}@agents.test` })
}, 300_000)

/**
 * B is cloned from the template, but A is this run's database, which earlier files of the
 * same process or shard may have given app schemas (an app creates its tables when it is
 * first registered). The move refuses two instances whose tables differ, so B gets the
 * table definitions of every app schema A holds and the template lacks.
 */
async function copyExtraAppSchemas(): Promise<void> {
  const schemas = (q: postgres.Sql) =>
    q<{ s: string }[]>`SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE 'app\_%'`
  const onB = new Set((await schemas(B)).map((r) => r.s))
  const extra = (await schemas(A)).map((r) => r.s).filter((n) => !onB.has(n))
  if (extra.length === 0) return
  const exec = (cmd: string[], input?: Uint8Array) => {
    const p = Bun.spawnSync(cmd, { stdin: input, stdout: "pipe", stderr: "pipe" })
    if (p.exitCode !== 0) throw new Error(`${cmd[0]} -> ${p.exitCode}: ${p.stderr.toString()}`)
    return p.stdout
  }
  const dump = exec(["pg_dump", "-s", "--no-owner", ...extra.flatMap((n) => ["-n", n]), superA])
  exec(["psql", "-q", "-v", "ON_ERROR_STOP=1", withDb(superA, dbB)], dump)
}

afterAll(async () => {
  for (const c of children) c.kill()
  for (const s of spies) s.mockRestore()
  for (const name of [INDEX_A, INDEX_B]) await meili.deleteIndex(name).catch(() => {})
  await new Queue(TEST_QUEUE, { connection: redisBullMQ, prefix: bullPrefix })
    .obliterate({ force: true })
    .catch(() => {})
  await new Queue(TEST_QUEUE, { connection: redisBullMQ, prefix: `${PREFIX_B}bull` })
    .obliterate({ force: true })
    .catch(() => {})
  await B?.end({ timeout: 5 })
  await A?.end({ timeout: 5 })
  const admin = postgres(superA, { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`)
  await admin.end()
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
})

describe("org transfer agents", () => {
  it("moves an org under writes: B serves it, A is moved, jobs once, Gmail after the commit", async () => {
    const { orgId, userId } = await sourceOrg()
    const transferId = randomUUID()
    const qa = new Queue(TEST_QUEUE, { connection: redisBullMQ, prefix: bullPrefix })
    const qb = new Queue(TEST_QUEUE, { connection: redisBullMQ, prefix: `${PREFIX_B}bull` })
    await qa.add("later", { orgId, n: 1 }, { delay: 3_600_000 })
    await qa.upsertJobScheduler(
      `sched-${orgId}`,
      { every: 3_600_000 },
      { name: "tick", data: { orgId } },
    )
    await seedMcpConnection({
      orgId,
      userId,
      clientId: "test-client",
      label: "Desk",
      refreshTokenHash: randomUUID(),
    })
    await writeIndexAndWait({
      docs: [{ id: `xfer-doc-${orgId}`, org_id: orgId, title: "Moved doc" }],
    })
    // A mailbox, when this build has the mail app's table.
    const [mail] = await A<
      { t: string | null }[]
    >`SELECT to_regclass('app_mail.accounts')::text AS t`
    let hasMail = false
    if (mail?.t) {
      hasMail = await withSystemDb("test-mail-account", (db) =>
        insertAppRow(db, "mail", "accounts", {
          org_id: orgId,
          connected_account_id: randomUUID(),
          owner_type: "user",
          owner_id: userId,
          provider: "gmail",
          email_address: `box-${orgId.slice(0, 6)}@agents.test`,
          sync_status: "active",
        }),
      )
        .then(() => true)
        .catch((err) => {
          console.warn("no mailbox row:", String(err))
          return false
        })
    }
    // Writes during the precopy: pass 1b and pass 2 carry them.
    let writes = 0
    const writer = setInterval(() => {
      writes += 1
      void A`UPDATE kernel.users SET name = ${`Writer ${writes}`} WHERE id = ${userId}`.catch(
        () => {},
      )
    }, 50)
    const control = new FakeControl()
    const lateMessage = randomUUID()
    const rewatchBeforeCommit: Array<unknown> = []
    let report: MoveReport
    try {
      report = await move(orgId, control, {
        transferId,
        hooks: {
          afterFreeze: async () => {
            clearInterval(writer)
          },
          beforeCommit: async () => {
            rewatchBeforeCommit.push(await rewatchKeys(transferId))
            // A control-plane message of the org queued after the drain.
            await seedControlPlaneMessage({
              type: "usage.report",
              messageId: lateMessage,
              data: { orgId, n: 1 },
            })
          },
        },
      })
    } finally {
      clearInterval(writer)
    }
    expect(report.reason).toBeNull()
    expect(report.outcome).toBe("committed")
    expect(control.state).toBe("committed")
    expect(await orgState(A, orgId)).toEqual({ s: "moved", t: transferId })
    expect((await orgState(B, orgId))?.s).toBeNull()
    // Every gap step measured, each under its ceiling.
    const steps = report.timings.map((t) => t.step)
    expect(steps).toEqual([
      "freeze-acks",
      "quiesce",
      "scan-diff",
      "apply",
      "verify",
      "commit",
      "unfreeze-acks",
    ])
    for (const t of report.timings) expect(t.ms).toBeLessThanOrEqual(GAP_STEPS[t.step].ceilingMs)
    expect(report.writeGapMs).toBeGreaterThan(0)
    expect(report.residue).toEqual({ ok: true, problems: [] })
    // The same rows on both sides (counts per closure table; the import compared contents).
    // B holds one more event: the reconnect notice the after-commit step queued.
    const counts = await closureRows(A, orgId)
    expect(await closureRows(B, orgId)).toEqual({
      ...counts,
      "kernel.pending_events": (counts["kernel.pending_events"] ?? 0) + 1,
    })
    const [name] = await B<{ name: string }[]>`SELECT name FROM kernel.users WHERE id = ${userId}`
    const [nameA] = await A<{ name: string }[]>`SELECT name FROM kernel.users WHERE id = ${userId}`
    expect(name?.name).toBe(nameA!.name)
    // Jobs: the queued job and the scheduler run on B, exactly once, and are gone from A.
    const jobsB = (await qb.getJobs(["delayed", "waiting"])).filter(
      (j) => j.data?.orgId === orgId && !j.repeatJobKey,
    )
    // "tick" is the scheduler's first tick, due and never run here: carried as a
    // normal job so it runs once on B (a due tick is not lost to the move).
    expect(jobsB.map((j) => j.name).sort()).toEqual(["later", "tick"])
    expect((await qb.getJobSchedulers()).filter((s) => s.key === `sched-${orgId}`)).toHaveLength(1)
    expect(
      (await qa.getJobs(["delayed", "waiting"])).filter((j) => j.data?.orgId === orgId),
    ).toHaveLength(0)
    expect((await qa.getJobSchedulers()).filter((s) => s.key === `sched-${orgId}`)).toHaveLength(0)
    // MCP: revoked on B with one attention event; A's copy untouched.
    const [mcp] = await B<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.mcp_connections
      WHERE org_id = ${orgId} AND revoked_at IS NOT NULL`
    expect(mcp?.n).toBe(1)
    const [ev] = await B<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'org_move' AND payload->>'action' = 'reconnect'`
    expect(ev?.n).toBe(1)
    // The late control-plane message is B's to send now; A's copy is cancelled.
    const [late] = await B<{ status: string }[]>`SELECT status FROM kernel.control_plane_outbox
      WHERE message_id = ${lateMessage}`
    expect(late?.status).toBe("pending")
    const [lateA] = await A<{ status: string }[]>`SELECT status FROM kernel.control_plane_outbox
      WHERE message_id = ${lateMessage}`
    expect(lateA?.status).toBe("cancelled")
    // Search: the document is on B's index too.
    const docsB = await meili.index(INDEX_B).getDocuments({ filter: `org_id = "${orgId}"` })
    expect(docsB.results.map((d) => d.id)).toEqual([`xfer-doc-${orgId}`])
    // Gmail re-watched on B, only after the commit.
    const after = report.afterCommit as { gmail: { accounts: number; rewatch: boolean } }
    expect(hasMail).toBe(true)
    expect(after.gmail).toEqual({ accounts: 1, rewatch: true })
    expect(rewatchBeforeCommit).toEqual([0])
    expect(await rewatchKeys(transferId)).toBeGreaterThan(0)
  }, 180_000)

  it("does not freeze before the router's moving entry can have reached every edge", async () => {
    // Far past what a small org's first pass takes, so only the wait can explain the time.
    const settleMs = 20_000
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    const phases: { phase: string; at: number }[] = []
    const started = Date.now()
    const report = await move(orgId, control, {
      routingSettleMs: settleMs,
      progress: (e) => {
        if (e.event === "phase") phases.push({ phase: String(e.phase), at: Number(e.at) })
      },
    })
    expect(report.outcome).toBe("committed")
    const draining = phases.find((p) => p.phase === "draining")
    expect(draining).toBeDefined()
    expect(draining!.at - started).toBeGreaterThanOrEqual(settleMs)
  }, 120_000)

  it("the default wait outlasts the router's 60 s of KV staleness", () => {
    expect(ROUTING_SETTLE_MS).toBeGreaterThan(60_000)
  })

  it("a step past its ceiling aborts before the commit: A serves again, B holds nothing", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    let imports = 0
    const slowPass2 = (t: TargetChannel): TargetChannel => ({
      call: async (cmd, args, lines) => {
        if (cmd === "import" && ++imports === 3) await Bun.sleep(GAP_STEPS.apply.ceilingMs + 500)
        return t.call(cmd, args, lines)
      },
      close: () => t.close(),
    })
    const report = await move(orgId, control, {}, slowPass2)
    expect(report.outcome).toBe("aborted")
    expect(report.reason).toContain("apply")
    expect(control.state).toBe("aborted")
    expect(control.calls).not.toContain("commit")
    expect((await orgState(A, orgId))?.s).toBeNull()
    expect(await orgState(B, orgId)).toBeNull()
  }, 120_000)

  it("refuses to move between two cells that share an object store or search index", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    // The real identity of this process equals the target child's (same environment), and the
    // real probe check sees the one store they share.
    const report = await move(orgId, control, { storageIdentity, probeVisible: probeVisibleHere })
    expect(report.outcome).toBe("aborted")
    expect(report.reason).toContain("probe object is visible here")
    expect(report.reason).toContain("same names")
    expect(await orgState(B, orgId)).toBeNull()
    expect((await orgState(A, orgId))?.s).toBeNull()
  }, 120_000)

  it("equal config names alone do not refuse: the probe decides (each cell's own http://meilisearch:7700)", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    // Same names as the target (this process's real identity), the probe not visible: distinct stores.
    const report = await move(orgId, control, { storageIdentity })
    expect(report.reason ?? "").not.toContain("share")
    expect(report.outcome).toBe("committed")
  }, 120_000)

  it("a probe written on this cell's own Redis is seen as shared Redis, and cleared with the probe", async () => {
    const { orgId } = await sourceOrg()
    const probe = await writeStorageProbe(orgId, randomUUID())
    try {
      expect(await probeVisibleHere(probe)).toContain(
        "Redis (the target's probe key is visible here)",
      )
      // The probe document belongs to no tenant: the org's own searches never return it.
      const doc = await searchClientModule
        .getMeili()
        .index(searchClientModule.effectiveIndexName())
        .getDocument(probe.searchId)
      expect(doc.org_id).toBe(PROBE_SEARCH_ORG_ID)
      expect(doc.org_id).not.toBe(orgId)
    } finally {
      await clearStorageProbe(probe)
    }
    expect((await probeVisibleHere(probe)).join(" ")).not.toContain("Redis")
  }, 60_000)

  it("a proven record with the same config names as this cell allows the moved copy's purge", async () => {
    const id = randomUUID()
    await recordPeerStorage(id, { ...storageIdentity(), proven: true })
    await expect(assertMovedPurgeSafe(id)).resolves.toBeUndefined()
  })

  it("refuses when the target's probe is visible here, whatever the config names say", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    // Different names (the default fake), one real object store: the real probe
    // check sees it. The two search indexes here do differ, and are not reported.
    const report = await move(orgId, control, { probeVisible: probeVisibleHere })
    expect(report.outcome).toBe("aborted")
    expect(report.reason).toContain("probe object is visible here")
    expect(report.reason).not.toContain("probe document")
    // B's Redis keys live under its own prefix: not shared, not reported.
    expect(report.reason).not.toContain("Redis")
    expect(await orgState(B, orgId)).toBeNull()
    expect((await orgState(A, orgId))?.s).toBeNull()
    // The target cleared its probe, and recorded no proof: no purge of a copy there.
    await expect(assertIncomingPurgeSafe(report.transferId)).rejects.toThrow(/no proof/)
    await expect(assertMovedPurgeSafe(report.transferId)).rejects.toThrow(/no proof/)
  }, 120_000)

  it("the control plane aborting mid-freeze (operator --abort) gives the org back to A", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    const report = await move(orgId, control, {
      hooks: {
        afterFreeze: async () => {
          control.state = "aborted"
        },
      },
    })
    expect(report.outcome).toBe("aborted")
    expect((await orgState(A, orgId))?.s).toBeNull()
    expect(await orgState(B, orgId)).toBeNull()
  }, 120_000)

  it("a commit whose reply is lost is settled by asking the control plane: committed", async () => {
    const { orgId } = await sourceOrg()
    const control = new FakeControl()
    control.loseCommitReply = true
    const report = await move(orgId, control)
    expect(report.outcome).toBe("committed")
    expect(control.calls.filter((c) => c === "commit")).toHaveLength(1)
    expect((await orgState(A, orgId))?.s).toBe("moved")
    expect((await orgState(B, orgId))?.s).toBeNull()
  }, 120_000)

  it("agent killed while frozen, control plane unreachable: stays frozen, then the lapsed lease returns it to A", async () => {
    const { orgId } = await sourceOrg()
    const transferId = randomUUID()
    const control = new FakeControl()
    const report = await move(orgId, control, {
      transferId,
      hooks: {
        beforeCommit: async () => {
          control.reachable = false
          throw new AgentKilled()
        },
      },
    })
    expect(report.outcome).toBe("unresolved")
    expect(await orgState(A, orgId)).toEqual({ s: "frozen", t: transferId })
    expect((await orgState(B, orgId))?.s).toBe("incoming")
    const ask = async (_o: string, _t: string) => {
      const d = await control.for().status()
      if (!d.ok) throw new Error(d.code)
      return d.state
    }
    const later = () => Date.now() + 46_000
    // Control unreachable: nothing moves, never two writers.
    const first = await resolveOverdueMoves({ moving: readMovingOrgs, askControl: ask, now: later })
    expect(first.find((o) => o.orgId === orgId)?.action).toBe("unreachable")
    expect((await orgState(A, orgId))?.s).toBe("frozen")
    // Control back, the lease long lapsed: aborted, A serves again.
    control.reachable = true
    control.offset = (MOVE_LEASE_SECONDS + 1) * 1000
    const second = await resolveOverdueMoves({
      moving: readMovingOrgs,
      askControl: ask,
      now: later,
    })
    expect(second.find((o) => o.orgId === orgId)?.action).toBe("unfrozen")
    expect(control.state).toBe("aborted")
    expect((await orgState(A, orgId))?.s).toBeNull()
    // B's resolver (its own process and database) purges the incoming copy.
    const purged = await runTargetResolver(orgId, transferId)
    expect(purged).toBe("purged")
    expect(await orgState(B, orgId)).toBeNull()
  }, 120_000)

  it("refuses --fail-at on a server not marked as a test one, before anything moves", async () => {
    const { orgId } = await sourceOrg()
    env.LIAISON_TEST_CELL = false
    try {
      await expect(
        move(orgId, new FakeControl(), { transferId: randomUUID(), failAt: "frozen" }),
      ).rejects.toThrow("LIAISON_TEST_CELL")
      expect((await orgState(A, orgId))?.s ?? null).toBeNull()
    } finally {
      env.LIAISON_TEST_CELL = true
    }
  })

  it("agent stopped right after the commit (--fail-at after-cas): B serves within one ask delay, not the deadline", async () => {
    const { orgId } = await sourceOrg()
    const transferId = randomUUID()
    const control = new FakeControl()
    const events: Array<Record<string, unknown>> = []
    const report = await move(orgId, control, {
      transferId,
      failAt: "after-cas",
      progress: (e) => events.push(e),
    })
    expect(report.outcome).toBe("unresolved")
    expect(report.reason).toBe("killed")
    expect(events.some((e) => e.event === "fault" && e.at === "after-cas")).toBe(true)
    expect(control.state).toBe("committed")
    // Neither copy was settled by the agent: A frozen, B incoming.
    expect(await orgState(A, orgId)).toEqual({ s: "frozen", t: transferId })
    expect((await orgState(B, orgId))?.s).toBe("incoming")
    // B's incoming state dates from the first import, before the freeze, so a
    // pass CONTROL_ASK_AFTER_MS from now is the latest one that has to act.
    const served = await runTargetResolver(orgId, transferId, "committed", CONTROL_ASK_AFTER_MS)
    expect(served).toBe("served")
    expect((await orgState(B, orgId))?.s).toBeNull()
    const ask = async () => {
      const d = await control.for().status()
      if (!d.ok) throw new Error(d.code)
      return d.state
    }
    const a = await resolveOverdueMoves({
      moving: async () => (await readMovingOrgs()).filter((r) => r.orgId === orgId),
      askControl: ask,
      now: () => Date.now() + CONTROL_ASK_AFTER_MS,
    })
    expect(a.find((o) => o.orgId === orgId)?.action).toBe("marked-moved")
    expect((await orgState(A, orgId))?.s).toBe("moved")
    // Gap bound after an agent loss post-commit: ask delay + one pass.
    expect(CONTROL_ASK_AFTER_MS + RESOLVER_INTERVAL_MS).toBeLessThan(20_000)
  }, 120_000)

  it("agent stopped while frozen (--fail-at frozen): the lapsed lease aborts and A serves again before the deadline", async () => {
    const { orgId } = await sourceOrg()
    const transferId = randomUUID()
    const control = new FakeControl()
    const report = await move(orgId, control, { transferId, failAt: "frozen" })
    expect(report.outcome).toBe("unresolved")
    expect(control.calls).not.toContain("commit")
    expect(await orgState(A, orgId)).toEqual({ s: "frozen", t: transferId })
    // The lease lapses; Control aborts on its next read.
    control.offset = (MOVE_LEASE_SECONDS + 1) * 1000
    const ask = async () => {
      const d = await control.for().status()
      if (!d.ok) throw new Error(d.code)
      return d.state
    }
    const a = await resolveOverdueMoves({
      moving: async () => (await readMovingOrgs()).filter((r) => r.orgId === orgId),
      askControl: ask,
      now: () => Date.now() + (MOVE_LEASE_SECONDS + 2) * 1000,
    })
    expect(a.find((o) => o.orgId === orgId)?.action).toBe("unfrozen")
    expect(control.state).toBe("aborted")
    expect((await orgState(A, orgId))?.s).toBeNull()
    expect(await runTargetResolver(orgId, transferId)).toBe("purged")
    expect(await orgState(B, orgId)).toBeNull()
  }, 120_000)

  it("moves an org with its own custom app (installed on B in the precopy)", async () => {
    _setEdition("managed")
    childExtra = { LIAISON_EDITION: "managed" }
    try {
      await moveCustomAppOrg()
    } finally {
      _setEdition(null)
      childExtra = {}
    }
  }, 180_000)
})

async function moveCustomAppOrg(): Promise<void> {
  const { orgId, userId } = await sourceOrg()
  const { customAppOrgKey } = await import("~/modules/apps/app-org-scope")
  const name = `crm-o${customAppOrgKey(orgId)}`
  const tar = makePackage(name)
  await installAppFromTarball({
    tarballPath: tar,
    installedBy: userId,
    grantedScopes: [`${name}:items:read`],
    requireSignature: false,
    ownerOrgId: orgId,
  })
  try {
    const control = new FakeControl()
    const report = await move(orgId, control)
    expect(report.reason).toBeNull()
    expect(report.outcome).toBe("committed")
    const [installed] = await B<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM kernel.apps_installed
      WHERE name = ${name} AND org_id = ${orgId}`
    expect(installed?.n).toBe(1)
    const [schema] = await B<
      { t: string | null }[]
    >`SELECT to_regclass(${`app_${name.replace(/-/g, "_")}.items`})::text AS t`
    expect(schema?.t).not.toBeNull()
    expect(await closureRows(B, orgId)).toEqual(await closureRows(A, orgId))
  } finally {
    // The app's schema outlives an uninstall: drop it on both sides.
    await uninstallApp({ name }).catch(() => {})
    const schema = `app_${name.replace(/-/g, "_")}`
    for (const sql of [A, B]) await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await A`DELETE FROM kernel.apps_active_version WHERE name = ${name}`
    await A`DELETE FROM kernel.apps_installed WHERE name = ${name}`
  }
}

/** B's Redis keys of the Gmail re-watch job of this move (its deduplication key). */
async function rewatchKeys(transferId: string): Promise<number> {
  const keys = await redisBullMQ.keys(`${PREFIX_B}bull:*xfer-rewatch-${transferId}*`)
  return keys.length
}

/** Run B's freeze-deadline resolver in B's own process (a one-shot child). */
async function runTargetResolver(
  orgId: string,
  transferId: string,
  answer: MoveState = "aborted",
  laterMs = 46_000,
): Promise<string | null> {
  const script = join(installRoot, "resolve-b.ts")
  writeFileSync(
    script,
    `import { resolveOverdueMoves } from ${JSON.stringify(join(SRC, "modules/org/transfer-state/resolver"))}
import { readMovingOrgs } from ${JSON.stringify(join(SRC, "modules/org/transfer-state/state"))}
import { purgeTransferCopy } from ${JSON.stringify(join(SRC, "modules/org/transfer/purge"))}
const out = await resolveOverdueMoves({
  moving: readMovingOrgs,
  askControl: async () => ${JSON.stringify(answer)},
  purgeIncoming: async (o, t) => { await purgeTransferCopy(o, t, "incoming") },
  now: () => Date.now() + ${laterMs},
})
const mine = out.find((o) => o.orgId === ${JSON.stringify(orgId)} && o.transferId === ${JSON.stringify(transferId)})
process.stdout.write("@@result " + JSON.stringify(mine?.action ?? null) + "\\n")
process.exit(0)
`,
  )
  const cwd = join(import.meta.dir, "../../../..")
  const proc = Bun.spawn(["bun", "run", "--cwd", cwd, script], {
    env: childEnv(),
    stdout: "pipe",
    stderr: "inherit",
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const line = text.split("\n").find((l) => l.startsWith("@@result "))
  return line ? (JSON.parse(line.slice("@@result ".length)) as string | null) : null
}

function makePackage(name: string): string {
  const stage = join(installRoot, `${name}-${randomBytes(3).toString("hex")}`)
  mkdirSync(stage, { recursive: true })
  const scope = `${name}:items:read`
  const manifest = {
    name,
    version: "1.0.0",
    packageFormat: 1,
    license: "MIT",
    displayName: "CRM",
    scopes: [scope],
    tools: { whoami: { description: "Who answers", handler: "whoami", requiredScopes: [scope] } },
    schema: { items: { fields: { title: "string" } } },
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "function whoami() { return { who: 'a' } }\n")
  const tar = join(installRoot, `${name}.liaisonapp`)
  Bun.spawnSync(["tar", "-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}
