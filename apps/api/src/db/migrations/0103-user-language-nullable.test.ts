// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A user who never chose a UI language has none. The column's NOT NULL 'en'
// default outranked the org default locale for every such user, so a French
// org read an English UI. 0101 drops the default and the NOT NULL, and must
// NOT rewrite a stored value: 'fr' is always a choice, and a stored 'en'
// cannot be told apart from a deliberate English choice.
//
// Replayed against real rows over the privileged DSN (same convention as
// 0100's test), so the replay also proves the file is idempotent.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const MIGRATION = new URL("./0103_user_language_nullable.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

const orgId = crypto.randomUUID()
const tag = Date.now().toString(36)
const users = {
  chose: crypto.randomUUID(),
  defaulted: crypto.randomUUID(),
  fresh: crypto.randomUUID(),
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug, default_locale)
            VALUES (${orgId}, ${`Lang ${tag}`}, ${`lang-${tag}`}, 'fr')`
  for (const [k, id] of Object.entries(users)) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
              VALUES (${id}, ${orgId}, ${`${k}-${tag}@test.local`}, ${k})`
  }
  await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${users.chose}, 'fr')`
  await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${users.defaulted}, 'en')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_preferences WHERE user_id IN ${sql(Object.values(users))}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  await sql.end()
})

async function languageOf(id: string): Promise<string | null> {
  const [row] = await sql<{ language: string | null }[]>`
    SELECT language FROM kernel.user_preferences WHERE user_id = ${id}`
  return row!.language
}

describe("0101: a user who never chose a language has none", () => {
  it("replays cleanly and leaves the column nullable with no default", async () => {
    await sql.unsafe(readFileSync(MIGRATION, "utf-8").replaceAll("--> statement-breakpoint", ""))
    const [col] = await sql<{ column_default: string | null; is_nullable: string }[]>`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'user_preferences' AND column_name = 'language'`
    expect(col).toEqual({ column_default: null, is_nullable: "YES" })
  })

  it("a row created without a language stores NULL, not 'en'", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id) VALUES (${users.fresh})`
    expect(await languageOf(users.fresh)).toBeNull()
  })

  it("never rewrites a stored value", async () => {
    expect(await languageOf(users.chose)).toBe("fr")
    expect(await languageOf(users.defaulted)).toBe("en")
  })
})
