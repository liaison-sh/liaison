// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import {
  createPool,
  __privileged_db__ as db,
  __request_pool_db__ as requestDb,
} from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { userThreadState } from "~/db/schema/kernel"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

describe("withRlsContext", () => {
  const ctx = {
    actorType: "user" as const,
    userId: TEST_USER_ID,
    orgId: TEST_ORG_ID,
    scopes: [] as string[],
    dimensionGrants: {},
  }

  it("sets all 4 GUC variables within transaction and cleans up after", async () => {
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000123",
        orgId: "00000000-0000-0000-0000-000000000456",
        scopes: ["test:items:read", "test:items:write"],
        dimensionGrants: { team: ["alpha", "beta"] },
      },
      async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT
							current_setting('app.current_user_id', true) as user_id,
							current_setting('app.current_org_id', true) as org_id,
							current_setting('app.current_scopes', true) as scopes,
							current_setting('app.current_dimensions', true) as dimensions`,
        )
        return row
      },
    )
    expect(result.user_id).toBe("00000000-0000-0000-0000-000000000123")
    expect(result.org_id).toBe("00000000-0000-0000-0000-000000000456")
    expect(result.scopes).toBe("test:items:read,test:items:write")
    expect(JSON.parse(result.dimensions as string)).toEqual({ team: ["alpha", "beta"] })
  })

  it("uses wildcard dimension grants for system actors", async () => {
    const result = await withRlsContext(
      {
        actorType: "system",
        orgId: "00000000-0000-0000-0000-000000000456",
        purpose: "webhook",
        scopes: ["mail"],
      },
      async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT current_setting('app.current_dimensions', true) as dimensions`,
        )
        return row
      },
    )

    expect(JSON.parse(result.dimensions as string)).toEqual({ "*": ["*"] })
  })

  it("GUC variables are not visible outside the transaction", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000999",
        orgId: "00000000-0000-0000-0000-000000000999",
        scopes: [],
        dimensionGrants: {},
      },
      async () => {},
    )

    // On the pool the transaction ran on. Unset reads as NULL on a connection
    // that never saw the setting, "" on one a transaction set it on.
    const [row] = await requestDb.execute(
      drizzleSql`SELECT current_setting('app.current_user_id', true) as user_id`,
    )
    // Outside transaction, GUC should be empty/default
    expect(row.user_id ?? "").toBe("")
  })

  // The policies split app.current_scopes on ',', so a scope holding a comma
  // (for example a smuggled agent ceiling entry) would become two grants.
  it("refuses a scope containing a comma instead of joining it into two grants", async () => {
    await expect(
      withRlsContext({ ...ctx, scopes: ["tickets:x,kernel:users:admin"] }, async () => {}),
    ).rejects.toThrow("invalid character ','")
  })

  // U4.16 — reclaim-on-timeout + /diag surfacing fixes for the live staging
  // sandbox-wedge finding (tickets:search + every app-tickets tool/job timing
  // out at executeInSandbox once the main RLS pool silently exhausted).
  describe("U4.16 pool-pressure hardening", () => {
    it("JIT is disabled inside the RLS transaction by default (measured root cause of finding 2 — JIT compile time, not execution, dominated tickets:search wall-clock)", async () => {
      const result = await withRlsContext(ctx, async (tx) => {
        const [row] = await tx.execute(drizzleSql`SHOW jit`)
        return row
      })
      const expected = process.env.DB_RLS_JIT_ENABLED === "true" ? "on" : "off"
      expect(String((result as { jit: string }).jit)).toBe(expected)
    })

    it("SET LOCAL statement_timeout is applied inside the transaction (a runaway query is killed server-side)", async () => {
      // A query that sleeps past DB_STATEMENT_TIMEOUT_MS (test env pins it low,
      // see run wiring below) must be cancelled by Postgres itself (57014
      // query_canceled) rather than run to completion / hang. This is the
      // reclaim half of the fix: without it, executeInSandbox's own JS timeout
      // gives up on the CALLER side while the query — and the connection it
      // holds — keeps running server-side, so the connection cannot return to
      // the pool until the query finishes (in the worst case, never).
      // RUN WIRING: pin DB_STATEMENT_TIMEOUT_MS="200" in the launch env.
      const timeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "10000")
      if (timeoutMs > 2000) {
        // Default production-scale timeout — assert the GUC is actually SET
        // rather than sleeping for it (keeps the test fast in the common run).
        const result = await withRlsContext(ctx, async (tx) => {
          const [row] = await tx.execute(drizzleSql`SHOW statement_timeout`)
          return row
        })
        expect(String((result as { statement_timeout: string }).statement_timeout)).not.toBe("0")
        return
      }
      await expect(
        withRlsContext(ctx, async (tx) => {
          await tx.execute(drizzleSql`SELECT pg_sleep(5)`)
        }),
      ).rejects.toThrow()
    })

    it("acquire-timeout safety net: fails FAST (does NOT hang) when the main RLS pool is exhausted", async () => {
      // Mirrors db/privileged.test.ts's analogous test for the dedicated
      // privileged pool: this exercises the SAME guard withRlsContext applies
      // to the pool it runs on. Self-contained: the test builds its own
      // two-slot pool through the app's pool factory and asks for a 300 ms
      // acquire timeout, so the result never depends on DB_POOL_MAX or
      // DB_ACQUIRE_TIMEOUT_MS in the launch env. Both slots are held by raw
      // transactions (not through withRlsContext, so the hogs aren't
      // themselves subject to the acquire-timeout), then one more is requested.
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
        const deadline = Date.now() + 3_000
        while (holders.length < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(holders.length).toBe(2)
        const start = Date.now()
        await expect(
          withRlsContext(ctx, async () => "never", { db: pool.db, acquireTimeoutMs: 300 }),
        ).rejects.toThrow(/pool acquire timed out|connection pool exhausted/i)
        expect(Date.now() - start).toBeLessThan(2_000)
      } finally {
        for (const h of holders) h.resolve()
        await Promise.allSettled(held)
        await pool.client.end({ timeout: 5 })
      }
    })

    it("records inFlight in pool-diag for the transaction's lifetime and clears it after", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      let sawInFlight = 0
      await withRlsContext(ctx, async () => {
        sawInFlight = getPoolDiagState().inFlight
      })
      expect(sawInFlight).toBeGreaterThanOrEqual(1)
      expect(getPoolDiagState().inFlight).toBe(0)
    })

    it("clears inFlight even when the handler throws", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      await expect(
        withRlsContext(ctx, async () => {
          throw new Error("deliberate")
        }),
      ).rejects.toThrow("deliberate")
      expect(getPoolDiagState().inFlight).toBe(0)
    })
  })

  it("rolls back on error", async () => {
    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: TEST_USER_ID,
          orgId: TEST_ORG_ID,
          scopes: [],
          dimensionGrants: {},
        },
        async () => {
          throw new Error("handler error")
        },
      )
    } catch (e: any) {
      expect(e.message).toBe("handler error")
    }
  })

  it("rolls back transaction on handler error", async () => {
    expect.assertions(1)
    try {
      await withRlsContext(ctx, async () => {
        throw new Error("handler error")
      })
      throw new Error("should have thrown")
    } catch (err: any) {
      expect(err.message).toBe("handler error")
    }
  })

  it("withRlsContext callback receives RlsClient with brand", async () => {
    let hasBrand = false
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: [],
        dimensionGrants: {},
      },
      async (tx) => {
        hasBrand = (tx as any).__rlsBrand === true
      },
    )
    expect(hasBrand).toBe(true)
  })

  // U4.16 perf regression pin: the five per-GUC `set_config` round-trips were
  // collapsed into ONE parameterized `SELECT set_config(...), set_config(...),
  // ...` statement (see rls.ts's withRlsContext doc comment). This test pins
  // that EVERY one of the five `app.*` GUCs the collapsed statement sets is
  // actually visible inside the transaction — a batching regression that drops
  // or mis-orders one of the five `set_config` calls would silently degrade
  // (or corrupt) an RLS policy that reads it, without failing any single-GUC
  // assertion elsewhere in this file. Also pins jit/statement_timeout (set
  // in the SAME collapsed statement, conditionally) and the role switch
  // (its own separate `SET LOCAL ROLE`, deliberately NOT folded into the
  // set_config batch since ROLE is not GUC-addressable) — a real transaction,
  // not a mock, so a regression in the batched SQL itself is caught.
  it("a real withRlsContext transaction sets all five app.* GUCs, jit, statement_timeout, and current_role = liaison_rls", async () => {
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000789",
        orgId: "00000000-0000-0000-0000-00000000abcd",
        scopes: ["kernel:threads:read"],
        dimensionGrants: { team: ["support-us"] },
      },
      async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT
            current_setting('app.current_user_id', true) as user_id,
            current_setting('app.current_org_id', true) as org_id,
            current_setting('app.current_scopes', true) as scopes,
            current_setting('app.current_dimensions', true) as dimensions,
            current_setting('app.current_roles', true) as roles,
            current_setting('jit', true) as jit,
            current_setting('statement_timeout', true) as statement_timeout,
            current_role as current_role`,
        )
        return row as {
          user_id: string
          org_id: string
          scopes: string
          dimensions: string
          roles: string
          jit: string
          statement_timeout: string
          current_role: string
        }
      },
    )

    expect(result.user_id).toBe("00000000-0000-0000-0000-000000000789")
    expect(result.org_id).toBe("00000000-0000-0000-0000-00000000abcd")
    expect(result.scopes).toBe("kernel:threads:read")
    expect(JSON.parse(result.dimensions)).toEqual({ team: ["support-us"] })
    // No explicit roles passed -> resolves to the "__none__" sentinel, not empty.
    expect(result.roles).toBe("__none__")
    // jit/statement_timeout are set CONDITIONALLY (DB_RLS_JIT_ENABLED /
    // DB_STATEMENT_TIMEOUT_MS) — assert each GUC reflects whichever branch the
    // test env is actually running under, rather than hardcoding one value.
    const expectedJit = process.env.DB_RLS_JIT_ENABLED === "true" ? "on" : "off"
    expect(result.jit).toBe(expectedJit)
    const timeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "0")
    if (timeoutMs > 0) {
      expect(result.statement_timeout).not.toBe("0")
    }
    expect(result.current_role).toBe("liaison_rls")
  })
})

describe("RLS tenant isolation", () => {
  // These org IDs must be valid UUIDs since the column is UUID type
  const orgA = "00000000-0000-0000-0000-00000000000a"
  const orgB = "00000000-0000-0000-0000-00000000000b"
  const itemId = "00000000-0000-0000-0000-0000000fffff"

  beforeAll(async () => {
    // 1. Verify the liaison_rls role exists (created by DB provisioning or E2E infra).
    //    The role is required for RLS enforcement — skip these tests if missing.
    const [{ exists: roleExists }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') AS "exists"
    `
    if (!roleExists) {
      throw new Error(
        "liaison_rls role does not exist. Run E2E setup or create it manually: " +
          "CREATE ROLE liaison_rls NOLOGIN NOBYPASSRLS; GRANT liaison_rls TO liaison_app;",
      )
    }

    // 2. Create schema and table — drop first to handle stale state from crashed runs
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlstest CASCADE`)
    await sql.unsafe(`CREATE SCHEMA app_rlstest`)
    await sql.unsafe(`
      CREATE TABLE app_rlstest.items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        team TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'public',
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // 3. Drop existing RLS policies to avoid "already exists" errors on re-runs
    const policies = await sql`
      SELECT polname FROM pg_policy
      WHERE polrelid = (
        SELECT oid FROM pg_class
        WHERE relname = 'items'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app_rlstest')
      )
    `
    for (const { polname } of policies) {
      await sql.unsafe(`DROP POLICY IF EXISTS "${polname}" ON app_rlstest.items`)
    }

    // 4. Apply RLS policies (org_id isolation, no dimension restrictions for these tests)
    const policySql = generateRlsPolicySql("app_rlstest", "items", {})
    for (const stmt of policySql.split(";").filter((s: string) => s.trim())) {
      await sql.unsafe(`${stmt};`)
    }

    // 5. Grant liaison_rls access to the schema and table
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_rlstest TO liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA app_rlstest TO liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA app_rlstest TO liaison_rls`)

    // 6. Seed a row owned by org A (bypass RLS using direct SQL as superuser)
    await sql.unsafe(`
      INSERT INTO app_rlstest.items (id, org_id, title, status, team)
      VALUES ('${itemId}', '${orgA}', 'Secret', 'open', 'alpha')
      ON CONFLICT (id) DO NOTHING
    `)
  })

  afterAll(async () => {
    // Clean up test data, policies, and schema
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlstest CASCADE`)
  })

  it("RLS allows same-org SELECT", async () => {
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000a1",
        orgId: orgA,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT * FROM app_rlstest.items WHERE id = ${itemId}::uuid`)
      },
    )
    expect(result).toHaveLength(1)
  })

  it("RLS denies cross-org SELECT", async () => {
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000b1",
        orgId: orgB,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT * FROM app_rlstest.items WHERE id = ${itemId}::uuid`)
      },
    )
    expect(result).toHaveLength(0)
  })

  it("RLS denies cross-org UPDATE", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000b1",
        orgId: orgB,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        const result = await tx.execute(
          drizzleSql`UPDATE app_rlstest.items SET title = 'Hacked' WHERE id = ${itemId}::uuid RETURNING id`,
        )
        expect(result).toHaveLength(0)
      },
    )

    // Verify the row is unchanged (read as org A)
    const [row] = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000a1",
        orgId: orgA,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        return tx.execute(
          drizzleSql`SELECT title FROM app_rlstest.items WHERE id = ${itemId}::uuid`,
        )
      },
    )
    expect(row.title).toBe("Secret")
  })

  it("RLS denies cross-org DELETE", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000b1",
        orgId: orgB,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        const result = await tx.execute(
          drizzleSql`DELETE FROM app_rlstest.items WHERE id = ${itemId}::uuid RETURNING id`,
        )
        expect(result).toHaveLength(0)
      },
    )

    // Verify the row still exists (read as org A)
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000a1",
        orgId: orgA,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT * FROM app_rlstest.items WHERE id = ${itemId}::uuid`)
      },
    )
    expect(result).toHaveLength(1)
  })

  it("RLS denies cross-org INSERT", async () => {
    // Org B should not be able to insert a row with org A's ID
    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: "00000000-0000-0000-0000-0000000000b1",
          orgId: orgB,
          scopes: ["*"],
          dimensionGrants: { "*": ["*"] },
        },
        async (tx) => {
          await tx.execute(
            drizzleSql`INSERT INTO app_rlstest.items (org_id, title, team)
              VALUES (${orgA}::uuid, 'Injected', 'evil')`,
          )
        },
      )
      // If we reach here, the insert didn't throw — that's a policy violation
      expect("insert should have been denied").toBe("denied")
    } catch (e: any) {
      // RLS WITH CHECK violation — drizzle wraps the postgres error;
      // check the original cause for the policy violation message
      const msg = (e.cause?.message ?? e.message ?? "").toLowerCase()
      expect(msg).toContain("row-level security")
    }
  })
})

describe("RLS dimension-based filtering (T-9)", () => {
  const orgC = "00000000-0000-0000-0000-00000000000c"
  const itemAlpha = "00000000-0000-0000-0000-0000000fff01"
  const itemBeta = "00000000-0000-0000-0000-0000000fff02"

  beforeAll(async () => {
    // Check liaison_rls role exists
    const [{ exists: roleExists }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') AS "exists"
    `
    if (!roleExists) {
      throw new Error("liaison_rls role does not exist. Run E2E setup or create it manually.")
    }

    // Ensure the app_rlstest schema and table exist (reuse from the parent describe block if it ran first)
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_rlstest`)
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_rlstest.items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        team TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'public',
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Drop any existing policies so we can recreate with dimension filtering
    const policies = await sql`
      SELECT polname FROM pg_policy
      WHERE polrelid = (
        SELECT oid FROM pg_class
        WHERE relname = 'items'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app_rlstest')
      )
    `
    for (const { polname } of policies) {
      await sql.unsafe(`DROP POLICY IF EXISTS "${polname}" ON app_rlstest.items`)
    }

    // Apply RLS with a "team" dimension (enum type)
    const policySql = generateRlsPolicySql("app_rlstest", "items", {
      team: { type: "enum" },
    })
    for (const stmt of policySql.split(";").filter((s: string) => s.trim())) {
      await sql.unsafe(`${stmt};`)
    }

    // Grant access
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_rlstest TO liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA app_rlstest TO liaison_rls`)

    // Seed two rows with different teams, both in orgC
    await sql.unsafe(`
      INSERT INTO app_rlstest.items (id, org_id, title, team)
      VALUES ('${itemAlpha}', '${orgC}', 'Alpha Item', 'alpha')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO app_rlstest.items (id, org_id, title, team)
      VALUES ('${itemBeta}', '${orgC}', 'Beta Item', 'beta')
      ON CONFLICT (id) DO NOTHING
    `)
  })

  afterAll(async () => {
    // Drop the fixture schema, as the block above does: left behind, its
    // GRANT ALL fails rls-completeness in the next run on this database.
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlstest CASCADE`)
  })

  it("dimension grant for 'alpha' team allows only alpha rows (T-9)", async () => {
    // User granted only the 'alpha' team dimension
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000c1",
        orgId: orgC,
        scopes: ["*"],
        dimensionGrants: { team: ["alpha"] },
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT id FROM app_rlstest.items WHERE org_id = ${orgC}::uuid`)
      },
    )
    const ids = result.map((r: any) => r.id)
    expect(ids).toContain(itemAlpha)
    expect(ids).not.toContain(itemBeta)
  })

  it("wildcard dimension grant allows all rows", async () => {
    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000c1",
        orgId: orgC,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT id FROM app_rlstest.items WHERE org_id = ${orgC}::uuid`)
      },
    )
    const ids = result.map((r: any) => r.id)
    expect(ids).toContain(itemAlpha)
    expect(ids).toContain(itemBeta)
  })
})

describe("system actor context", () => {
  const orgA = "00000000-0000-0000-0000-00000000000a"

  it("system context sets nil-uuid user_id GUC", async () => {
    await withRlsContext({ actorType: "system", orgId: orgA, purpose: "audit" }, async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT current_setting('app.current_user_id', true) as uid`,
      )
      // A system actor has no user id, but RLS policies read this GUC via a raw
      // `::uuid` cast (80+ call sites) that throws 22P02 on an empty string —
      // so withRlsContext resolves a non-user actor to the nil uuid (rls.ts),
      // which matches no real owner/user id and so still denies via RLS.
      expect(row.uid).toBe("00000000-0000-0000-0000-000000000000")
    })
  })

  it("system audit context has only kernel:audit:write scope", async () => {
    await withRlsContext({ actorType: "system", orgId: orgA, purpose: "audit" }, async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT current_setting('app.current_scopes', true) as scopes`,
      )
      expect(row.scopes).toBe("kernel:audit:write")
    })
  })

  it("system timeline context has only kernel:timeline:write scope", async () => {
    await withRlsContext({ actorType: "system", orgId: orgA, purpose: "timeline" }, async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT current_setting('app.current_scopes', true) as scopes`,
      )
      expect(row.scopes).toBe("kernel:timeline:write")
    })
  })
})

describe("uts_insert participant/self tightening", () => {
  const orgA = "00000000-0000-0000-0000-00000000000a"
  const userA = "00000000-0000-0000-0000-000000000a01"
  const userB = "00000000-0000-0000-0000-000000000a02"
  let threadT1: string

  beforeAll(async () => {
    // Check liaison_rls role exists
    const [{ exists: roleExists }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') AS "exists"
    `
    if (!roleExists) {
      throw new Error("liaison_rls role does not exist.")
    }

    // Check kernel tables exist (need migrations to have run)
    const [{ exists: schemaExists }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'kernel') AS "exists"
    `
    if (!schemaExists) {
      throw new Error("kernel schema does not exist. Run migrations.")
    }

    // Seed: create org, users, thread, and one participant (userA)
    await sql.unsafe(`
      INSERT INTO kernel.organizations (id, name, slug) VALUES ('${orgA}', 'Test Org A', 'test-org-a')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.users (id, org_id, email, password_hash, name)
      VALUES ('${userA}', '${orgA}', 'usera-rls@test.com', 'hash', 'User A'),
             ('${userB}', '${orgA}', 'userb-rls@test.com', 'hash', 'User B')
      ON CONFLICT (id) DO NOTHING
    `)

    // Create thread as superuser
    const [thread] = await sql.unsafe(`
      INSERT INTO kernel.threads (org_id, handle, created_by, title)
      VALUES ('${orgA}', 'rls-test-thread', '${userA}', 'RLS Test Thread')
      ON CONFLICT (org_id, handle) DO UPDATE SET title = EXCLUDED.title
      RETURNING id
    `)
    threadT1 = thread.id

    // Add userA as participant
    await sql.unsafe(`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES ('${threadT1}', '${userA}', '${orgA}')
      ON CONFLICT (thread_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
    `)

    // Clean any stale UTS from previous runs
    await sql.unsafe(`
      DELETE FROM kernel.user_thread_state WHERE thread_id = '${threadT1}'
    `)
  })

  afterAll(async () => {
    if (threadT1) {
      await sql.unsafe(`DELETE FROM kernel.user_thread_state WHERE thread_id = '${threadT1}'`)
      await sql.unsafe(`DELETE FROM kernel.thread_participants WHERE thread_id = '${threadT1}'`)
      await sql.unsafe(`DELETE FROM kernel.threads WHERE id = '${threadT1}'`)
    }
    // Clean up users and org seeded by this describe block to avoid leaking
    // test data that interferes with concurrent test files (e.g. auth.test.ts
    // bootstrapRegister which requires zero orgs).
    await sql.unsafe(`DELETE FROM kernel.users WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })

  it("participant can INSERT own user_thread_state", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: userA,
        orgId: orgA,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.insert(userThreadState).values({
          userId: userA,
          threadId: threadT1,
          orgId: orgA,
        })
      },
    )
    // Clean up for next test
    await sql.unsafe(
      `DELETE FROM kernel.user_thread_state WHERE user_id = '${userA}' AND thread_id = '${threadT1}'`,
    )
  })

  it("non-participant CAN INSERT own user_thread_state (self-insert allowed)", async () => {
    // Policy allows user_id = current_user_id for own state — this is a
    // no-op UX convenience (e.g. pre-archiving before joining). The thread
    // participant check only applies to cross-user inserts.
    await withRlsContext(
      {
        actorType: "user",
        userId: userB,
        orgId: orgA,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.insert(userThreadState).values({
          userId: userB,
          threadId: threadT1,
          orgId: orgA,
        })
      },
    )
    // Clean up
    await sql.unsafe(
      `DELETE FROM kernel.user_thread_state WHERE user_id = '${userB}' AND thread_id = '${threadT1}'`,
    )
  })

  it("non-participant cannot INSERT user_thread_state for another user", async () => {
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: userB,
          orgId: orgA,
          scopes: ["kernel:threads:write"],
          dimensionGrants: {},
        },
        async (tx) => {
          await tx.insert(userThreadState).values({
            userId: userA,
            threadId: threadT1,
            orgId: orgA,
          })
        },
      ),
    ).rejects.toThrow()
  })

  it("participant can INSERT user_thread_state for another participant (service-level add)", async () => {
    // Add userB as participant first — the tightened policy requires the target
    // user to be an existing thread participant
    await sql.unsafe(`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES ('${threadT1}', '${userB}', '${orgA}')
      ON CONFLICT (thread_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
    `)

    await withRlsContext(
      {
        actorType: "user",
        userId: userA,
        orgId: orgA,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.insert(userThreadState).values({
          userId: userB,
          threadId: threadT1,
          orgId: orgA,
        })
      },
    )
    // Clean up
    await sql.unsafe(
      `DELETE FROM kernel.user_thread_state WHERE user_id = '${userB}' AND thread_id = '${threadT1}'`,
    )
    await sql.unsafe(
      `DELETE FROM kernel.thread_participants WHERE thread_id = '${threadT1}' AND user_id = '${userB}'`,
    )
  })

  it("participant cannot INSERT user_thread_state for a NON-participant", async () => {
    // UserB is NOT a participant — policy should block this
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: userA,
          orgId: orgA,
          scopes: ["kernel:threads:write"],
          dimensionGrants: {},
        },
        async (tx) => {
          await tx.insert(userThreadState).values({
            userId: userB,
            threadId: threadT1,
            orgId: orgA,
          })
        },
      ),
    ).rejects.toThrow()
  })
})

describe("RLS org GUC empty-string tolerance (deferred-events cron crash)", () => {
  // Reproduces the invoicing `deferred-retry` cron crash: a background job
  // reaching its handler with NO RLS context leaves `app.current_org_id` set
  // to '' (current_setting(..., true) returns '' when the GUC was never SET,
  // not NULL). The generated policy's org-condition cast must tolerate that
  // as "no org" (0 rows), never a hard `''::uuid` cast error.
  const orgA = "00000000-0000-0000-0000-0000000000e1"
  const itemId = "00000000-0000-0000-0000-0000000eff01"

  beforeAll(async () => {
    const [{ exists: roleExists }] = await sql`
      SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') AS "exists"
    `
    if (!roleExists) {
      throw new Error("liaison_rls role does not exist. Run E2E setup or create it manually.")
    }

    await sql.unsafe(`DROP SCHEMA IF EXISTS app_orgguctest CASCADE`)
    await sql.unsafe(`CREATE SCHEMA app_orgguctest`)
    await sql.unsafe(`
      CREATE TABLE app_orgguctest.items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Apply the REAL generated policy (org isolation + a scope check), same
    // shape as an app manifest table like invoicing's deferred_events.
    const policySql = generateRlsPolicySql(
      "app_orgguctest",
      "items",
      {},
      "orgguctest",
      "internal",
      {},
    )
    for (const stmt of policySql.split(";").filter((s: string) => s.trim())) {
      await sql.unsafe(`${stmt};`)
    }

    await sql.unsafe(`GRANT USAGE ON SCHEMA app_orgguctest TO liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA app_orgguctest TO liaison_rls`)

    await sql.unsafe(`
      INSERT INTO app_orgguctest.items (id, org_id, title)
      VALUES ('${itemId}', '${orgA}', 'Stuck deferred event')
      ON CONFLICT (id) DO NOTHING
    `)
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_orgguctest CASCADE`)
  })

  it("an empty app.current_org_id GUC yields 0 rows, not a cast error", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('app.current_org_id', '', true)`)
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_scopes', 'orgguctest:internal', true)`,
      )
      await tx.execute(drizzleSql.raw("SET LOCAL ROLE liaison_rls"))

      const rows = await tx.execute(
        drizzleSql`SELECT * FROM app_orgguctest.items WHERE id = ${itemId}::uuid`,
      )
      expect(rows).toHaveLength(0)

      // The UPDATE the deferred-retry cron actually runs — must be a 0-row
      // no-op, never a thrown "invalid input syntax for type uuid" error.
      const updated = await tx.execute(
        drizzleSql`UPDATE app_orgguctest.items SET title = 'mutated' WHERE id = ${itemId}::uuid RETURNING id`,
      )
      expect(updated).toHaveLength(0)
    })
  })

  it("a valid org + matching scope still reads and writes normally", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-0000000000e2",
        orgId: orgA,
        scopes: ["orgguctest:internal"],
        dimensionGrants: {},
      },
      async (tx) => {
        const rows = await tx.execute(
          drizzleSql`SELECT * FROM app_orgguctest.items WHERE id = ${itemId}::uuid`,
        )
        expect(rows).toHaveLength(1)

        const updated = await tx.execute(
          drizzleSql`UPDATE app_orgguctest.items SET title = 'resolved' WHERE id = ${itemId}::uuid RETURNING id`,
        )
        expect(updated).toHaveLength(1)
      },
    )
  })
})
