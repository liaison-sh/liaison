// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bridge unit tests (mock transport only — transports have their own
// integration tests). Covers: exactly-one-credential-mode validation (both
// negative AND the two positive paths, M3), disabled db_query, audit entry
// per call incl. outcome + on simulated error/blocked (M8), non-vacuous
// column projection, db_describe restricted to catalog tables +
// SECRET_COLUMNS-filtered (M1), db_probe parity with connect-time shape (M2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import {
  buildTransport,
  DatabaseConfigError,
  type DatabaseCredentials,
  resolveCredentialMode,
} from "~/modules/apps/connections/sql/credentials"
import { SqlPoolTestAccess } from "~/modules/apps/connections/sql/pool"
import type {
  DbTransport,
  ExecOptions,
  ProbeReport,
} from "~/modules/apps/connections/sql/transport"
import { DbTransportError } from "~/modules/apps/connections/sql/transport"
import { resolveToolTimeoutMs } from "~/modules/apps/run-limits"
import manifest from "./app.manifest.json"
import * as bridgeModule from "./bridge"
import { buildDatabaseBridgeMethods, type DatabaseBridgeDeps } from "./bridge"

const testCatalog: ReadCatalog = {
  adapter: "bridge-test",
  reads: {
    org_tier: {
      description: "org tier",
      domain: "licenses",
      sql: "SELECT tier FROM kernel.organizations WHERE slug = :slug",
      params: { slug: { type: "string" } },
      columns: ["tier", "id"],
      tables: ["kernel.organizations"],
    },
    recent_orgs: {
      description: "recent orgs",
      domain: "licenses",
      sql: "SELECT tier FROM kernel.organizations LIMIT :limit OFFSET :ratio",
      params: { limit: { type: "integer" }, ratio: { type: "number" } },
      columns: ["tier"],
      tables: ["kernel.organizations"],
    },
  },
}

class MockTransport implements DbTransport {
  public probeReport: ProbeReport = { ok: true, mode: "direct", warnings: [] }
  public rowsToReturn: Record<string, unknown>[] = [
    { tier: "pro", id: "org-1", credentials_encrypted: "leak" },
  ]
  public runReadCalls = 0
  public lastReadParams: Record<string, unknown> | undefined
  public throwOnRunRead: Error | undefined

  async probe(): Promise<ProbeReport> {
    return this.probeReport
  }
  async runRead(_read: unknown, _name: string, params: Record<string, unknown>) {
    this.runReadCalls++
    this.lastReadParams = params
    if (this.throwOnRunRead) throw this.throwOnRunRead
    // Deliberately returns MORE than the allow-list (id, credentials_encrypted
    // extra) — non-vacuous column-projection fixture (M4). The bridge itself
    // doesn't re-project (that's the transport's job per Task 3) — this test
    // asserts the transport's job is trusted/passed through faithfully, and a
    // separate transport-level test (postgres-direct.test.ts) proves the
    // projection itself is non-vacuous.
    return { rows: this.rowsToReturn, truncated: false, durationMs: 5 }
  }
  async runQuery(
    _sql?: string,
    _opts?: ExecOptions,
  ): Promise<{
    rows: Record<string, unknown>[]
    truncated: boolean
    durationMs: number
  }> {
    return { rows: [{ one: 1 }], truncated: false, durationMs: 3 }
  }
  async describe(_catalog: ReadCatalog, table?: string) {
    // Discovery-shaped mock: the transport returns the role's readable tables
    // (grant-based). A table it has no grant on returns nothing (→ the bridge's
    // table_not_readable guidance path).
    const readable: Record<string, { column: string; dataType: string }[]> = {
      "kernel.organizations": [
        { column: "id", dataType: "uuid" },
        { column: "tier", dataType: "text" },
        { column: "settings", dataType: "jsonb" }, // secret column — belt-filtered by the bridge
      ],
      "app_tickets.tickets": [
        { column: "id", dataType: "uuid" },
        { column: "status", dataType: "text" },
      ],
    }
    const entries = table
      ? Object.entries(readable).filter(([t]) => t === table || t.endsWith(`.${table}`))
      : Object.entries(readable)
    return { tables: entries.map(([t, columns]) => ({ table: t, columns })) }
  }
  async close() {}
}

interface AuditCall {
  action: string
  outcome: string
  metadata: Record<string, unknown>
}

function makeDeps(overrides: Partial<DatabaseBridgeDeps> = {}) {
  const transport = new MockTransport()
  const auditCalls: AuditCall[] = []
  const deps: DatabaseBridgeDeps = {
    orgId: "org-1",
    callerScopes: ["database:reads:read", "database:query:read"],
    resolveCredentials: async () => ({ connectionString: "postgres://x:y@localhost/db" }),
    transportFactory: () => transport,
    resolveCatalog: () => testCatalog,
    writeAudit: async (entry) => {
      auditCalls.push(entry)
    },
    ...overrides,
  }
  return { deps, transport, auditCalls }
}

beforeEach(() => {
  SqlPoolTestAccess.reset()
})
afterEach(() => {
  SqlPoolTestAccess.reset()
})

describe("resolveCredentialMode — exactly-one-mode validation", () => {
  test("both connectionString and gateUrl set -> typed config error", () => {
    expect(() =>
      resolveCredentialMode({ connectionString: "dsn", gateUrl: "http://gate", gateToken: "tok" }),
    ).toThrow(DatabaseConfigError)
  })

  test("neither set -> typed config error", () => {
    expect(() => resolveCredentialMode({})).toThrow(DatabaseConfigError)
  })

  test("DSN-only (positive path, M3) -> direct mode, gate fields untouched", () => {
    const creds = { connectionString: "postgres://x:y@localhost/db" }
    const mode = resolveCredentialMode(creds)
    expect(mode).toBe("direct")
    expect(creds).not.toHaveProperty("gateUrl")
    expect(creds).not.toHaveProperty("gateToken")
  })

  test("gate-only (positive path, M3) -> gate mode, connectionString untouched", () => {
    const creds = { gateUrl: "https://gate.example.com", gateToken: "a".repeat(40) }
    const mode = resolveCredentialMode(creds)
    expect(mode).toBe("gate")
    expect(creds).not.toHaveProperty("connectionString")
  })

  test("gate mode missing gateToken -> typed config error", () => {
    expect(() => resolveCredentialMode({ gateUrl: "https://gate.example.com" })).toThrow(
      DatabaseConfigError,
    )
  })
})

describe("db_list_reads", () => {
  test("returns the catalog shape and writes an audit entry", async () => {
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_list_reads("{}"))
    expect(result.adapter).toBe("bridge-test")
    expect(result.reads.org_tier).toBeDefined()
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe("success")
  })
})

describe("db_read", () => {
  test("happy path returns rows and writes a success audit entry with metadata", async () => {
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_read(JSON.stringify({ name: "org_tier", params: { slug: "acme" } })),
    )
    expect(result.rows).toBeDefined()
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe("success")
    expect(auditCalls[0].metadata.read).toBe("org_tier")
    expect(auditCalls[0].metadata.rowCount).toBe(1)
  })

  // A read called without one of its declared params bound `undefined` into the SQL, and
  // postgres.js refused the query with UNDEFINED_VALUE (an opaque 500 to the agent).
  test("a missing or mistyped declared param is refused before the query, naming the param", async () => {
    const { deps, transport, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const missing = JSON.parse(await methods.db_read(JSON.stringify({ name: "org_tier" })))
    expect(missing.error.code).toBe("invalid_params")
    expect(missing.error.params).toEqual([
      expect.objectContaining({ name: "slug", expected: "string" }),
    ])
    expect(missing.error.message).toContain("slug")
    const mistyped = JSON.parse(
      await methods.db_read(JSON.stringify({ name: "org_tier", params: { slug: 42 } })),
    )
    expect(mistyped.error.code).toBe("invalid_params")
    expect(transport.runReadCalls).toBe(0)
    expect(auditCalls.map((a) => a.outcome)).toEqual(["blocked", "blocked"])
    expect(auditCalls[0].metadata.redactedReason).toBe("invalid_params")
  })

  // Models often send numbers as strings ("10"). A numeric string for a
  // number/integer param is the number the caller meant, not an error.
  test("a numeric string for an integer or number param is coerced; a non-numeric one is refused", async () => {
    const { deps, transport } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const ok = JSON.parse(
      await methods.db_read(
        JSON.stringify({ name: "recent_orgs", params: { limit: "10", ratio: " 0.5 " } }),
      ),
    )
    expect(ok.error).toBeUndefined()
    expect(transport.lastReadParams).toMatchObject({ limit: 10, ratio: 0.5 })
    for (const bad of [
      { limit: "ten", ratio: 1 },
      { limit: "1.5", ratio: 1 },
      { limit: "", ratio: 1 },
      { limit: 1, ratio: "abc" },
    ]) {
      const refused = JSON.parse(
        await methods.db_read(JSON.stringify({ name: "recent_orgs", params: bad })),
      )
      expect(refused.error?.code).toBe("invalid_params")
    }
    expect(transport.runReadCalls).toBe(1)
  })

  test("unknown read name -> blocked outcome, audit still fires (M8)", async () => {
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_read(JSON.stringify({ name: "nonexistent" })))
    expect(result.error.code).toBe("unknown_read")
    expect(result.error.validNames).toContain("org_tier")
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe("blocked")
  })

  test("transport throw -> error outcome, audit still fires with sqlHash-style redactedReason not raw detail (M8)", async () => {
    const { deps, transport, auditCalls } = makeDeps()
    const { DbTransportError } = await import("~/modules/apps/connections/sql/transport")
    transport.throwOnRunRead = new DbTransportError("permission denied", "execution", "42501")
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_read(JSON.stringify({ name: "org_tier", params: { slug: "x" } })),
    )
    expect(result.error).toBeDefined()
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe("error")
    expect(auditCalls[0].metadata.redactedReason).toBe("execution")
  })

  test("a param the database cannot cast (a slug for a uuid id) is invalid_params, not an execution fault", async () => {
    // A curated read binding `WHERE id = :id` against a uuid column, called
    // with a product slug: Postgres raises 22P02. Answered as `execution` it
    // surfaced as HTTP 500 plus an error-level log for a caller mistake.
    const { deps, transport } = makeDeps()
    transport.throwOnRunRead = new DbTransportError(
      'invalid input syntax for type uuid: "acmesound"',
      "execution",
      "22P02",
    )
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_read(JSON.stringify({ name: "org_tier", params: { slug: "acmesound" } })),
    )
    expect(result.error.code).toBe("invalid_params")
    expect(result.error.message).toContain('invalid input syntax for type uuid: "acmesound"')
    expect(result.error.message).toContain("UUID")
  })

  // The "not connected" fallback (NOT_CONNECTED_ERROR) is reached when the
  // caught error is neither a DatabaseConfigError nor a DbTransportError —
  // this happens for real in production when `getCredentialsForConnection`
  // throws a plain Error because no `database` connected account exists yet
  // for this org. Reachable, not dead code: exercise it directly.
  test("resolveCredentials throws a generic (non-typed) Error -> not_connected fallback, audit fires with error outcome", async () => {
    const { deps, auditCalls } = makeDeps({
      resolveCredentials: async () => {
        throw new Error("no connected account found for app 'database'")
      },
    })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_read(JSON.stringify({ name: "org_tier", params: { slug: "x" } })),
    )
    expect(result.error.code).toBe("not_connected")
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe("error")
  })
})

describe("db_describe — discovery (grant-grounded) + SECRET_COLUMNS belt", () => {
  test("no argument lists every readable table (discovery map)", async () => {
    const { deps } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_describe("{}"))
    const tables = result.tables.map((t: { table: string }) => t.table)
    expect(tables).toContain("kernel.organizations")
    expect(tables).toContain("app_tickets.tickets")
  })

  test("a table with no grant returns table_not_readable + the readable-table list", async () => {
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_describe(JSON.stringify({ table: "kernel.users" })))
    expect(result.error.code).toBe("table_not_readable")
    expect(result.error.readableTables).toContain("kernel.organizations")
    expect(auditCalls[0].outcome).toBe("blocked")
  })

  test("a readable table's secret column (settings) is belt-filtered from the result", async () => {
    const { deps } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_describe(JSON.stringify({ table: "kernel.organizations" })),
    )
    const columnNames = result.tables[0].columns.map((c: { column: string }) => c.column)
    expect(columnNames).toContain("tier")
    expect(columnNames).not.toContain("settings")
  })
})

describe("db_probe", () => {
  test("returns the same shape a connect-time probe would produce (M2)", async () => {
    const { deps, transport } = makeDeps()
    transport.probeReport = { ok: true, mode: "direct", warnings: [] }
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_probe("{}"))
    expect(result).toEqual({ ok: true, mode: "direct", warnings: [] })
  })

  test("dirty probe -> blocked outcome audited", async () => {
    const { deps, transport, auditCalls } = makeDeps()
    transport.probeReport = {
      ok: false,
      mode: "direct",
      writeGrantsDetected: true,
      warnings: ["has write grants"],
    }
    const methods = buildDatabaseBridgeMethods(deps)
    await methods.db_probe("{}")
    expect(auditCalls[0].outcome).toBe("blocked")
  })
})

describe("db_query — enabled by default, explicit opt-out only", () => {
  const originalFlag = process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    else process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY = originalFlag
  })

  test("no env flag -> ENABLED (a valid SELECT runs, not a disabled error)", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(result.error).toBeUndefined()
    expect(result.rows).toBeDefined()
    expect(auditCalls[0].outcome).toBe("success")
  })

  test('explicit "false" -> typed disabled error, audit fires with blocked outcome', async () => {
    process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY = "false"
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(result.error.code).toBe("disabled")
    expect(auditCalls[0].outcome).toBe("blocked")
  })

  test("enabled + hostile SQL -> sql-guard rejection, blocked outcome, sqlHash not raw SQL in metadata", async () => {
    process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY = "true"
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_query(JSON.stringify({ sql: "INSERT INTO t VALUES (1)" })),
    )
    expect(result.error).toBeDefined()
    expect(auditCalls[0].outcome).toBe("blocked")
  })

  test("enabled + valid SELECT -> success, sqlHash recorded not raw SQL", async () => {
    process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY = "true"
    const { deps, auditCalls } = makeDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(result.rows).toBeDefined()
    expect(auditCalls[0].outcome).toBe("success")
    expect(auditCalls[0].metadata.sqlHash).toBeDefined()
    expect(JSON.stringify(auditCalls[0].metadata)).not.toContain("SELECT 1")
  })
})

// A second, named connection ("warehouse"): db_query / db_describe / db_probe
// take an optional `connection` param. Absent means the default connection,
// resolved and pooled exactly as before.
describe("connection targeting — default unchanged, warehouse selectable", () => {
  class WarehouseTransport extends MockTransport {
    override async runQuery() {
      return { rows: [{ from: "warehouse" }], truncated: false, durationMs: 1 }
    }
    override async describe() {
      return { tables: [{ table: "dwh.fact", columns: [{ column: "id", dataType: "bigint" }] }] }
    }
  }

  function makeTwoConnectionDeps(
    warehouseCreds: DatabaseCredentials = {
      connectionString: "postgres://ro:pw@127.0.0.9:5439/wh",
      dialect: "redshift",
    },
  ) {
    const resolved: string[] = []
    const built: DatabaseCredentials[] = []
    const defaultTransport = new MockTransport()
    const warehouseTransport = new WarehouseTransport()
    const { deps, auditCalls } = makeDeps({
      resolveCredentials: async (connection) => {
        resolved.push(connection)
        return connection === "warehouse"
          ? warehouseCreds
          : { connectionString: "postgres://x:y@localhost/db" }
      },
      transportFactory: (creds) => {
        built.push(creds)
        return creds.dialect === "redshift" ? warehouseTransport : defaultTransport
      },
    })
    return { deps, auditCalls, resolved, built }
  }

  test("no connection param resolves the default connection; audit metadata unchanged", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const { deps, auditCalls, resolved } = makeTwoConnectionDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(result.rows).toEqual([{ one: 1 }])
    expect(resolved).toEqual(["default"])
    expect(auditCalls[0].metadata).not.toHaveProperty("connection")
  })

  test('connection: "warehouse" runs db_query on the warehouse transport, audited as such', async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const { deps, auditCalls, resolved } = makeTwoConnectionDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_query(JSON.stringify({ sql: "SELECT 1", connection: "warehouse" })),
    )
    expect(result.rows).toEqual([{ from: "warehouse" }])
    expect(resolved).toEqual(["warehouse"])
    expect(auditCalls[0].metadata.connection).toBe("warehouse")
  })

  test("the two connections are pooled apart: warehouse then default builds two transports", async () => {
    const { deps, built } = makeTwoConnectionDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const wh = JSON.parse(await methods.db_describe(JSON.stringify({ connection: "warehouse" })))
    const def = JSON.parse(await methods.db_describe("{}"))
    expect(wh.tables.map((t: { table: string }) => t.table)).toEqual(["dwh.fact"])
    expect(def.tables.map((t: { table: string }) => t.table)).toContain("kernel.organizations")
    expect(built).toHaveLength(2)
  })

  test("db_probe targets the named connection", async () => {
    const { deps, resolved, auditCalls } = makeTwoConnectionDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    await methods.db_probe(JSON.stringify({ connection: "warehouse" }))
    await methods.db_probe("{}")
    expect(resolved).toEqual(["warehouse", "default"])
    expect(auditCalls.map((a) => a.metadata)).toEqual([{ connection: "warehouse" }, {}])
  })

  test("an unknown connection is refused, never routed to the default", async () => {
    const { deps, resolved, auditCalls } = makeTwoConnectionDeps()
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_query(JSON.stringify({ sql: "SELECT 1", connection: "replica2" })),
    )
    expect(result.error.code).toBe("unknown_connection")
    expect(resolved).toEqual([])
    expect(auditCalls[0].outcome).toBe("blocked")
  })

  test("the warehouse connection is direct only: gate credentials are a config error", async () => {
    const { deps } = makeTwoConnectionDeps({ gateUrl: "https://gate", gateToken: "t" })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_describe(JSON.stringify({ connection: "warehouse" })),
    )
    expect(result.error.code).toBe("config_error")
  })
})

describe("buildTransport — dialect and statement timeout from the stored connection", () => {
  test("an unknown dialect is a config error", () => {
    expect(() =>
      buildTransport({ connectionString: "postgres://x:y@localhost/db", dialect: "mysql" }),
    ).toThrow(DatabaseConfigError)
  })

  test("statementTimeoutMs outside 1 s to 300 s is a config error", () => {
    for (const statementTimeoutMs of ["500", "300001", "ten"]) {
      expect(() =>
        buildTransport({ connectionString: "postgres://x:y@localhost/db", statementTimeoutMs }),
      ).toThrow(DatabaseConfigError)
    }
  })
})

describe("warehouse scope — describe and probe need database:query:read too", () => {
  test("a caller with curated reads only cannot describe or probe the warehouse", async () => {
    const resolved: string[] = []
    const { deps, auditCalls } = makeDeps({
      callerScopes: ["database:reads:read"],
      resolveCredentials: async (connection) => {
        resolved.push(connection)
        return { connectionString: "postgres://x:y@localhost/db" }
      },
    })
    const methods = buildDatabaseBridgeMethods(deps)
    const described = JSON.parse(
      await methods.db_describe(JSON.stringify({ connection: "warehouse" })),
    )
    const probed = JSON.parse(await methods.db_probe(JSON.stringify({ connection: "warehouse" })))
    expect(described.error.code).toBe("forbidden")
    expect(probed.error.code).toBe("forbidden")
    expect(resolved).toEqual([])
    expect(auditCalls.map((a) => a.outcome)).toEqual(["blocked", "blocked"])
  })

  test("the same caller still describes the default connection", async () => {
    const { deps } = makeDeps({ callerScopes: ["database:reads:read"] })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_describe("{}"))
    expect(result.tables).toBeDefined()
  })

  test("a wildcard grant (the connect-event auto-probe runs with database:*) passes", async () => {
    const { deps } = makeDeps({ callerScopes: ["database:*"] })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_probe(JSON.stringify({ connection: "warehouse" })))
    expect(result.ok).toBe(true)
  })
})

describe("transport pool follows the stored credentials", () => {
  test("a changed credential builds a new transport and closes the old one, no restart", async () => {
    let dsn = "postgres://x:y@localhost/one"
    const built: string[] = []
    const closed: string[] = []
    const { deps } = makeDeps({
      resolveCredentials: async () => ({ connectionString: dsn }),
      transportFactory: (creds) => {
        const t = new MockTransport()
        const tag = creds.connectionString ?? ""
        built.push(tag)
        t.close = async () => {
          closed.push(tag)
        }
        return t
      },
    })
    const methods = buildDatabaseBridgeMethods(deps)
    await methods.db_probe("{}")
    await methods.db_probe("{}")
    dsn = "postgres://x:y@localhost/two"
    await methods.db_probe("{}")
    expect(built).toEqual(["postgres://x:y@localhost/one", "postgres://x:y@localhost/two"])
    expect(closed).toEqual(["postgres://x:y@localhost/one"])
  })
})

describe("configuration errors reach the agent without internals", () => {
  test("an adapter path in a config error stays in the log, the agent gets a generic hint", async () => {
    const { deps } = makeDeps({
      resolveCatalog: () => {
        throw new DatabaseConfigError(
          'LIAISON_DATABASE_ADAPTER_PATH="/srv/secret/adapter.yaml" is not readable',
        )
      },
    })
    const methods = buildDatabaseBridgeMethods(deps)
    for (const out of [
      await methods.db_describe("{}"),
      await methods.db_list_reads("{}"),
      await methods.db_read(JSON.stringify({ name: "org_tier" })),
    ]) {
      expect(JSON.parse(out).error.code).toBe("config_error")
      expect(out).not.toContain("/srv/secret")
    }
  })

  test("a key=value DSN is a config_error whose message never carries the password", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const { deps } = makeDeps({
      resolveCredentials: async () => ({
        connectionString: "host=h user=u password=SECRETPW dbname=d",
      }),
      transportFactory: buildTransport,
    })
    const methods = buildDatabaseBridgeMethods(deps)
    const out = await methods.db_query(JSON.stringify({ sql: "SELECT 1" }))
    expect(JSON.parse(out).error.code).toBe("config_error")
    expect(out).not.toContain("SECRETPW")
  })
})

describe("db_query on the warehouse — the timeout wall cannot be reset from SQL", () => {
  test('set_config("statement_timeout") is refused before any credential is resolved', async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const resolved: string[] = []
    const { deps, auditCalls } = makeDeps({
      resolveCredentials: async (connection) => {
        resolved.push(connection)
        return { connectionString: "postgres://x:y@localhost/db" }
      },
    })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(
      await methods.db_query(
        JSON.stringify({
          sql: `SELECT "pg_catalog"."set_config"('statement_timeout', '0', true)`,
          connection: "warehouse",
        }),
      ),
    )
    expect(result.error.code).toBe("dangerous_function")
    expect(resolved).toEqual([])
    expect(auditCalls[0].outcome).toBe("blocked")
  })
})

// Live walk against the production warehouse (statement timeout 120 s): db_query
// declared no budget, so the sandbox's 5 s production default applied. The tool
// answered "timed out, retry once" after ~8 s and the query ran on in Redshift
// until ITS timeout stopped it, holding a pooled connection throughout.
describe("the tool budget covers the database call", () => {
  const DB_TOOLS = ["db_read", "db_describe", "db_probe", "db_query"] as const
  const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv

  test("every db tool that reaches the database declares the bridge's budget", () => {
    const tools = manifest.tools as Record<string, { timeoutMs?: number }>
    expect(typeof (bridgeModule as Record<string, unknown>).DATABASE_TOOL_TIMEOUT_MS).toBe("number")
    for (const name of DB_TOOLS) {
      expect({ name, timeoutMs: tools[name]?.timeoutMs }).toEqual({
        name,
        timeoutMs: (bridgeModule as Record<string, unknown>).DATABASE_TOOL_TIMEOUT_MS as number,
      })
    }
  })

  test("in production the statement timeout and the host deadline both fall inside the sandbox budget", () => {
    const declared = (manifest.tools as Record<string, { timeoutMs?: number }>).db_query?.timeoutMs
    const granted = resolveToolTimeoutMs(declared, PROD)
    expect(granted).toBeDefined()
    const resolve = (bridgeModule as Record<string, unknown>).resolveDatabaseCallBudget as
      | ((env: NodeJS.ProcessEnv) => { statementTimeoutMs: number; deadlineMs: number })
      | undefined
    expect(typeof resolve).toBe("function")
    const budget = resolve?.(PROD)
    expect(budget?.statementTimeoutMs).toBeLessThan(budget?.deadlineMs ?? 0)
    expect(budget?.deadlineMs).toBeLessThan(granted ?? 0)
  })

  test("a lower sandbox cap lowers the call's bounds with it", () => {
    const resolve = (bridgeModule as Record<string, unknown>).resolveDatabaseCallBudget as
      | ((env: NodeJS.ProcessEnv) => { statementTimeoutMs: number; deadlineMs: number })
      | undefined
    const budget = resolve?.({ ...PROD, LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS: "20000" })
    expect(budget?.deadlineMs).toBeLessThan(20_000)
    expect(budget?.statementTimeoutMs).toBeLessThan(budget?.deadlineMs ?? 0)
  })
})

describe("a call that outlives its budget is stopped and cancelled, not abandoned", () => {
  /** A warehouse that answers after `answerAfterMs` unless the call is aborted,
   *  in which case it records the cancel and rejects the way postgres.js does. */
  class SlowTransport extends MockTransport {
    public seen: ExecOptions | undefined
    public cancelled = false
    constructor(private readonly answerAfterMs: number) {
      super()
    }
    override async runQuery(_sql: string, opts?: ExecOptions) {
      this.seen = opts
      return new Promise<{
        rows: Record<string, unknown>[]
        truncated: boolean
        durationMs: number
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ rows: [{ late: true }], truncated: false, durationMs: 0 }),
          this.answerAfterMs,
        )
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          this.cancelled = true
          reject(new DbTransportError("Query cancelled on the database", "timeout", "57014"))
        })
      })
    }
  }

  test("at the deadline the bridge answers statement_timeout, non-retryable, and the statement is cancelled", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const slow = new SlowTransport(1_500)
    const { deps, auditCalls } = makeDeps({
      transportFactory: () => slow,
      budget: { statementTimeoutMs: 100, deadlineMs: 200 },
    } as Partial<DatabaseBridgeDeps>)
    const methods = buildDatabaseBridgeMethods(deps)
    const start = Date.now()
    const result = JSON.parse(
      await methods.db_query(JSON.stringify({ sql: "SELECT 1", connection: "warehouse" })),
    )
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(result.error?.code).toBe("statement_timeout")
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toMatch(/Do not retry the same SQL/)
    expect(result.error?.message).toMatch(/hub/)
    expect(slow.cancelled).toBe(true)
    expect(slow.seen?.statementTimeoutMs).toBe(100)
    expect(auditCalls[0]?.outcome).toBe("error")
  })

  test("the caller's abort cancels the running statement too", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const slow = new SlowTransport(1_500)
    const caller = new AbortController()
    const { deps } = makeDeps({
      transportFactory: () => slow,
      signal: caller.signal,
      budget: { statementTimeoutMs: 10_000, deadlineMs: 10_000 },
    } as Partial<DatabaseBridgeDeps>)
    const methods = buildDatabaseBridgeMethods(deps)
    setTimeout(() => caller.abort(), 100)
    const start = Date.now()
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(result.error?.code).toBe("statement_timeout")
    expect(slow.cancelled).toBe(true)
  })

  test("at the deadline the bridge answers only once the cancelled statement has stopped", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    // The server takes 300 ms to act on the cancel, as a real CancelRequest does.
    class SlowCancel extends MockTransport {
      stopped = false
      override async runQuery(_sql: string, opts?: ExecOptions) {
        return new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              this.stopped = true
              reject(new DbTransportError("Query cancelled on the database", "timeout", "57014"))
            }, 300)
          })
        })
      }
    }
    const transport = new SlowCancel()
    const { deps } = makeDeps({
      transportFactory: () => transport,
      budget: { statementTimeoutMs: 100, deadlineMs: 200 },
    } as Partial<DatabaseBridgeDeps>)
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(transport.stopped).toBe(true)
    expect(result.error?.code).toBe("statement_timeout")
  })

  test("a cancel that never lands still answers within the grace", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    class NeverStops extends MockTransport {
      override async runQuery(): Promise<never> {
        return new Promise<never>(() => {})
      }
    }
    const { deps } = makeDeps({
      transportFactory: () => new NeverStops(),
      budget: { statementTimeoutMs: 100, deadlineMs: 200 },
    } as Partial<DatabaseBridgeDeps>)
    const methods = buildDatabaseBridgeMethods(deps)
    const start = Date.now()
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(result.error?.code).toBe("statement_timeout")
  })

  test("a statement timeout raised by the database is non-retryable and says how to narrow the query", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    class TimesOut extends MockTransport {
      override async runQuery(): Promise<never> {
        throw new DbTransportError(
          "Query exceeded the 55000 ms statement timeout and was cancelled on the database (raw_query)",
          "timeout",
          "57014",
        )
      }
    }
    const { deps } = makeDeps({ transportFactory: () => new TimesOut() })
    const methods = buildDatabaseBridgeMethods(deps)
    const result = JSON.parse(await methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
    expect(result.error?.code).toBe("statement_timeout")
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toMatch(/55000 ms statement timeout/)
    expect(result.error?.message).toMatch(/aggregate/)
  })
})

// Live walk: db_describe with no table returned every column of 165 warehouse
// tables (~121 KB) and the result was truncated.
describe("db_describe without a table is a compact listing", () => {
  class WideWarehouse extends MockTransport {
    public describedTable: string | undefined = "unset"
    override async describe(_catalog: ReadCatalog, table?: string) {
      this.describedTable = table
      const tables = []
      for (const schema of ["dwh", "staging"]) {
        for (let i = 0; i < 80; i++) {
          tables.push({
            table: `${schema}.table_${String(i).padStart(3, "0")}`,
            columns: Array.from({ length: 30 }, (_, c) => ({
              column: `a_rather_long_column_name_${c}`,
              dataType: "character varying",
            })),
          })
        }
      }
      return { tables: table ? tables.filter((t) => t.table === table) : tables }
    }
  }

  function wideDeps() {
    const wh = new WideWarehouse()
    const { deps } = makeDeps({ transportFactory: () => wh })
    return { methods: buildDatabaseBridgeMethods(deps), wh }
  }

  test("lists every table with its column count, never the columns", async () => {
    const { methods } = wideDeps()
    const out = await methods.db_describe(JSON.stringify({ connection: "warehouse" }))
    const result = JSON.parse(out)
    expect(result.tables).toHaveLength(160)
    expect(result.tables[0]).toEqual({ table: "dwh.table_000", columnCount: 30 })
    expect(out).not.toContain("a_rather_long_column_name")
    expect(out.length).toBeLessThan(12_000)
    expect(result.hint).toMatch(/table: "schema.table"/)
  })

  test("schema and search narrow the listing, case-insensitively", async () => {
    const { methods } = wideDeps()
    const bySchema = JSON.parse(
      await methods.db_describe(JSON.stringify({ connection: "warehouse", schema: "STAGING" })),
    )
    expect(bySchema.tables).toHaveLength(80)
    expect(bySchema.tables.every((t: { table: string }) => t.table.startsWith("staging."))).toBe(
      true,
    )
    const bySearch = JSON.parse(
      await methods.db_describe(JSON.stringify({ connection: "warehouse", search: "TABLE_07" })),
    )
    expect(bySearch.tables.map((t: { table: string }) => t.table)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `dwh.table_07${i}`),
      ...Array.from({ length: 10 }, (_, i) => `staging.table_07${i}`),
    ])
    const none = JSON.parse(
      await methods.db_describe(JSON.stringify({ connection: "warehouse", search: "nope" })),
    )
    expect(none.tables).toEqual([])
    expect(none.hint).toMatch(/No readable table matched/)
  })

  test("a named table still returns its columns and types", async () => {
    const { methods, wh } = wideDeps()
    const result = JSON.parse(
      await methods.db_describe(
        JSON.stringify({ connection: "warehouse", table: "dwh.table_005" }),
      ),
    )
    expect(wh.describedTable).toBe("dwh.table_005")
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0].columns).toHaveLength(30)
    expect(result.tables[0].columns[0]).toEqual({
      column: "a_rather_long_column_name_0",
      dataType: "character varying",
    })
  })
})
