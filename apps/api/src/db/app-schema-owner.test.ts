// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every table in an app schema belongs to the schema's owner (liaison_admin).
// A migration that creates one and forgets `OWNER TO liaison_admin` leaves it
// owned by whoever ran the migration, and the roles that act through
// liaison_admin lose the owner's rights on it: 0198 did that to
// app_mcp_manager.mcp_connection_access, and a whole-database reset
// (TRUNCATE kernel.organizations CASCADE) was refused on it (0238 fixed it).
import { describe, expect, test } from "bun:test"
import { sql } from "~/db"

describe("app schema table ownership", () => {
  test("every table in an app_* schema is owned by its schema's owner", async () => {
    const rows = await sql<{ name: string; owner: string; schemaOwner: string }[]>`
      SELECT n.nspname || '.' || c.relname AS name,
             pg_get_userbyid(c.relowner) AS owner,
             pg_get_userbyid(n.nspowner) AS "schemaOwner"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname LIKE 'app\\_%'
        AND c.relkind IN ('r', 'p')
        AND c.relowner <> n.nspowner
      ORDER BY 1`
    expect(rows.map((r) => `${r.name} (owner ${r.owner}, schema ${r.schemaOwner})`)).toEqual([])
  })

  test("the scan sees the app schemas the migrations create", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app_mcp_manager' AND c.relname = 'mcp_connection_access'`
    expect(row?.n).toBe(1)
  })
})
