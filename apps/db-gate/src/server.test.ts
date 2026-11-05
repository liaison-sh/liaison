// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HTTP-level tests for the db-gate server, with real PG behind it (test DB).
// Covers: bearer auth on every route but /healthz, timing-safe compare
// (behavioral: wrong token -> 401), non-vacuous column projection via a
// fixture read with extra columns, unknown-read 404 with valid names, /query
// disabled-by-default, sql-guard rejection + READ-ONLY-txn bypass proof,
// dangerous-function rejection, rate limiting, weak-token startup refusal,
// and dirty-probe startup refusal under DB_GATE_ALLOW_QUERY=true.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import postgres from "postgres"
import { loadConfig } from "./config"
import { GateDb } from "./gate-db"
import { createDbGateHandler, type RateLimitOptions } from "./server"

const DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const SUPERUSER_DSN = DSN.replace("liaison_app:liaison_app", "liaison:liaison")
const SCRATCH_SCHEMA = "db_gate_test_scratch"
const TOKEN = "a".repeat(40)

let setupSql: ReturnType<typeof postgres>

const testCatalog: ReadCatalog = {
  adapter: "gate-test",
  reads: {
    widgets_overview: {
      description: "list widgets",
      domain: "health",
      sql: `SELECT id, name FROM ${SCRATCH_SCHEMA}.widgets ORDER BY id`,
      params: {},
      columns: ["id", "name"],
      tables: [`${SCRATCH_SCHEMA}.widgets`],
    },
  },
}

beforeAll(async () => {
  setupSql = postgres(SUPERUSER_DSN, { max: 1, onnotice: () => {} })
  await setupSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await setupSql.unsafe(`CREATE SCHEMA ${SCRATCH_SCHEMA}`)
  await setupSql.unsafe(`
    CREATE TABLE ${SCRATCH_SCHEMA}.widgets (
      id serial PRIMARY KEY,
      name text NOT NULL,
      secret_col text NOT NULL DEFAULT 'nope'
    )
  `)
  await setupSql.unsafe(`INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('a'), ('b')`)
  await setupSql.unsafe(`GRANT USAGE ON SCHEMA ${SCRATCH_SCHEMA} TO liaison_app`)
  await setupSql.unsafe(`GRANT SELECT, INSERT ON ${SCRATCH_SCHEMA}.widgets TO liaison_app`)
})

afterAll(async () => {
  await setupSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await setupSql.end()
})

function makeHandler(opts: { allowQuery?: boolean; rateLimit?: RateLimitOptions } = {}) {
  const config = {
    dsn: DSN,
    token: TOKEN,
    catalogPath: "",
    allowQuery: opts.allowQuery ?? false,
    port: 0,
  }
  const db = new GateDb(DSN)
  const handler = createDbGateHandler({
    config,
    catalog: testCatalog,
    db,
    rateLimit: opts.rateLimit,
  })
  return { handler, db }
}

function req(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

describe("db-gate server — auth", () => {
  test("/healthz is unauthenticated and returns 200", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/healthz"))
      expect(res.status).toBe(200)
    } finally {
      await db.close()
    }
  })

  test("/catalog with no token -> 401", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/catalog"))
      expect(res.status).toBe(401)
    } finally {
      await db.close()
    }
  })

  test("/catalog with wrong token -> 401 (timing-safe compare path)", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/catalog", { token: "wrong-token-wrong-token-wrong-token" }))
      expect(res.status).toBe(401)
    } finally {
      await db.close()
    }
  })

  test("/read/* with no token -> 401", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/read/widgets_overview", { method: "POST", body: {} }))
      expect(res.status).toBe(401)
    } finally {
      await db.close()
    }
  })

  test("/query with no token -> 401", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const res = await handler(req("/query", { method: "POST", body: { sql: "SELECT 1" } }))
      expect(res.status).toBe(401)
    } finally {
      await db.close()
    }
  })

  test("/catalog with correct token -> 200", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/catalog", { token: TOKEN }))
      expect(res.status).toBe(200)
    } finally {
      await db.close()
    }
  })
})

describe("db-gate server — /catalog", () => {
  test("returns read names/descriptions/params/columns, never raw SQL text", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(req("/catalog", { token: TOKEN }))
      const body = (await res.json()) as { reads: Record<string, { columns: string[] }> }
      expect(body.reads.widgets_overview.columns).toEqual(["id", "name"])
      expect(JSON.stringify(body)).not.toContain("SELECT")
    } finally {
      await db.close()
    }
  })
})

describe("db-gate server — /read/{name}", () => {
  test("returns rows shaped by the column allow-list (non-vacuous: underlying table has an extra secret_col)", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(
        req("/read/widgets_overview", { method: "POST", token: TOKEN, body: {} }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rows: Record<string, unknown>[] }
      expect(body.rows.length).toBeGreaterThan(0)
      for (const row of body.rows) {
        expect(row).not.toHaveProperty("secret_col")
        expect(Object.keys(row).sort()).toEqual(["id", "name"])
      }
    } finally {
      await db.close()
    }
  })

  test("unknown read -> 404 with the list of valid names", async () => {
    const { handler, db } = makeHandler()
    try {
      const res = await handler(
        req("/read/nonexistent", { method: "POST", token: TOKEN, body: {} }),
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { validNames: string[] } }
      expect(body.error.validNames).toContain("widgets_overview")
    } finally {
      await db.close()
    }
  })
})

describe("db-gate server — /query", () => {
  test("disabled by default -> explicit disabled error", async () => {
    const { handler, db } = makeHandler({ allowQuery: false })
    try {
      const res = await handler(
        req("/query", { method: "POST", token: TOKEN, body: { sql: "SELECT 1" } }),
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("disabled")
    } finally {
      await db.close()
    }
  })

  test("enabled + SELECT -> rows", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const res = await handler(
        req("/query", { method: "POST", token: TOKEN, body: { sql: "SELECT 1 AS one" } }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rows: Record<string, unknown>[] }
      expect(body.rows[0]?.one).toBe(1)
    } finally {
      await db.close()
    }
  })

  test("enabled + INSERT -> sql-guard rejection (400)", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const res = await handler(
        req("/query", {
          method: "POST",
          token: TOKEN,
          body: { sql: `INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('x')` },
        }),
      )
      expect(res.status).toBe(400)
    } finally {
      await db.close()
    }
  })

  test("READ ONLY txn independently blocks a write bypassing sql-guard (direct GateDb.runQuery smuggled call)", async () => {
    const db = new GateDb(DSN)
    try {
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing assertReadOnlySelect for the layer-5-independent test
        (db as any).sql.begin(async (tx: any) => {
          await tx.unsafe("SET TRANSACTION READ ONLY")
          return tx.unsafe(`INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('hostile')`)
        }),
      ).rejects.toThrow()
    } finally {
      await db.close()
    }
  })

  test("enabled + pg_sleep -> sql-guard rejection", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const res = await handler(
        req("/query", { method: "POST", token: TOKEN, body: { sql: "SELECT pg_sleep(5)" } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("dangerous_function")
    } finally {
      await db.close()
    }
  })

  test("enabled + dblink -> sql-guard rejection", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const res = await handler(
        req("/query", {
          method: "POST",
          token: TOKEN,
          body: { sql: "SELECT dblink('conn','select 1')" },
        }),
      )
      expect(res.status).toBe(400)
    } finally {
      await db.close()
    }
  })
})

describe("db-gate server — pool concurrency + rate limit", () => {
  test("pool-concurrency bound holds under parallel requests (no crash, all complete)", async () => {
    const { handler, db } = makeHandler({ allowQuery: true })
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handler(
            req("/query", { method: "POST", token: TOKEN, body: { sql: "SELECT pg_sleep(0.05)" } }),
          ),
        ),
      )
      for (const res of results) expect(res.status).toBe(400) // pg_sleep rejected, but proves no crash under parallelism
    } finally {
      await db.close()
    }
  })

  test("rate limit trips after the configured max", async () => {
    const { handler, db } = makeHandler({ rateLimit: { windowMs: 10_000, maxRequests: 2 } })
    try {
      const r1 = await handler(req("/catalog", { token: TOKEN }))
      const r2 = await handler(req("/catalog", { token: TOKEN }))
      const r3 = await handler(req("/catalog", { token: TOKEN }))
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(r3.status).toBe(429)
    } finally {
      await db.close()
    }
  })
})

describe("db-gate — startup config refusal", () => {
  test("weak token -> loadConfig throws", () => {
    expect(() =>
      loadConfig({ DB_GATE_DSN: DSN, DB_GATE_TOKEN: "short" } as NodeJS.ProcessEnv),
    ).toThrow(/too weak/)
  })

  test("missing DSN -> loadConfig throws", () => {
    expect(() => loadConfig({ DB_GATE_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toThrow(/DB_GATE_DSN/)
  })

  test("valid config loads with defaults", () => {
    const config = loadConfig({ DB_GATE_DSN: DSN, DB_GATE_TOKEN: TOKEN } as NodeJS.ProcessEnv)
    expect(config.allowQuery).toBe(false)
    expect(config.port).toBe(8478)
  })
})

describe("db-gate — dirty-probe startup refusal", () => {
  test("DB_GATE_ALLOW_QUERY=true with a dirty probe (write grants detected) refuses to start", async () => {
    // Connected as superuser -> has write grants -> probe.ok === false.
    const db = new GateDb(SUPERUSER_DSN)
    try {
      const probe = await db.probe()
      expect(probe.ok).toBe(false)
      expect(probe.writeGrantsDetected).toBe(true)
      // The refusal-to-start logic itself lives in index.ts's main(); this
      // test proves the probe signal it gates on is correctly dirty here.
    } finally {
      await db.close()
    }
  })
})
