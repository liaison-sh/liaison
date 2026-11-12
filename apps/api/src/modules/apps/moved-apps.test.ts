// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app that moved from the source tree to the catalog keeps everything an
// instance had for it (moved-apps.ts): the boot reconcile installs the catalog
// app under the same name and runs its data steps once. Proven by a row diff of
// every table that holds the app's state, before and after, and again after a
// second run (idempotent).
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { ActivationSyncTestAccess } from "~/modules/apps/activation"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { reconcileCatalogApps, resetCatalogCache } from "~/modules/apps/catalog"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { MOVED_APPS, MovedAppsTestAccess } from "~/modules/apps/moved-apps"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const ORG = "00000000-0000-0000-0000-0000000ad001"
const USER = "00000000-0000-0000-0000-0000000ad002"
const APP = "moved-test-app"
const VERSION = "1.0.0"
const ACCOUNT = "00000000-0000-0000-0000-0000000ad003"
const COLLECTION = "00000000-0000-0000-0000-0000000ad004"
const SOURCE = "00000000-0000-0000-0000-0000000ad005"
const IDENTITY = "00000000-0000-0000-0000-0000000ad006"
const DOCUMENT = "00000000-0000-0000-0000-0000000ad007"
const RULES = { finance: { tier: "confidential", roles: ["r1"] } }

let catalogDir: string
let installRoot: string

function bakeCatalog(withApp: boolean, name: string = APP): void {
  const entries: unknown[] = []
  if (withApp) {
    const file = `${name}-${VERSION}.liaisonapp`
    const stage = mkdtempSync(join(tmpdir(), "moved-stage-"))
    writeFileSync(
      join(stage, "app.manifest.json"),
      JSON.stringify({
        name,
        version: VERSION,
        packageFormat: 1,
        license: "MIT",
        scopes: [`${name}:items:read`],
      }),
    )
    writeFileSync(join(stage, "bundle.js"), "// noop\n")
    spawnSync("tar", [
      "-czf",
      join(catalogDir, file),
      "-C",
      stage,
      "app.manifest.json",
      "bundle.js",
    ])
    rmSync(stage, { recursive: true, force: true })
    entries.push({
      name,
      version: VERSION,
      file,
      scopes: [`${name}:items:read`],
      connections: [],
    })
  }
  writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(entries))
  resetCatalogCache()
}

/** The in-tree app's state, as an instance that ran it holds it. */
async function seedInTreeState(): Promise<void> {
  const settings = JSON.stringify({ movedTest: { rules: RULES, other: "kept" }, theme: "dark" })
  const json = (v: unknown) => ({ raw: `'${JSON.stringify(v)}'::jsonb` })
  await sql.unsafe(
    insertSql(
      "kernel.organizations",
      { id: ORG, name: "Moved Org", slug: "moved-org", settings: { raw: `'${settings}'::jsonb` } },
      { onConflictDoNothing: true },
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.users",
      {
        id: USER,
        org_id: ORG,
        email: "moved@test.com",
        password_hash: "hash",
        name: "Moved",
        status: "active",
      },
      { onConflictDoNothing: true },
    ),
  )
  // An org that is already set up, as on a running instance.
  await ensureAppsForOrg(ORG)
  const fixtures: Array<[string, Record<string, RowValue>]> = [
    [
      "kernel.apps",
      { org_id: ORG, name: APP, version: "0.9.0", status: "active", config: json({ kept: true }) },
    ],
    [
      "kernel.connected_accounts",
      {
        id: ACCOUNT,
        org_id: ORG,
        app_name: APP,
        connection_name: "main",
        owner_type: "org",
        provider_type: "credentials",
        identifier: "default",
        credentials_encrypted: "enc:v1:opaque",
        metadata: json({ note: "kept" }),
        created_by: USER,
      },
    ],
    ["app_knowledge.collections", { id: COLLECTION, org_id: ORG, name: "Synced root" }],
    [
      "app_knowledge.synced_sources",
      {
        id: SOURCE,
        org_id: ORG,
        app_name: APP,
        folder_ref: "root",
        display_name: "Synced",
        root_collection_id: COLLECTION,
        default_sensitivity: "internal",
        created_by: USER,
      },
    ],
    [
      "app_knowledge.source_identities",
      { id: IDENTITY, org_id: ORG, source: APP, external_id: "row-1" },
    ],
    [
      "app_knowledge.documents",
      {
        id: DOCUMENT,
        org_id: ORG,
        title: "Doc",
        body: "Body",
        sensitivity: "internal",
        created_by: USER,
        synced_source_id: SOURCE,
        source_identity_id: IDENTITY,
        required_scopes: { raw: "'{}'::text[]" },
      },
    ],
  ]
  for (const [table, row] of fixtures) await sql.unsafe(insertSql(table, row))
}

/** Every row of the app's state, timestamps that a step may touch left out. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const rows = async (query: PromiseLike<readonly unknown[]>) =>
    (await query).map((r) => {
      const { updated_at: _u, ...rest } = r as Record<string, unknown>
      return rest
    })
  return {
    organizations: await rows(sql`SELECT id, settings FROM kernel.organizations WHERE id = ${ORG}`),
    apps: await rows(sql`SELECT id, org_id, name, status, config FROM kernel.apps
      WHERE org_id = ${ORG} AND name = ${APP}`),
    connectedAccounts: await rows(
      sql`SELECT * FROM kernel.connected_accounts WHERE org_id = ${ORG}`,
    ),
    syncedSources: await rows(
      sql`SELECT * FROM app_knowledge.synced_sources WHERE org_id = ${ORG}`,
    ),
    sourceIdentities: await rows(
      sql`SELECT * FROM app_knowledge.source_identities WHERE org_id = ${ORG}`,
    ),
    documents: await rows(sql`SELECT * FROM app_knowledge.documents WHERE org_id = ${ORG}`),
    collections: await rows(sql`SELECT * FROM app_knowledge.collections WHERE org_id = ${ORG}`),
    store: await rows(sql`SELECT app, collection, doc_id, data, version FROM kernel.app_documents
      WHERE org_id = ${ORG} AND app = ${APP}`),
    installed: await rows(sql`SELECT name, version, source_url FROM kernel.apps_installed
      WHERE name = ${APP}`),
    active: await rows(
      sql`SELECT name, version FROM kernel.apps_active_version WHERE name = ${APP}`,
    ),
    adoptions: await rows(sql`SELECT app_name, step_id, report FROM kernel.app_adoptions
      WHERE app_name = ${APP} ORDER BY step_id`),
  }
}

beforeEach(async () => {
  catalogDir = mkdtempSync(join(tmpdir(), "moved-catalog-"))
  installRoot = mkdtempSync(join(tmpdir(), "moved-install-root-"))
  process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  process.env.LIAISON_APPS_DIR = installRoot
  MovedAppsTestAccess.set([
    {
      name: APP,
      steps: [
        {
          id: "settings-rules",
          kind: "org-setting-to-store",
          settingPath: ["movedTest", "rules"],
          collection: "settings",
          docId: "rules",
        },
        { id: "sources-kind", kind: "synced-sources-to-kind", sourceKind: "rows" },
      ],
    },
  ])
  await seedInTreeState()
})

afterEach(async () => {
  await ActivationSyncTestAccess.settle()
  MovedAppsTestAccess.set(null)
  rmSync(catalogDir, { recursive: true, force: true })
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  delete process.env.LIAISON_APPS_DIR
  resetCatalogCache()
  await withSystemDb("moved-apps-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
  })
  resetAppRegistries()
  await sql`DELETE FROM kernel.app_adoptions WHERE app_name = ${APP}`
  await sql`DELETE FROM kernel.app_documents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_document_usage WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.source_identities WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.synced_sources WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.collections WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("an app moved from the source tree to the catalog", () => {
  it("is installed under the same name and keeps every row; its data steps run once", async () => {
    bakeCatalog(true)
    const before = await snapshot()

    const first = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(first.failed).toEqual([])
    expect(first.repaired).toContain(APP)
    const after = await snapshot()

    // Unchanged: the org row, the registration (same id, status, config), the
    // connected account with its credentials, the collection, the identity and
    // the document.
    for (const table of [
      "organizations",
      "apps",
      "connectedAccounts",
      "collections",
      "sourceIdentities",
      "documents",
    ] as const) {
      expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] })
    }
    // Changed, and only as the steps say.
    expect(before.installed).toEqual([])
    expect(after.installed).toEqual([
      { name: APP, version: VERSION, source_url: `catalog:${APP}@${VERSION}` },
    ])
    expect(after.active).toEqual([{ name: APP, version: VERSION }])
    expect(before.store).toEqual([])
    expect(after.store).toEqual([
      { app: APP, collection: "settings", doc_id: "rules", data: { value: RULES }, version: 1 },
    ])
    const [sourceBefore] = before.syncedSources as Array<Record<string, unknown>>
    const [sourceAfter] = after.syncedSources as Array<Record<string, unknown>>
    expect(sourceBefore?.source_kind ?? null).toBeNull()
    expect(sourceAfter).toEqual({
      ...sourceBefore,
      source_kind: "rows",
      source_config: sourceBefore?.source_config ?? {},
    })
    expect(after.adoptions).toEqual([
      { app_name: APP, step_id: "settings-rules", report: { orgs: 1, copied: 1, kept: 0 } },
      { app_name: APP, step_id: "sources-kind", report: { sources: 1 } },
    ])

    // Idempotent: a second boot changes nothing.
    const second = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(second.failed).toEqual([])
    expect(second.ok).toContain(APP)
    expect(await snapshot()).toEqual(after)
  })

  it("never overwrites a document the catalog app already holds", async () => {
    bakeCatalog(true)
    await sql.unsafe(insertSql("kernel.app_adoptions", { app_name: APP, step_id: "sources-kind" }))
    await sql.unsafe(
      insertSql("kernel.app_documents", {
        org_id: ORG,
        app: APP,
        collection: "settings",
        doc_id: "rules",
        data: { raw: `'${JSON.stringify({ value: { mine: true } })}'::jsonb` },
        size_bytes: 20,
      }),
    )
    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.failed).toEqual([])
    const [doc] = await sql`SELECT data FROM kernel.app_documents
      WHERE org_id = ${ORG} AND app = ${APP} AND doc_id = 'rules'`
    expect(doc?.data).toEqual({ value: { mine: true } })
    const [report] = await sql`SELECT report FROM kernel.app_adoptions
      WHERE app_name = ${APP} AND step_id = 'settings-rules'`
    expect(report?.report).toEqual({ orgs: 1, copied: 0, kept: 1 })
  })

  it("fails the reconcile (and so a strict deploy) when the image's catalog lacks the moved app", async () => {
    bakeCatalog(false)
    const before = await snapshot()
    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.failed.map((f) => f.name)).toEqual([APP])
    expect(await snapshot()).toEqual(before)
  })

  it("leaves an instance that never ran the in-tree app alone", async () => {
    bakeCatalog(true)
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG} AND name = ${APP}`
    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.failed).toEqual([])
    expect(result.repaired).not.toContain(APP)
    const installed = await sql`SELECT 1 FROM kernel.apps_installed WHERE name = ${APP}`
    expect(installed.length).toBe(0)
  })
})

describe("the moved-app list", () => {
  const repoRoot = join(import.meta.dir, "../../../../..")
  it("names apps that ship as catalog apps and no longer in the source tree", () => {
    for (const app of MOVED_APPS) {
      expect(existsSync(join(repoRoot, "bundled-apps", app.name, "app.manifest.json"))).toBe(true)
      expect(existsSync(join(repoRoot, "apps/api/src/apps", app.name))).toBe(false)
    }
    // Sanity: the paths above resolve to the repository.
    expect(readdirSync(join(repoRoot, "bundled-apps")).length).toBeGreaterThan(0)
  })
})

// The database app's own move, with the real step list: its Report access
// rules leave the org's settings for the app's store under the key the app
// reads (settings / domain_access, bundled-apps/database/src/access.ts), its
// knowledge sources become the app's `catalog` kind, and every other row it
// had (registration, both connections and their credentials, the synced
// source's documents and identities) is the same row before and after.
describe("the database app's move", () => {
  const DB = "database"
  const DB_ACCOUNT = "00000000-0000-0000-0000-0000000ad013"
  const WH_ACCOUNT = "00000000-0000-0000-0000-0000000ad023"
  const DB_SOURCE = "00000000-0000-0000-0000-0000000ad015"
  const DB_IDENTITY = "00000000-0000-0000-0000-0000000ad016"
  const DB_DOCUMENT = "00000000-0000-0000-0000-0000000ad017"
  const ACCESS = {
    revenue: { tier: "confidential", roles: ["00000000-0000-0000-0000-0000000ad0a1"] },
  }
  const json = (v: unknown) => ({ raw: `'${JSON.stringify(v)}'::jsonb` })

  async function seedDatabaseApp(): Promise<void> {
    await sql`UPDATE kernel.organizations
      SET settings = settings || ${JSON.stringify({ database: { domainAccess: ACCESS } })}::jsonb
      WHERE id = ${ORG}`
    const rows: Array<[string, Record<string, RowValue>]> = [
      [
        "kernel.apps",
        { org_id: ORG, name: DB, version: "1.4.0", status: "active", config: json({}) },
      ],
      ...[
        [DB_ACCOUNT, "database"],
        [WH_ACCOUNT, "warehouse"],
      ].map(
        ([id, conn]) =>
          [
            "kernel.connected_accounts",
            {
              id: id as string,
              org_id: ORG,
              app_name: DB,
              connection_name: conn as string,
              owner_type: "org",
              provider_type: "credentials",
              identifier: conn === "warehouse" ? "warehouse" : "default",
              credentials_encrypted: `enc:v1:${conn}`,
              created_by: USER,
            },
          ] as [string, Record<string, RowValue>],
      ),
      [
        "app_knowledge.synced_sources",
        {
          id: DB_SOURCE,
          org_id: ORG,
          app_name: DB,
          folder_ref: "default",
          display_name: "database folder default",
          root_collection_id: COLLECTION,
          default_sensitivity: "internal",
          created_by: USER,
        },
      ],
      [
        "app_knowledge.source_identities",
        { id: DB_IDENTITY, org_id: ORG, source: DB, external_id: "kb-1" },
      ],
      [
        "app_knowledge.documents",
        {
          id: DB_DOCUMENT,
          org_id: ORG,
          title: "Pairing",
          body: "Hold the button",
          sensitivity: "internal",
          created_by: USER,
          synced_source_id: DB_SOURCE,
          source_identity_id: DB_IDENTITY,
          required_scopes: { raw: "'{}'::text[]" },
        },
      ],
    ]
    for (const [table, row] of rows) await sql.unsafe(insertSql(table, row))
  }

  async function dbSnapshot(): Promise<Record<string, unknown[]>> {
    const strip = (rows: readonly unknown[]) =>
      rows.map((r) => {
        const { updated_at: _u, ...rest } = r as Record<string, unknown>
        return rest
      })
    return {
      settings: strip(await sql`SELECT settings FROM kernel.organizations WHERE id = ${ORG}`),
      apps: strip(
        await sql`SELECT id, name, status, config FROM kernel.apps
        WHERE org_id = ${ORG} AND name = ${DB}`,
      ),
      accounts: strip(
        await sql`SELECT * FROM kernel.connected_accounts
        WHERE org_id = ${ORG} AND app_name = ${DB} ORDER BY connection_name`,
      ),
      sources: strip(
        await sql`SELECT * FROM app_knowledge.synced_sources
        WHERE org_id = ${ORG} AND app_name = ${DB}`,
      ),
      identities: strip(
        await sql`SELECT * FROM app_knowledge.source_identities
        WHERE org_id = ${ORG} AND source = ${DB}`,
      ),
      documents: strip(await sql`SELECT * FROM app_knowledge.documents WHERE id = ${DB_DOCUMENT}`),
      store: strip(
        await sql`SELECT collection, doc_id, data FROM kernel.app_documents
        WHERE org_id = ${ORG} AND app = ${DB}`,
      ),
      adoptions: strip(
        await sql`SELECT step_id, report FROM kernel.app_adoptions
        WHERE app_name = ${DB} ORDER BY step_id`,
      ),
    }
  }

  afterEach(async () => {
    await withSystemDb("moved-apps-db-test-cleanup", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, DB))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, DB))
    })
    await sql`DELETE FROM kernel.app_adoptions WHERE app_name = ${DB}`
  })

  it("keeps every row and moves Report access and the knowledge source, once", async () => {
    MovedAppsTestAccess.set(null)
    bakeCatalog(true, DB)
    await seedDatabaseApp()
    const before = await dbSnapshot()

    const first = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(first.failed).toEqual([])
    expect(first.repaired).toContain(DB)
    const after = await dbSnapshot()

    // Same rows: the settings (the source of the copy is kept for a rollback),
    // the registration, both connections with their credentials, the
    // identity and the document.
    for (const table of ["settings", "apps", "accounts", "identities", "documents"] as const) {
      expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] })
    }
    expect(before.store).toEqual([])
    expect(after.store).toEqual([
      { collection: "settings", doc_id: "domain_access", data: { value: ACCESS } },
    ])
    const [sourceBefore] = before.sources as Array<Record<string, unknown>>
    expect(after.sources).toEqual([
      { ...sourceBefore, source_kind: "catalog", source_config: sourceBefore?.source_config ?? {} },
    ])
    expect(after.adoptions).toEqual([
      { step_id: "domain-access-to-store", report: { orgs: 1, copied: 1, kept: 0 } },
      { step_id: "knowledge-sources-to-catalog", report: { sources: 1 } },
    ])

    const second = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(second.failed).toEqual([])
    expect(await dbSnapshot()).toEqual(after)
  })
})

// The API connector's move: everything it had stays where the catalog app (and
// the platform-held API connections, connections/api/) read it. The
// registration, both connections' accounts with their encrypted credentials,
// the adapters and their kept versions in the app's own tables are the same
// rows before and after, the catalog app is installed under the same name, and
// the platform still reads every connection.
describe("the api-connector app's move", () => {
  const AC = "api-connector"
  const CRM_ACCOUNT = "00000000-0000-0000-0000-0000000ad033"
  const ERP_ACCOUNT = "00000000-0000-0000-0000-0000000ad043"
  const json = (v: unknown) => ({ raw: `'${JSON.stringify(v)}'::jsonb` })
  const adapter = (id: string, auth: Record<string, unknown>) => ({
    id,
    name: `${id.toUpperCase()} system`,
    version: "1.0.0",
    baseUrl: `https://${id}.example.com/api`,
    auth,
    operations: [
      {
        name: "list_companies",
        description: "Companies.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: {} },
        items: "/data",
        fields: ["id", "name"],
      },
    ],
  })
  const CRM = adapter("crm", { type: "apiKey", in: "header", name: "X-Api-Key" })
  const ERP = adapter("erp", {
    type: "oauth2ClientCredentials",
    tokenUrl: "https://erp.example.com/oauth/token",
  })

  async function seedApiConnector(): Promise<void> {
    const rows: Array<[string, Record<string, RowValue>]> = [
      [
        "kernel.apps",
        { org_id: ORG, name: AC, version: "1.3.1", status: "active", config: json({}) },
      ],
      ...[
        [CRM_ACCOUNT, "crm"],
        [ERP_ACCOUNT, "erp"],
      ].map(
        ([id, identifier]) =>
          [
            "kernel.connected_accounts",
            {
              id: id as string,
              org_id: ORG,
              app_name: AC,
              connection_name: "api",
              owner_type: "org",
              provider_type: "credentials",
              identifier: identifier as string,
              display_name: `${identifier} system`,
              credentials_encrypted: `enc:v1:${identifier}`,
              created_by: USER,
            },
          ] as [string, Record<string, RowValue>],
      ),
      ...[CRM, ERP].map(
        (doc) =>
          [
            "app_api_connector.adapters",
            {
              org_id: ORG,
              identifier: doc.id,
              adapter: json(doc),
              adapter_version: doc.version,
              updated_by: USER,
            },
          ] as [string, Record<string, RowValue>],
      ),
      [
        "app_api_connector.adapter_versions",
        {
          org_id: ORG,
          identifier: "crm",
          adapter: json({ ...CRM, version: "0.9.0" }),
          adapter_version: "0.9.0",
          saved_by: USER,
          saved_at: { raw: "now()" },
        },
      ],
    ]
    for (const [table, row] of rows) await sql.unsafe(insertSql(table, row))
  }

  async function acSnapshot(): Promise<Record<string, unknown[]>> {
    const strip = (rows: readonly unknown[]) =>
      rows.map((r) => {
        const { updated_at: _u, ...rest } = r as Record<string, unknown>
        return rest
      })
    return {
      apps: strip(
        await sql`SELECT id, name, status, config FROM kernel.apps
        WHERE org_id = ${ORG} AND name = ${AC}`,
      ),
      accounts: strip(
        await sql`SELECT * FROM kernel.connected_accounts
        WHERE org_id = ${ORG} AND app_name = ${AC} ORDER BY identifier`,
      ),
      adapters: strip(
        await sql`SELECT * FROM app_api_connector.adapters WHERE org_id = ${ORG} ORDER BY identifier`,
      ),
      versions: strip(
        await sql`SELECT * FROM app_api_connector.adapter_versions
        WHERE org_id = ${ORG} ORDER BY identifier, saved_at`,
      ),
      adoptions: strip(
        await sql`SELECT step_id, report FROM kernel.app_adoptions WHERE app_name = ${AC}`,
      ),
    }
  }

  afterEach(async () => {
    await withSystemDb("moved-apps-ac-test-cleanup", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, AC))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, AC))
    })
    await sql`DELETE FROM app_api_connector.adapter_versions WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_api_connector.adapters WHERE org_id = ${ORG}`
  })

  it("keeps every row: registration, accounts and credentials, adapters and their versions", async () => {
    MovedAppsTestAccess.set(null)
    bakeCatalog(true, AC)
    await seedApiConnector()
    const before = await acSnapshot()
    expect(before.accounts).toHaveLength(2)
    expect(before.adapters).toHaveLength(2)
    expect(before.versions).toHaveLength(1)

    const first = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(first.failed).toEqual([])
    expect(first.repaired).toContain(AC)
    const after = await acSnapshot()
    expect(after).toEqual(before)
    expect(after.adoptions).toEqual([])
    const [installed] = await sql`SELECT name, version, source_url FROM kernel.apps_installed
      WHERE name = ${AC}`
    expect(installed?.version).toBe(VERSION)

    // The platform reads every connection, with its credentials' status.
    const { listAdapterRows, credentialStatuses } = await import(
      "~/modules/apps/connections/api/store"
    )
    expect((await listAdapterRows(ORG)).map((r) => [r.identifier, r.adapter.auth.type])).toEqual([
      ["crm", "apiKey"],
      ["erp", "oauth2ClientCredentials"],
    ])
    expect([...(await credentialStatuses(ORG)).keys()].sort()).toEqual(["crm", "erp"])

    const second = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(second.failed).toEqual([])
    expect(await acSnapshot()).toEqual(after)
  })
})
