// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Drops and recreates the target database, ensures roles exist, then runs migrations.
 *
 * Usage:
 *   bun run db:reset          # resets liaison_dev
 *   bun run db:reset:test     # resets the test database the env is configured for
 *
 * `test` never assumes `liaison_test`: the name comes from the DB URL env vars (DATABASE_URL,
 * E2E_DATABASE_URL, MIGRATION_DATABASE_URL_TEST, ...; see test-db-target.ts), so a run pointed at
 * a private database resets that one and never the shared one. Variables that disagree, or a
 * caller expecting another database (LIAISON_RESET_EXPECT_DB), stop the reset before anything is
 * dropped.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "bun"
import {
  assertResetTarget,
  RESET_EXPECT_DB_VAR,
  resolveTestDb,
  serverBaseUrl,
  TestDbTargetError,
} from "../packages/test-helpers/src/test-db-target"
import { ABANDONED_STASH_QUERY, formatAbandonedStashReport } from "./lib/fixture-stashes"

const TARGETS: Record<string, string> = {
  dev: "liaison_dev",
  test: "liaison_test",
  // Isolated test DB for local parallel test runs — kept separate from the
  // shared liaison_test DB so a reset here never disturbs concurrent work.
  hardening: "liaison_hardening_test",
  // A throwaway target for driven walks of the desktop shell on this Mac, never shared.
  walk: "liaison_walk",
}

const ROOT = join(import.meta.dir, "..")
const readIf = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")

const target = process.argv[2] ?? "dev"
let dbName = TARGETS[target]
if (!dbName) {
  console.error(`Unknown target "${target}". Valid: ${Object.keys(TARGETS).join(", ")}`)
  process.exit(1)
}
try {
  if (target === "test") {
    const resolved = resolveTestDb({
      env: process.env,
      envTestText: readIf(join(ROOT, ".env.test")),
      rootEnvText: readIf(join(ROOT, ".env")),
    })
    dbName = resolved.name
    console.log(`Test database: ${dbName} (from ${resolved.sources.join(", ")})`)
  }
  assertResetTarget(dbName, process.env[RESET_EXPECT_DB_VAR])
} catch (err) {
  if (!(err instanceof TestDbTargetError)) throw err
  console.error(`db-reset: ${err.message}`)
  process.exit(1)
}

// Connect over TCP to the (dockerized) Postgres superuser. The previous bare
// `psql -d <db>` relied on a local unix socket + peer auth, which does not
// exist when Postgres runs in Docker — psql then failed with an opaque
// "/tmp/.s.PGSQL.5432: No such file or directory". Override via
// DB_RESET_SUPERUSER_URL if your cluster differs.
// A URL that names a database is accepted too: only its server part is used.
const SUPERUSER_BASE = serverBaseUrl(
  process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432",
)

async function psql(db: string, sql: string, extraArgs: string[] = []): Promise<string> {
  // PGCONNECT_TIMEOUT bounds a hung/unreachable Postgres so this fails in
  // seconds with a clear error instead of hanging indefinitely.
  const proc = spawn(
    ["psql", `${SUPERUSER_BASE}/${db}`, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-c", sql],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
    },
  )
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    // Ignore harmless notices
    if (!err.includes("NOTICE") && !err.includes("does not exist")) {
      throw new Error(
        `psql failed connecting to ${SUPERUSER_BASE}/${db} (exit ${code}): ${err.trim()}\n` +
          `If Postgres runs in Docker, ensure it is up ('docker compose ps') and ` +
          `that DB_RESET_SUPERUSER_URL matches docker-compose.yml.`,
      )
    }
  }
  return out
}

console.log(`Resetting ${dbName}...`)

// Fixture stash report. The DROP DATABASE below takes these schemas with
// everything else, so there is nothing here to sweep; what an operator needs is
// to be TOLD that the database was in that state, which the old sweep's RAISE
// WARNING never managed (psql's stderr was read only on a non-zero exit).
const stashReport = formatAbandonedStashReport(
  await psql(dbName, ABANDONED_STASH_QUERY, ["-t", "-A"]),
)
if (stashReport) console.log(stashReport)

// Terminate connections + drop + create
// Connect to template1 (always exists) to avoid "connected to target DB" issues
await psql(
  "template1",
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid!=pg_backend_pid()`,
)
await psql("template1", `DROP DATABASE IF EXISTS ${dbName}`)
await psql("template1", `CREATE DATABASE ${dbName}`)

// Ensure liaison_app and liaison_rls roles exist (cluster-level, survive DB drops)
await psql(
  dbName,
  `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='liaison_app') THEN CREATE ROLE liaison_app LOGIN PASSWORD 'liaison_app'; END IF; END $$`,
)
await psql(
  dbName,
  `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='liaison_rls') THEN CREATE ROLE liaison_rls NOBYPASSRLS; END IF; END $$`,
)
await psql(dbName, `GRANT ALL ON DATABASE ${dbName} TO liaison_app`)
await psql(dbName, `GRANT liaison_rls TO liaison_app`)

// Test/hardening clusters only: ~132 unit fixtures seed kernel.organizations
// directly over the bare `sql` connection (role liaison_app, no SET ROLE),
// which requires that connection to bypass RLS. liaison_app is NOBYPASSRLS by
// default and stays that way for `dev` (mirroring prod); grant BYPASSRLS on the
// test targets only. Without this, a freshly-reset cluster fails the whole unit
// suite with "new row violates row-level security policy for table
// organizations" (the parallel-worker path in test-helpers/src/db.ts sets this
// for cloned schemas, but the flat suite never runs it). BYPASSRLS is a
// cluster-level role attribute, so a plain ALTER (re-applied every reset) is
// idempotent and survives DB drops.
if (target !== "dev") {
  await psql(dbName, `ALTER ROLE liaison_app BYPASSRLS`)
}

// Run migrations over the same TCP superuser connection (consistent with the
// psql calls above — never the unavailable local socket).
const migrationEnv = { MIGRATION_DATABASE_URL: `${SUPERUSER_BASE}/${dbName}` }

const proc = spawn(["bun", "run", "db:migrate"], {
  cwd: process.cwd(),
  env: { ...process.env, ...migrationEnv },
  stdout: "inherit",
  stderr: "inherit",
})
const code = await proc.exited
if (code !== 0) process.exit(code)

console.log(`${dbName} reset complete.`)
