// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Migrations run once under a lease (db/migrate.ts). Every case runs on a
// freshly created empty database, dropped afterwards: replicas that start
// together on a new instance must not both run `0000`, which creates `kernel`
// without IF NOT EXISTS, and the lease itself must not need `kernel`.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import postgres from "postgres"
import { advisoryLockKey } from "~/db/advisory-lock"
import {
  MIGRATION_FENCE_LOCK,
  MIGRATION_LEASE_TABLE,
  runMigrations,
  withMigrationLease,
} from "~/db/migrate"

const ADMIN_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test"
const MIGRATIONS = resolve(import.meta.dir, "../../db/migrations")
const JOURNAL_ENTRIES = (
  JSON.parse(readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: unknown[]
  }
).entries.length

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
const created: string[] = []

async function emptyDatabase(): Promise<string> {
  const name = `migration_lease_${Math.random().toString(36).slice(2, 10)}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  created.push(name)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  return url.toString()
}

afterAll(async () => {
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

async function withDb<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

async function ledgerCount(url: string): Promise<number> {
  return withDb(url, async (sql) => {
    const [row] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    return row?.n ?? -1
  })
}

const quiet = { log: () => {}, migrationsFolder: MIGRATIONS }

describe("migrations under the lease", () => {
  test("runMigrations on an empty database succeeds with the lease", async () => {
    const url = await emptyDatabase()
    await runMigrations(url, quiet)
    expect(await ledgerCount(url)).toBe(JOURNAL_ENTRIES)
    await withDb(url, async (sql) => {
      const [kernel] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'kernel'`
      expect(kernel?.n).toBe(1)
      const [lease] = await sql<{ live: number }[]>`
        SELECT count(*) FILTER (WHERE expires_at > now())::int AS live
          FROM ${sql.unsafe(MIGRATION_LEASE_TABLE)}`
      expect(lease?.live).toBe(0)
    })
  }, 300_000)

  test("two concurrent runMigrations on an empty database apply each migration once and both succeed", async () => {
    const url = await emptyDatabase()
    const order: string[] = []
    const log = (line: string) => order.push(line)
    const results = await Promise.allSettled([
      runMigrations(url, { ...quiet, holder: "runner-a", pollMs: 100, log }),
      runMigrations(url, { ...quiet, holder: "runner-b", pollMs: 100, log }),
    ])
    expect(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual([
      "ok",
      "ok",
    ])
    expect(await ledgerCount(url)).toBe(JOURNAL_ENTRIES)
    // One of them waited for the other.
    expect(order.some((l) => l.includes("waiting"))).toBe(true)
  }, 300_000)

  test("a holder that stops renewing is taken over after the TTL", async () => {
    const url = await emptyDatabase()
    // A crashed holder: its row stays, nobody renews it.
    await withMigrationLease(url, async () => {}, { holder: "setup", log: () => {} })
    await withDb(url, (sql) =>
      sql.unsafe(
        `INSERT INTO ${MIGRATION_LEASE_TABLE} (id, holder, expires_at) VALUES (1, 'crashed', now() + interval '2 seconds')`,
      ),
    )
    const started = Date.now()
    let ran = false
    await withMigrationLease(
      url,
      async () => {
        ran = true
      },
      { holder: "next", pollMs: 100, log: () => {} },
    )
    const waited = Date.now() - started
    expect(ran).toBe(true)
    expect(waited).toBeGreaterThanOrEqual(1_000)
    expect(waited).toBeLessThan(10_000)
  }, 60_000)

  test("a held lease is not taken while its holder renews it", async () => {
    const url = await emptyDatabase()
    let releaseA: () => void = () => {}
    const aHolds = new Promise<void>((r) => {
      releaseA = r
    })
    let aStarted: () => void = () => {}
    const aIn = new Promise<void>((r) => {
      aStarted = r
    })
    const events: string[] = []
    const a = withMigrationLease(
      url,
      async () => {
        events.push("a-start")
        aStarted()
        await aHolds
        events.push("a-end")
      },
      { holder: "a", ttlMs: 1_000, renewMs: 200, log: () => {} },
    )
    await aIn
    const b = withMigrationLease(
      url,
      async () => {
        events.push("b-start")
      },
      { holder: "b", pollMs: 100, log: () => {} },
    )
    // Well past the 1 s TTL: renewals keep it.
    await Bun.sleep(2_500)
    releaseA()
    await Promise.all([a, b])
    expect(events).toEqual(["a-start", "a-end", "b-start"])
  }, 60_000)

  test("a holder whose renew fails twice gives the lease up (exits non-zero by default)", async () => {
    const url = await emptyDatabase()
    const lost: string[] = []
    let calls = 0
    await withMigrationLease(
      url,
      async () => {
        await Bun.sleep(1_000)
      },
      {
        holder: "flaky",
        renewMs: 150,
        log: () => {},
        renew: async () => {
          calls++
          throw new Error("connection reset")
        },
        onLost: (reason) => lost.push(reason),
      },
    )
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toContain("2 renewals")
  }, 60_000)

  test("a renewal that hangs counts as a failure: the lease is given up loudly and the runner never hangs", async () => {
    const url = await emptyDatabase()
    const lost: string[] = []
    const started = Date.now()
    await withMigrationLease(
      url,
      async () => {
        await Bun.sleep(1_500)
      },
      {
        holder: "hung",
        renewMs: 150,
        log: () => {},
        // A renewal stuck on the lease connection: it never answers, and the
        // release queued behind it would wait forever without a bound.
        renew: async (sql) => {
          await sql.unsafe("SELECT pg_sleep(30)")
          return true
        },
        onLost: (reason) => lost.push(reason),
      },
    )
    expect(lost).toHaveLength(1)
    expect(lost[0]).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 60_000)

  test("on a direct connection the migration also waits on a session advisory lock (the fence)", async () => {
    const url = await emptyDatabase()
    // A runner that lost its lease but is still migrating holds the fence.
    const zombie = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await zombie.unsafe("SELECT pg_advisory_lock($1)", [
        String(advisoryLockKey(MIGRATION_FENCE_LOCK)),
      ])
      let done = false
      const run = runMigrations(url, quiet).then(() => {
        done = true
      })
      await Bun.sleep(1_500)
      expect(done).toBe(false)
      await zombie.unsafe("SELECT pg_advisory_unlock_all()")
      await run
      expect(await ledgerCount(url)).toBe(JOURNAL_ENTRIES)
    } finally {
      await zombie.end()
    }
  }, 300_000)

  test("SIGTERM to a runner holding the lease releases it before the process exits", async () => {
    const url = await emptyDatabase()
    const dir = mkdtempSync(join(tmpdir(), "migration-lease-signal-"))
    try {
      const ready = join(dir, "ready")
      const script = join(dir, "hold.ts")
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs"
import { withMigrationLease } from ${JSON.stringify(resolve(import.meta.dir, "../../db/migrate.ts"))}
await withMigrationLease(${JSON.stringify(url)}, async () => {
  writeFileSync(${JSON.stringify(ready)}, "1")
  await new Promise(() => {})
}, { holder: "signalled", releaseOnSignal: true, log: () => {} })
`,
      )
      const child = spawn(process.execPath, [script], { stdio: "ignore" })
      const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)))
      const end = Date.now() + 20_000
      while (Date.now() < end && !existsSync(ready)) await Bun.sleep(50)
      expect(existsSync(ready)).toBe(true)
      child.kill("SIGTERM")
      expect(await exited).toBe(143)
      await withDb(url, async (sql) => {
        const rows = await sql.unsafe(`SELECT holder FROM ${MIGRATION_LEASE_TABLE}`)
        expect(rows.length).toBe(0)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
