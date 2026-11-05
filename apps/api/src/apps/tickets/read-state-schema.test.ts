// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

describe("tickets.read-state.schema", () => {
  it("ticket_reads table exists with PK (ticket_id, user_id)", async () => {
    const rows = extractRows<{ attname: string }>(
      await db.execute(drizzleSql`
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = (SELECT oid FROM pg_class WHERE relname = 'ticket_reads' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app_tickets'))
          AND i.indisprimary
        ORDER BY a.attnum
      `),
    )
    expect(rows.map((r) => r.attname).sort()).toEqual(["ticket_id", "user_id"])
  })

  it("ticket_reads has indexes on (ticket_id, read_at desc) and (user_id, read_at desc)", async () => {
    const rows = extractRows<{ indexname: string }>(
      await db.execute(drizzleSql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'app_tickets' AND tablename = 'ticket_reads'
      `),
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain("ticket_reads_ticket_read_at_idx")
    expect(names).toContain("ticket_reads_user_read_at_idx")
  })

  it("ticket_reads RLS enabled with select + modify-self policies", async () => {
    const rls = extractRows<{ relrowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT relrowsecurity FROM pg_class
        WHERE relname = 'ticket_reads'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app_tickets')
      `),
    )
    expect(rls[0]?.relrowsecurity).toBe(true)
    const pols = extractRows<{ polname: string }>(
      await db.execute(drizzleSql`
        SELECT polname FROM pg_policy
        WHERE polrelid = (SELECT oid FROM pg_class WHERE relname = 'ticket_reads' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app_tickets'))
      `),
    )
    const names = pols.map((r) => r.polname)
    expect(names).toContain("ticket_reads_select")
    expect(names).toContain("ticket_reads_modify_self")
  })
})
