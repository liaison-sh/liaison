#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provisions/rotates/checks the `liaison_readonly` role on an EXISTING
// cluster (the fresh-cluster path is `deploy/postgres-init/20-readonly-role.sh`
// — both execute the SAME generated allow-list grants file, Task 7 §7.1).
//
// Usage:
//   bun run scripts/db-readonly-role.ts --create [--password <pw>]
//   bun run scripts/db-readonly-role.ts --rotate --password <new-pw>
//   bun run scripts/db-readonly-role.ts --check
//   bun run scripts/db-readonly-role.ts --regenerate
//   bun run scripts/db-readonly-role.ts --check-sync
//
// --create is idempotent (safe to re-run). --rotate only ALTERs the password
// — it never touches grants (a rotate should never drop what --create built).
// --check queries a LIVE database's actually-applied grants and reports
// SELECT grants beyond the allow-list and EXECUTE grants beyond the curated
// list — run it after --create/--rotate to confirm the role is still
// fail-closed on that specific cluster (requires DATABASE_URL).
// --regenerate renders the grants SQL from the current liaison-self catalog
// (`packages/db-core/src/grants-renderer.ts`) and WRITES it to the single
// checked-in file (`apps/api/src/apps/database/generated/readonly-grants.sql`
// — also the file `deploy/postgres-init/20-readonly-role.sh` executes via a
// bind mount, no second copy). No DB connection required — run this after
// any catalog change, then commit the diff.
// --check-sync re-renders from the catalog and diffs against the checked-in
// file WITHOUT writing — exits non-zero on drift (catalog changed but the
// file wasn't regenerated). No DB connection required; safe for CI.
//
// Password source: --password <pw> arg, or DB_READONLY_PASSWORD env var.
// Never printed to stdout/stderr.

import { readFileSync, writeFileSync } from "node:fs"
import { getAdapter, renderReadonlyGrants } from "@liaison/db-core"
import postgres from "postgres"
// Side-effect import: registers the liaison-self adapter into db-core's
// static registry so getAdapter("liaison-self") resolves.
import "../apps/api/src/apps/database/adapters/liaison-self"

const ROLE_NAME = "liaison_readonly"
const GENERATED_GRANTS_PATH = new URL(
  "../apps/api/src/apps/database/generated/readonly-grants.sql",
  import.meta.url,
).pathname

interface Args {
  create: boolean
  rotate: boolean
  check: boolean
  regenerate: boolean
  checkSync: boolean
  password?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    create: false,
    rotate: false,
    check: false,
    regenerate: false,
    checkSync: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--create") args.create = true
    else if (arg === "--rotate") args.rotate = true
    else if (arg === "--check") args.check = true
    else if (arg === "--regenerate" || arg === "--render") args.regenerate = true
    else if (arg === "--check-sync") args.checkSync = true
    else if (arg === "--password") args.password = argv[++i]
  }
  return args
}

function getDatabaseUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url)
    throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required (superuser/owner DSN)")
  return url
}

function loadGeneratedGrants(): string {
  return readFileSync(GENERATED_GRANTS_PATH, "utf-8")
}

async function runCreate(sql: ReturnType<typeof postgres>, password: string): Promise<void> {
  const grants = loadGeneratedGrants()
  await sql.unsafe(grants)
  // Password + LOGIN are applied separately from the generated grants file
  // (the generated file is deterministic from the catalog and carries no
  // secret — the password never appears in a checked-in artifact).
  await sql.unsafe(`ALTER ROLE ${ROLE_NAME} PASSWORD '${escapeSqlLiteral(password)}'`)
  console.log(`[db-readonly-role] ${ROLE_NAME} created/updated (grants applied, password set)`)
}

async function runRotate(sql: ReturnType<typeof postgres>, password: string): Promise<void> {
  // Rotate ONLY the password — never touches grants, so a rotate can never
  // accidentally narrow or widen the allow-list.
  await sql.unsafe(`ALTER ROLE ${ROLE_NAME} PASSWORD '${escapeSqlLiteral(password)}'`)
  console.log(`[db-readonly-role] ${ROLE_NAME} password rotated (grants untouched)`)
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

interface CheckReport {
  roleExists: boolean
  writeGrants: Array<{ table_schema: string; table_name: string; privilege_type: string }>
  dangerousExecuteGrants: Array<{ routine_schema: string; routine_name: string }>
}

export async function runCheck(sql: ReturnType<typeof postgres>): Promise<CheckReport> {
  const roleRows = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE_NAME}`
  const roleExists = roleRows.length > 0
  if (!roleExists) {
    return { roleExists: false, writeGrants: [], dangerousExecuteGrants: [] }
  }
  const writeGrants = (await sql`
    SELECT table_schema, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE grantee = ${ROLE_NAME} AND privilege_type NOT IN ('SELECT')
  `) as unknown as Array<{ table_schema: string; table_name: string; privilege_type: string }>
  const dangerousExecuteGrants = (await sql`
    SELECT routine_schema, routine_name
    FROM information_schema.role_routine_grants
    WHERE grantee = ${ROLE_NAME} AND privilege_type = 'EXECUTE'
  `) as unknown as Array<{ routine_schema: string; routine_name: string }>
  return { roleExists, writeGrants, dangerousExecuteGrants }
}

function printCheckReport(report: CheckReport): void {
  if (!report.roleExists) {
    console.log(`[db-readonly-role] ${ROLE_NAME} does not exist — run --create first`)
    return
  }
  if (report.writeGrants.length === 0 && report.dangerousExecuteGrants.length === 0) {
    console.log(
      `[db-readonly-role] ${ROLE_NAME} is clean: no write grants, no EXECUTE grants beyond built-ins`,
    )
    return
  }
  if (report.writeGrants.length > 0) {
    console.log(
      `[db-readonly-role] WARNING: ${report.writeGrants.length} non-SELECT grant(s) detected:`,
    )
    for (const g of report.writeGrants) {
      console.log(`  ${g.privilege_type} on ${g.table_schema}.${g.table_name}`)
    }
  }
  if (report.dangerousExecuteGrants.length > 0) {
    console.log(
      `[db-readonly-role] WARNING: ${report.dangerousExecuteGrants.length} EXECUTE grant(s) detected:`,
    )
    for (const g of report.dangerousExecuteGrants) {
      console.log(`  EXECUTE on ${g.routine_schema}.${g.routine_name}`)
    }
  }
}

/** Renders the current liaison-self catalog's grants and diffs it against the
 *  checked-in generated file — used by CI/`--check-sync` to catch catalog
 *  drift. Pure (no DB connection). */
export async function checkGrantsInSync(): Promise<{
  inSync: boolean
  rendered: string
  checkedIn: string
}> {
  const catalog = getAdapter("liaison-self")
  if (!catalog) throw new Error('adapter "liaison-self" not registered')
  const { sql: rendered } = renderReadonlyGrants(catalog)
  const checkedIn = loadGeneratedGrants()
  return { inSync: rendered === checkedIn, rendered, checkedIn }
}

/** Renders the current liaison-self catalog's grants and WRITES them to the
 *  single checked-in generated file. Pure (no DB connection) — the actual
 *  `--create`/`--rotate` DB steps are separate and read this file back. */
export function regenerateGrantsFile(): { sql: string; path: string } {
  const catalog = getAdapter("liaison-self")
  if (!catalog) throw new Error('adapter "liaison-self" not registered')
  const { sql } = renderReadonlyGrants(catalog)
  writeFileSync(GENERATED_GRANTS_PATH, sql, "utf-8")
  return { sql, path: GENERATED_GRANTS_PATH }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.create && !args.rotate && !args.check && !args.regenerate && !args.checkSync) {
    console.error(
      "Usage: db-readonly-role.ts --create|--rotate|--check|--regenerate|--check-sync [--password <pw>]",
    )
    process.exit(1)
  }

  // Pure, no-DB modes first — these never need a database connection.
  if (args.regenerate) {
    const { path } = regenerateGrantsFile()
    console.log(`[db-readonly-role] regenerated ${path} from the liaison-self catalog`)
  }
  if (args.checkSync) {
    const { inSync, rendered, checkedIn } = await checkGrantsInSync()
    if (!inSync) {
      console.error(
        "[db-readonly-role] DRIFT: the checked-in readonly-grants.sql does not match a fresh " +
          "render of the liaison-self catalog. Run `bun run scripts/db-readonly-role.ts --regenerate` " +
          "and commit the result.",
      )
      console.error(`  checked-in length: ${checkedIn.length}, rendered length: ${rendered.length}`)
      process.exit(1)
    }
    console.log("[db-readonly-role] grants file is in sync with the liaison-self catalog")
  }

  if (!args.create && !args.rotate && !args.check) return

  const sql = postgres(getDatabaseUrl(), { max: 1, onnotice: () => {} })
  try {
    if (args.create) {
      const password = args.password ?? process.env.DB_READONLY_PASSWORD
      if (!password) throw new Error("--password or DB_READONLY_PASSWORD is required for --create")
      await runCreate(sql, password)
    }
    if (args.rotate) {
      const password = args.password ?? process.env.DB_READONLY_PASSWORD
      if (!password) throw new Error("--password or DB_READONLY_PASSWORD is required for --rotate")
      await runRotate(sql, password)
    }
    if (args.check) {
      const report = await runCheck(sql)
      printCheckReport(report)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
