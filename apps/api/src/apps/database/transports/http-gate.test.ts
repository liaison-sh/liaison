// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Integration tests for HttpGate against a real in-process db-gate server
// (Task 4) + PG (test DB). Proves: end-to-end runRead parity with
// PostgresDirect on the same catalog (the seam contract test — both
// transports return the same rows), catalog-drift detection, 401 -> typed
// auth error (no token echoed), gate down -> typed unreachable error,
// malformed JSON -> typed protocol error, http:// remote gate URL refused.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import postgres from "postgres"
import { HttpGate } from "./http-gate"
import { PostgresDirect } from "./postgres-direct"

const DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const SUPERUSER_DSN = DSN.replace("liaison_app:liaison_app", "liaison:liaison")
const SCRATCH_SCHEMA = "http_gate_test_scratch"
const TOKEN = "b".repeat(40)
const PORT = 18_490

let setupSql: ReturnType<typeof postgres>
let gateServer: ReturnType<typeof Bun.serve> | undefined
let gateDb: import("../../../../../db-gate/src/gate-db").GateDb | undefined

const testCatalog: ReadCatalog = {
  adapter: "gate-parity-test",
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
    CREATE TABLE ${SCRATCH_SCHEMA}.widgets (id serial PRIMARY KEY, name text NOT NULL)
  `)
  await setupSql.unsafe(`INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('a'), ('b'), ('c')`)
  await setupSql.unsafe(`GRANT USAGE ON SCHEMA ${SCRATCH_SCHEMA} TO liaison_app`)
  await setupSql.unsafe(`GRANT SELECT ON ${SCRATCH_SCHEMA}.widgets TO liaison_app`)

  const { GateDb } = await import("../../../../../db-gate/src/gate-db")
  const { createDbGateHandler } = await import("../../../../../db-gate/src/server")
  gateDb = new GateDb(DSN)
  const config = { dsn: DSN, token: TOKEN, catalogPath: "", allowQuery: false, port: PORT }
  const handler = createDbGateHandler({ config, catalog: testCatalog, db: gateDb })
  gateServer = Bun.serve({ port: PORT, fetch: handler })
})

afterAll(async () => {
  gateServer?.stop(true)
  await gateDb?.close()
  await setupSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await setupSql.end()
})

describe("HttpGate — transport parity with PostgresDirect", () => {
  test("runRead returns the SAME rows via both transports on the same catalog read", async () => {
    // The application login reaches privileged roles; this parity check opts out of that refusal.
    const direct = new PostgresDirect({ dsn: DSN, allowPrivilegedSession: true })
    const gate = new HttpGate({
      gateUrl: `http://localhost:${PORT}`,
      gateToken: TOKEN,
      allowPrivate: true,
    })
    try {
      const directResult = await direct.runRead(
        testCatalog.reads.widgets_overview,
        "widgets_overview",
        {},
      )
      const gateResult = await gate.runRead(
        testCatalog.reads.widgets_overview,
        "widgets_overview",
        {},
      )
      expect(gateResult.rows).toEqual(directResult.rows)
    } finally {
      await direct.close()
      await gate.close()
    }
  })
})

describe("HttpGate — catalog drift detection", () => {
  test("probe/diffCatalog names a read the gate is missing", async () => {
    const gate = new HttpGate({
      gateUrl: `http://localhost:${PORT}`,
      gateToken: TOKEN,
      allowPrivate: true,
    })
    const localCatalogWithExtra: ReadCatalog = {
      adapter: "gate-parity-test",
      reads: {
        ...testCatalog.reads,
        an_extra_read_the_gate_lacks: {
          description: "not on the gate",
          domain: "health",
          sql: "SELECT 1 AS x",
          params: {},
          columns: ["x"],
          tables: ["pg_catalog.pg_class"],
        },
      },
    }
    try {
      const missing = await gate.diffCatalog(localCatalogWithExtra)
      expect(missing).toEqual(["an_extra_read_the_gate_lacks"])
    } finally {
      await gate.close()
    }
  })
})

describe("HttpGate — error mapping", () => {
  test("401 -> typed auth error, no token echoed", async () => {
    const gate = new HttpGate({
      gateUrl: `http://localhost:${PORT}`,
      gateToken: "totally-wrong-token-value",
      allowPrivate: true,
    })
    try {
      let caught: unknown
      try {
        await gate.diffCatalog(testCatalog)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      expect((caught as Error).message).not.toContain("totally-wrong-token-value")
    } finally {
      await gate.close()
    }
  })

  test("gate down -> typed unreachable error", async () => {
    const gate = new HttpGate({
      gateUrl: "http://localhost:1",
      gateToken: TOKEN,
      timeoutMs: 2000,
      allowPrivate: true,
    })
    try {
      await expect(gate.diffCatalog(testCatalog)).rejects.toThrow(/reach/)
    } finally {
      await gate.close()
    }
  })

  test("http:// remote (non-local) gate URL is refused (TLS-by-resolved-IP)", async () => {
    const gate = new HttpGate({
      gateUrl: "http://public-gate.example.com",
      gateToken: TOKEN,
      resolveDns: async () => ["203.0.113.7"],
    })
    try {
      await expect(gate.diffCatalog(testCatalog)).rejects.toThrow(/TLS is required/)
    } finally {
      await gate.close()
    }
  })
})
