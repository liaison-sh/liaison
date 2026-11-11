// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo warehouse runs on its OWN login: a role that is a member of no
// Liaison role, so SQL that slips past the read-only guard has no privileged
// role to step into. Covers the runtime refusal when the DSN is absent, the
// provisioning rules for the login, and (live Postgres) that the provisioned
// login really reaches nothing but the warehouse.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { PostgresDirect } from "~/modules/apps/connections/sql/transports/postgres-direct"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { DemoOrgTestAccess, invalidateDemoMarker, visitorMarker } from "~/modules/demo/demo-org"
import { provisionDemoWarehouse, warehouseLoginFromDsn } from "./provision"
import { DemoWarehouseRefused, resolveDemoWarehouseHandle } from "./resolve"
import { DEMO_WAREHOUSE_DSN_ENV, DEMO_WAREHOUSE_SENTINEL_DSN } from "./sentinel"

const APP_DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const ADMIN_DSN = APP_DSN.replace("liaison_app:liaison_app", "liaison:liaison")
const LOGIN = "liaison_demo_warehouse_test"
const PASSWORD = "wh-test-password-0123456789"
const WAREHOUSE_DSN = APP_DSN.replace("liaison_app:liaison_app", `${LOGIN}:${PASSWORD}`)

describe("warehouseLoginFromDsn", () => {
  it("accepts a dedicated, prefixed login with a strong password", () => {
    expect(warehouseLoginFromDsn(WAREHOUSE_DSN, APP_DSN)).toEqual({
      role: LOGIN,
      password: PASSWORD,
    })
  })

  it("refuses a login that is not a warehouse login (it would be reconfigured), including the application's own", () => {
    const app = "postgres://liaison_app:a-long-enough-password@h/db"
    expect(() => warehouseLoginFromDsn(app, APP_DSN)).toThrow(/liaison_demo_warehouse/)
    expect(() => warehouseLoginFromDsn("postgres://postgres:a-long-enough-password@h/db")).toThrow()
    expect(() =>
      warehouseLoginFromDsn(
        "postgres://liaison_demo_warehouse:a-long-enough-password@h/db",
        "postgres://liaison_demo_warehouse:other@h/db",
      ),
    ).toThrow(/application's own login/)
  })

  it("refuses a short password", () => {
    expect(() => warehouseLoginFromDsn("postgres://liaison_demo_warehouse:short@h/db")).toThrow(
      /16 characters/,
    )
  })
})

// The marker lookup is the only database touch on the runtime path; priming its
// cache keeps these two tests off the shared test database (a module mock would
// replace demo-org for every later file in the same process).
const DEMO_ORG = "00000000-0000-4000-8000-0000000000d1"

describe("demo warehouse: own login, no fallback", () => {
  const saved = process.env[DEMO_WAREHOUSE_DSN_ENV]
  const orgId = DEMO_ORG

  afterAll(() => {
    DemoModeTestAccess.set(null)
    invalidateDemoMarker(DEMO_ORG)
    if (saved === undefined) delete process.env[DEMO_WAREHOUSE_DSN_ENV]
    else process.env[DEMO_WAREHOUSE_DSN_ENV] = saved
  })
  beforeEach(() => {
    DemoModeTestAccess.set(true)
    DemoOrgTestAccess.prime(DEMO_ORG, visitorMarker(1))
  })
  afterEach(() => {
    DemoModeTestAccess.set(null)
  })

  it("refuses when the warehouse DSN is absent, never falling back to the application's DATABASE_URL", async () => {
    delete process.env[DEMO_WAREHOUSE_DSN_ENV]
    process.env.DATABASE_URL ??= APP_DSN
    const err = await resolveDemoWarehouseHandle(orgId, {
      connectionString: DEMO_WAREHOUSE_SENTINEL_DSN,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DemoWarehouseRefused)
    expect(String(err.message)).toContain(DEMO_WAREHOUSE_DSN_ENV)
  })

  it("hands back the warehouse's own DSN, not the application's, when it is set", async () => {
    process.env[DEMO_WAREHOUSE_DSN_ENV] = WAREHOUSE_DSN
    const handle = await resolveDemoWarehouseHandle(orgId, {
      connectionString: DEMO_WAREHOUSE_SENTINEL_DSN,
    })
    expect(handle?.connectionString).toBe(WAREHOUSE_DSN)
    expect(handle?.connectionString).not.toBe(process.env.DATABASE_URL)
  })
})

describe("demo warehouse provisioning", () => {
  afterAll(async () => {
    const su = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} })
    try {
      await su.unsafe("DROP SCHEMA IF EXISTS demo_warehouse CASCADE")
      await su.unsafe(`DROP OWNED BY ${LOGIN}`).catch(() => {})
      await su.unsafe(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {})
    } finally {
      await su.end()
    }
  })

  it("provisioning creates a login in no role that reads the warehouse and nothing else", async () => {
    const lines: string[] = []
    await provisionDemoWarehouse({
      adminDsn: ADMIN_DSN,
      appDsn: APP_DSN,
      warehouseDsn: WAREHOUSE_DSN,
      force: true,
      log: (m) => lines.push(m),
    })
    const su = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} })
    try {
      const attrs = await su.unsafe(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit,
           (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
         FROM pg_roles r WHERE rolname = '${LOGIN}'`,
      )
      expect(attrs[0]).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        memberships: 0,
      })
    } finally {
      await su.end()
    }

    // Through the real connector transport: its pre-flight accepts this login,
    // the warehouse is readable, Liaison's own tables are not, and the session
    // cannot step into any role.
    const transport = new PostgresDirect({ dsn: WAREHOUSE_DSN })
    try {
      const rows = await transport.runQuery("SELECT count(*)::int AS n FROM demo_warehouse.orders")
      expect(Number(rows.rows[0]?.n)).toBeGreaterThan(0)
      await expect(transport.runQuery("SELECT * FROM kernel.users")).rejects.toThrow()
      await expect(transport.runQuery("SELECT * FROM kernel.organizations")).rejects.toThrow()
    } finally {
      await transport.close()
    }
    const raw = postgres(WAREHOUSE_DSN, { max: 1, onnotice: () => {} })
    try {
      for (const role of ["liaison_admin", "liaison_rls", "liaison_app", "liaison_schema_admin"]) {
        await expect((async () => raw.unsafe(`SET ROLE ${role}`))()).rejects.toThrow()
      }
      await expect(
        (async () => raw.unsafe("SELECT set_config('role', 'liaison_admin', false)"))(),
      ).rejects.toThrow()
    } finally {
      await raw.end()
    }
  }, 120_000)
})
