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
import { demoWorldPack } from "~/seed/worlds/index"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The demo apps shipped as catalog bundles; the others are in-tree. */
const CATALOG_DEMO_APPS = [
  "invoicing",
  "social",
  "pennylane",
  "boxtal",
  "shopify",
  "monitoring",
  "stripe",
  // The oracle layer's headless app, a catalog app on a demo box like the others. Installed here
  // as the demo world test installs it: an app is installed for the whole instance, so a suite run
  // after that file would otherwise see one app more than this file alone.
  "database",
  // The services world signs its client work: its layer seeds agreements when this is installed.
  "agreements",
  // The services world reads its delivery traces: its layer installs the stand-in connection.
  "github",
]

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
 * Re-measured 2026-11-11 with the payments app in the demo catalog: 5 923
 * round trips in 551 transactions (cold 5 942 in 552), 334 outbox events: the
 * app is installed for the org, with its roles and their events. The figure is
 * set 5 above the warm local one, as before.
 * Re-measured 2026-11-11 once the seed stores the apps' attention lists (the
 * Home feed reads only those and runs no app code): 6 532 round trips in 655
 * transactions (cold 6 554 in 656, 6 544 in 656 beside four other seeds), 334
 * outbox events. The lists alone cost 583 round trips in 101 transactions for
 * the world's 8 people (each person's permissions read once for every app),
 * the work the first minute tick would otherwise do; they queue no event.
 * Re-measured 2026-11-14 after main's typed task fields and status transitions
 * and the move of four apps (database, GitLab, Google Drive, the API
 * connector) to the catalog: 6 592 round trips in 639 transactions locally,
 * 6 615 in 644 on a Linux runner, 359 outbox events: one status change event
 * per seeded task (+36), less the role events of the apps that left the
 * in-tree set (-11). The pin is the runner's figure.
 * With the database app installed here as on a demo box (it was only when an
 * earlier file of the suite had installed it): 362 outbox events, its role
 * events (+3), on the runner and locally alike.
 * Re-pinned 2026-11-17 (a working day) to the runner's figure, 6 748 round trips in 659
 * transactions: the agreements app, installed on the instance as on a demo box since that day,
 * took the seed to 6 717-6 723 in 653-654 locally (inside the margin, so the pin stayed), and the
 * runner counts about 25 more than this Mac, which crossed it. The same day's fix round moved
 * nothing here: 6 723 in 654 locally before and after it.
 * 366 outbox events once the agreements app declares its roles (member, lead, admin): their
 * registration events and the Full Member grant (+4); round trips 6 744 in 655, pin unchanged.
 * 369 outbox events once the code host app is installed on the instance as on a demo box (its
 * role registration events, +3); round trips 6 785 in 659, inside the margin, pin unchanged.
 * Re-pinned 2026-11-19 (a working day) to the runner's figure, 6 820 round trips in 659
 * transactions, 369 outbox events. The climb from 6 748 is the agreements roles (+21) and the
 * code host app (+41) above, each inside the margin on this Mac but not on the runner, plus,
 * measured statement by statement on this Mac between two heads of the branch (6 776 to 6 788):
 * each seeded ticket's sent reply stamps the ticket's first response, as the reply service does
 * (+4, one update per reply, kept), and the projects Home answer read the org's time zone twice,
 * once for its due rows and again for its month-close line (+8, one per person). The second read
 * is gone: the month-close line takes the answer's today, so this Mac counts 6 780 in 658. The
 * runner counted 6 808-6 828 on the branch (6 800-6 820 without that read), about half a percent
 * over this Mac, with a spread of about 20 between runs; the pin is the top of that range.
 * Transactions re-pinned the same day on the same ground: this Mac counts 658-659, the runner
 * 662-666 warm across three runs of the branch (the same half percent), so the pin is 666.
 * Re-pinned 2026-11-25 with main's Knowledge pages (Trash, page links, folder pages): this Mac
 * counts 6 836 before that merge and 6 864 after it (+28: each seeded page's links are indexed
 * and stamped), 658 transactions both; the runner counted 6 889 in 663, so the pin is 6 890.
 */
const PRODUCTS_BASELINE = {
  outboxEvents: 369,
  queuedJobs: 0,
  attentionEvents: 0,
  notificationDeliveries: 0,
  statements: 6_890,
  transactions: 666,
}
/**
 * Round trips are deterministic up to a few cache reads (5 251-5 262 across
 * runs, cold or warm, alone or concurrent); transactions did not move at all.
 * One more transaction per seeded ticket already fails both.
 */
/**
 * The software world's visitor seed, measured on its own (no concurrent run):
 * its companies, deals, card mirror, the year's invoices and schedules.
 */
const SAAS_BASELINE = {
  // Measured 2026-11-11: 6 751 round trips in 630 transactions, 466 outbox
  // events (1.14 times the products world); set 5 above, as products is.
  // Re-measured the same day at 6 826 in 644, once the card reminder pinned
  // its own send check (the product's check reads the recipients, their
  // opt-outs and the invoice it is about) and each card invoice's document
  // names the processor invoice it was issued for.
  // Re-measured the same day at 8 172 in 863, 484 outbox events: 6 892 in 644
  // before the attention lists (the Support handover channel and the merges
  // since the last figure), and the lists of the world's 14 people 1 280 in 219.
  // Re-measured 2026-11-14 at 8 049 in 817 locally, 8 102 in 828 on a Linux
  // runner, 507 outbox events: a status change event per seeded task (+35), less
  // the role events of the four apps that moved to the catalog (-12).
  // 510 with the database app installed here as on a demo box (+3 role events).
  // Re-pinned 2026-11-17 to the runner's figure, 8 304 in 852: the agreements app installed on
  // the instance as on a demo box took it to 8 214-8 219 in 836-837 locally (inside the margin),
  // and the runner's usual excess over this Mac (about one percent) crossed it.
  // 514 once the agreements app declares its roles (+4 role events); 8 235 in 837, pin unchanged.
  // Re-pinned 2026-11-18 at 8 443 in 867, 515 outbox events: the demo's app list gained the
  // agreements and code host apps, which this world governs Off; turning the installed
  // agreements app Off writes its row, re-reads each of the 14 people's apps (+208 round trips
  // in 30 transactions) and queues one status event. Rows otherwise unchanged.
  // Re-pinned 2026-11-18 at 8 693 in 902, 519 outbox events, once the code host app is installed
  // on the instance as on a demo box: this world turns it Off as it does agreements (its row
  // and each of the 14 people's apps re-read, +250 round trips in 35 transactions, one status
  // event) and its role registration events (+3). Rows otherwise unchanged.
  // Re-pinned 2026-11-18 to the runner's figure, 8 807 in 922, 519 outbox events: the pin above
  // was this Mac's count, and the runner counts about one percent more round trips and two
  // percent more transactions than this Mac (as on 2026-11-17), which crossed the margin. Nothing
  // the world seeds moved: this Mac measures 8 693-8 698 in 902-903 on the same head.
  outboxEvents: 519,
  queuedJobs: 0,
  attentionEvents: 0,
  notificationDeliveries: 0,
  statements: 8_807,
  transactions: 922,
}
/**
 * The services world's visitor seed, measured on its own: its people and roles,
 * clients, pipeline, seven projects and two closed ones with their tasks, time, plans, cost rates
 * and who is away, every row through the product's writers.
 *
 * Measured 2026-11-13: 10 870 round trips in 1 048 transactions, 351 outbox
 * events; set 5 above. The world's own layer is 3 838 of them in 75
 * transactions (120 tasks through the task writer); the rest is the org,
 * support and agent layers for its 24 people. That is 1.64 times the products
 * world in round trips and 1.62 in transactions, so the products ratio below
 * is not asserted for this world.
 * Re-measured 2026-11-14 once each person enters their own time through the
 * time writer, and finance each cost rate through the rate writer, one entry
 * per transaction, as the product does: 11 540 round trips in 1 106
 * transactions locally, 11 648 in 1 128 on a Linux runner (the pin), 351
 * outbox events; 354 with the database app installed here as on a demo box
 * (+3 role events).
 * Re-measured 2026-11-15 once the world carries its money (an issuer, a year of invoices
 * issued through the invoicing writers, the fixed-price project's quote and billing plan, the
 * retainers' schedules and last month's card) and each client company names its main contact:
 * 12 884 round trips in 1 137 transactions on a Linux runner (the pin), 372 outbox events.
 * Re-measured 2026-11-16 once every client has a billing address and a registry identity (each
 * written by its own writer) and no milestone is drafted before its task is done: 12 946 round
 * trips in 1 151 transactions on a Linux runner on a Sunday, 368 outbox events; 13 090 in
 * 1 175 on the Monday after (the pin, a working day; products 6 668 in 650, software 8 153 in 832).
 * One outbox event more once the finance role is granted the org's shared mailbox: 369.
 * Re-measured 2026-11-17 (a working day) once the world carries its agreements layer: the
 * agreements app installed and enabled, two companies only the agreements name, twelve
 * agreements with their drafts, versions and stand-in signature events, the series counters,
 * the client's mail, the change request card and its conversation, and two past-project notes in
 * Knowledge: 13 412 round trips in 1 205 transactions locally, 376 outbox events (+7). The
 * products and software worlds, with the agreements app now installed on the instance as on a
 * demo box, measured 6 717 in 653 and 8 218 in 837: inside their margins, their pins unchanged.
 * Re-measured 2026-11-17 (the same working day) once the fixed-price client has its portal: two
 * portal people (one transaction each), seven shares through the share writer as the project's
 * lead (one transaction and one `portal_share:opened` event each, plus loading the lead's
 * permissions), the contacts read once, and each seeded invoice stamped with its company from one
 * read of the contacts: 13 521 round trips in 1 223 transactions, 383 outbox events (+7). Products
 * 6 723 in 654 and software 8 214 in 836: inside their margins, their pins unchanged.
 * Re-pinned 2026-11-17 (the same working day) to the runner's figure, 13 682 round trips in
 * 1 250 transactions: 13 538 in 1 224 locally once the portal and agreements fixes landed (+17
 * in 1: the agreements layer opens each agreement's shares as their owner, and the portal shares
 * are read under the sharer's own row security), and the runner counts about one percent more
 * than this Mac. Outbox events unchanged.
 * 388 outbox events once the agreements app declares its roles (+4 role events) and the project
 * lead is given the agreements lead role (+1); 13 618 round trips in 1 227, pin unchanged.
 * Re-pinned 2026-11-18 at 14 144 round trips in 1 274 transactions, 441 outbox events (+526 in
 * 47, +53 events), once the pack seeds its desks and the rest of its day: four desks with their
 * prompts and tools (org layer), five tickets with their thirteen messages and four categories
 * and one handbook note due for review (support layer), three channels and the owner's chat
 * with their messages (threads), and three routines with the Morning brief's thread and text
 * (the world's layer). No job, attention row or delivery is queued.
 * Re-pinned 2026-11-18 at 14 187 round trips in 1 279 transactions, 444 outbox events (+43 in 5,
 * +3 events), once the code host app is installed on the instance as on a demo box: the org
 * layer enables it with its roles (their three registration events), and the world's layer
 * installs its stand-in connection (one transaction, no event).
 * The runner counted that head at 14 326 round trips in 1 304 transactions (this Mac 14 187 in
 * 1 279): its usual excess over this Mac, about one percent in round trips and two in
 * transactions, crossed the margin since the pin above was this Mac's count.
 * Re-pinned 2026-11-18 at 14 526 round trips in 1 322 transactions, 454 outbox events: the
 * runner's figure plus what the two closed past projects add, measured here (14 387 in 1 297,
 * +200 in 18, +10 events): each project created with its statuses, its time switched on and its
 * plan written, its one sign-on task with its comment thread, that task's time entered by its
 * person, and the project archived on the day it closed (created, switched and archived events,
 * and the task's).
 * Re-pinned 2026-11-19 at 14 682 round trips in 1 335 transactions, 467 outbox events: the pin
 * above plus what this change adds, measured here (14 543 in 1 310, +156 in 13, +13 events): the
 * past client's contact with its address and billing identity, its closed audit project with its
 * statuses, three tasks and their threads, archived; the owner's finance role; three standing
 * events on the team calendar; and one update dating the seeded tasks from their first hour.
 */
const STUDIO_BASELINE = {
  outboxEvents: 467,
  queuedJobs: 0,
  attentionEvents: 0,
  notificationDeliveries: 0,
  statements: 14_682,
  transactions: 1_335,
}
const BASELINE = {
  products: PRODUCTS_BASELINE,
  saas: SAAS_BASELINE,
  studio: STUDIO_BASELINE,
} as const
/** No world's seed costs more than this many times the products world's. */
const WORLD_COST_RATIO = 1.5
/**
 * A visitor's world is built around today, and a working day seeds more activity than a weekend:
 * the same code counted 6 620 round trips in 642 transactions for the products world on a Sunday
 * and 6 663 in 649 on the Monday after (the services world 12 941 in 1 150, then 13 085 in 1 174).
 * The baselines are working-day counts and the margins cover the day-to-day swing; a seed that
 * re-reads per row still shows. The clock is not faked: the object store refuses a request signed
 * with a moved clock, and its client keeps the correction for the rest of the process.
 */
const STATEMENT_MARGIN = 1.01
const TRANSACTION_MARGIN = 1.01
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

async function seedVisitorWorld(
  world: keyof typeof BASELINE = "products",
): Promise<{ ok: boolean; orgId: string; wallMs: number }> {
  const slug = `demo-cost-${crypto.randomUUID().slice(0, 8)}`
  const t0 = performance.now()
  const seed = await seedDemoOrgData({
    orgSlug: slug,
    orgName: world === "products" ? DEMO_COMPANY_NAME : demoWorldPack(world).orgName,
    worldId: world,
    variant: "visitor",
    locale: "en",
    owner: {
      email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
      name: "Unclaimed",
      password: "VisitorOwner1!Seed",
    },
    needs: [...DEMO_WORLD_NEEDS[world]],
  })
  return { ok: seed.ok, orgId: seed.orgId ?? "", wallMs: Math.round(performance.now() - t0) }
}

async function seedOnce(
  world: keyof typeof BASELINE = "products",
): Promise<{ orgId: string; cost: SeedCost }> {
  const cpu0 = process.cpuUsage()
  const counter = startStatementCount()
  const { ok, orgId, wallMs } = await seedVisitorWorld(world)
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
    expect(warm.statements).toBeLessThanOrEqual(PRODUCTS_BASELINE.statements * STATEMENT_MARGIN)
    expect(warm.transactions).toBeLessThanOrEqual(
      PRODUCTS_BASELINE.transactions * TRANSACTION_MARGIN,
    )
    expect(concurrent.ok).toBe(POOL_PARALLELISM)
    expect(concurrent.statementsPerSeed).toBeLessThanOrEqual(
      PRODUCTS_BASELINE.statements * STATEMENT_MARGIN,
    )
    expect(concurrent.transactionsPerSeed).toBeLessThanOrEqual(
      PRODUCTS_BASELINE.transactions * TRANSACTION_MARGIN,
    )
  })

  it("queues no more work for the api and worker processes than the baseline", () => {
    expect(warm.outboxEvents).toBeLessThanOrEqual(PRODUCTS_BASELINE.outboxEvents)
    expect(warm.queuedJobs).toBeLessThanOrEqual(PRODUCTS_BASELINE.queuedJobs)
    expect(warm.attentionEvents).toBeLessThanOrEqual(PRODUCTS_BASELINE.attentionEvents)
    expect(warm.notificationDeliveries).toBeLessThanOrEqual(
      PRODUCTS_BASELINE.notificationDeliveries,
    )
  })
})

describe("the software world's visitor seed cost", () => {
  let products: SeedCost
  let saas: SeedCost

  beforeAll(async () => {
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    // Warm both, then measure each alone.
    await seedOnce("saas")
    products = (await seedOnce("products")).cost
    saas = (await seedOnce("saas")).cost
    console.log(`[visitor-seed-cost] ${JSON.stringify({ products, saas })}`)
  }, 2_400_000)

  it("makes no more round trips than its baseline, and queues no job, attention row or delivery", () => {
    expect(saas.statements).toBeLessThanOrEqual(SAAS_BASELINE.statements * STATEMENT_MARGIN)
    expect(saas.transactions).toBeLessThanOrEqual(SAAS_BASELINE.transactions * TRANSACTION_MARGIN)
    expect(saas.outboxEvents).toBeLessThanOrEqual(SAAS_BASELINE.outboxEvents)
    expect([saas.queuedJobs, saas.attentionEvents, saas.notificationDeliveries]).toEqual([0, 0, 0])
  })

  it("costs at most one and a half times the products world in statements and transactions", () => {
    expect(saas.statements).toBeLessThanOrEqual(products.statements * WORLD_COST_RATIO)
    expect(saas.transactions).toBeLessThanOrEqual(products.transactions * WORLD_COST_RATIO)
  })
})

describe("the services world's visitor seed cost", () => {
  let studio: SeedCost

  beforeAll(async () => {
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    // Warm, then measure.
    await seedOnce("studio")
    studio = (await seedOnce("studio")).cost
    console.log(`[visitor-seed-cost] ${JSON.stringify({ studio })}`)
  }, 2_400_000)

  it("makes no more round trips than its baseline, and queues no job, attention row or delivery", () => {
    expect(studio.statements).toBeLessThanOrEqual(STUDIO_BASELINE.statements * STATEMENT_MARGIN)
    expect(studio.transactions).toBeLessThanOrEqual(
      STUDIO_BASELINE.transactions * TRANSACTION_MARGIN,
    )
    expect(studio.outboxEvents).toBeLessThanOrEqual(STUDIO_BASELINE.outboxEvents)
    expect([studio.queuedJobs, studio.attentionEvents, studio.notificationDeliveries]).toEqual([
      0, 0, 0,
    ])
  })
})
