// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the database app's contract fixtures (fixtures/database/*.json). Not part of any
// suite: a developer runs it by path when the app's calls change, then reads what it wrote and
// commits it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-database.ts)
//
// The provider is a real Postgres: the test database, read through the platform's SQL
// connection (`ctx.sql`) as a read-only login this run creates, which sees two small schemas
// and nothing else. The deployment catalog (LIAISON_DATABASE_ADAPTER_PATH) is a contract
// catalog over them: a knowledge base (the `catalog` knowledge source), an orders table, and a
// confidential `revenue` domain. Every entry runs once on the live bridge, then its fixture is
// scrubbed and replayed twice before it is written. The login, the schemas and the contract
// org's rows are removed at the end.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { BUNDLED_APPS_DIR, bridgeSurfaceOf } from "~/modules/apps/contract/apps.test-helpers"
import { contractEntries } from "~/modules/apps/contract/entries"
import { bundledAppScripts, productionLimits } from "~/modules/apps/contract/harness"
import type { ContractIsolate } from "~/modules/apps/contract/isolate"
import { quickJsContractExecutor } from "~/modules/apps/contract/quickjs-isolate"
import {
  type Replacement,
  recordEntry,
  scrubFixture,
  verifyFixture,
  writeFixture,
} from "~/modules/apps/contract/recorder"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "~/modules/apps/contract/replay-bridge"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { acquireTestLock, releaseTestLock, superuserUrlForTestDb } from "~/tests/route-test-setup"

const APP = "database"
const FIXTURES_DIR = join(import.meta.dir, "../../src/modules/apps/contract/fixtures")
const LOGIN = "liaison_contract_db_reader"
const PASSWORD = randomBytes(18).toString("hex")
const ROLE_ID = "00000000-0000-4000-8000-00000000c0e1"
const RECORDED_FROM =
  "a contract org reading two contract schemas of the test database as a read-only login, scripts/contract/record-database.ts"

type Manifest = Record<string, unknown> & { version: string; scopes: string[] }
const manifest = JSON.parse(
  readFileSync(join(BUNDLED_APPS_DIR, APP, "app.manifest.json"), "utf8"),
) as Manifest

const actor: UserContext = {
  actorType: "user",
  userId: CONTRACT_USER_ID,
  orgId: CONTRACT_ORG_ID,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

/** The deployment catalog the run points the connection at (JSON is YAML). */
const CATALOG = {
  adapter: "contract-shop",
  domains: { revenue: { tier: "confidential" } },
  reads: {
    knowledge_sync_list: {
      description: "Knowledge articles, keyset-paginated by (updated_at, id).",
      domain: "knowledge",
      sql:
        "SELECT id, title, updated_at FROM contract_kb.articles " +
        "WHERE (:after_updated_at::timestamptz IS NULL OR (updated_at, id) > (:after_updated_at::timestamptz, :after_id)) " +
        "ORDER BY updated_at ASC, id ASC LIMIT :limit",
      params: {
        after_updated_at: { type: "string" },
        after_id: { type: "string" },
        limit: { type: "integer" },
      },
      columns: ["id", "title", "updated_at"],
      tables: ["contract_kb.articles"],
    },
    knowledge_sync_get: {
      description: "One knowledge article with its body.",
      domain: "knowledge",
      sql: "SELECT id, title, body, updated_at FROM contract_kb.articles WHERE id = :id",
      params: { id: { type: "string" } },
      columns: ["id", "title", "body", "updated_at"],
      tables: ["contract_kb.articles"],
      maxRows: 1,
    },
    orders_by_status: {
      description: "Orders in one status, newest first.",
      domain: "support",
      sql: "SELECT id, status, total_cents, created_at FROM contract_shop.orders WHERE status = :status ORDER BY created_at DESC LIMIT 20",
      params: { status: { type: "string" } },
      columns: ["id", "status", "total_cents", "created_at"],
      tables: ["contract_shop.orders"],
    },
    revenue_by_month: {
      description: "Revenue per month.",
      domain: "revenue",
      sql: "SELECT date_trunc('month', created_at) AS month, sum(total_cents) AS revenue_cents FROM contract_shop.orders GROUP BY 1 ORDER BY 1",
      params: {},
      columns: ["month", "revenue_cents"],
      tables: ["contract_shop.orders"],
      resultIsAggregate: true,
      grantColumns: { "contract_shop.orders": ["created_at", "total_cents"] },
    },
  },
}

/** Each entry with the input a production run of it gets. */
const PLAN: Array<{ entry: string; params?: unknown }> = [
  { entry: "tool:db_list_reads", params: {} },
  { entry: "tool:db_read", params: { name: "orders_by_status", params: { status: "open" } } },
  { entry: "tool:db_describe", params: { table: "contract_shop.orders" } },
  { entry: "tool:db_probe", params: {} },
  {
    entry: "tool:db_query",
    params: {
      sql: "SELECT status, count(*) AS n FROM contract_shop.orders GROUP BY status ORDER BY status",
    },
  },
  {
    entry: "tool:report_access_set",
    params: { domainAccess: { revenue: { tier: "confidential", roles: [ROLE_ID] } } },
  },
  { entry: "tool:report_access_get", params: {} },
  { entry: "tool:report_access_find_people", params: { emails: ["recorder@example.com"] } },
  {
    entry: "event:kernel/connected_account:create",
    params: {
      app: "kernel",
      entity: "connected_account",
      action: "create",
      data: { appName: "database", connectionName: "database" },
    },
  },
  {
    entry: "knowledge-sync:catalog",
    params: {
      sourceId: "00000000-0000-4000-8000-00000000c0e2",
      kind: "catalog",
      config: {},
      cursor: null,
    },
  },
  {
    entry: "provision:handler",
    params: {
      config: {
        domainAccess: { revenue: { tier: "restricted", users: ["recorder@example.com"] } },
      },
      dryRun: false,
    },
  },
]

describe("record database contract fixtures", () => {
  let isolate: ContractIsolate
  let catalogDir: string
  let su: Awaited<ReturnType<typeof superuser>>
  let bridgeManifest: unknown
  const surface = bridgeSurfaceOf(APP)
  const entries = new Map(contractEntries(manifest).map((e) => [e.entry, e]))

  async function superuser() {
    const url = superuserUrlForTestDb()
    if (!url) throw new Error("the recorder needs the test database's superuser URL")
    const { default: postgres } = await import("postgres")
    return postgres(url, { max: 1, onnotice: () => {} })
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    catalogDir = mkdtempSync(join(tmpdir(), "contract-db-catalog-"))
    const catalogPath = join(catalogDir, "catalog.yaml")
    writeFileSync(catalogPath, JSON.stringify(CATALOG))
    process.env.LIAISON_DATABASE_ADAPTER_PATH = catalogPath

    su = await superuser()
    await su.unsafe(`
      DROP SCHEMA IF EXISTS contract_kb CASCADE;
      DROP SCHEMA IF EXISTS contract_shop CASCADE;
      CREATE SCHEMA contract_kb;
      CREATE SCHEMA contract_shop;
      CREATE TABLE contract_kb.articles (id text PRIMARY KEY, title text NOT NULL, body text NOT NULL, updated_at timestamptz NOT NULL);
      INSERT INTO contract_kb.articles VALUES
        ('kb-1', 'Pairing a controller', '# Pairing\nHold the button for 3 s.', '2026-05-01T00:00:00Z'),
        ('kb-2', 'Firmware update', '# Update\nUse the desktop app.', '2026-05-02T00:00:00Z');
      CREATE TABLE contract_shop.orders (id text PRIMARY KEY, status text NOT NULL, total_cents integer NOT NULL, created_at timestamptz NOT NULL);
      INSERT INTO contract_shop.orders VALUES
        ('o-1', 'open', 12900, '2026-04-03T10:00:00Z'),
        ('o-2', 'shipped', 4500, '2026-04-18T10:00:00Z'),
        ('o-3', 'open', 8800, '2026-05-02T10:00:00Z');
    `)
    await su.unsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
        EXECUTE 'DROP OWNED BY ${LOGIN}'; EXECUTE 'DROP ROLE ${LOGIN}';
      END IF; END $$`)
    await su.unsafe(
      `CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    )
    await su.unsafe(`ALTER ROLE ${LOGIN} SET default_transaction_read_only = on`)
    for (const schema of ["contract_kb", "contract_shop"]) {
      await su.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${LOGIN}`)
      await su.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${LOGIN}`)
    }
    const dbName = (await su`SELECT current_database() AS d`)[0]?.d as string
    await su.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${LOGIN}`)
    const dsn = new URL(process.env.DATABASE_URL ?? "")
    dsn.username = LOGIN
    dsn.password = PASSWORD
    dsn.search = ""

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${CONTRACT_ORG_ID}, 'Contract recording', 'contract-recording') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${CONTRACT_USER_ID}, ${CONTRACT_ORG_ID}, 'recorder@example.com', 'Contract Recorder', 'x')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_ID}, ${CONTRACT_ORG_ID}, 'finance', 'Contract role') ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(CONTRACT_ORG_ID)
    await registerApps(
      [
        {
          ...manifest,
          trusted: false,
          _firstParty: true,
          _format: "manifest",
          _bundlePath: join(BUNDLED_APPS_DIR, APP, manifest.version, "bundle.js"),
        },
      ] as never,
      CONTRACT_ORG_ID,
    )
    bridgeManifest = (
      toolRegistry.get([CONTRACT_ORG_ID, APP, "db_list_reads"]) as { _manifest?: unknown }
    )?._manifest
    if (!bridgeManifest) throw new Error("database did not register")
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    await sql`DELETE FROM kernel.app_documents WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP}`
    await withPrivilegedDb(CONTRACT_ORG_ID, "contract-record-database", (tx) =>
      createCredentialConnection(tx, CONTRACT_ORG_ID, CONTRACT_USER_ID, APP, "database", {
        identifier: "default",
        ownerType: "org",
        credentials: { connectionString: dsn.toString() },
      }),
    )
    const scripts = await bundledAppScripts(join(BUNDLED_APPS_DIR, APP))
    isolate = await quickJsContractExecutor.open(scripts.source, { memoryBytes: 64 * 1024 * 1024 })
  }, 300_000)

  afterAll(async () => {
    isolate?.dispose()
    await teardownAppRegistrations(CONTRACT_ORG_ID, APP)
    toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
    initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    await sql`DELETE FROM kernel.app_documents WHERE org_id = ${CONTRACT_ORG_ID} AND app = ${APP}`
    const { closeSqlPools } = await import("~/modules/apps/connections/sql/pool")
    closeSqlPools({ orgId: CONTRACT_ORG_ID })
    await su?.unsafe(
      `DROP SCHEMA IF EXISTS contract_kb CASCADE; DROP SCHEMA IF EXISTS contract_shop CASCADE`,
    )
    await su?.unsafe(`DROP OWNED BY ${LOGIN}; DROP ROLE IF EXISTS ${LOGIN}`).catch(() => {})
    await su?.end()
    rmSync(catalogDir, { recursive: true, force: true })
    delete process.env.LIAISON_DATABASE_ADAPTER_PATH
    await releaseTestLock()
  })

  function liveBridge(): AppBridge {
    return createSessionRpcBridge(
      APP,
      CONTRACT_USER_ID,
      CONTRACT_ORG_ID,
      { run: (fn) => withRlsContext(actor, fn) },
      bridgeManifest as never,
      ["*"],
      "user",
      undefined,
      { actor } as never,
    ) as AppBridge
  }

  it("records every entry", async () => {
    const replacements: Replacement[] = [{ from: PASSWORD, to: "redacted" }]
    const report: string[] = []
    for (const step of PLAN) {
      const entry = entries.get(step.entry)
      if (!entry)
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry,
        input: { params: step.params },
        real: liveBridge(),
        surface,
        limits: productionLimits(entry),
        recordedFrom: RECORDED_FROM,
      })
      const answer = outcome.ok ? outcome.result : { thrown: outcome.error }
      const summary = JSON.stringify(answer)?.slice(
        0,
        process.env.CONTRACT_RECORD_DEBUG ? 3000 : 240,
      )
      const rejected =
        !outcome.ok ||
        (answer !== null && typeof answer === "object" && "error" in (answer as object))
      if (rejected) {
        report.push(`FAIL ${step.entry}: the live run refused | ${summary}`)
        continue
      }
      const scrubbed = scrubFixture(fixture, replacements)
      const problem = await verifyFixture({
        isolate,
        entry,
        fixture: scrubbed,
        surface,
        limits: productionLimits(entry),
      })
      if (problem) {
        report.push(`FAIL ${step.entry}: ${problem} | ${summary}`)
        continue
      }
      expect(JSON.stringify(scrubbed).includes(PASSWORD)).toBe(false)
      writeFixture(FIXTURES_DIR, APP, scrubbed)
      report.push(`ok   ${step.entry} (${scrubbed.calls.length} calls): ${summary}`)
    }
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => l.startsWith("FAIL"))).toEqual([])
  }, 600_000)
})
