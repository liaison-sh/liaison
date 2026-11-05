// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0213: the application roles keep USAGE on `public`, where pg_trgm lives, on
// a database whose public schema lost the default grant to PUBLIC (a restore,
// hardening). Without it the memory consolidation dedupe query fails as the
// privileged role with `similarity(text, unknown) does not exist`.
//
// Everything runs in ONE transaction on one superuser connection and is rolled
// back: the revoke is never visible to any other session, so tests sharing this
// database are unaffected and nothing needs restoring.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0213_public_schema_usage.sql", import.meta.url).pathname

const ROLES = [
  "liaison_app",
  "liaison_admin",
  "liaison_definer",
  "liaison_readonly",
  "liaison_request",
  "liaison_rls",
  "liaison_schema_admin",
]

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

/** The consolidation fact dedupe query, with ordinary string parameters. */
const DEDUPE = `SELECT id, name FROM kernel.agent_memory
  WHERE org_id = $1 AND owner_agent_id = $2
    AND type NOT IN ('episode', '_index')
    AND superseded_at IS NULL
    AND (name = $3 OR similarity(description, $4) >= $5)
  ORDER BY (name = $6) DESC, similarity(description, $7) DESC
  LIMIT 1`

const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await conn.end()
})

class Rollback extends Error {}

describe("0213 public schema usage", () => {
  it("the dedupe query fails as the privileged role once public lost PUBLIC usage, and passes after the migration", async () => {
    const outcome: { before?: string; after?: number } = {}
    await conn
      .begin(async (tx) => {
        const existing = (
          await tx.unsafe<{ rolname: string }[]>(
            "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1)",
            [ROLES],
          )
        ).map((r) => r.rolname)
        expect(existing).toContain("liaison_admin")
        // The failing database: public's ACL holds only its owner.
        await tx.unsafe(
          `REVOKE USAGE ON SCHEMA public FROM PUBLIC, ${existing.map((r) => `"${r}"`).join(", ")}`,
        )
        const id = crypto.randomUUID()
        const params = [id, id, "carrier-cutoff", "Carrier pickup cutoff is 4pm", 0.8]
        const run = async () => {
          await tx.unsafe("SAVEPOINT q")
          try {
            await tx.unsafe("SET LOCAL ROLE liaison_admin")
            const rows = await tx.unsafe(DEDUPE, [...params, params[2], params[3]] as never[])
            return rows.length
          } finally {
            await tx.unsafe("ROLLBACK TO SAVEPOINT q")
            await tx.unsafe("RESET ROLE")
          }
        }
        try {
          await run()
          outcome.before = "passed"
        } catch (err) {
          outcome.before = (err as Error).message
        }
        await tx.unsafe(readFileSync(FILE, "utf8"))
        outcome.after = await run()
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })
    expect(outcome.before).toBe("function similarity(text, unknown) does not exist")
    expect(outcome.after).toBe(0)
  })
})
