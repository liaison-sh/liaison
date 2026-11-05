// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T28: this slice's own migration must be safe to run twice.
//
// Two halves, because two different things can go wrong:
//   1. The LEDGER half: the discovered runner is `bun src/db/migrate.ts`
//      (apps/api package.json, script `db:migrate`). Run twice, the second run
//      must apply NOTHING: drizzle.__drizzle_migrations must hold exactly the
//      same rows afterwards.
//   2. The SQL half: the file's own statements, replayed against a database
//      that already has them, must succeed and leave exactly one column, one
//      constraint and one index behind. This is what the ledger skip would
//      hide, and what a hand-applied hotfix would hit for real.
//
// The privileged DSN follows scripts/db-reset.ts's convention
// (DB_RESET_SUPERUSER_URL, else the compose superuser), because migrations run
// as an owner role and DATABASE_URL is the unprivileged app role.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const MIGRATION_FILE = new URL("./0073_mcp_connections_agent_binding.sql", import.meta.url).pathname
// X11's own migration, covered by the same two halves: the ledger skip and the
// statement replay. A second slice migration is a second chance to ship a
// non-re-runnable statement.
const MIGRATION_FILE_0074 = new URL("./0074_agent_runs_agent_id.sql", import.meta.url).pathname
const API_DIR = new URL("../../..", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const url = privilegedUrl()
const sql = postgres(url, { max: 1, onnotice: () => {} })

afterAll(async () => {
  await sql.end()
})

async function ledgerRowCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
  return row!.n
}

async function catalogShape(): Promise<{ columns: number; constraints: number; indexes: number }> {
  const [row] = await sql<{ columns: number; constraints: number; indexes: number }[]>`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'mcp_connections'
          AND column_name IN ('agent_id', 'mint_scope_snapshot')) AS columns,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conname = 'mcp_connections_agent_org_fk'
          AND connamespace = 'kernel'::regnamespace) AS constraints,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'kernel' AND indexname = 'mcp_connections_agent_idx') AS indexes`
  return row!
}

async function catalogShape0074(): Promise<{
  columns: number
  constraints: number
  indexes: number
}> {
  const [row] = await sql<{ columns: number; constraints: number; indexes: number }[]>`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'agent_runs'
          AND column_name = 'agent_id') AS columns,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conname = 'agent_runs_agent_org_fk'
          AND connamespace = 'kernel'::regnamespace) AS constraints,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'kernel' AND indexname = 'agent_runs_agent_idx') AS indexes`
  return row!
}

async function runMigrateCommand(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "src/db/migrate.ts"], {
    cwd: API_DIR,
    env: { ...process.env, MIGRATION_DATABASE_URL: url, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: out + err }
}

describe("0073_mcp_connections_agent_binding is idempotent", () => {
  it("a second run of the migrate command applies no further migration", async () => {
    const first = await runMigrateCommand()
    expect(first.code).toBe(0)
    const before = await ledgerRowCount()
    const second = await runMigrateCommand()
    expect(second.code).toBe(0)
    expect(await ledgerRowCount()).toBe(before)
    expect(await catalogShape()).toEqual({ columns: 2, constraints: 1, indexes: 1 })
  })

  it("replaying this migration's own statements changes nothing", async () => {
    const statements = readFileSync(MIGRATION_FILE, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    expect(statements.length).toBeGreaterThan(3)
    for (const statement of statements) {
      await sql.unsafe(statement)
    }
    expect(await catalogShape()).toEqual({ columns: 2, constraints: 1, indexes: 1 })
  })
})

describe("0074_agent_runs_agent_id is idempotent", () => {
  it("a second run of the migrate command applies no further migration", async () => {
    const first = await runMigrateCommand()
    expect(first.code).toBe(0)
    const before = await ledgerRowCount()
    const second = await runMigrateCommand()
    expect(second.code).toBe(0)
    expect(await ledgerRowCount()).toBe(before)
    expect(await catalogShape0074()).toEqual({ columns: 1, constraints: 1, indexes: 1 })
  })

  it("replaying this migration's own statements changes nothing", async () => {
    const statements = readFileSync(MIGRATION_FILE_0074, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    expect(statements.length).toBe(3)
    for (const statement of statements) {
      await sql.unsafe(statement)
    }
    expect(await catalogShape0074()).toEqual({ columns: 1, constraints: 1, indexes: 1 })
  })
})
