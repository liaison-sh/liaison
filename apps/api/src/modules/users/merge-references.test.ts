// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every foreign key to kernel.users has a merge disposition, and every
// disposition names a real foreign key. A new FK to users (a new app table, a
// new kernel column) fails here until someone decides what a placeholder merge
// does with it, instead of the merge's final DELETE cascading or nulling it
// silently (merge-references.ts).
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { USER_FK_DISPOSITION } from "./merge-references"

// Schemas that exist only in the test database (fixture apps), never in a
// deployment: their tables are not the merge's business.
const TEST_ONLY_SCHEMA = /^(app_test|app_example)/

async function catalogUserFks(): Promise<string[]> {
  const kernel = schemaRef("kernel")
  const prefix = kernel.slice(0, kernel.length - "kernel".length)
  // pg_catalog, not information_schema: the information_schema constraint
  // views only show tables the connected role OWNS, and the tests connect as
  // the unprivileged app role, which owns none of them (it saw zero FKs).
  const rows = await sql<Array<{ nsp: string; rel: string; col: string }>>`
    SELECT n.nspname AS nsp, t.relname AS rel, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = ${`${kernel}.users`}::regclass`
  return rows
    .map((r) => ({ ...r, nsp: r.nsp.startsWith(prefix) ? r.nsp.slice(prefix.length) : r.nsp }))
    .filter((r) => !TEST_ONLY_SCHEMA.test(r.nsp))
    .map((r) => `${r.nsp}.${r.rel}.${r.col}`)
    .sort()
}

describe("placeholder merge: foreign keys to kernel.users", () => {
  it("every FK to kernel.users has a disposition", async () => {
    const fks = await catalogUserFks()
    expect(fks.length).toBeGreaterThan(20)
    const unhandled = fks.filter((k) => !(k in USER_FK_DISPOSITION))
    expect(unhandled).toEqual([])
  })

  it("every disposition names a foreign key that exists", async () => {
    const fks = new Set(await catalogUserFks())
    const stale = Object.keys(USER_FK_DISPOSITION).filter((k) => !fks.has(k))
    expect(stale).toEqual([])
  })

  it("never re-points a credential or a role to another person", () => {
    for (const key of [
      "kernel.sessions.user_id",
      "kernel.oauth_accounts.user_id",
      "kernel.user_roles.user_id",
      "kernel.password_resets.user_id",
    ]) {
      expect(USER_FK_DISPOSITION[key]?.kind).toBe("cascade")
    }
  })
})
