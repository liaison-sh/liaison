// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App integration tests (real discovery + execute-tool pipeline): tool
// visible to an org, scope enforcement (actor missing database:query:read
// rejected pre-handler), db_read happy path through the full
// sandbox->bridge->transport chain against the real test PG, credentials
// absent -> typed "not connected" guidance error, db_probe callable
// post-connect and surfaces warnings.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import databaseManifest from "~/apps/database/app.manifest.json"
import { DatabaseBridgeTestAccess } from "~/apps/database/bridge"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import {
  connectionConfigRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const EXPECTED_TOOLS = ["db_list_reads", "db_read", "db_describe", "db_probe", "db_query"]

let TEST_ORG: string
let TEST_USER: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `database-app-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'DatabaseAppOrg', ${slug})
          RETURNING id`,
    ),
  )
  TEST_ORG = org?.id ?? ""

  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
          (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${TEST_ORG}::uuid,
                  ${`alice-db-app-${Date.now()}@database-app.test`},
                  'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  TEST_USER = u?.id ?? ""

  await ensureAppsForOrg(TEST_ORG)
}, 120_000) // queued behind the cross-file test lock when the whole directory runs

afterAll(async () => {
  resetAppRegistries()
  await releaseTestLock()
})

async function seedDatabaseCredentials(connectionString: string): Promise<void> {
  const credentialsJson = JSON.stringify({ connectionString })
  const encrypted = encryptSecret(
    credentialsJson,
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountCredentials,
  )
  await db.execute(
    drizzleSql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, access_token_encrypted, refresh_token_encrypted, credentials_encrypted,
         status, created_by)
        VALUES (
          ${TEST_ORG}::uuid, 'database', 'database', 'org', NULL, 'credentials',
          'default', NULL, NULL, ${encrypted}, 'active', ${TEST_USER}::uuid
        )
        ON CONFLICT DO NOTHING`,
  )
}

// These suites connect the connector to the test database as the application's
// own login, which can reach the privileged roles. That is exactly what the
// transport's pre-flight refuses, so they take the operator opt-out; the
// refusal itself is covered in transports/postgres-direct*.test.ts.
const priorAllowPrivileged = process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION
beforeAll(() => {
  process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = "true"
})
afterAll(() => {
  if (priorAllowPrivileged === undefined) delete process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION
  else process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION = priorAllowPrivileged
})

describe("database app registration + tool discovery", () => {
  it("all 5 database tools are registered in toolRegistry", () => {
    for (const toolName of EXPECTED_TOOLS) {
      const entry = toolRegistry.get([TEST_ORG, "database", toolName])
      expect(entry, `Tool '${toolName}' should be registered`).toBeDefined()
      expect(entry?.appName).toBe("database")
    }
  })

  it("db_query has scope database:query:read, curated tools have database:reads:read", () => {
    expect(toolRegistry.get([TEST_ORG, "database", "db_query"])?.requiredScopes).toEqual([
      "database:query:read",
    ])
    for (const toolName of ["db_list_reads", "db_read", "db_describe", "db_probe"]) {
      expect(toolRegistry.get([TEST_ORG, "database", toolName])?.requiredScopes).toEqual([
        "database:reads:read",
      ])
    }
  })

  it("connectionConfigRegistry has 'database' connection with 3 credential fields", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "database", "database"])
    expect(config).toBeDefined()
    expect(config?.type).toBe("credentials")
    const fieldNames = (config?.credentialFields ?? []).map((f) => f.name)
    expect(fieldNames).toContain("connectionString")
    expect(fieldNames).toContain("gateUrl")
    expect(fieldNames).toContain("gateToken")
  })
})

describe("database app — scope enforcement", () => {
  it("actor with database:reads:read but NOT database:query:read calling db_query is rejected pre-handler", async () => {
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    await expect(
      executeTool({
        toolName: "database:db_query",
        orgId: TEST_ORG,
        actor,
        params: { sql: "SELECT 1" },
      }),
    ).rejects.toThrow()
  })
})

describe("database app — credentials absent", () => {
  it("db_list_reads works without credentials (no transport needed)", async () => {
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    const out = await executeTool({
      toolName: "database:db_list_reads",
      orgId: TEST_ORG,
      actor,
      params: {},
    })
    const data = out.data as { adapter: string; reads: Record<string, unknown> }
    expect(data.adapter).toBe("liaison-self")
    expect(Object.keys(data.reads).length).toBeGreaterThan(0)
  })

  it("db_read without a connected account answers a typed not_connected envelope, not a stack trace", async () => {
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    // "Nothing is connected yet" is the NORMAL state of a fresh install, not a
    // server fault, so execute-tool deliberately rides the connector's
    // `{error:{code,message}}` envelope back as the tool's ANSWER with a 200
    // rather than throwing a 500 (`isNotConnectedToolErrorCode`, and its own
    // `not-connected-tool-result.test.ts`). This test asserted the older
    // throwing behaviour and had been failing ever since that changed. What
    // matters either way is the same and is what is asserted here: a typed
    // code an agent can act on plus guidance, never a stack trace.
    const out = await executeTool({
      toolName: "database:db_read",
      orgId: TEST_ORG,
      actor,
      params: { name: "org_tier_and_slug", params: { slug: "acme" } },
    })
    const data = out.data as { error?: { code?: string; message?: string }; rows?: unknown[] }
    expect(data.rows).toBeUndefined()
    expect(data.error?.code).toBe("not_connected")
    expect(data.error?.message ?? "").toMatch(/database connection/i)
  })
})

describe("database app — db_read happy path through sandbox->bridge->transport", () => {
  const DSN =
    process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"

  it("returns the seeded org's tier via the full pipeline", async () => {
    await seedDatabaseCredentials(DSN)
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    const out = await executeTool({
      toolName: "database:db_read",
      orgId: TEST_ORG,
      actor,
      params: { name: "org_tier_and_slug", params: { slug: await orgSlug() } },
    })
    const data = out.data as { rows?: Array<Record<string, unknown>>; error?: unknown }
    expect(data.error).toBeUndefined()
    expect(data.rows?.length).toBeGreaterThan(0)
    expect(data.rows?.[0]?.tier).toBeDefined()
  })

  it("unknown read name -> error listing valid names (agent-recoverable)", async () => {
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    let caught: (Error & { code?: string; body?: { validNames?: string[] } }) | undefined
    try {
      await executeTool({
        toolName: "database:db_read",
        orgId: TEST_ORG,
        actor,
        params: { name: "does_not_exist" },
      })
    } catch (err) {
      caught = err as Error & { code?: string; body?: { validNames?: string[] } }
    }
    expect(caught).toBeDefined()
    expect(caught?.code).toBe("unknown_read")
  })

  it("db_probe is callable post-connect and surfaces warnings", async () => {
    const actor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["database:reads:read"],
      dimensionGrants: {},
    }
    const out = await executeTool({
      toolName: "database:db_probe",
      orgId: TEST_ORG,
      actor,
      params: {},
    })
    const data = out.data as { mode: string; warnings: string[] }
    expect(data.mode).toBe("direct")
    expect(Array.isArray(data.warnings)).toBe(true)
  })

  async function orgSlug(): Promise<string> {
    const [row] = extractRows<{ slug: string }>(
      await db.execute(
        drizzleSql`SELECT slug FROM kernel.organizations WHERE id = ${TEST_ORG}::uuid`,
      ),
    )
    return row?.slug ?? ""
  }
})

// The true agent-path coverage this connector was missing: db_describe must
// let the agent DISCOVER the readable schema, and db_query must actually run
// (enabled by default) — the exact tools that failed in the field ("db_query
// disabled", "db_describe: table not in catalog") when an agent tried to
// answer a support question. Driven through the real execute-tool -> sandbox
// -> bridge -> transport pipeline against the real test PG.
describe("database app — db_describe discovery + db_query (agent-path)", () => {
  const DSN =
    process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
  const readActor = () => ({
    actorType: "user" as const,
    userId: TEST_USER,
    orgId: TEST_ORG,
    scopes: ["database:reads:read", "database:query:read"],
    dimensionGrants: {},
  })

  it("db_describe() with no argument lists the readable tables, compactly", async () => {
    await seedDatabaseCredentials(DSN)
    const out = await executeTool({
      toolName: "database:db_describe",
      orgId: TEST_ORG,
      actor: readActor(),
      params: {},
    })
    const data = out.data as {
      tables?: Array<{ table: string; columnCount: number; columns?: unknown }>
      hint?: string
    }
    expect(Array.isArray(data.tables)).toBe(true)
    // Discovery: every readable table with its width, never its columns (a
    // warehouse's full map overflowed the tool result); db_describe(table)
    // gives the columns, see the next test.
    expect(data.tables?.length ?? 0).toBeGreaterThan(1)
    const orgTable = data.tables?.find((t) => t.table === "kernel.organizations")
    expect(orgTable?.columnCount ?? 0).toBeGreaterThan(0)
    expect(data.tables?.some((t) => "columns" in t)).toBe(false)
    expect(data.hint).toContain("schema.table")
  })

  it("db_describe(schema) narrows the listing through the real tool path", async () => {
    await seedDatabaseCredentials(DSN)
    const out = await executeTool({
      toolName: "database:db_describe",
      orgId: TEST_ORG,
      actor: readActor(),
      params: { schema: "kernel" },
    })
    const data = out.data as { tables?: Array<{ table: string }> }
    expect(data.tables?.length ?? 0).toBeGreaterThan(0)
    expect(data.tables?.every((t) => t.table.startsWith("kernel."))).toBe(true)
  })

  // Live walk: db_query declared no budget, so a long warehouse query outlived
  // the tool call and ran on in the database. Through the real pipeline, with
  // the sandbox cap lowered to 3 s: the call answers a non-retryable
  // statement_timeout inside the budget and leaves nothing running server side.
  it("a query longer than the tool budget is stopped inside it and leaves nothing running", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    await seedDatabaseCredentials(DSN)
    const saved = {
      base: process.env.LIAISON_SANDBOX_TIMEOUT_MS,
      max: process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS,
    }
    process.env.LIAISON_SANDBOX_TIMEOUT_MS = "3000"
    process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = "3000"
    const marker = `budget_marker_${Date.now()}`
    const su = postgres(DSN.replace("liaison_app:liaison_app", "liaison:liaison"), {
      max: 1,
      onnotice: () => {},
    })
    try {
      const start = Date.now()
      const err = await executeTool({
        toolName: "database:db_query",
        orgId: TEST_ORG,
        actor: readActor(),
        params: { sql: `SELECT count(*) AS ${marker} FROM generate_series(1, 2000000000) g` },
      }).catch((e) => e)
      expect(Date.now() - start).toBeLessThan(3_000)
      expect((err as { code?: string }).code).toBe("statement_timeout")
      expect((err as { details?: { retryable?: boolean } }).details?.retryable).toBe(false)
      expect(String((err as Error).message)).toMatch(/Do not retry the same SQL/)
      const running = await su.unsafe(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE state = 'active' AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()`,
        [marker],
      )
      expect(Number(running[0]?.n)).toBe(0)
    } finally {
      await su.end()
      for (const [key, value] of [
        ["LIAISON_SANDBOX_TIMEOUT_MS", saved.base],
        ["LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS", saved.max],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it("db_describe(table) narrows to that table's columns", async () => {
    await seedDatabaseCredentials(DSN)
    const out = await executeTool({
      toolName: "database:db_describe",
      orgId: TEST_ORG,
      actor: readActor(),
      params: { table: "kernel.organizations" },
    })
    const data = out.data as { tables?: Array<{ table: string; columns: { column: string }[] }> }
    expect(data.tables?.map((t) => t.table)).toEqual(["kernel.organizations"])
    expect(data.tables?.[0]?.columns.some((c) => c.column === "tier")).toBe(true)
  })

  it("db_query runs a real read-only SELECT (enabled by default, no env flag) — the field scenario", async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    await seedDatabaseCredentials(DSN)
    // Raw query over the instance's own database is the operator org's.
    const savedOperator = env.LIAISON_OPERATOR_ORG_ID
    ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = TEST_ORG
    const out = await executeTool({
      toolName: "database:db_query",
      orgId: TEST_ORG,
      actor: readActor(),
      // "the last N granted licenses" — exactly the kind of ad-hoc cross-cutting
      // read the curated tools don't cover, which is why db_query must work.
      params: {
        sql: "SELECT slug, tier, created_at FROM kernel.organizations ORDER BY created_at DESC LIMIT 2",
      },
    }).finally(() => {
      ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = savedOperator
    })
    const data = out.data as { rows?: Array<Record<string, unknown>>; error?: unknown }
    expect(data.error).toBeUndefined()
    expect(Array.isArray(data.rows)).toBe(true)
    expect(data.rows?.length ?? 0).toBeGreaterThan(0)
    expect(data.rows?.[0]?.slug).toBeDefined()
  })

  it("db_query rejects a write even when raw query is enabled", async () => {
    await seedDatabaseCredentials(DSN)
    // sql-guard rejects the write shape before it reaches the DB; a deliberate
    // typed tool error surfaces as a THROW through execute-tool (not out.data.error).
    let threw: (Error & { code?: string }) | undefined
    try {
      await executeTool({
        toolName: "database:db_query",
        orgId: TEST_ORG,
        actor: readActor(),
        params: { sql: "UPDATE kernel.organizations SET tier = 'x'" },
      })
    } catch (err) {
      threw = err as Error & { code?: string }
    }
    expect(threw).toBeDefined()
  })
})

// S2 (review_code.md) — the connect-time probe must run automatically, not
// just be callable on demand via db_probe. Covers: the manifest actually
// declares the kernel/connected_account:create subscription (so
// runtime.ts's real dispatch wires it up for every org, exercised already
// by ensureAppsForOrg above), and the sandboxed onDatabaseConnected handler
// itself calls db_probe and filters to this app's own connection — the same
// direct-sandbox-invocation style `mail/handlers.test.ts` uses for event
// handlers, exercising the real handlers.ts bundle through the real
// QuickJS sandbox (not a mocked module).
describe("database app — auto-probe on connect (S2)", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(new URL("./handlers.ts", import.meta.url).pathname)
  })

  it("manifest declares the kernel/connected_account:create subscription routed to onDatabaseConnected", () => {
    const subs = (databaseManifest as { events?: { subscribes?: Record<string, string> } }).events
      ?.subscribes
    expect(subs?.["kernel/connected_account:create"]).toBe("onDatabaseConnected")
  })

  it("fires db_probe when the connected account is for this app (database)", async () => {
    const probeCalls: unknown[] = []
    const logCalls: Array<{ level: string; msg: string }> = []
    const bridge = {
      db_probe: async (_paramsJson: string) => {
        probeCalls.push(true)
        return JSON.stringify({ ok: true, mode: "direct", warnings: [] })
      },
      log_info: (msg: string) => {
        logCalls.push({ level: "info", msg })
      },
      log_warn: (msg: string) => {
        logCalls.push({ level: "warn", msg })
      },
    }
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onDatabaseConnected",
      params: {
        app: "kernel",
        entity: "connected_account",
        action: "create",
        data: {
          id: "ca_1",
          appName: "database",
          connectionName: "database",
          identifier: "default",
        },
      },
      bridge,
    })
    expect(probeCalls).toHaveLength(1)
    expect(logCalls.some((l) => l.level === "info")).toBe(true)
  })

  it("does NOT fire db_probe when the connected account is for a different app", async () => {
    const probeCalls: unknown[] = []
    const bridge = {
      db_probe: async (_paramsJson: string) => {
        probeCalls.push(true)
        return JSON.stringify({ ok: true, mode: "direct", warnings: [] })
      },
      log_info: () => {},
      log_warn: () => {},
    }
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onDatabaseConnected",
      params: {
        app: "kernel",
        entity: "connected_account",
        action: "create",
        data: { id: "ca_2", appName: "gitlab", connectionName: "gitlab" },
      },
      bridge,
    })
    expect(probeCalls).toHaveLength(0)
  })

  it("a dirty probe (ok:false) logs a warning, never throws (advisory, non-fatal per spec layer 8)", async () => {
    const logCalls: Array<{ level: string; msg: string }> = []
    const bridge = {
      db_probe: async (_paramsJson: string) =>
        JSON.stringify({
          ok: false,
          mode: "direct",
          writeGrantsDetected: true,
          warnings: ["has write grants"],
        }),
      log_info: (msg: string) => {
        logCalls.push({ level: "info", msg })
      },
      log_warn: (msg: string) => {
        logCalls.push({ level: "warn", msg })
      },
    }
    // A dirty probe must never propagate a rejection out of the connect
    // subscriber (advisory, non-fatal per spec layer 8) — call directly and
    // assert no throw, rather than the `.resolves.not.toThrow()` matcher
    // combo (which asserts the RESOLVED VALUE isn't itself a throwing
    // function, not "the promise doesn't reject").
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onDatabaseConnected",
      params: {
        app: "kernel",
        entity: "connected_account",
        action: "create",
        data: { id: "ca_3", appName: "database", connectionName: "database" },
      },
      bridge,
    })
    expect(logCalls.some((l) => l.level === "warn")).toBe(true)
  })
})

// The second, named connection. An org whose ONLY database connection is
// `warehouse` proves the param routes: the same db_query answers rows with
// connection "warehouse" and not_connected without it (the default path is
// untouched). Raw query on the warehouse keeps database:query:read.
describe("database app — second connection (warehouse)", () => {
  const DSN =
    process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
  let WH_ORG = ""
  let WH_USER = ""
  const actor = (scopes: string[]) => ({
    actorType: "user" as const,
    userId: WH_USER,
    orgId: WH_ORG,
    scopes,
    dimensionGrants: {},
  })

  beforeAll(async () => {
    const [org] = extractRows<{ id: string }>(
      await db.execute(
        drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (gen_random_uuid(), 'DatabaseWarehouseOrg', ${`database-wh-${Date.now()}`})
            RETURNING id`,
      ),
    )
    WH_ORG = org?.id ?? ""
    const [u] = extractRows<{ id: string }>(
      await db.execute(
        drizzleSql`INSERT INTO kernel.users
            (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${WH_ORG}::uuid,
                    ${`wh-db-app-${Date.now()}@database-app.test`}, 'Wanda', 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    WH_USER = u?.id ?? ""
    await ensureAppsForOrg(WH_ORG)
    const encrypted = encryptSecret(
      JSON.stringify({ connectionString: DSN, dialect: "postgres", statementTimeoutMs: "30000" }),
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(
      drizzleSql`INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
           identifier, credentials_encrypted, status, created_by)
          VALUES (${WH_ORG}::uuid, 'database', 'warehouse', 'org', NULL, 'credentials',
                  'warehouse', ${encrypted}, 'active', ${WH_USER}::uuid)`,
    )
  })

  it("the manifest declares a direct-only 'warehouse' connection", () => {
    const config = connectionConfigRegistry.get([WH_ORG, "database", "warehouse"])
    expect(config?.type).toBe("credentials")
    expect((config?.credentialFields ?? []).map((f) => f.name)).toEqual([
      "connectionString",
      "dialect",
      "statementTimeoutMs",
    ])
  })

  it('db_query with connection "warehouse" reads through the warehouse connection', async () => {
    delete process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY
    const out = await executeTool({
      toolName: "database:db_query",
      orgId: WH_ORG,
      actor: actor(["database:reads:read", "database:query:read"]),
      params: { sql: "SELECT 7 AS seven", connection: "warehouse" },
    })
    const data = out.data as { rows?: Array<Record<string, unknown>>; error?: unknown }
    expect(data.error).toBeUndefined()
    expect(data.rows).toEqual([{ seven: 7 }])
  })

  it("without the param the same call still targets the (unconnected) default connection", async () => {
    const out = await executeTool({
      toolName: "database:db_query",
      orgId: WH_ORG,
      actor: actor(["database:reads:read", "database:query:read"]),
      params: { sql: "SELECT 7 AS seven" },
    })
    const data = out.data as { rows?: unknown; error?: { code: string } }
    expect(data.rows).toBeUndefined()
    expect(data.error?.code).toBe("not_connected")
  })

  it("db_describe targets the warehouse connection too", async () => {
    const out = await executeTool({
      toolName: "database:db_describe",
      orgId: WH_ORG,
      actor: actor(["database:reads:read", "database:query:read"]),
      params: { table: "kernel.organizations", connection: "warehouse" },
    })
    const data = out.data as { tables?: Array<{ table: string }> }
    expect(data.tables?.map((t) => t.table)).toEqual(["kernel.organizations"])
  })

  it("raw query on the warehouse still requires database:query:read (rejected pre-handler)", async () => {
    await expect(
      executeTool({
        toolName: "database:db_query",
        orgId: WH_ORG,
        actor: actor(["database:reads:read"]),
        params: { sql: "SELECT 1", connection: "warehouse" },
      }),
    ).rejects.toThrow(/database:query:read/)
  })

  it("describing the warehouse also requires database:query:read (a member cannot list its schema)", async () => {
    const err = await executeTool({
      toolName: "database:db_describe",
      orgId: WH_ORG,
      actor: actor(["database:reads:read"]),
      params: { connection: "warehouse" },
    }).catch((e) => e)
    expect(String((err as Error)?.message)).toContain("database:query:read")
    expect((err as { status?: number }).status).toBe(403)
  })

  it("an unknown connection is a 400-class refusal (the manifest enum), not a server fault", async () => {
    const err = await executeTool({
      toolName: "database:db_query",
      orgId: WH_ORG,
      actor: actor(["database:reads:read", "database:query:read"]),
      params: { sql: "SELECT 1", connection: "replica2" },
    }).catch((e) => e)
    expect((err as { status?: number }).status).toBe(400)
  })

  it("a member's personal `warehouse` connection never shadows the org's", async () => {
    // A cold pool, so the lookup really runs for this call.
    DatabaseBridgeTestAccess.resetTransportPool()
    // What POST /connections/database/warehouse saves for a member in personal
    // mode (identifier = their user id), newest-updated so a newest-wins lookup
    // would pick it. Its DSN points nowhere useful. (A second active row with
    // the identifier "warehouse" is impossible: unique active index.)
    const encrypted = encryptSecret(
      JSON.stringify({ connectionString: "postgres://evil:evil@127.0.0.1:1/nope" }),
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(
      drizzleSql`INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
           identifier, credentials_encrypted, status, created_by, updated_at)
          VALUES (${WH_ORG}::uuid, 'database', 'warehouse', 'user', ${WH_USER}::uuid, 'credentials',
                  ${WH_USER}, ${encrypted}, 'active', ${WH_USER}::uuid, now() + interval '1 hour')`,
    )
    // In-app (RLS lookup, where the member's own row is visible) and MCP
    // origin (privileged lookup, newest-updated across owners).
    for (const origin of [undefined, "mcp"] as const) {
      const out = await executeTool({
        toolName: "database:db_query",
        orgId: WH_ORG,
        actor: actor(["database:reads:read", "database:query:read"]),
        params: { sql: "SELECT 7 AS seven", connection: "warehouse" },
        ...(origin ? { origin } : {}),
      })
      expect((out.data as { rows?: unknown }).rows).toEqual([{ seven: 7 }])
    }
  })

  it("a saved credential change takes effect on the next call, without a restart", async () => {
    const q = {
      toolName: "database:db_query",
      orgId: WH_ORG,
      actor: actor(["database:reads:read", "database:query:read"]),
      params: { sql: "SELECT current_setting('statement_timeout') AS st", connection: "warehouse" },
    }
    expect((await executeTool(q)).data).toMatchObject({ rows: [{ st: "30s" }] })
    const encrypted = encryptSecret(
      JSON.stringify({ connectionString: DSN, dialect: "postgres", statementTimeoutMs: "45000" }),
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(
      drizzleSql`UPDATE kernel.connected_accounts SET credentials_encrypted = ${encrypted}
          WHERE org_id = ${WH_ORG}::uuid AND connection_name = 'warehouse' AND owner_type = 'org'`,
    )
    expect((await executeTool(q)).data).toMatchObject({ rows: [{ st: "45s" }] })
  })
})

describe("database app — default connected, warehouse not", () => {
  it('connection "warehouse" answers not_connected rather than falling back to the default', async () => {
    const DSN =
      process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
    await seedDatabaseCredentials(DSN)
    const out = await executeTool({
      toolName: "database:db_query",
      orgId: TEST_ORG,
      actor: {
        actorType: "user" as const,
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["database:reads:read", "database:query:read"],
        dimensionGrants: {},
      },
      params: { sql: "SELECT 1 AS one", connection: "warehouse" },
    })
    const data = out.data as { rows?: unknown; error?: { code: string } }
    expect(data.rows).toBeUndefined()
    expect(data.error?.code).toBe("not_connected")
  })

  it("hostile SQL on the warehouse is refused by the guard (the reproduced PoC)", async () => {
    const err = await executeTool({
      toolName: "database:db_query",
      orgId: TEST_ORG,
      actor: {
        actorType: "user" as const,
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["database:reads:read", "database:query:read"],
        dimensionGrants: {},
      },
      params: {
        sql: "SELECT 1 AS a$$) x; COMMIT; SELECT current_setting('transaction_read_only'), current_setting('statement_timeout') FROM (SELECT 1 AS b$$",
        connection: "warehouse",
      },
    }).catch((e) => e)
    expect(String((err as Error)?.message)).toMatch(/Multiple statements/)
  })

  it("a malformed warehouse DSN is a 409 config_error that never echoes the password", async () => {
    const encrypted = encryptSecret(
      JSON.stringify({ connectionString: "host=h user=u password=SECRETPW dbname=d" }),
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(
      drizzleSql`INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
           identifier, credentials_encrypted, status, created_by)
          VALUES (${TEST_ORG}::uuid, 'database', 'warehouse', 'org', NULL, 'credentials',
                  'warehouse', ${encrypted}, 'active', ${TEST_USER}::uuid)`,
    )
    const err = await executeTool({
      toolName: "database:db_query",
      orgId: TEST_ORG,
      actor: {
        actorType: "user" as const,
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["database:reads:read", "database:query:read"],
        dimensionGrants: {},
      },
      params: { sql: "SELECT 1", connection: "warehouse" },
    }).catch((e) => e)
    expect((err as { status?: number }).status).toBe(409)
    expect(JSON.stringify(err)).not.toContain("SECRETPW")
    expect(String((err as Error).message)).not.toContain("SECRETPW")
  })
})
