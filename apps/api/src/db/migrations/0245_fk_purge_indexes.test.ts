// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0245: the foreign-key columns an org purge searches when it deletes their
// parent rows each have an index led by that column, so an ON DELETE action is
// an index lookup instead of a scan of the whole table across every org.
import { describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"

const PURGED_FK_COLUMNS: Array<[schema: string, table: string, column: string]> = [
  ["kernel", "agent_memory", "source_thread_id"],
  ["kernel", "agent_memory", "supersedes_id"],
  ["kernel", "thread_participants", "thread_id"],
  ["app_knowledge", "taggings", "tag_id"],
  ["app_knowledge", "taggings", "created_by"],
  ["kernel", "routines", "report_thread_id"],
  ["kernel", "routines", "output_thread_id"],
  ["kernel", "routines", "created_by_user_id"],
  ["kernel", "routines", "edited_by_user_id"],
  ["app_projects", "tasks", "thread_id"],
  ["app_projects", "tasks", "created_by"],
  ["kernel", "pending_events", "org_id"],
  ["kernel", "user_thread_state", "thread_id"],
  ["app_knowledge", "documents", "created_by"],
  ["app_knowledge", "documents", "verified_by"],
  ["app_knowledge", "documents", "updated_by"],
  ["app_knowledge", "documents", "source_identity_id"],
  ["kernel", "agent_turns", "thread_id"],
  ["kernel", "skills", "created_by_user_id"],
  ["app_tickets", "tickets", "related_ticket_id"],
  ["kernel", "agents", "owner_user_id"],
  ["kernel", "approval_requests", "thread_id"],
  ["kernel", "approval_requests", "originating_thread_id"],
  ["app_knowledge", "collection_memberships", "created_by"],
]

describe("0245 foreign-key purge indexes", () => {
  it("every purged foreign-key column leads an index", async () => {
    const missing = await withSystemDb("test-0245-fk-indexes", async (db) => {
      const out: string[] = []
      for (const [schema, table, column] of PURGED_FK_COLUMNS) {
        const rows = extractRows<{ n: number }>(
          await db.execute(sql`
            SELECT count(*)::int AS n
              FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_namespace ns ON ns.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
             WHERE c.relname = ${table} AND a.attname = ${column}
               AND ns.nspname LIKE ${`%${schema}`}`),
        )
        if ((rows[0]?.n ?? 0) === 0) out.push(`${schema}.${table}.${column}`)
      }
      return out
    })
    expect(missing).toEqual([])
  })
})
