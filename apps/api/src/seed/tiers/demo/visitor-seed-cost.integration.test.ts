// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visitor seed is on the load path: the demo warm pool fills itself by
// running it inside the live api and worker processes, so its wall clock, its
// CPU, its database round trips and the work it leaves queued for those
// processes (outbox events, BullMQ jobs, attention and notification rows) are
// a budget. This test seeds two visitor worlds exactly as the pool does
// (`seedDemoOrgData` with every need), prints what the second (warm) one cost,
// and fails when the counts rise over the pinned baseline. Wall clock and CPU
// are printed for information only: they move with machine load, so nothing
// asserts them.
//
// Then it seeds POOL_PARALLELISM worlds at once, as a launch box's refill does
// in one process. A wall clock misses a seed that got slower only under
// concurrency or only on a busy machine, so the budget that matters most is
// load-independent: statements and transactions per seed, quiet and
// concurrent alike (a concurrent seed that retries, waits on a lock it then
// re-takes, or re-reads per row shows up as more round trips, not just more
// time), and every concurrent seed must finish whole on the process's pools.
//
// Change a pin only on purpose, with the new measurement in the PR.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { startStatementCount } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { listOrgQueuedJobs } from "~/infra/jobs/jobs"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { DEMO_COMPANY_NAME, seedDemoOrgData } from "~/modules/demo/demo-seeder"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The demo apps shipped as catalog bundles; the others are in-tree. */
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]

/**
 * What one warm visitor seed cost on a Mac mini (M-series, 2026-11), median of
 * four runs: 4.4 s wall, 7.8 s CPU (the process's threads together), 511 outbox
 * events, nothing queued in BullMQ directly (search and notification jobs come
 * from the outbox consumers of the api process), no attention event and no
 * notification delivery. Re-measured 2026-11-02 on main 684b9b3cd: 272 outbox
 * events (the role-scope events dropped since), 5 253 round trips in 512
 * transactions, the same on every run, alone or beside four other seeds, at
 * any machine load. Re-measured 2026-11-03 once the commerce layer's dealers
 * and suppliers went through the contacts service like every other contact:
 * 281 outbox events (their nine contact create events, which the privileged
 * write never queued), 5 267 round trips in 513 transactions. Re-measured
 * 2026-11-04 on main 51c8ce2a9: 5 327 round trips in 519 transactions, 281
 * outbox events, statement for statement the same on that main commit itself,
 * so the growth came with the main features merged since the last measure.
 * Re-measured 2026-11-08 on the foundation branch: 5 452 round trips in 541
 * transactions (cold 5 457 in 542), 281 outbox events: the org's switched-on
 * features are read in a transaction of their own on each app-state reload, so
 * a failed feature read cannot abort the app state read (about one per reload).
 * Re-measured 2026-11-09 on the foundation branch: 5 853 round trips in 543
 * transactions (cold 5 872 in 544, 5 858 on a Linux runner), 323 outbox events:
 * the tier now seeds companies and a deals pipeline, each company and deal
 * written through its product path with its event.
 * Re-measured 2026-11-09 after main's dealer-quote contact (+1 contact create
 * event) merged in: 5 867 round trips in 545 transactions (cold 5 881), 324
 * outbox events; the Linux figure is set 5 above the warm local one, as before.
 * Re-measured 2026-11-10 once each dealer's sales contact is linked to its
 * company: 330 outbox events, the six dealer links each emitting one contact
 * update event (inherent to the links; one write per dealer, nothing per-row
 * to batch).
 * Re-measured 2026-11-10 once contacts carry the country the world places
 * them in: 5 892 round trips in 545 transactions (cold 5 897), 330 outbox
 * events; the Linux figure is set 5 above the warm local one, as before. The
 * countries are written in one statement per contacts batch (one per contact
 * cost 5 926 on Linux), and the round trips also count the dealer links above,
 * whose re-measure left the statement figure as it was.
 * Re-measured 2026-11-11 once a seeded org carries the world company's
 * commercial identity: 5 903 round trips in 547 transactions (cold 5 920 in
 * 548), 330 outbox events. The identity costs two transactions: its read and
 * write in one, and the apply's drift record reading it back. The org pass
 * alone carries the email section; the later passes, which never write it,
 * read it back four more times when they carried it too (5 932 in 553 on
 * Linux).
 */
const BASELINE = {
  outboxEvents: 330,
  queuedJobs: 0,
  attentionEvents: 0,
  notificationDeliveries: 0,
  statements: 5_908,
  transactions: 547,
}
/**
 * Round trips are deterministic up to a few cache reads (5 251-5 262 across
 * runs, cold or warm, alone or concurrent); transactions did not move at all.
 * One more transaction per seeded ticket already fails both.
 */
const STATEMENT_MARGIN = 1.005
const TRANSACTION_SLACK = 2
/**
 * Seeds a launch box's pool refill runs at once in one process:
 * `demoPoolRefillParallelism()` with LIAISON_DEMO_SEED_CONCURRENCY=6.
 */
const POOL_PARALLELISM = 5

interface SeedCost {
  wallMs: number
  cpuMs: number
  statements: number
  transactions: number
  outboxEvents: number
  queuedJobs: number
  attentionEvents: number
  notificationDeliveries: number
}

async function count(orgId: string, query: ReturnType<typeof sql>): Promise<number> {
  return withPrivilegedDb(orgId, "visitor-seed-cost", async (tx) => {
    const result = await tx.execute(query)
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ n: number }>
    return Number(rows[0]?.n ?? 0)
  })
}

async function seedVisitorWorld(): Promise<{ ok: boolean; orgId: string; wallMs: number }> {
  const slug = `demo-cost-${crypto.randomUUID().slice(0, 8)}`
  const t0 = performance.now()
  const seed = await seedDemoOrgData({
    orgSlug: slug,
    orgName: DEMO_COMPANY_NAME,
    variant: "visitor",
    locale: "en",
    owner: {
      email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
      name: "Unclaimed",
      password: "VisitorOwner1!Seed",
    },
    needs: [...DEMO_WORLD_NEEDS.products],
  })
  return { ok: seed.ok, orgId: seed.orgId ?? "", wallMs: Math.round(performance.now() - t0) }
}

async function seedOnce(): Promise<{ orgId: string; cost: SeedCost }> {
  const cpu0 = process.cpuUsage()
  const counter = startStatementCount()
  const { ok, orgId, wallMs } = await seedVisitorWorld()
  const { statements, transactions } = counter.stop()
  const cpu = process.cpuUsage(cpu0)
  expect(ok).toBe(true)
  const queued = await listOrgQueuedJobs(orgId, { scan: 50_000 })
  const cost: SeedCost = {
    wallMs,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    statements,
    transactions,
    outboxEvents: await count(
      orgId,
      sql`SELECT count(*)::int AS n FROM kernel.pending_events WHERE org_id = ${orgId}`,
    ),
    queuedJobs: queued.jobs.length,
    attentionEvents: await count(
      orgId,
      sql`SELECT count(*)::int AS n FROM kernel.attention_events WHERE org_id = ${orgId}`,
    ),
    notificationDeliveries: await count(
      orgId,
      sql`SELECT count(*)::int AS n FROM kernel.notification_deliveries WHERE org_id = ${orgId}`,
    ),
  }
  return { orgId, cost }
}

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-seed-cost-")),
      "apps",
    )
  }
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

interface ConcurrentCost {
  seeds: number
  ok: number
  /** Median wall clock of one seed among POOL_PARALLELISM running together. */
  medianWallMs: number
  statementsPerSeed: number
  transactionsPerSeed: number
}

async function seedConcurrently(n: number): Promise<ConcurrentCost> {
  const counter = startStatementCount()
  const results = await Promise.all(Array.from({ length: n }, () => seedVisitorWorld()))
  const { statements, transactions } = counter.stop()
  const walls = results.map((r) => r.wallMs).sort((a, b) => a - b)
  return {
    seeds: n,
    ok: results.filter((r) => r.ok).length,
    medianWallMs: walls[Math.floor(n / 2)] ?? 0,
    statementsPerSeed: Math.round(statements / n),
    transactionsPerSeed: Math.round(transactions / n),
  }
}

describe("the visitor seed's cost", () => {
  let cold: SeedCost
  let warm: SeedCost
  let concurrent: ConcurrentCost

  beforeAll(async () => {
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    cold = (await seedOnce()).cost
    warm = (await seedOnce()).cost
    concurrent = await seedConcurrently(POOL_PARALLELISM)
    console.log(`[visitor-seed-cost] ${JSON.stringify({ cold, warm, concurrent })}`)
  }, 2_400_000)

  it("makes no more database round trips than the baseline, alone or beside other seeds", () => {
    expect(warm.statements).toBeLessThanOrEqual(BASELINE.statements * STATEMENT_MARGIN)
    expect(warm.transactions).toBeLessThanOrEqual(BASELINE.transactions + TRANSACTION_SLACK)
    expect(concurrent.ok).toBe(POOL_PARALLELISM)
    expect(concurrent.statementsPerSeed).toBeLessThanOrEqual(BASELINE.statements * STATEMENT_MARGIN)
    expect(concurrent.transactionsPerSeed).toBeLessThanOrEqual(
      BASELINE.transactions + TRANSACTION_SLACK,
    )
  })

  it("queues no more work for the api and worker processes than the baseline", () => {
    expect(warm.outboxEvents).toBeLessThanOrEqual(BASELINE.outboxEvents)
    expect(warm.queuedJobs).toBeLessThanOrEqual(BASELINE.queuedJobs)
    expect(warm.attentionEvents).toBeLessThanOrEqual(BASELINE.attentionEvents)
    expect(warm.notificationDeliveries).toBeLessThanOrEqual(BASELINE.notificationDeliveries)
  })
})
