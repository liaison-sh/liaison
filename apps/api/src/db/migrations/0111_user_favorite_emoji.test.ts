// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S16: 0111 adds `favorite_emoji` to kernel.user_preferences, the reaction
// picker's favourites row. The live table is already migrated when this runs,
// so the file is replayed against a SCRATCH copy of the pre-migration table in
// its own schema: the statements are the file's own, only the schema name is
// swapped (push-tokens-environment.test.ts's recipe).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0111_user_favorite_emoji.sql", import.meta.url).pathname
const SCRATCH = "mig0111_fav_emoji"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

function migrationText(): string {
  return readFileSync(FILE, "utf8")
    .replaceAll("kernel.user_preferences", `${SCRATCH}.user_preferences`)
    .replaceAll("'kernel'", `'${SCRATCH}'`)
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationText().split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await sql.unsafe(statement)
  }
}

describe("0111 user_preferences.favorite_emoji", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${SCRATCH}`)
    await sql.unsafe(`CREATE TABLE ${SCRATCH}.user_preferences (
      user_id uuid PRIMARY KEY,
      theme text NOT NULL DEFAULT 'system')`)
    await sql.unsafe(
      `INSERT INTO ${SCRATCH}.user_preferences (user_id) VALUES ('00000000-0000-0000-0000-000000000001')`,
    )
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`)
    await sql.end()
  })

  it("adds a nullable jsonb column, existing rows read NULL (the default 9)", async () => {
    await applyMigration()
    const [col] = await sql.unsafe<{ data_type: string; is_nullable: string }[]>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = '${SCRATCH}' AND table_name = 'user_preferences'
          AND column_name = 'favorite_emoji'`,
    )
    expect(col).toEqual({ data_type: "jsonb", is_nullable: "YES" })
    const [row] = await sql.unsafe<{ favorite_emoji: unknown }[]>(
      `SELECT favorite_emoji FROM ${SCRATCH}.user_preferences`,
    )
    expect(row.favorite_emoji).toBeNull()
  })

  it("stores an array and refuses any other JSON shape", async () => {
    await sql.unsafe(`UPDATE ${SCRATCH}.user_preferences SET favorite_emoji = '["👍","🚀"]'::jsonb`)
    let refused = ""
    try {
      await sql.unsafe(`UPDATE ${SCRATCH}.user_preferences SET favorite_emoji = '{"a":1}'::jsonb`)
    } catch (err) {
      refused = String((err as Error).message)
    }
    expect(refused).toContain("user_preferences_favorite_emoji_array")
  })

  it("is re-runnable", async () => {
    await applyMigration()
    const [row] = await sql.unsafe<{ favorite_emoji: string[] }[]>(
      `SELECT favorite_emoji FROM ${SCRATCH}.user_preferences`,
    )
    expect(row.favorite_emoji).toEqual(["👍", "🚀"])
  })
})
