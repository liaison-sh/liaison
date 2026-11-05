// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11: 0107 adds `environment` to kernel.push_tokens and marks every iOS row
// that already exists as `sandbox` (each one came from an Xcode build). The
// live table is already migrated when this runs, so the file is replayed
// against a SCRATCH copy of the pre-migration table in its own schema: the
// statements are the file's own, only the schema name is swapped.
//
// The privileged DSN follows migration-idempotency-4a.test.ts: migrations run
// as an owner role and DATABASE_URL is the unprivileged app role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0107_push_tokens_environment.sql", import.meta.url).pathname
const SCRATCH = "mig0107_push_env"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

/** The migration's statements, pointed at the scratch schema. */
function migrationText(): string {
  return readFileSync(FILE, "utf8")
    .replaceAll("kernel.push_tokens", `${SCRATCH}.push_tokens`)
    .replaceAll("'kernel'", `'${SCRATCH}'`)
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationText().split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

describe("0107 push_tokens.environment", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.push_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform text NOT NULL,
      token text NOT NULL)`)
    await sql.unsafe(`INSERT INTO ${SCRATCH}.push_tokens (platform, token)
      VALUES ('ios', 'xcode-ios'), ('android', 'fcm-android')`)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("existing ios rows become sandbox, android rows stay production", async () => {
    await applyMigration()
    const rows = await sql.unsafe<{ token: string; environment: string }[]>(
      `SELECT token, environment FROM ${SCRATCH}.push_tokens ORDER BY token`,
    )
    expect([...rows]).toEqual([
      { token: "fcm-android", environment: "production" },
      { token: "xcode-ios", environment: "sandbox" },
    ])
  })

  it("a new row defaults to production and an unknown environment is refused", async () => {
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.push_tokens (platform, token) VALUES ('ios', 'new-ios')`,
    )
    const [row] = await sql.unsafe<{ environment: string }[]>(
      `SELECT environment FROM ${SCRATCH}.push_tokens WHERE token = 'new-ios'`,
    )
    expect(row.environment).toBe("production")
    let refused = ""
    try {
      await sql.unsafe(
        `INSERT INTO ${SCRATCH}.push_tokens (platform, token, environment) VALUES ('ios', 'x', 'staging')`,
      )
    } catch (err) {
      refused = String(err)
    }
    expect(refused).toContain("push_tokens_environment_check")
  })

  it("a replay changes nothing: a production ios row is not flipped back to sandbox", async () => {
    await applyMigration()
    const [row] = await sql.unsafe<{ environment: string }[]>(
      `SELECT environment FROM ${SCRATCH}.push_tokens WHERE token = 'new-ios'`,
    )
    expect(row.environment).toBe("production")
    const [constraints] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = '${SCRATCH}.push_tokens'::regclass AND contype = 'c'`,
    )
    expect(constraints.n).toBe(1)
  })
})
