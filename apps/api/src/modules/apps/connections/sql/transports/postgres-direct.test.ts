// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Integration tests for PostgresDirect against the project's real test PG
// (DATABASE_URL from .env.test). Proves each safety layer independently:
// READ ONLY txn (layer 5) holds even with the sql-guard validator bypassed
// (calling runQuery directly with a write statement), statement_timeout
// fires, row cap truncates+flags, pool-concurrency bound queues rather than
// exhausts, TLS refusal by resolved IP (incl. a public-resolving bare/
// .internal name), redaction never leaks the DSN/password, probe reports
// write/EXECUTE grants, and column projection is non-vacuous (extra/secret-
// like columns in the underlying row never surface).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ReadDefinition } from "@liaison/db-core"
import postgres from "postgres"
import { buildTransport } from "../credentials"
import { DbTransportError } from "../transport"
import { PostgresDirect } from "./postgres-direct"

const APP_DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const SUPERUSER_DSN = APP_DSN.replace("liaison_app:liaison_app", "liaison:liaison")
// The connector runs as a dedicated read-only login that is a member of no
// other role, which is the shape the transport's pre-flight demands. The
// application's own login (a member of liaison_admin) is used only to prove
// that it is refused.
const TEST_LOGIN = "db_connector_test_login"
const TEST_LOGIN_PW = "test-login-pw-0123456789"
const DSN = APP_DSN.replace("liaison_app:liaison_app", `${TEST_LOGIN}:${TEST_LOGIN_PW}`)

const SCRATCH_SCHEMA = "db_connector_test_scratch"

let setupSql: ReturnType<typeof postgres>

beforeAll(async () => {
  setupSql = postgres(SUPERUSER_DSN, { max: 1, onnotice: () => {} })
  await setupSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await setupSql.unsafe(`CREATE SCHEMA ${SCRATCH_SCHEMA}`)
  await setupSql.unsafe(`
    CREATE TABLE ${SCRATCH_SCHEMA}.widgets (
      id serial PRIMARY KEY,
      name text NOT NULL,
      secret_token text NOT NULL DEFAULT 'do-not-leak'
    )
  `)
  await setupSql.unsafe(`INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('a'), ('b'), ('c')`)
  await setupSql.unsafe(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => {})
  await setupSql.unsafe(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_LOGIN}') THEN CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${TEST_LOGIN_PW}'; END IF; END $$`,
  )
  await setupSql.unsafe(`GRANT USAGE ON SCHEMA ${SCRATCH_SCHEMA} TO ${TEST_LOGIN}`)
  await setupSql.unsafe(`GRANT SELECT, INSERT ON ${SCRATCH_SCHEMA}.widgets TO ${TEST_LOGIN}`)
  // The bound and cancellation tests below need a slow statement. Liaison's
  // own database takes pg_sleep away from PUBLIC (migration 0247); the login
  // here stands for a login on any database the connector reads, which keeps
  // the Postgres default.
  await setupSql.unsafe(
    `GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) TO ${TEST_LOGIN}`,
  )
})

afterAll(async () => {
  await setupSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await setupSql
    .unsafe(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM ${TEST_LOGIN}`)
    .catch(() => {})
  await setupSql.unsafe(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => {})
  await setupSql.end()
})

function widgetsRead(overrides: Partial<ReadDefinition> = {}): ReadDefinition {
  return {
    description: "list widgets",
    domain: "health",
    sql: `SELECT id, name FROM ${SCRATCH_SCHEMA}.widgets ORDER BY id`,
    params: {},
    columns: ["id", "name"],
    tables: [`${SCRATCH_SCHEMA}.widgets`],
    ...overrides,
  }
}

describe("PostgresDirect — structural safety", () => {
  test("READ ONLY txn blocks an INSERT smuggled past the validator (runQuery called directly, bypassing sql-guard)", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      await expect(
        transport.runQuery(`INSERT INTO ${SCRATCH_SCHEMA}.widgets (name) VALUES ('hostile')`),
      ).rejects.toThrow(DbTransportError)
    } finally {
      await transport.close()
    }
  })

  test("statement_timeout fires on a long-running query", async () => {
    const transport = new PostgresDirect({ dsn: DSN, statementTimeoutMs: 200 })
    try {
      const start = Date.now()
      await expect(transport.runQuery("SELECT pg_sleep(2)")).rejects.toThrow(DbTransportError)
      expect(Date.now() - start).toBeLessThan(2000)
    } finally {
      await transport.close()
    }
  })

  test("row cap truncates and flags", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      const result = await transport.runRead(widgetsRead({ maxRows: 2 }), "widgets", {})
      expect(result.rows.length).toBe(2)
      expect(result.truncated).toBe(true)
    } finally {
      await transport.close()
    }
  })

  test("no truncation flag when under the cap", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      const result = await transport.runRead(widgetsRead({ maxRows: 50 }), "widgets", {})
      expect(result.rows.length).toBe(3)
      expect(result.truncated).toBe(false)
    } finally {
      await transport.close()
    }
  })

  test("column projection is non-vacuous: extra/secret-like column never surfaces even though the underlying SQL returns it", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      const read = widgetsRead({
        sql: `SELECT id, name, secret_token FROM ${SCRATCH_SCHEMA}.widgets ORDER BY id`,
        columns: ["id", "name"], // allow-list deliberately narrower than the SQL's SELECT
      })
      const result = await transport.runRead(read, "widgets", {})
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(row).not.toHaveProperty("secret_token")
        expect(Object.keys(row).sort()).toEqual(["id", "name"])
      }
    } finally {
      await transport.close()
    }
  })

  test("pool-concurrency bound: N parallel pg_sleep-shaped calls queue rather than all executing simultaneously", async () => {
    const transport = new PostgresDirect({
      dsn: DSN,
      concurrencyLimit: 1,
      statementTimeoutMs: 5000,
    })
    try {
      const start = Date.now()
      await Promise.all([
        transport.runQuery("SELECT pg_sleep(0.2)"),
        transport.runQuery("SELECT pg_sleep(0.2)"),
        transport.runQuery("SELECT pg_sleep(0.2)"),
      ])
      // With concurrency=1, three 0.2s sleeps must serialize -> >= ~0.6s.
      expect(Date.now() - start).toBeGreaterThanOrEqual(550)
    } finally {
      await transport.close()
    }
  })

  test("redaction: error from a bad password does not leak the password/DSN", async () => {
    // A login that does not exist, with a wrong password: refused whether the
    // server checks passwords on localhost or trusts it (a local Postgres often
    // does, and then a wrong password alone connects).
    const badDsn = DSN.replace(
      `${TEST_LOGIN}:${TEST_LOGIN_PW}`,
      `${TEST_LOGIN}_absent:wrong-password-xyz`,
    )
    const transport = new PostgresDirect({ dsn: badDsn, poolMax: 1 })
    try {
      let caught: unknown
      try {
        await transport.runQuery("SELECT 1")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(DbTransportError)
      const message = (caught as DbTransportError).message
      expect(message).not.toContain("wrong-password-xyz")
      expect(message).not.toContain("postgres://")
    } finally {
      await transport.close().catch(() => {})
    }
  })

  test("probe reports write grants and dangerous EXECUTE grants when connected as a broad role", async () => {
    const transport = new PostgresDirect({ dsn: SUPERUSER_DSN, allowPrivilegedSession: true })
    try {
      const report = await transport.probe()
      expect(report.mode).toBe("direct")
      expect(report.writeGrantsDetected).toBe(true)
    } finally {
      await transport.close()
    }
  })
})

describe("PostgresDirect — a login that can step into a privileged role is refused (live PG)", () => {
  test("the application's own login (a member of liaison_admin) is refused before any SQL runs", async () => {
    const transport = new PostgresDirect({ dsn: APP_DSN })
    try {
      const err = await transport.runQuery("SELECT 1").catch((e) => e)
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).kind).toBe("config")
      expect((err as DbTransportError).message).toContain("superuser or BYPASSRLS")
    } finally {
      await transport.close()
    }
  })

  test("a superuser login is refused", async () => {
    const transport = new PostgresDirect({ dsn: SUPERUSER_DSN })
    try {
      const err = await transport.runQuery("SELECT 1").catch((e) => e)
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).kind).toBe("config")
    } finally {
      await transport.close()
    }
  })

  test("the dedicated login that is a member of nothing runs", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      const result = await transport.runQuery("SELECT 1 AS one")
      expect(result.rows).toEqual([{ one: 1 }])
    } finally {
      await transport.close()
    }
  })

  test("a login granted membership in a BYPASSRLS role is refused, and is accepted once the grant is revoked", async () => {
    await setupSql.unsafe(`GRANT liaison_admin TO ${TEST_LOGIN}`)
    const refused = new PostgresDirect({ dsn: DSN })
    try {
      expect(await refused.runQuery("SELECT 1").catch((e) => e)).toBeInstanceOf(DbTransportError)
    } finally {
      await refused.close()
      await setupSql.unsafe(`REVOKE liaison_admin FROM ${TEST_LOGIN}`)
    }
    const allowed = new PostgresDirect({ dsn: DSN })
    try {
      expect((await allowed.runQuery("SELECT 1 AS one")).rows).toEqual([{ one: 1 }])
    } finally {
      await allowed.close()
    }
  })

  test("a login that can run server programs or read server files is refused", async () => {
    for (const role of ["pg_execute_server_program", "pg_read_server_files"]) {
      await setupSql.unsafe(`GRANT ${role} TO ${TEST_LOGIN}`)
      const refused = new PostgresDirect({ dsn: DSN })
      try {
        const err = await refused.runQuery("SELECT 1").catch((e) => e)
        expect([role, err instanceof DbTransportError]).toEqual([role, true])
      } finally {
        await refused.close()
        await setupSql.unsafe(`REVOKE ${role} FROM ${TEST_LOGIN}`)
      }
    }
  })

  test("the operator opt-out lets the application login through", async () => {
    const transport = new PostgresDirect({ dsn: APP_DSN, allowPrivilegedSession: true })
    try {
      expect((await transport.runQuery("SELECT 1 AS one")).rows).toEqual([{ one: 1 }])
    } finally {
      await transport.close()
    }
  })
})

describe("PostgresDirect — TLS-by-resolved-IP refusal", () => {
  test("refuses a public-IP DSN without TLS param (fast-fail, no connection attempted)", async () => {
    const transport = new PostgresDirect({
      dsn: "postgres://user:pass@203.0.113.5:5432/db",
      resolveDns: async () => ["203.0.113.5"],
    })
    await expect(transport.runQuery("SELECT 1")).rejects.toThrow(/TLS is required/)
    await transport.close()
  })

  test("refuses a bare/.internal hostname that resolves (via DNS stub) to a public IP", async () => {
    const transport = new PostgresDirect({
      dsn: "postgres://user:pass@db.internal:5432/db",
      resolveDns: async () => ["203.0.113.9"],
    })
    await expect(transport.runQuery("SELECT 1")).rejects.toThrow(/TLS is required/)
    await transport.close()
  })

  test("accepts a loopback DSN without TLS", async () => {
    const transport = new PostgresDirect({
      dsn: DSN,
      resolveDns: async () => ["127.0.0.1"],
    })
    try {
      const result = await transport.runQuery("SELECT 1 AS one")
      expect(result.rows[0]?.one).toBe(1)
    } finally {
      await transport.close()
    }
  })

  test("LIAISON_DB_ALLOW_PLAINTEXT_LOCAL opt-in: off by default still allows loopback (the flag governs an explicit local-only exception, not a block)", async () => {
    const transportOff = new PostgresDirect({
      dsn: DSN,
      resolveDns: async () => ["127.0.0.1"],
      allowPlaintextLocal: false,
    })
    const transportOn = new PostgresDirect({
      dsn: DSN,
      resolveDns: async () => ["127.0.0.1"],
      allowPlaintextLocal: true,
    })
    try {
      await expect(transportOff.runQuery("SELECT 1")).resolves.toBeDefined()
      await expect(transportOn.runQuery("SELECT 1")).resolves.toBeDefined()
    } finally {
      await transportOff.close()
      await transportOn.close()
    }
  })
})

// The simple query protocol runs every statement in a string. A single lexer
// desync in the SQL guard (`a$$` read as a dollar quote, 2026-09-22) then let
// `...; COMMIT; <anything>` leave the READ ONLY transaction, the timeout and
// the row cap behind. Every execution is on the extended protocol now, so the
// SERVER refuses a second statement, whatever the guard thought.
describe("PostgresDirect — one statement per execution, enforced by the server", () => {
  const POC =
    "SELECT 1 AS a$$) x; COMMIT; SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS st FROM (SELECT 1 AS b$$"

  test("the reproduced guard-bypass PoC is refused by the database", async () => {
    const t = new PostgresDirect({ dsn: DSN })
    try {
      await expect(t.runQuery(POC)).rejects.toBeInstanceOf(DbTransportError)
    } finally {
      await t.close()
    }
  })

  test("a smuggled write after COMMIT never lands (runQuery called directly, guard bypassed)", async () => {
    const t = new PostgresDirect({ dsn: DSN })
    const before = await setupSql.unsafe(`SELECT count(*)::int AS n FROM ${SCRATCH_SCHEMA}.widgets`)
    try {
      await expect(
        t.runQuery(
          `SELECT 1 AS a$$) x; COMMIT; INSERT INTO ${SCRATCH_SCHEMA}.widgets (id, name) VALUES (9001, 'pwn'); SELECT 1 FROM (SELECT 1 AS b$$`,
        ),
      ).rejects.toBeInstanceOf(DbTransportError)
    } finally {
      await t.close()
    }
    const after = await setupSql.unsafe(`SELECT count(*)::int AS n FROM ${SCRATCH_SCHEMA}.widgets`)
    expect(after[0]?.n).toBe(before[0]?.n)
  })

  test("a parameterless catalog read with two statements is refused too", async () => {
    const t = new PostgresDirect({ dsn: DSN })
    try {
      await expect(
        t.runRead(
          // Balanced once wrapped by the row cap, so only the second
          // statement makes it fail.
          widgetsRead({
            sql: `SELECT id, name FROM ${SCRATCH_SCHEMA}.widgets) x; SELECT 1 AS id, 'x' AS name FROM (SELECT 1`,
          }),
          "two",
          {},
        ),
      ).rejects.toBeInstanceOf(DbTransportError)
    } finally {
      await t.close()
    }
  })
})

describe("PostgresDirect — TLS policy on every path, typed", () => {
  test("describe refuses plaintext to a public host like runQuery does", async () => {
    const t = new PostgresDirect({
      dsn: "postgres://user:pass@203.0.113.5:5432/db",
      resolveDns: async () => ["203.0.113.5"],
    })
    try {
      const err = await t.describe({ adapter: "t", reads: {} }).catch((e) => e)
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).kind).toBe("tls_required")
    } finally {
      await t.close()
    }
  })

  test("runQuery's refusal is a typed tls_required, not an untyped error", async () => {
    const t = new PostgresDirect({
      dsn: "postgres://user:pass@203.0.113.5:5432/db",
      resolveDns: async () => ["203.0.113.5"],
    })
    try {
      const err = await t.runQuery("SELECT 1").catch((e) => e)
      expect((err as DbTransportError).kind).toBe("tls_required")
    } finally {
      await t.close()
    }
  })
})

describe("PostgresDirect — connection string handling", () => {
  test("a key=value DSN is a typed config error that never quotes the password", () => {
    let err: unknown
    try {
      new PostgresDirect({ dsn: "host=h user=u password=SECRETPW dbname=d" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DbTransportError)
    expect((err as DbTransportError).kind).toBe("config")
    expect(String((err as Error).message)).not.toContain("SECRETPW")
  })

  test("statementTimeoutMs from the stored connection reaches SET LOCAL", async () => {
    const t = buildTransport({ connectionString: DSN, statementTimeoutMs: "1500" })
    try {
      const r = await t.runQuery("SELECT current_setting('statement_timeout') AS st")
      expect(r.rows[0]?.st).toBe("1500ms")
    } finally {
      await t.close()
    }
  })
})

// Live walk against the production warehouse: the tool gave up on a long query
// while the statement ran on in the database until its own timeout. A call's
// bound shortens the statement timeout, and its abort cancels the statement ON
// THE SERVER (checked in pg_stat_activity, not just by the promise settling).
describe("PostgresDirect — per-call bounds and server-side cancellation", () => {
  async function activeSleeps(marker: string): Promise<number> {
    const rows = await setupSql.unsafe(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE state = 'active' AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()`,
      [marker],
    )
    return Number(rows[0]?.n ?? 0)
  }

  test("an aborted call cancels its running statement on the server", async () => {
    const transport = new PostgresDirect({ dsn: DSN, statementTimeoutMs: 120_000 })
    const marker = `cancel_marker_${Date.now()}`
    try {
      const controller = new AbortController()
      const start = Date.now()
      const pending = transport
        .runQuery(`SELECT pg_sleep(30) AS ${marker}`, { signal: controller.signal })
        .catch((e) => e)
      // Wait until the statement is really running server side, then abort.
      for (let i = 0; i < 50 && (await activeSleeps(marker)) === 0; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(await activeSleeps(marker)).toBe(1)
      controller.abort()
      const err = await pending
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).kind).toBe("timeout")
      expect(Date.now() - start).toBeLessThan(5_000)
      expect(await activeSleeps(marker)).toBe(0)
      // The pooled connection is usable again right away.
      const ok = await transport.runQuery("SELECT 1 AS one")
      expect(ok.rows).toEqual([{ one: 1 }])
    } finally {
      await transport.close()
    }
  })

  test("a call already aborted never reaches the database", async () => {
    const transport = new PostgresDirect({ dsn: DSN })
    try {
      const controller = new AbortController()
      controller.abort()
      const err = await transport
        .runQuery("SELECT pg_sleep(5)", { signal: controller.signal })
        .catch((e) => e)
      expect((err as DbTransportError).kind).toBe("timeout")
    } finally {
      await transport.close()
    }
  })

  test("the call's bound shortens a longer configured statement timeout", async () => {
    const transport = new PostgresDirect({ dsn: DSN, statementTimeoutMs: 120_000 })
    try {
      const start = Date.now()
      const err = await transport
        .runQuery("SELECT pg_sleep(5)", { statementTimeoutMs: 300 })
        .catch((e) => e)
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).kind).toBe("timeout")
      expect((err as Error).message).toContain("300 ms statement timeout")
      expect(Date.now() - start).toBeLessThan(3_000)
    } finally {
      await transport.close()
    }
  })

  test("the call's bound never lengthens a shorter configured timeout", async () => {
    const transport = new PostgresDirect({ dsn: DSN, statementTimeoutMs: 1_500 })
    try {
      const r = await transport.runQuery("SELECT current_setting('statement_timeout') AS st", {
        statementTimeoutMs: 55_000,
      })
      expect(r.rows[0]?.st).toBe("1500ms")
    } finally {
      await transport.close()
    }
  })

  test("describe honours the bound too", async () => {
    const transport = new PostgresDirect({ dsn: DSN, statementTimeoutMs: 120_000 })
    try {
      const controller = new AbortController()
      controller.abort()
      const err = await transport
        .describe({ adapter: "t", reads: {} }, undefined, { signal: controller.signal })
        .catch((e) => e)
      expect((err as DbTransportError).kind).toBe("timeout")
    } finally {
      await transport.close()
    }
  })
})
