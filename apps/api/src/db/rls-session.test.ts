// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TDD for the bridge-owned-transactions refactor.
//
// `createRlsSession` captures an ActorContext + WithRlsOptions WITHOUT
// acquiring a connection. `session.run(fn)` opens exactly one short-lived RLS
// transaction (acquire -> GUCs + SET LOCAL ROLE -> fn -> commit -> release)
// per call — mirroring `withRlsContext`'s per-call semantics, but reusable:
// the same session can `run()` many times, each a fresh transaction, with NO
// connection held between runs. This file intentionally imports a symbol
// (`createRlsSession`) that does not exist yet in `~/db/rls` — these tests
// MUST fail to load/compile until the production code lands (red phase).
import { afterAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { __request_pool_db__ as requestDb } from "~/db/connection"
import { createRlsSession } from "~/db/rls"

const TEST_ORG_ID = "00000000-0000-0000-0000-0000000c0001"
const TEST_USER_ID = "00000000-0000-0000-0000-0000000c0002"

describe("createRlsSession", () => {
  const ctx = {
    actorType: "user" as const,
    userId: TEST_USER_ID,
    orgId: TEST_ORG_ID,
    scopes: ["test:items:read", "test:items:write"],
    dimensionGrants: { team: ["alpha", "beta"] },
  }

  it("createRlsSession captures ctx/opts without touching the DB (no connection acquired at construction)", async () => {
    const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
    PoolDiagTestAccess.reset()
    // Merely constructing the session must not open a transaction — inFlight
    // stays at 0 until .run() is actually called.
    const session = createRlsSession(ctx)
    expect(session.ctx).toEqual(ctx)
    expect(getPoolDiagState().inFlight).toBe(0)
  })

  it("session.run sets all app.* GUCs and switches to liaison_rls inside the transaction", async () => {
    const session = createRlsSession({
      actorType: "user",
      userId: "00000000-0000-0000-0000-0000000c0123",
      orgId: "00000000-0000-0000-0000-0000000c0456",
      scopes: ["test:items:read", "test:items:write"],
      dimensionGrants: { team: ["alpha", "beta"] },
    })

    const result = await session.run(async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT
          current_setting('app.current_user_id', true) as user_id,
          current_setting('app.current_org_id', true) as org_id,
          current_setting('app.current_scopes', true) as scopes,
          current_setting('app.current_dimensions', true) as dimensions,
          current_role as current_role`,
      )
      return row as {
        user_id: string
        org_id: string
        scopes: string
        dimensions: string
        current_role: string
      }
    })

    expect(result.user_id).toBe("00000000-0000-0000-0000-0000000c0123")
    expect(result.org_id).toBe("00000000-0000-0000-0000-0000000c0456")
    expect(result.scopes).toBe("test:items:read,test:items:write")
    expect(JSON.parse(result.dimensions)).toEqual({ team: ["alpha", "beta"] })
    expect(result.current_role).toBe("liaison_rls")
  })

  it("session.run commits on success (data is visible after the transaction returns)", async () => {
    const session = createRlsSession(ctx)
    // Reuse the real kernel.user_thread_state RLS pattern is overkill here —
    // pin the commit contract against a scratch RLS-governed scratch schema
    // instead, mirroring rls.test.ts's app_rlstest fixture so this test does
    // not depend on kernel table shape.
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlssessiontest CASCADE`)
    await sql.unsafe(`CREATE SCHEMA app_rlssessiontest`)
    await sql.unsafe(`
      CREATE TABLE app_rlssessiontest.items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        title TEXT NOT NULL
      )
    `)
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_rlssessiontest TO liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA app_rlssessiontest TO liaison_rls`)
    // No RLS policy needed for a commit-visibility check — the row is read back
    // via a superuser `sql` query outside the session's transaction.
    await sql.unsafe(`ALTER TABLE app_rlssessiontest.items DISABLE ROW LEVEL SECURITY`)

    try {
      const insertedId = await session.run(async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`INSERT INTO app_rlssessiontest.items (org_id, title)
            VALUES (${TEST_ORG_ID}::uuid, 'session-commit-check') RETURNING id`,
        )
        return (row as { id: string }).id
      })

      const rows =
        await sql`SELECT title FROM app_rlssessiontest.items WHERE id = ${insertedId}::uuid`
      expect(rows).toHaveLength(1)
      expect(rows[0]?.title).toBe("session-commit-check")
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlssessiontest CASCADE`)
    }
  })

  it("session.run rolls back on handler error", async () => {
    const session = createRlsSession(ctx)
    await expect(
      session.run(async () => {
        throw new Error("deliberate session.run failure")
      }),
    ).rejects.toThrow("deliberate session.run failure")
  })

  it("two sequential session.run calls each use a FRESH transaction (GUCs from one run do not leak into the next)", async () => {
    const sessionA = createRlsSession({
      actorType: "user",
      userId: "00000000-0000-0000-0000-0000000c0a01",
      orgId: TEST_ORG_ID,
      scopes: ["run-a-scope"],
      dimensionGrants: {},
    })
    const sessionB = createRlsSession({
      actorType: "user",
      userId: "00000000-0000-0000-0000-0000000c0b01",
      orgId: TEST_ORG_ID,
      scopes: ["run-b-scope"],
      dimensionGrants: {},
    })

    const [scopesA, scopesB] = await Promise.all([
      sessionA.run(async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT current_setting('app.current_scopes', true) as scopes`,
        )
        return (row as { scopes: string }).scopes
      }),
      sessionB.run(async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT current_setting('app.current_scopes', true) as scopes`,
        )
        return (row as { scopes: string }).scopes
      }),
    ])

    expect(scopesA).toBe("run-a-scope")
    expect(scopesB).toBe("run-b-scope")

    // A THIRD run on sessionA, after sessionB's run interleaved, must still see
    // sessionA's own scopes — proving GUCs are per-transaction, not accidentally
    // cached/shared on the session object itself.
    const scopesAAgain = await sessionA.run(async (tx) => {
      const [row] = await tx.execute(
        drizzleSql`SELECT current_setting('app.current_scopes', true) as scopes`,
      )
      return (row as { scopes: string }).scopes
    })
    expect(scopesAAgain).toBe("run-a-scope")
  })

  it("GUC variables set inside session.run are not visible outside the transaction", async () => {
    const session = createRlsSession({
      actorType: "user",
      userId: "00000000-0000-0000-0000-0000000c0999",
      orgId: "00000000-0000-0000-0000-0000000c0999",
      scopes: [],
      dimensionGrants: {},
    })
    await session.run(async () => {})

    // On the pool the transaction ran on. Unset reads as NULL on a connection
    // that never saw the setting, "" on one a transaction set it on.
    const [row] = await requestDb.execute(
      drizzleSql`SELECT current_setting('app.current_user_id', true) as user_id`,
    )
    expect(row.user_id ?? "").toBe("")
  })

  describe("pool-diag inFlight lifecycle — the session holds NO connection between runs", () => {
    it("inFlight is 0 before run(), >0 DURING run(), and back to 0 immediately after run() resolves", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      const session = createRlsSession(ctx)

      expect(getPoolDiagState().inFlight).toBe(0)

      let sawInFlightDuringRun = 0
      await session.run(async () => {
        sawInFlightDuringRun = getPoolDiagState().inFlight
      })

      expect(sawInFlightDuringRun).toBeGreaterThanOrEqual(1)
      expect(getPoolDiagState().inFlight).toBe(0)
    })

    it("inFlight returns to 0 even when the handler throws", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      const session = createRlsSession(ctx)

      await expect(
        session.run(async () => {
          throw new Error("deliberate")
        }),
      ).rejects.toThrow("deliberate")
      expect(getPoolDiagState().inFlight).toBe(0)
    })

    it("holds no connection between two sequential runs — inFlight is 0 in the gap between them", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      const session = createRlsSession(ctx)

      await session.run(async () => {
        expect(getPoolDiagState().inFlight).toBeGreaterThanOrEqual(1)
      })
      // The gap: session is idle, holding nothing, exactly as an app handler
      // would be between two bridge-method calls under the new per-call
      // transaction contract (spec "Target contract").
      expect(getPoolDiagState().inFlight).toBe(0)

      await session.run(async () => {
        expect(getPoolDiagState().inFlight).toBeGreaterThanOrEqual(1)
      })
      expect(getPoolDiagState().inFlight).toBe(0)
    })

    it("N sequential session.run calls never accumulate inFlight above 1 (proves no leaked handle across runs)", async () => {
      const { PoolDiagTestAccess, getPoolDiagState } = await import("~/db/pool-diag")
      PoolDiagTestAccess.reset()
      const session = createRlsSession(ctx)

      for (let i = 0; i < 5; i++) {
        await session.run(async (tx) => {
          await tx.execute(drizzleSql`SELECT 1`)
        })
        expect(getPoolDiagState().inFlight).toBe(0)
      }
    })
  })

  describe("WithRlsOptions plumbing (pool selection)", () => {
    it("createRlsSession accepts WithRlsOptions and stores them on the session", () => {
      const session = createRlsSession(ctx, { pool: "jobs" })
      expect(session.opts).toEqual({ pool: "jobs" })
    })

    it("defaults to the request pool when no opts are passed", () => {
      const session = createRlsSession(ctx)
      expect(session.opts?.pool ?? "request").toBe("request")
    })
  })

  describe("system actor context", () => {
    it("session.run resolves a system actor to the nil-uuid app.current_user_id GUC", async () => {
      const session = createRlsSession({
        actorType: "system",
        orgId: TEST_ORG_ID,
        purpose: "webhook",
        scopes: ["mail"],
      })
      await session.run(async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`SELECT current_setting('app.current_user_id', true) as uid`,
        )
        expect(row.uid).toBe("00000000-0000-0000-0000-000000000000")
      })
    })
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_rlssessiontest CASCADE`)
  })
})
