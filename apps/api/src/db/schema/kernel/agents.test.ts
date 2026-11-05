// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

describe("AGENTS TABLE", () => {
  it("kernel.agents exists with FORCE RLS enabled", async () => {
    const rows = extractRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel' AND c.relname = 'agents'
      `),
    )

    expect(rows.length).toBe(1)
    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].relforcerowsecurity).toBe(true)
  })
})
