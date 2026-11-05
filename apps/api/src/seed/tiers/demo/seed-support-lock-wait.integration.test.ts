// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The support seed against policy DDL fired in the middle of it.
//
// The ticket seed writes every ticket in ONE privileged transaction. A ticket
// it inserts takes a key-share lock on its category, held to the end of that
// transaction. An app registration running meanwhile (a server's boot, another
// org's registration) re-applies the tickets app's RLS policies, and
// `DROP POLICY ... ON app_tickets.categories` queues for an exclusive lock
// behind the seed. If the seed then reads anything on a SECOND connection (the
// next ticket's category check did), that read queues behind the DDL, which
// waits for the seed's transaction, which waits for the read. Postgres sees no
// cycle (one leg is in the client), so nothing ever ends: the demo box's
// deploy-time seed hung exactly like that.
//
// Here the DDL is fired the moment the seed's transaction holds that lock, and
// a watchdog declares the hang as soon as a connection queues behind the DDL
// while the DDL itself waits (cancelling the DDL so the run still ends). The
// seed must finish with nobody ever queued behind the DDL.
import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import postgres from "postgres"
import { appRegistrationStats } from "~/modules/apps/runtime"
import { seedDemoWorld } from "./seed-demo"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"
import { seedDemoSupport } from "./seed-support"

// A fresh org per run: the race needs the seed to INSERT tickets, and a re-run
// on an org that has them adopts them instead.
const ORG_SLUG = `demo-lock-wait-${Date.now().toString(36)}`
const DB_URL = process.env.DATABASE_URL ?? ""
const BASE_TIME = new Date("2026-09-16T09:00:00.000Z")
/** How long a connection may sit behind the waiting DDL before it is the hang. */
const HANG_AFTER_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-lock-wait-")),
      "apps",
    )
  }
})

interface DdlProbe {
  /** The DDL was fired (the seed's transaction held the category lock). */
  fired: boolean
  /** The DDL waited on the seed's transaction: the race was really set up. */
  waitedOnSeed: boolean
  /** A connection queued behind the waiting DDL for HANG_AFTER_MS. */
  hung: boolean
  stop: () => Promise<void>
}

/**
 * Watch for a transaction holding the FK key-share lock a seeded ticket takes
 * on its category; then run the policy DDL a registration runs, on its own
 * connection, and watch who queues behind it.
 */
function fireDdlWhenSeedHoldsCategories(): DdlProbe {
  const watch = postgres(DB_URL, { max: 1, onnotice: () => {} })
  const ddl = postgres(DB_URL, { max: 1, onnotice: () => {} })
  const probe: DdlProbe = { fired: false, waitedOnSeed: false, hung: false, stop: async () => {} }
  let stopped = false
  const loop = (async () => {
    // The DDL's transaction is opened up front (holding nothing), so the DDL
    // goes out the moment the lock is seen. It drops a REAL policy, as
    // registration does: dropping a missing one never locks the table. It
    // always rolls back.
    let ddlPid = 0
    let go: () => void = () => {}
    const goSignal = new Promise<void>((r) => {
      go = r
    })
    let opened: () => void = () => {}
    const openedSignal = new Promise<void>((r) => {
      opened = r
    })
    let ddlDone = false
    const rollback = new Error("rollback")
    const running = ddl
      .begin(async (t: postgres.TransactionSql) => {
        ddlPid = (await t`SELECT pg_backend_pid() AS pid`)[0]?.pid as number
        opened()
        await goSignal
        if (stopped) throw rollback
        await t.unsafe(`DROP POLICY IF EXISTS "categories_rls_select" ON app_tickets.categories`)
        throw rollback
      })
      .catch(() => {})
      .finally(() => {
        ddlDone = true
      })
    await openedSignal
    try {
      while (!stopped) {
        const holders = await watch`
          SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.relation = to_regclass('app_tickets.categories')
            AND l.mode = 'RowShareLock' AND l.granted
            AND a.datname = current_database() AND l.pid <> pg_backend_pid()
            -- The ticket transaction, not a category insert (a child category's
            -- parent key takes the same lock, in a transaction of its own).
            AND EXISTS (SELECT 1 FROM pg_locks t
              WHERE t.pid = l.pid AND t.granted AND t.mode = 'RowExclusiveLock'
                AND t.relation = to_regclass('app_tickets.tickets'))
          LIMIT 1`
        if (holders.length > 0) break
        await sleep(10)
      }
      if (stopped) return
      probe.fired = true
      go()
      let queuedSince: number | null = null
      while (!ddlDone) {
        const [state] = await watch`
          SELECT cardinality(pg_blocking_pids(${ddlPid}::int)) > 0 AS waiting,
            (SELECT count(*)::int FROM pg_stat_activity
              WHERE ${ddlPid}::int = ANY(pg_blocking_pids(pid))) AS queued`
        if (state?.waiting) probe.waitedOnSeed = true
        if (state?.waiting && Number(state.queued) > 0) {
          queuedSince ??= Date.now()
          if (Date.now() - queuedSince >= HANG_AFTER_MS) {
            probe.hung = true
            // Unblock the run so the test reports instead of hanging.
            await watch`SELECT pg_cancel_backend(${ddlPid}::int)`
            break
          }
        } else {
          queuedSince = null
        }
        await sleep(5)
      }
    } finally {
      go()
      await running
    }
  })()
  probe.stop = async () => {
    stopped = true
    await loop
    await watch.end()
    await ddl.end()
  }
  return probe
}

describe("seedDemoSupport with policy DDL fired mid-seed", () => {
  let org: SeedDemoOrgResult

  beforeAll(async () => {
    org = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "visitor" })
  }, 600_000)

  it("finishes, and nothing it runs ever queues behind the DDL", async () => {
    const probe = fireDdlWhenSeedHoldsCategories()
    try {
      await seedDemoSupport(org, {
        now: BASE_TIME,
        tailored: { parts: new Set(["tickets"]), installedApps: new Set() },
      })
    } finally {
      await probe.stop()
    }
    expect(probe.fired).toBe(true)
    expect(probe.waitedOnSeed).toBe(true)
    expect(probe.hung).toBe(false)
  }, 900_000)

  // The other half: a new org's seed (the visitor path behind the signup)
  // must not re-apply app schema DDL once the schemas are current. The first
  // org above brought them current in this process.
  it("a second org's visitor seed runs no app schema DDL", async () => {
    const before = appRegistrationStats.ddlTransactions
    const world = await seedDemoWorld({
      orgSlug: `${ORG_SLUG}-b`,
      orgName: "Lock Wait B",
      variant: "visitor",
      needs: ["support"],
      baseTime: BASE_TIME,
    })
    expect(world.orgId).toBeTruthy()
    expect(appRegistrationStats.ddlTransactions - before).toBe(0)
  }, 900_000)
})
