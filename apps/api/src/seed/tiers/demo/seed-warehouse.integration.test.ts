// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ORACLE, END TO END, AGAINST A REAL DATABASE.
//
// The gap this closes was not subtle: on the live demo box the `database` app
// was enabled, no connection existed, and `db_list_reads`, `db_describe`,
// `db_read` and `db_query` all answered nothing. So the assertions here are
// about ANSWERS, not about rows existing somewhere: every one of them goes
// through `executeTool` -> the QuickJS handler -> the host bridge -> a real
// Postgres transport, which is the same path a visitor's agent takes.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the `seedDemoWarehouse` call from `seed-demo.ts`, or the
//    `installDemoWarehouseConnection` call from `seed-warehouse.ts`: every read
//    and query test fails with `not_connected`, which is exactly the live box's
//    behaviour today.
//  * Resolve the demo handle to the application's DATABASE_URL instead of the
//    warehouse's own login: every tool call is refused by the transport's
//    privileged-role pre-flight (that login can reach liaison_admin), and the
//    login test below fails on its memberships.
//  * Make `resolveDemoWarehouseHandle` accept a stored DSN instead of refusing
//    anything but the sentinel: "refuses a demo org that carries a real
//    connection string" fails.
//  * Point `resolveCatalog` back at `resolveDatabaseCatalog()` unconditionally:
//    the catalog test fails, because a demo org is handed the liaison-self
//    reads, which describe tables it cannot see.
//
// Locally, against the isolated hardening database, never a shared one, and
// from `apps/api` (the modules below are written against apps/api's `~/*`
// alias, which only resolves from a cwd whose tsconfig declares it):
//
//   bun scripts/db-reset.ts hardening
//   cd apps/api && bun test src/seed/tiers/demo/seed-warehouse.integration.test.ts --timeout 600000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { SqlPoolTestAccess } from "~/modules/apps/connections/sql/pool"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import {
  DEMO_WAREHOUSE_DSN_ENV,
  DEMO_WAREHOUSE_SCHEMA,
  DEMO_WAREHOUSE_SENTINEL_DSN,
} from "~/modules/demo/warehouse"
import { seedDemoWarehouse } from "./seed-warehouse"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The warehouse's own login: a role in no Liaison role, created by the seed. */
const WAREHOUSE_LOGIN = "liaison_demo_warehouse_it"
const WAREHOUSE_DSN = DB_URL.replace(
  /\/\/[^@]*@/,
  `//${WAREHOUSE_LOGIN}:it-warehouse-password-0123456789@`,
)
const SLUG = `demo-warehouse-${Date.now()}`

let ORG = ""
let USER = ""
let COUNTS: Record<string, number> = {}

const ACTOR = () => ({
  actorType: "user" as const,
  userId: USER,
  orgId: ORG,
  scopes: ["database:reads:read", "database:query:read"],
  dimensionGrants: {},
})

async function tool<T>(toolName: string, params: Record<string, unknown>): Promise<T> {
  const out = await executeTool({ toolName, orgId: ORG, actor: ACTOR(), params })
  return out.data as T
}

/**
 * The refusal a tool call produced, however the pipeline chose to express it.
 * `execute-tool` throws a typed error for some handler error envelopes and
 * passes others back as `data.error`, and a wall is a wall either way: this
 * normalises both into one `{ code, message }` so a test asserts on the
 * refusal rather than on which of the two shapes carried it.
 */
async function toolError(
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ code?: string; message: string } | undefined> {
  try {
    const out = await executeTool({ toolName, orgId: ORG, actor: ACTOR(), params })
    const envelope = (out.data as { error?: { code?: string; message?: string } } | undefined)
      ?.error
    if (!envelope) return undefined
    return { ...(envelope.code ? { code: envelope.code } : {}), message: envelope.message ?? "" }
  } catch (err) {
    const e = err as Error & { code?: string }
    return { ...(e.code ? { code: e.code } : {}), message: e.message }
  }
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to write to a shared database: use liaison_hardening_test")
  }
  // The warehouse schema and its role are DDL, which the application role has
  // no rights to. On the demo box the app container already carries this exact
  // variable (deploy/docker-compose.yml); here it is the local superuser.
  if (!process.env.MIGRATION_DATABASE_URL) {
    const name = DB_URL.split("/").pop() ?? "liaison_hardening_test"
    process.env.MIGRATION_DATABASE_URL = `postgres://postgres:postgres@localhost:5432/${name}`
  }
  process.env[DEMO_WAREHOUSE_DSN_ENV] = WAREHOUSE_DSN
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "demo-wh-")), "apps")
  }
  DemoModeTestAccess.set(true)

  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'Resonant Audio Labs', ${SLUG}) RETURNING id`,
    ),
  )
  ORG = org?.id ?? ""
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${ORG}::uuid, ${`admin-${SLUG}@warehouse.test`}, 'Elodie', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  USER = u?.id ?? ""

  await markOrgAsDemo(ORG, reservedMarker())
  await ensureAppsForOrg(ORG)

  const result = await seedDemoWarehouse(
    { orgId: ORG, orgSlug: SLUG, adminUserId: USER },
    { force: true, log: (m) => console.log(`[warehouse-test] ${m}`) },
  )
  COUNTS = result.counts
})

afterAll(async () => {
  SqlPoolTestAccess.reset()
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

describe("the demo oracle: catalog and schema discovery", () => {
  it("db_list_reads hands a demo org the warehouse catalog, not the liaison-self one", async () => {
    const data = await tool<{ adapter: string; reads: Record<string, { description: string }> }>(
      "database:db_list_reads",
      {},
    )
    expect(data.adapter).toBe("resonant-warehouse")
    const names = Object.keys(data.reads)
    expect(names.length).toBeGreaterThanOrEqual(12)
    for (const expected of [
      "revenue_by_month",
      "returns_by_reason_and_product",
      "dealer_aging",
      "top_customers_by_lifetime_value",
      "rma_rate_by_product_and_firmware",
      "stock_cover_by_product",
    ]) {
      expect(names).toContain(expected)
    }
    // Read descriptions are shown to a visitor: no dash punctuation in any of them.
    for (const [name, read] of Object.entries(data.reads)) {
      expect(read.description, `read '${name}' description`).not.toMatch(/--|–|—/)
    }
  })

  it("a member without a granted role neither sees nor runs the confidential domains", async () => {
    // The catalog marks revenue, dealers and customers confidential; the demo
    // org grants them to finance and operations (seed-org.ts). USER holds no
    // role, so with curated reads only (no database:query:read) those domains
    // are hidden from the list and refused by name.
    const member = { ...ACTOR(), scopes: ["database:reads:read"] }
    const listed = await executeTool({
      toolName: "database:db_list_reads",
      orgId: ORG,
      actor: member,
      params: {},
    })
    const names = Object.keys((listed.data as { reads: Record<string, unknown> }).reads)
    expect(names).toContain("returns_by_reason_and_product")
    for (const hidden of ["revenue_by_month", "dealer_aging", "top_customers_by_lifetime_value"]) {
      expect(names).not.toContain(hidden)
    }
    let refusal: { code?: string } | undefined
    try {
      const out = await executeTool({
        toolName: "database:db_read",
        orgId: ORG,
        actor: member,
        params: { name: "dealer_aging", params: {} },
      })
      refusal = (out.data as { error?: { code?: string } }).error
    } catch (err) {
      refusal = { code: (err as { code?: string }).code }
    }
    expect(refusal?.code).toBe("domain_restricted")
  })

  it("db_describe shows the warehouse and ONLY the warehouse", async () => {
    const data = await tool<{ tables: { table: string; columns: { column: string }[] }[] }>(
      "database:db_describe",
      {},
    )
    expect(data.tables.length).toBeGreaterThan(5)
    const foreign = data.tables.filter((t) => !t.table.startsWith(`${DEMO_WAREHOUSE_SCHEMA}.`))
    expect(foreign.map((t) => t.table)).toEqual([])
    expect(data.tables.some((t) => t.table === `${DEMO_WAREHOUSE_SCHEMA}.orders`)).toBe(true)
    // With no table the map lists tables only; a table's columns come from
    // naming it.
    const one = await tool<{ tables: { table: string; columns: { column: string }[] }[] }>(
      "database:db_describe",
      { table: `${DEMO_WAREHOUSE_SCHEMA}.orders` },
    )
    const orders = one.tables.find((t) => t.table === `${DEMO_WAREHOUSE_SCHEMA}.orders`)
    expect(orders).toBeDefined()
    const cols = (orders?.columns ?? []).map((c) => c.column)
    for (const c of [
      "order_id",
      "order_date",
      "channel",
      "dealer_code",
      "total_minor",
      "paid_on",
    ]) {
      expect(cols).toContain(c)
    }
  })
})

describe("the demo oracle: curated reads return real answers", () => {
  it("revenue_by_month covers more than two years and every month has money in it", async () => {
    const from = new Date()
    from.setUTCMonth(from.getUTCMonth() - 30)
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "revenue_by_month",
      params: {
        from_month: `${from.toISOString().slice(0, 7)}-01`,
        to_month: `${new Date().toISOString().slice(0, 7)}-01`,
      },
    })
    const months = new Set(data.rows.map((r) => String(r.month)))
    expect(months.size).toBeGreaterThanOrEqual(24)
    for (const row of data.rows) {
      expect(Number(row.net_revenue_minor)).toBeGreaterThan(0)
    }
    const channels = new Set(data.rows.map((r) => String(r.channel)))
    expect([...channels].sort()).toEqual(["dealer", "direct"])
  })

  it("returns_by_reason_and_product names the ten input recorder and its worst reason", async () => {
    const from = new Date()
    from.setUTCFullYear(from.getUTCFullYear() - 3)
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "returns_by_reason_and_product",
      params: {
        from_date: from.toISOString().slice(0, 10),
        to_date: new Date().toISOString().slice(0, 10),
      },
    })
    expect(data.rows.length).toBeGreaterThan(5)
    const tenInput = data.rows.filter((r) => r.sku === "RAL-FLAG-02")
    expect(tenInput.length).toBeGreaterThan(0)
    expect(String(tenInput[0]?.product_title)).toBe("Kestrel 10 Field Recorder")
    for (const row of data.rows) expect(Number(row.rma_count)).toBeGreaterThan(0)
  })

  it("dealer_aging returns dealers with money past their own credit terms", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "dealer_aging",
      params: { as_of: new Date().toISOString().slice(0, 10) },
    })
    expect(data.rows.length).toBeGreaterThan(0)
    const pastDue = data.rows.filter((r) => Number(r.past_due_minor) > 0)
    expect(pastDue.length).toBeGreaterThan(0)
    for (const row of data.rows) {
      expect(Number(row.credit_terms_days)).toBeGreaterThan(0)
      expect(Number(row.outstanding_minor)).toBeGreaterThan(0)
    }
  })

  it("rma_rate_by_product_and_firmware separates a bad release from a good one", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "rma_rate_by_product_and_firmware",
      params: { min_devices: 5 },
    })
    expect(data.rows.length).toBeGreaterThan(0)
    const byVersion = new Map<string, number[]>()
    for (const row of data.rows) {
      const v = String(row.firmware_version)
      byVersion.set(v, [...(byVersion.get(v) ?? []), Number(row.rma_rate_pct ?? 0)])
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    const bad = mean(byVersion.get("2.0.0") ?? [])
    const good = mean(byVersion.get("2.1.2") ?? [])
    expect(bad).toBeGreaterThan(good)
  })

  it("db_probe reports a clean read only role rather than an error", async () => {
    const report = await tool<{ ok: boolean; mode: string; warnings: string[] }>(
      "database:db_probe",
      {},
    )
    expect(report.mode).toBe("direct")
    expect(report.warnings).toBeDefined()
    if (report.warnings.length > 0) {
      console.log("[warehouse-test] db_probe warnings", report.warnings)
    }
    // The wall that matters: the role the reads run as must hold no write grant.
    expect(report.warnings.join(" ")).not.toMatch(/non-SELECT privilege/)
  })

  it("stock_cover_by_product answers in units on hand and days of cover", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "stock_cover_by_product",
      params: { lookback_days: 90 },
    })
    expect(data.rows.length).toBeGreaterThan(5)
    for (const row of data.rows) {
      expect(row.product_title).toBeTruthy()
      expect(Number.isFinite(Number(row.units_on_hand))).toBe(true)
    }
  })

  it("top_customers_by_lifetime_value ranks the seeded people from world.ts", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_read", {
      name: "top_customers_by_lifetime_value",
      params: { min_orders: 1 },
    })
    expect(data.rows.length).toBeGreaterThan(5)
    const first = data.rows[0] as Record<string, unknown>
    expect(Number(first.lifetime_value_minor)).toBeGreaterThan(0)
    expect(Number(first.order_count)).toBeGreaterThanOrEqual(Number(data.rows.at(-1)?.order_count))
  })
})

describe("the demo oracle: raw SQL answers a question nobody wrote a read for", () => {
  it("returns by month for the Kestrel 10, straight out of db_query", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_query", {
      sql: `SELECT to_char(date_trunc('month', r.opened_on), 'YYYY-MM') AS month,
                   count(*) AS returns,
                   sum(r.refund_minor) AS refunded_minor
            FROM ${DEMO_WAREHOUSE_SCHEMA}.rmas r
            JOIN ${DEMO_WAREHOUSE_SCHEMA}.products p ON p.sku = r.sku
            WHERE p.title = 'Kestrel 10 Field Recorder'
            GROUP BY 1 ORDER BY 1`,
    })
    expect(data.rows.length).toBeGreaterThan(6)
    console.log("[warehouse-test] returns by month for the Kestrel 10 (first 8 rows)")
    console.table(data.rows.slice(0, 8))
    for (const row of data.rows) {
      expect(String(row.month)).toMatch(/^\d{4}-\d{2}$/)
      expect(Number(row.returns)).toBeGreaterThan(0)
    }
  })

  it("which dealers are past their credit terms, straight out of db_query", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_query", {
      sql: `SELECT d.name AS dealer, d.country, d.credit_terms_days,
                   count(*) AS unpaid_invoices,
                   sum(o.total_minor) AS outstanding_minor,
                   max(current_date - o.due_on) AS worst_days_late
            FROM ${DEMO_WAREHOUSE_SCHEMA}.orders o
            JOIN ${DEMO_WAREHOUSE_SCHEMA}.dealers d ON d.dealer_code = o.dealer_code
            WHERE o.paid_on IS NULL AND o.due_on < current_date
            GROUP BY 1, 2, 3 ORDER BY 5 DESC`,
    })
    expect(data.rows.length).toBeGreaterThan(0)
    console.log("[warehouse-test] dealers past their credit terms")
    console.table(data.rows)
  })

  it("the mart agrees with the order grain it was built from", async () => {
    const data = await tool<{ rows: Record<string, unknown>[] }>("database:db_query", {
      sql: `SELECT (SELECT sum(gross_revenue_minor) FROM ${DEMO_WAREHOUSE_SCHEMA}.monthly_revenue) AS mart_gross,
                   (SELECT sum(line_total_minor) FROM ${DEMO_WAREHOUSE_SCHEMA}.order_lines) AS grain_gross,
                   (SELECT count(*) FROM ${DEMO_WAREHOUSE_SCHEMA}.order_lines l
                     LEFT JOIN ${DEMO_WAREHOUSE_SCHEMA}.products p ON p.sku = l.sku
                     WHERE p.sku IS NULL) AS orphan_lines`,
    })
    const row = data.rows[0] as Record<string, unknown>
    expect(Number(row.mart_gross)).toBe(Number(row.grain_gross))
    expect(Number(row.orphan_lines)).toBe(0)
  })
})

describe("the demo oracle: the walls hold", () => {
  it("cannot read Liaison's own tables, however the SQL is written", async () => {
    const caught = await toolError("database:db_query", {
      sql: "SELECT id, slug FROM kernel.organizations LIMIT 1",
    })
    expect(caught).toBeDefined()
    expect(caught?.message ?? "").toMatch(/permission denied|Permission denied/)
  })

  it("cannot read a connected account's stored credentials", async () => {
    const caught = await toolError("database:db_query", {
      sql: "SELECT credentials_encrypted FROM kernel.connected_accounts LIMIT 1",
    })
    expect(caught).toBeDefined()
  })

  it("cannot write, even with the SQL guard bypassed by a WITH prefix", async () => {
    const caught = await toolError("database:db_query", {
      sql: `WITH x AS (INSERT INTO ${DEMO_WAREHOUSE_SCHEMA}.products (sku, title, tier, list_price_minor, currency, weight_kg, launched_on, is_serialized) VALUES ('X', 'X', 'x', 1, 'EUR', 1, current_date, false) RETURNING sku) SELECT * FROM x`,
    })
    expect(caught).toBeDefined()
  })

  it("stores NO credential on the demo org: the row carries the sentinel", async () => {
    const rows = extractRows<{ credentials_encrypted: string; display_name: string }>(
      await db.execute(
        sql`SELECT credentials_encrypted, display_name FROM kernel.connected_accounts
            WHERE org_id = ${ORG}::uuid AND app_name = 'database' AND status = 'active'`,
      ),
    )
    expect(rows.length).toBe(1)
    const decrypted = JSON.parse(
      decryptSecret(
        rows[0]?.credentials_encrypted as string,
        process.env.ENCRYPTION_KEY ?? "",
        CryptoContext.connectedAccountCredentials,
      ),
    ) as { connectionString: string }
    expect(decrypted.connectionString).toBe(DEMO_WAREHOUSE_SENTINEL_DSN)
    // Not a DSN by any reading: no scheme, no host, no password.
    expect(decrypted.connectionString).not.toMatch(/postgres|@|:\/\//)
    expect(JSON.stringify(decrypted)).not.toContain(DB_URL)
  })

  it("the warehouse login is a member of no role and cannot bypass row security", async () => {
    const rows = extractRows<{ rolsuper: boolean; rolbypassrls: boolean; memberships: number }>(
      await db.execute(
        sql`SELECT rolsuper, rolbypassrls,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
            FROM pg_roles r WHERE rolname = ${WAREHOUSE_LOGIN}`,
      ),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.rolsuper).toBe(false)
    expect(rows[0]?.rolbypassrls).toBe(false)
    expect(rows[0]?.memberships).toBe(0)
  })

  it("refuses a demo org that somehow carries a real connection string", async () => {
    const real = encryptSecret(
      JSON.stringify({ connectionString: DB_URL }),
      process.env.ENCRYPTION_KEY ?? "",
      CryptoContext.connectedAccountCredentials,
    )
    await db.execute(
      sql`UPDATE kernel.connected_accounts SET credentials_encrypted = ${real}
          WHERE org_id = ${ORG}::uuid AND app_name = 'database' AND status = 'active'`,
    )
    SqlPoolTestAccess.reset()
    try {
      const caught = await toolError("database:db_read", {
        name: "product_catalog",
        params: {},
      })
      expect(caught).toBeDefined()
      expect(caught?.code).toBe("not_connected")
    } finally {
      await seedDemoWarehouse({ orgId: ORG, orgSlug: SLUG, adminUserId: USER }, {})
      SqlPoolTestAccess.reset()
    }
  })

  it("a box that is not a demo instance gets nothing from the sentinel", async () => {
    DemoModeTestAccess.set(false)
    invalidateDemoMarker(ORG)
    SqlPoolTestAccess.reset()
    try {
      const listed = await tool<{ adapter: string }>("database:db_list_reads", {})
      expect(listed.adapter).toBe("liaison-self")
      const caught = await toolError("database:db_read", { name: "product_catalog", params: {} })
      expect(caught).toBeDefined()
    } finally {
      DemoModeTestAccess.set(true)
      invalidateDemoMarker(ORG)
      SqlPoolTestAccess.reset()
    }
  })
})

describe("the demo oracle: re-seeding converges", () => {
  it("a second seed reuses the warehouse it already built and keeps one connection", async () => {
    const again = await seedDemoWarehouse({ orgId: ORG, orgSlug: SLUG, adminUserId: USER }, {})
    expect(again.rebuilt).toBe(false)
    expect(again.counts).toEqual(COUNTS)
    const rows = extractRows<{ count: string }>(
      await db.execute(
        sql`SELECT count(*) AS count FROM kernel.connected_accounts
            WHERE org_id = ${ORG}::uuid AND app_name = 'database' AND status = 'active'`,
      ),
    )
    expect(Number(rows[0]?.count)).toBe(1)

    // THE ROWS ARE STILL THERE. A reused build must not have emptied the
    // warehouse on its way to deciding there was nothing to do: the first cut
    // of the provisioner truncated BEFORE it read the build stamp, so the
    // second seed of any given day left a warehouse that answered every
    // question with no rows, which is indistinguishable from the bug this
    // whole layer exists to fix. Asserted through the tool, not off the table.
    const after = await tool<{ rows: Record<string, unknown>[] }>("database:db_query", {
      sql: `SELECT count(*) AS orders FROM ${DEMO_WAREHOUSE_SCHEMA}.orders`,
    })
    expect(Number(after.rows[0]?.orders)).toBe(COUNTS.orders ?? -1)
  })

  // MUTATION PROOF: delete the `content_hash` comparison from the reuse check
  // in `provision.ts` and this fails, because the stale stamp's date and row
  // total still match and the load is skipped.
  it("a stamp from a DIFFERENT catalog forces a rebuild, even on the same day at the same size", async () => {
    // How this shipped: the fictional range was renamed end to end, which
    // changed every product TITLE and no row COUNT. The stamp recorded only the
    // date and the total, both unchanged, so the provisioner reported "already
    // built today" and the box served the previous catalog while knowledge,
    // agents and skills had all moved on. The green deploy log said nothing.
    // Read over the admin DSN: the application's own login has no grant on the
    // warehouse (only the warehouse's dedicated login does).
    const adminRead = async (q: string) => {
      const c = postgres(process.env.MIGRATION_DATABASE_URL ?? "", { max: 1 })
      try {
        return (await c.unsafe(q)) as unknown as Record<string, unknown>[]
      } finally {
        await c.end()
      }
    }
    const title = async () =>
      (
        await adminRead(
          `SELECT title FROM ${DEMO_WAREHOUSE_SCHEMA}.products WHERE sku = 'RAL-FLAG-01'`,
        )
      )[0]?.title as string | undefined

    const real = await title()
    expect(real).toBeTruthy()

    // A warehouse loaded from an older catalog: same day, same row total, and
    // a product carrying the name that catalog would have given it.
    //
    // Written through the ADMIN dsn, not the app connection: the whole point of
    // this schema is that the app role can only read it, so the app connection
    // is refused here exactly as it should be.
    const admin = postgres(process.env.MIGRATION_DATABASE_URL ?? "", { max: 1 })
    try {
      await admin.unsafe(
        `UPDATE ${DEMO_WAREHOUSE_SCHEMA}.build_info SET content_hash = 'a-previous-catalog' WHERE id = 1`,
      )
      await admin.unsafe(
        `UPDATE ${DEMO_WAREHOUSE_SCHEMA}.products SET title = 'Stale Catalog Name' WHERE sku = 'RAL-FLAG-01'`,
      )
    } finally {
      await admin.end()
    }

    const result = await seedDemoWarehouse({ orgId: ORG, orgSlug: SLUG, adminUserId: USER }, {})
    expect(result.rebuilt).toBe(true)
    expect(await title()).toBe(real)

    const stamped = (
      await adminRead(`SELECT content_hash FROM ${DEMO_WAREHOUSE_SCHEMA}.build_info WHERE id = 1`)
    )[0]?.content_hash as string | null | undefined
    expect(stamped).not.toBe("a-previous-catalog")
    expect(stamped).toBeTruthy()
  })

  it("the generated history is big enough and wide enough to be worth asking about", () => {
    expect(COUNTS.orders ?? 0).toBeGreaterThan(600)
    expect(COUNTS.order_lines ?? 0).toBeGreaterThan(900)
    expect(COUNTS.rmas ?? 0).toBeGreaterThan(120)
    expect(COUNTS.inventory_movements ?? 0).toBeGreaterThan(1000)
    expect(COUNTS.monthly_revenue ?? 0).toBeGreaterThan(200)
    console.log("[warehouse-test] warehouse row counts", COUNTS)
  })
})

describe("the demo oracle: turned on without its login, the layer fails loud", () => {
  // The serving process has no privileged DSN, so the layer skips the build and
  // only connects. Without the warehouse's own login that connection refuses
  // every call at run time; the layer must throw instead of reporting success.
  it("throws on the connect-only path, naming the missing variable", async () => {
    const savedDsn = process.env[DEMO_WAREHOUSE_DSN_ENV]
    const savedAdmin = process.env.MIGRATION_DATABASE_URL
    delete process.env[DEMO_WAREHOUSE_DSN_ENV]
    delete process.env.MIGRATION_DATABASE_URL
    try {
      await expect(
        seedDemoWarehouse({ orgId: ORG, orgSlug: SLUG, adminUserId: USER }),
      ).rejects.toThrow(DEMO_WAREHOUSE_DSN_ENV)
    } finally {
      if (savedDsn !== undefined) process.env[DEMO_WAREHOUSE_DSN_ENV] = savedDsn
      if (savedAdmin !== undefined) process.env.MIGRATION_DATABASE_URL = savedAdmin
    }
  })
})
