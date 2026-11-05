// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who may touch `kernel.durable_consumer_marks`.
//
// It is worker bookkeeping: every reader and writer of it runs as
// `liaison_admin` (infra/events/consumer-marks.ts through withPrivilegedDb,
// and the outbox worker's own prune, both of which SET LOCAL ROLE
// liaison_admin). FORCE RLS with no policy already hides every row from an
// RLS-context caller, so a grant to `liaison_app` bought nothing and only made
// the table look like something an app-role path was expected to read.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"

const MIGRATION = readFileSync(
  path.join(import.meta.dir, "0089_durable_consumer_marks.sql"),
  "utf8",
)

/**
 * The table's own ACL, one entry per grantee.
 *
 * `has_table_privilege` is the wrong question here: `liaison_app` is a MEMBER
 * of `liaison_admin` in this deployment, so it answers "yes" for everything
 * through inheritance whatever this table grants. What the migration decides,
 * and what this test is about, is whether the table names those roles at all.
 */
async function grantees(): Promise<string[]> {
  const rows = await sql<{ grantee: string }[]>`
    SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'kernel' AND table_name = 'durable_consumer_marks'`
  return [...new Set(rows.map((row) => row.grantee))].sort()
}

async function privilegesOf(role: string): Promise<string[]> {
  const rows = await sql<{ privilege_type: string }[]>`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'kernel' AND table_name = 'durable_consumer_marks'
      AND grantee = ${role}`
  return rows.map((row) => row.privilege_type).sort()
}

describe("the durable consumer marks table's grants", () => {
  it("names liaison_admin in the migration and nobody else", () => {
    const grants = MIGRATION.split("\n").filter((line) => line.trim().startsWith("GRANT"))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toContain("TO liaison_admin")
    expect(grants[0]).not.toContain("liaison_app")
    expect(grants[0]).not.toContain("liaison_rls")
    // And it takes back what the first version of this migration handed out,
    // so a database that already ran it converges on the same grants.
    expect(MIGRATION).toContain("REVOKE ALL ON kernel.durable_consumer_marks FROM liaison_app")
  })

  it("lets the privileged role do its bookkeeping", async () => {
    const privileges = await privilegesOf("liaison_admin")
    for (const privilege of ["SELECT", "INSERT", "DELETE"]) {
      expect(privileges).toContain(privilege)
    }
  })

  it("names neither the app role nor the RLS role", async () => {
    const named = await grantees()
    expect(named).not.toContain("liaison_app")
    expect(named).not.toContain("liaison_rls")
    expect(named).toContain("liaison_admin")
  })
})
