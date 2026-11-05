// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0175 takes TRUNCATE and TRIGGER (both ignore RLS) back from the request role
// on app tables and app-schema default privileges that an older runtime
// registration set to ALL. Replayed inside one transaction that is rolled back.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0175_request_role_app_table_privileges.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

class Rollback extends Error {}

afterAll(async () => {
  await sql.end()
})

describe("0175 request role app table privileges", () => {
  it("revokes TRUNCATE and TRIGGER on app tables and defaults, keeps read/write", async () => {
    const migration = readFileSync(FILE, "utf8")
    let checked = false
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA app_mig0175`)
        await tx.unsafe(`CREATE TABLE app_mig0175.rows (id uuid PRIMARY KEY)`)
        await tx.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA app_mig0175 TO liaison_rls`)
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA app_mig0175 GRANT ALL ON TABLES TO liaison_rls`,
        )
        const [before] = await tx`
          SELECT has_table_privilege('liaison_rls', 'app_mig0175.rows', 'TRUNCATE') AS t`
        expect(before.t).toBe(true)

        await tx.unsafe(migration)
        await tx.unsafe(migration) // re-runnable

        const [after] = await tx`
          SELECT has_table_privilege('liaison_rls', 'app_mig0175.rows', 'SELECT') AS sel,
                 has_table_privilege('liaison_rls', 'app_mig0175.rows', 'DELETE') AS del,
                 has_table_privilege('liaison_rls', 'app_mig0175.rows', 'TRUNCATE') AS trunc,
                 has_table_privilege('liaison_rls', 'app_mig0175.rows', 'TRIGGER') AS trig`
        expect(after).toEqual({ sel: true, del: true, trunc: false, trig: false })

        await tx.unsafe(`CREATE TABLE app_mig0175.later (id uuid PRIMARY KEY)`)
        const [later] = await tx`
          SELECT has_table_privilege('liaison_rls', 'app_mig0175.later', 'SELECT') AS sel,
                 has_table_privilege('liaison_rls', 'app_mig0175.later', 'TRUNCATE') AS trunc,
                 has_table_privilege('liaison_rls', 'app_mig0175.later', 'TRIGGER') AS trig`
        expect(later).toEqual({ sel: true, trunc: false, trig: false })
        checked = true
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })
    expect(checked).toBe(true)
  })
})
