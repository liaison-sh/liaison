// SPDX-License-Identifier: FSL-1.1-ALv2
// 0212_app_versions_rollback: the previous-version and reserved org columns on
// apps_active_version, the persisted problem beside kernel.apps' status, and the
// activation events table (privileged only).
import { afterAll, describe, expect, it } from "bun:test"
import postgres from "postgres"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await sql.end()
})

describe("0212_app_versions_rollback", () => {
  it("adds previous_version and the reserved org_id, one row per (name, org_id) with NULLs equal", async () => {
    const cols = await sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'apps_active_version'
        AND column_name IN ('previous_version', 'org_id') ORDER BY column_name`
    expect(cols.map((c) => [c.column_name, c.is_nullable])).toEqual([
      ["org_id", "YES"],
      ["previous_version", "YES"],
    ])
    const [idx] = await sql`
      SELECT i.indisunique AS unique, i.indnullsnotdistinct AS nulls_not_distinct
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'apps_active_version_name_org_idx'`
    expect(idx).toMatchObject({ unique: true, nulls_not_distinct: true })
  })

  it("persists an app problem beside its status", async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'apps'
        AND column_name IN ('problem_code', 'problem_message') ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual(["problem_code", "problem_message"])
  })

  it("app_activation_events bounds its values and is closed to the request role", async () => {
    const refused = async (reasonMessage: string | null, outcome: string): Promise<string> => {
      try {
        await sql`INSERT INTO kernel.app_activation_events (app, to_version, outcome, actor_kind, reason_message)
          VALUES ('x', '1.0.0', ${outcome}, 'system', ${reasonMessage})`
        return "inserted"
      } catch (err) {
        return (err as { code?: string }).code ?? "error"
      }
    }
    // 23514: check_violation.
    expect(await refused(null, "exploded")).toBe("23514")
    expect(await refused("r".repeat(501), "refused")).toBe("23514")
    const [grant] = await sql`
      SELECT has_table_privilege('liaison_rls', 'kernel.app_activation_events', 'SELECT') AS can_read`
    expect(grant?.can_read).toBe(false)
  })
})
