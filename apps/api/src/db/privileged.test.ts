// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"

describe("withPrivilegedDb", () => {
  let withPrivilegedDb: typeof import("~/db/privileged").withPrivilegedDb

  const setup = async () => {
    const mod = await import("~/db/privileged")
    withPrivilegedDb = mod.withPrivilegedDb
  }

  it("sets app.current_org_id GUC within transaction", async () => {
    await setup()
    const orgId = "00000000-0000-0000-0000-ffffffffffff"
    const result = await withPrivilegedDb(orgId, "test-guc", async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT current_setting('app.current_org_id', true) as org_id`,
      )
      return row
    })
    expect(result.org_id).toBe("00000000-0000-0000-0000-ffffffffffff")
  })

  it("GUC is NOT visible after transaction completes", async () => {
    await setup()
    const orgId = "00000000-0000-0000-0000-aaaaaaaaaa01"
    await withPrivilegedDb(orgId, "test-isolation", async () => {})

    const [row] = await sql`SELECT current_setting('app.current_org_id', true) as org_id`
    // Not leaked: either "" (tx-local set_config reset) or null (withPrivilegedDb runs on its OWN
    // dedicated pool now — BL-131 — so this main-pool connection never had the GUC set at all).
    expect(row.org_id ?? "").toBe("")
  })

  it("rolls back on error", async () => {
    await setup()
    expect.assertions(1)
    try {
      await withPrivilegedDb("org-x", "test-rollback", async () => {
        throw new Error("deliberate failure")
      })
    } catch (e: any) {
      expect(e.message).toBe("deliberate failure")
    }
  })

  it("returns the callback result", async () => {
    await setup()
    const result = await withPrivilegedDb("org-y", "test-return", async () => 42)
    expect(result).toBe(42)
  })

  it("acquire-timeout safety net: fails FAST (does NOT hang) when the privileged pool is exhausted", async () => {
    // BL-131 — the root fix is the DEDICATED privileged pool (withPrivilegedDb no longer competes
    // with the RLS pool). This test exercises the remaining safety net: if the PRIVILEGED pool is
    // itself exhausted, the acquire-timeout must fail FAST (loud, surfaced) rather than hang to the
    // 300s sandbox ceiling. Hold every privileged-pool slot via a RAW transaction on that pool (NOT
    // through withPrivilegedDb, so the hogs are not subject to the acquire-timeout under test), then
    // request one more. Without the bound it would queue forever; with it, fast reject.
    // Self-contained: the test builds its own two-slot pool through the app's pool factory and
    // asks for a 300 ms acquire timeout, so the result never depends on DB_PRIVILEGED_POOL_MAX,
    // DB_POOL_MAX or DB_ACQUIRE_TIMEOUT_MS in the launch env.
    const { createPool } = await import("~/db/connection")
    await setup()
    const pool = createPool(2)
    const holders: Array<{ resolve: () => void }> = []
    const held = Array.from({ length: 2 }, () =>
      pool.db.transaction(async () => {
        await new Promise<void>((resolve) => holders.push({ resolve }))
      }),
    )
    held.forEach((p) => {
      p.catch(() => {})
    })
    try {
      // wait until every hog has actually checked out its slot (truly exhausted)
      const deadline = Date.now() + 3_000
      while (holders.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(holders.length).toBe(2)
      const start = Date.now()
      await expect(
        withPrivilegedDb(
          "00000000-0000-0000-0000-000000000002",
          "contended-acquire",
          async () => "never",
          { db: pool.db, acquireTimeoutMs: 300 },
        ),
      ).rejects.toThrow(/pool acquire timed out|connection pool exhausted/i)
      expect(Date.now() - start).toBeLessThan(2_000) // fast-fail, nowhere near the 300s ceiling
    } finally {
      for (const h of holders) h.resolve()
      await Promise.allSettled(held)
      await pool.client.end({ timeout: 5 })
    }
  })
})

describe("withSystemDb", () => {
  let withSystemDb: typeof import("~/db/privileged").withSystemDb

  const setup = async () => {
    const mod = await import("~/db/privileged")
    withSystemDb = mod.withSystemDb
  }

  it("does NOT set any GUC", async () => {
    await setup()
    await withSystemDb("test-no-guc", async (db) => {
      const [row] = await db.execute(
        drizzleSql`SELECT current_setting('app.current_org_id', true) as org_id`,
      )
      // withSystemDb sets no org GUC; on a fresh dedicated-pool connection it is null (never set),
      // equivalently "" on a recycled one — either way no org context.
      expect(row.org_id ?? "").toBe("")
    })
  })

  it("provides a working db handle", async () => {
    await setup()
    const result = await withSystemDb("test-handle", async (db) => {
      const [row] = await db.execute(drizzleSql`SELECT 1 as val`)
      return row
    })
    expect(result.val).toBe(1)
  })
})

describe("withSchemaAdmin", () => {
  let withSchemaAdmin: typeof import("~/db/privileged").withSchemaAdmin

  const setup = async () => {
    const mod = await import("~/db/privileged")
    withSchemaAdmin = mod.withSchemaAdmin
  }

  it("exposes a transaction with queueEvent attached", async () => {
    await setup()
    const orgId = "00000000-0000-0000-0000-aabbccddee01"
    let queueEventAttached = false
    await withSchemaAdmin(orgId, "test-helper-shape", async (tx) => {
      queueEventAttached = typeof (tx as any).queueEvent === "function"
    })
    expect(queueEventAttached).toBe(true)
  })

  it("can perform DDL inside the helper transaction", async () => {
    await setup()
    const orgId = "00000000-0000-0000-0000-aabbccddee03"
    await withSchemaAdmin(orgId, "test-helper-ddl", async (tx) => {
      await tx.execute(
        drizzleSql.raw("CREATE SCHEMA IF NOT EXISTS test_schema_admin_helper_canary"),
      )
      await tx.execute(drizzleSql.raw("DROP SCHEMA test_schema_admin_helper_canary"))
    })
  })
})

describe("liaison_schema_admin role", () => {
  it("exists with NOLOGIN, no BYPASSRLS", async () => {
    const rows = await sql<Array<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>>`
      SELECT rolname, rolcanlogin, rolbypassrls
      FROM pg_roles WHERE rolname = 'liaison_schema_admin'
    `
    expect(rows.length).toBe(1)
    expect(rows[0].rolcanlogin).toBe(false)
    expect(rows[0].rolbypassrls).toBe(false)
  })

  it("can create and drop a schema when role is assumed", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_schema_admin")
      await tx.unsafe("CREATE SCHEMA IF NOT EXISTS test_schema_admin_canary")
      await tx.unsafe("DROP SCHEMA test_schema_admin_canary")
    })
  })
})
