// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0143: the runtime role reads the migration ledger, read only, so /healthz
// reports the real migrationHead instead of pending:0/N on a fully migrated
// database. Runs against the migrated database (`bun run db:migrate` first),
// connected as the app role (DATABASE_URL, liaison_app in the test env); the
// "twice" case replays the file in a transaction that rolls back.
import { afterAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { computeMigrationHead } from "~/modules/healthz"

const MIGRATION = join(import.meta.dir, "0143_migration_ledger_read_grant.sql")

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const priv = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
const app = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => {} })
class Rollback extends Error {}

const onDisk = readdirSync(import.meta.dir).filter((f) => /^\d+_.+\.sql$/.test(f)).length

afterAll(async () => {
  await app.end()
  await priv.end()
})

describe("0143 migration ledger read grant", () => {
  it("lets the app role count the ledger", async () => {
    const [row] = await app<
      { c: number }[]
    >`select count(*)::int as c from drizzle.__drizzle_migrations`
    expect(row!.c).toBe(onDisk)
  })

  it("grants no write on the ledger", async () => {
    const [{ role }] = await app<{ role: string }[]>`select current_user as role`
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      const [row] = await priv<{ ok: boolean }[]>`
        select has_table_privilege(${role}, 'drizzle.__drizzle_migrations', ${p}) as ok`
      expect({ p, ok: row!.ok }).toEqual({ p, ok: false })
    }
  })

  it("makes computeMigrationHead return the SHA-256 head, not pending", async () => {
    expect(await computeMigrationHead()).toMatch(/^[0-9a-f]{64}$/)
  })

  it("applies twice without error", async () => {
    const sql = readFileSync(MIGRATION, "utf8")
    await expect(
      priv.begin(async (tx) => {
        await tx.unsafe(sql)
        await tx.unsafe(sql)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  })
})
