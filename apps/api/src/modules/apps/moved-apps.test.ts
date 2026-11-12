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

function bakeCatalog(withApp: boolean): void {
  const entries: unknown[] = []
  if (withApp) {
    const file = `${APP}-${VERSION}.liaisonapp`
    const stage = mkdtempSync(join(tmpdir(), "moved-stage-"))
    writeFileSync(
      join(stage, "app.manifest.json"),
      JSON.stringify({
        name: APP,
        version: VERSION,
        packageFormat: 1,
        license: "MIT",
        scopes: [`${APP}:items:read`],
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
      name: APP,
      version: VERSION,
      file,
      scopes: [`${APP}:items:read`],
      connections: [],
    })
  }
  writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(entries))
  resetCatalogCache()
}

/** The in-tree app's state, as an instance that ran it holds it. */
async function seedInTreeState(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${ORG}, 'Moved Org', 'moved-org',
      ${JSON.stringify({ movedTest: { rules: RULES, other: "kept" }, theme: "dark" })}::jsonb)
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${USER}, ${ORG}, 'moved@test.com', 'hash', 'Moved', 'active')
    ON CONFLICT (id) DO NOTHING`
  // An org that is already set up, as on a running instance.
  await ensureAppsForOrg(ORG)
  await sql`INSERT INTO kernel.apps (org_id, name, version, status, config)
    VALUES (${ORG}, ${APP}, '0.9.0', 'active', ${JSON.stringify({ kept: true })}::jsonb)`
  await sql`INSERT INTO kernel.connected_accounts
      (id, org_id, app_name, connection_name, owner_type, provider_type, identifier,
       credentials_encrypted, metadata, created_by)
    VALUES (${ACCOUNT}, ${ORG}, ${APP}, 'main', 'org', 'credentials', 'default',
      'enc:v1:opaque', ${JSON.stringify({ note: "kept" })}::jsonb, ${USER})`
  await sql`INSERT INTO app_knowledge.collections (id, org_id, name)
    VALUES (${COLLECTION}, ${ORG}, 'Synced root')`
  await sql`INSERT INTO app_knowledge.synced_sources
      (id, org_id, app_name, folder_ref, display_name, root_collection_id,
       default_sensitivity, created_by)
    VALUES (${SOURCE}, ${ORG}, ${APP}, 'root', 'Synced', ${COLLECTION}, 'internal', ${USER})`
  await sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
    VALUES (${IDENTITY}, ${ORG}, ${APP}, 'row-1')`
  await sql`INSERT INTO app_knowledge.documents
      (id, org_id, title, body, sensitivity, created_by, synced_source_id, source_identity_id, required_scopes)
    VALUES (${DOCUMENT}, ${ORG}, 'Doc', 'Body', 'internal', ${USER}, ${SOURCE}, ${IDENTITY}, '{}'::text[])`
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
    await sql`INSERT INTO kernel.app_adoptions (app_name, step_id) VALUES (${APP}, 'sources-kind')`
    await sql`INSERT INTO kernel.app_documents (org_id, app, collection, doc_id, data, size_bytes)
      VALUES (${ORG}, ${APP}, 'settings', 'rules', ${JSON.stringify({ value: { mine: true } })}::jsonb, 20)`
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
