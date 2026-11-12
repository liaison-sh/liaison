// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the apps provisioner (Task 11).
 *
 * - enable-only (invoicing: no connections) → enabled, no pending, no connection;
 *   re-run → still ONE entry in settings.enabledApps (idempotent DISTINCT).
 * - credentials connection (gitlab) → connected_accounts row + derived identifier;
 *   re-run → NO new row (4-key precheck, count==1).
 * - oauth2 connection (shopify/shop) → pending, no write.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appSettingsSchema } from "@liaison/app-sdk"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { planAppSettings } from "~/cli/provisioners/app-settings"
import { appsProvisioner } from "~/cli/provisioners/apps"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { readOrgAppNamespace } from "~/lib/settings"
import {
  appSettingsRegistry,
  connectionConfigRegistry,
  manifestRegistry,
} from "~/modules/apps/app-registries"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { getCredentialsForConnection } from "~/modules/apps/connections/service"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { buildManifestSettingsEntry } from "~/modules/apps/settings-schema-from-manifest"
import { requiredScopesFor } from "~/modules/provisioning/config-section-scopes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Pin an EMPTY catalog for the enable-only / connection cases so they are
// deterministic regardless of whether a dev built the repo-root app-catalog/
// (a present catalog would make invoicing INSTALL instead of enable-only). The
// dedicated install test below points the env at its own controlled catalog.
let emptyCatalogDir: string
beforeAll(async () => {
  await acquireTestLock()
  emptyCatalogDir = mkdtempSync(join(tmpdir(), "apps-prov-empty-catalog-"))
  process.env.LIAISON_APP_CATALOG_DIR = emptyCatalogDir
  resetCatalogCache()
})
afterAll(async () => {
  rmSync(emptyCatalogDir, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  await releaseTestLock()
})

async function freshOrgWithAdmin(): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-apps-${crypto.randomUUID().slice(0, 12)}`,
    name: "AppsTestOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-apps-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

interface AppEntry {
  name: string
  enabled: boolean
  installed?: boolean
  connected?: boolean
}

/** (Re)write a single-app catalog (tarball + catalog.json) at `version` into an
 *  existing catalog dir. Reused to simulate a newer baked catalog (an upgrade). */
function writeCatalogEntry(catalogDir: string, name: string, version: string): void {
  const stage = mkdtempSync(join(tmpdir(), "apps-prov-stage-"))
  const scope = `${name}:items:read`
  writeFileSync(
    join(stage, "app.manifest.json"),
    JSON.stringify({
      name,
      version,
      packageFormat: 1,
      license: "MIT",
      scopes: [scope],
    }),
  )
  writeFileSync(join(stage, "bundle.js"), "// noop\n")
  const file = `${name}-${version}.liaisonapp`
  spawnSync("tar", ["-czf", join(catalogDir, file), "-C", stage, "app.manifest.json", "bundle.js"])
  rmSync(stage, { recursive: true, force: true })
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([{ name, version, file, scopes: [scope], connections: [] }]),
  )
}

/** Stage a minimal `.liaisonapp` + catalog.json into a fresh catalog dir, so the
 *  provisioner sees `name` as a first-party catalog app to install. */
function stageCatalog(name: string): { catalogDir: string; installRoot: string } {
  const catalogDir = mkdtempSync(join(tmpdir(), "apps-prov-catalog-"))
  const installRoot = mkdtempSync(join(tmpdir(), "apps-prov-install-root-"))
  writeCatalogEntry(catalogDir, name, "0.1.0")
  return { catalogDir, installRoot }
}

function findApp(result: { section?: unknown }, name: string): AppEntry {
  const section = result.section as { apps: AppEntry[] }
  const entry = section.apps.find((a) => a.name === name)
  if (!entry) throw new Error(`no app result entry for '${name}'`)
  return entry
}

describe("apps provisioner (Task 11)", () => {
  test("enable-only (invoicing): enabled, no pending, no connection; idempotent enabledApps DISTINCT", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [{ name: "invoicing", enable: true }],
    }

    const r1 = await appsProvisioner.apply(ctx, { actions: [] }, config)
    const e1 = findApp(r1, "invoicing")
    expect(e1.enabled).toBe(true)
    expect(e1.connected).toBeFalsy()
    expect((r1.pending ?? []).length).toBe(0)

    const enabled1 = await getEnabledApps(orgId)
    expect(enabled1.filter((a) => a === "invoicing").length).toBe(1)

    // Run 1 reported the app as a CHANGE (newly enabled).
    expect(r1.changed ?? []).toContain("apps.invoicing.enabled")
    expect(r1.unchanged ?? []).not.toContain("apps.invoicing.enabled")

    // Re-run → idempotent DISTINCT (still exactly one entry) AND reported as
    // UNCHANGED, not changed (enableApp returns false on a no-op re-enable).
    const r2 = await appsProvisioner.apply(ctx, { actions: [] }, config)
    const enabled2 = await getEnabledApps(orgId)
    expect(enabled2.filter((a) => a === "invoicing").length).toBe(1)
    expect(r2.unchanged ?? []).toContain("apps.invoicing.enabled")
    expect(r2.changed ?? []).not.toContain("apps.invoicing.enabled")
  })

  test("an app an admin turned Off is turned on, reported changed and enabled (CLI)", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await ensureAppsForOrg(orgId)
    await setOrgAppStatus(orgId, "projects", "disabled")
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [{ name: "projects", enable: true }],
    }
    const r = await appsProvisioner.apply(ctx, { actions: [] }, config)
    expect((await getOrgAppState(orgId, "projects"))?.status).toBe("active")
    expect(findApp(r, "projects").enabled).toBe(true)
    expect(r.changed ?? []).toContain("apps.projects.enabled")
    // Re-run: already On, unchanged.
    const again = await appsProvisioner.apply(ctx, { actions: [] }, config)
    expect(again.unchanged ?? []).toContain("apps.projects.enabled")
  })

  test("catalog app: installed from the catalog + enabled; re-run reports unchanged install", async () => {
    const appName = `catprov-${crypto.randomUUID().slice(0, 8)}`
    const { catalogDir, installRoot } = stageCatalog(appName)
    const prevCatalog = process.env.LIAISON_APP_CATALOG_DIR
    const prevApps = process.env.LIAISON_APPS_DIR
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    process.env.LIAISON_APPS_DIR = installRoot
    resetCatalogCache()
    try {
      const { ctx, orgId } = await freshOrgWithAdmin()
      await ensureAppsForOrg(orgId)
      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        apps: [{ name: appName, enable: true }],
      }

      const r1 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      const e1 = findApp(r1, appName)
      expect(e1.enabled).toBe(true)
      expect(e1.installed).toBe(true)
      expect(r1.changed ?? []).toContain(`apps.${appName}.installed`)

      // The install actually landed (active-version row).
      const active = await withSystemDb("apps-prov-active", (db) =>
        db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, appName)),
      )
      expect(active).toHaveLength(1)

      // Re-run → already installed → reported UNCHANGED, not changed.
      const r2 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(r2.unchanged ?? []).toContain(`apps.${appName}.installed`)
      expect(r2.changed ?? []).not.toContain(`apps.${appName}.installed`)
    } finally {
      await withSystemDb("apps-prov-cleanup", async (db) => {
        await db.delete(appsInstalled).where(eq(appsInstalled.name, appName))
        await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, appName))
      })
      if (prevCatalog === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
      else process.env.LIAISON_APP_CATALOG_DIR = prevCatalog
      if (prevApps === undefined) delete process.env.LIAISON_APPS_DIR
      else process.env.LIAISON_APPS_DIR = prevApps
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
      rmSync(installRoot, { recursive: true, force: true })
    }
  })

  // An apps-only config (no `admin` block) on an org that has its owner: the
  // admin section acts as the org's admin, so the install records its author.
  // Without one, the install is a usage error that names the missing block.
  test("apps-only config (no admin block): catalog app installs as the org's admin; no admin = clear error", async () => {
    const appName = `catnoadm-${crypto.randomUUID().slice(0, 8)}`
    const { catalogDir, installRoot } = stageCatalog(appName)
    const prevCatalog = process.env.LIAISON_APP_CATALOG_DIR
    const prevApps = process.env.LIAISON_APPS_DIR
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    process.env.LIAISON_APPS_DIR = installRoot
    resetCatalogCache()
    try {
      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        apps: [{ name: appName, enable: true }],
      }

      // Org without any admin: a clear ConfigError naming `admin`, no install.
      const { orgId: bareOrg } = await ensureOrg({
        slug: `cli-apps-bare-${crypto.randomUUID().slice(0, 8)}`,
        name: "Bare",
      })
      await ensureAppsForOrg(bareOrg)
      const bare = buildProvisionContext({ log: () => {}, validateByok: false })
      bare.orgId = bareOrg
      await adminProvisioner.apply(bare, { actions: [] }, config)
      const err = await appsProvisioner.apply(bare, { actions: [] }, config).catch((e) => e)
      expect(err).toBeInstanceOf(ConfigError)
      expect(String(err.message)).toContain("admin")

      // Org with its owner: installs, authored by that admin.
      const { ctx: seeded, orgId } = await freshOrgWithAdmin()
      const adminId = seeded.actor.userId
      await ensureAppsForOrg(orgId)
      const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
      ctx.orgId = orgId
      await adminProvisioner.apply(ctx, { actions: [] }, config)
      const r = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(findApp(r, appName).installed).toBe(true)
      const rows = await withSystemDb("apps-prov-installed-by", (db) =>
        db
          .select({ installedBy: appsInstalled.installedBy })
          .from(appsInstalled)
          .where(eq(appsInstalled.name, appName)),
      )
      expect(rows.map((row) => row.installedBy)).toContain(adminId)
    } finally {
      await withSystemDb("apps-prov-cleanup", async (db) => {
        await db.delete(appsInstalled).where(eq(appsInstalled.name, appName))
        await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, appName))
      })
      if (prevCatalog === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
      else process.env.LIAISON_APP_CATALOG_DIR = prevCatalog
      if (prevApps === undefined) delete process.env.LIAISON_APPS_DIR
      else process.env.LIAISON_APPS_DIR = prevApps
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
      rmSync(installRoot, { recursive: true, force: true })
    }
  })

  test("plan (tool path): a newer active version than the catalog's is said, not planned as a change", async () => {
    const appName = `catahead-${crypto.randomUUID().slice(0, 8)}`
    const { catalogDir, installRoot } = stageCatalog(appName)
    const prevCatalog = process.env.LIAISON_APP_CATALOG_DIR
    const prevApps = process.env.LIAISON_APPS_DIR
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    process.env.LIAISON_APPS_DIR = installRoot
    resetCatalogCache()
    try {
      const { ctx, orgId } = await freshOrgWithAdmin()
      await ensureAppsForOrg(orgId)
      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        apps: [{ name: appName, enable: true }],
      }
      await appsProvisioner.apply(ctx, { actions: [] }, config)
      // A rollback: this release's catalog carries an older version.
      writeCatalogEntry(catalogDir, appName, "0.0.9")
      resetCatalogCache()
      ctx.toolPath = true
      const plan = await appsProvisioner.plan(ctx, config)
      expect(plan.actions).toContain(`app '${appName}': kept newer v0.1.0 (catalog has v0.0.9)`)
      expect(plan.actions.some((a) => a.startsWith(`upgrade app '${appName}'`))).toBe(false)
      expect(plan.changes ?? 0).toBe(0)
    } finally {
      await withSystemDb("apps-prov-cleanup", async (db) => {
        await db.delete(appsInstalled).where(eq(appsInstalled.name, appName))
        await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, appName))
      })
      if (prevCatalog === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
      else process.env.LIAISON_APP_CATALOG_DIR = prevCatalog
      if (prevApps === undefined) delete process.env.LIAISON_APPS_DIR
      else process.env.LIAISON_APPS_DIR = prevApps
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
      rmSync(installRoot, { recursive: true, force: true })
    }
  })

  // NOTE: the provisioner's version-aware UPGRADE branch (re-install when the baked
  // catalog version differs from the installed one) is not exercised as a full
  // apply here: an upgrade means a SECOND installCatalogApp in one test, and each
  // install runs reloadInstalledApps (re-registers every org app) -- two of those
  // blow past the unit suite's fixed 5s per-test cap. The branch's INPUT (the
  // installed-vs-catalog version skew that drives `needsUpgrade`) is covered cheaply
  // by catalog.test.ts "reports installedVersion + detects an available upgrade",
  // and the install action itself by the "installed from the catalog" case above.

  test("credentials connection (gitlab): connected_accounts row + derived identifier; re-run no dup", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const group = `grp-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: "gitlab",
          enable: true,
          connection: {
            name: "gitlab",
            identifier: group,
            ownerType: "org",
            credentials: { token: "glpat-secret-1", group },
          },
        },
      ],
    }

    const r1 = await appsProvisioner.apply(ctx, { actions: [] }, config)
    const e1 = findApp(r1, "gitlab")
    expect(e1.enabled).toBe(true)
    expect(e1.connected).toBe(true)

    const count1 = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = 'gitlab' AND connection_name = 'gitlab'
          AND identifier = ${group} AND status = 'active'
      `),
    )
    expect(extractRows(count1).length).toBe(1)

    // Re-run → no new connected_account.
    await appsProvisioner.apply(ctx, { actions: [] }, config)
    const count2 = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = 'gitlab' AND connection_name = 'gitlab'
          AND identifier = ${group} AND status = 'active'
      `),
    )
    expect(extractRows(count2).length).toBe(1)
  })

  // A credentials connection whose non-secret setting (the URL) moved: the dry
  // run's plan shows old -> new without writing, apply replaces it and reports
  // the change on the app entry, and the post-apply health check turns a dead
  // connection into a pending item instead of a silent success.
  test("credentials connection drift: plan shows it, apply writes it, a failed health check is pending", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const [org] = await withSystemDb("t", (db) =>
      db
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, orgId)),
    )
    if (!org) throw new Error("org not found")
    const identifier = `gate-${crypto.randomUUID().slice(0, 8)}`
    const configWith = (group: string): ProvisioningConfig => ({
      org: { slug: org.slug, name: "X" },
      apps: [
        {
          name: "gitlab",
          enable: true,
          connection: {
            name: "gitlab",
            identifier,
            ownerType: "org",
            credentials: { group, token: "tok-SECRET-1" },
          },
        },
      ],
    })
    await appsProvisioner.apply(ctx, { actions: [] }, configWith("team-old"))

    // Dry run: the CLI plans with no org set yet (resolved by slug).
    const planCtx = buildProvisionContext({ log: () => {}, validateByok: false })
    const plan = await appsProvisioner.plan(planCtx, configWith("team-new"))
    expect(plan.actions).toContain(
      `update app 'gitlab' connection 'gitlab': group "team-old" -> "team-new"`,
    )
    const afterPlan = await withPrivilegedDb(orgId, "t", (tx) =>
      getCredentialsForConnection(tx, orgId, ctx.actor.userId, "gitlab", "gitlab", identifier, {
        actorType: "system",
      }),
    )
    expect(afterPlan.group).toBe("team-old")

    // Apply: replaced, reported, then probed.
    ctx.connectionProbes = {
      gitlab: async () => {
        throw new Error("HTTP 404 from gate-new.example.com")
      },
    }
    const r = await appsProvisioner.apply(
      ctx,
      { actions: [] },
      configWith("team-new"),
    )
    expect(r.changed).toContain("apps.gitlab.connection.group")
    const entry = (r.section as { apps: Array<Record<string, unknown>> }).apps.find(
      (a) => a.name === "gitlab",
    )
    expect(entry?.connectionChanges).toEqual([
      {
        field: "group",
        secret: false,
        from: "team-old",
        to: "team-new",
      },
    ])
    expect(entry?.health).toEqual({ status: "FAIL", error: "HTTP 404 from gate-new.example.com" })
    const healthPending = (r.pending ?? []).find(
      (p) => p.app === "gitlab" && p.kind === "credentials",
    )
    expect(healthPending?.message).toContain("health check failed")
    expect(JSON.stringify(r)).not.toContain("tok-SECRET")

    const afterApply = await withPrivilegedDb(orgId, "t", (tx) =>
      getCredentialsForConnection(tx, orgId, ctx.actor.userId, "gitlab", "gitlab", identifier, {
        actorType: "system",
      }),
    )
    expect(afterApply.group).toBe("team-new")
  })

  test("oauth2 connection (google-drive/drive): pending, no write", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: "google-drive",
          enable: true,
          connection: { name: "drive", identifier: "drive-account", ownerType: "org" },
        },
      ],
    }

    const r = await appsProvisioner.apply(ctx, { actions: [] }, config)
    const e = findApp(r, "google-drive")
    expect(e.enabled).toBe(true)
    expect(e.connected).toBeFalsy()

    const pending = r.pending ?? []
    expect(pending.find((p) => p.app === "google-drive" && p.connection === "drive")).toBeDefined()

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = 'google-drive'
      `),
    )
    expect(extractRows(rows).length).toBe(0)
  })
})

describe("apps provisioner: apps[].config", () => {
  const APP = "cfgprov"

  /** A registered app declaring two config keys and a connection secret key. */
  async function orgWithConfigApp(): Promise<{ ctx: ProvisionContext; orgId: string }> {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await ensureAppsForOrg(orgId)
    manifestRegistry.set([orgId, APP], {
      name: APP,
      uiBundleUrl: null,
      configKeys: [
        { key: "sources", type: "json" },
        { key: "dashboardUrl", type: "url" },
      ],
    })
    connectionConfigRegistry.set([orgId, APP, "hook"], {
      type: "credentials",
      allowedDomains: ["demo.test"],
      webhookSecretConfigKey: "hookSecret",
    })
    await withSystemDb("apps-prov-config-row", (db) =>
      db.execute(drizzleSql`
        INSERT INTO kernel.apps (org_id, name, version, status, config)
        VALUES (${orgId}, ${APP}, '1.0.0', 'active', '{"hookSecret":"cipher"}'::jsonb)
      `),
    )
    return { ctx, orgId }
  }

  async function storedConfig(orgId: string): Promise<Record<string, unknown>> {
    const rows = await withSystemDb("apps-prov-config-read", (db) =>
      db.execute(
        drizzleSql`SELECT config FROM kernel.apps WHERE org_id = ${orgId} AND name = ${APP}`,
      ),
    )
    return (extractRows<{ config: Record<string, unknown> }>(rows)[0]?.config ?? {}) as Record<
      string,
      unknown
    >
  }

  test("writes declared keys; re-apply with the same values reports unchanged", async () => {
    const { ctx, orgId } = await orgWithConfigApp()
    const sources = [{ id: "uptime", label: "Uptime" }]
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: APP,
          enable: true,
          config: { sources, dashboardUrl: "https://status.example/board" },
        },
      ],
    }
    try {
      const r1 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(r1.changed ?? []).toEqual(
        expect.arrayContaining([`apps.${APP}.config.sources`, `apps.${APP}.config.dashboardUrl`]),
      )
      const stored = await storedConfig(orgId)
      expect(stored.sources).toEqual(sources)
      expect(stored.dashboardUrl).toBe("https://status.example/board")
      expect(stored.hookSecret).toBe("cipher")

      const r2 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(r2.unchanged ?? []).toEqual(
        expect.arrayContaining([`apps.${APP}.config.sources`, `apps.${APP}.config.dashboardUrl`]),
      )
      expect((r2.changed ?? []).filter((k) => k.includes(".config."))).toEqual([])
    } finally {
      manifestRegistry.delete([orgId, APP])
      connectionConfigRegistry.deleteByPrefix([orgId, APP])
    }
  })

  test("a connection secret key or an undeclared key is a usage error, nothing written", async () => {
    const { ctx, orgId } = await orgWithConfigApp()
    try {
      for (const bad of [{ hookSecret: "attacker" }, { other: 1 }, { dashboardUrl: "ftp://x" }]) {
        const config: ProvisioningConfig = {
          org: { slug: "x", name: "X" },
          apps: [{ name: APP, enable: true, config: { sources: [], ...bad } }],
        }
        await expect(appsProvisioner.plan(ctx, config)).rejects.toBeInstanceOf(ConfigError)
        await expect(appsProvisioner.apply(ctx, { actions: [] }, config)).rejects.toBeInstanceOf(
          ConfigError,
        )
      }
      const stored = await storedConfig(orgId)
      expect(stored.hookSecret).toBe("cipher")
      expect(stored.sources).toBeUndefined()
      expect(stored.other).toBeUndefined()
    } finally {
      manifestRegistry.delete([orgId, APP])
      connectionConfigRegistry.deleteByPrefix([orgId, APP])
    }
  })
})

describe("apps provisioner: apps[].settings", () => {
  const APP = "setprov"

  /** A registered app whose settings page has a toggle in the org settings and a
   *  field kept in its config, under a section guarded by its own admin scope. */
  async function orgWithSettingsApp(): Promise<{ ctx: ProvisionContext; orgId: string }> {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await ensureAppsForOrg(orgId)
    const manifestSettings = buildManifestSettingsEntry(
      appSettingsSchema.parse({
        sections: [
          {
            id: "main",
            title: "Main",
            scope: "org",
            adminScope: `${APP}:admin`,
            blocks: [
              { block: "field", key: "history", type: "toggle", label: "History", default: false },
              { block: "field", key: "url", type: "url", label: "Link", source: "config" },
            ],
          },
        ],
      }),
      { app: APP },
    )
    appSettingsRegistry.set([orgId, APP], { manifestSettings })
    return { ctx, orgId }
  }

  async function storedNamespace(orgId: string): Promise<Record<string, unknown>> {
    return withPrivilegedDb(orgId, "apps-prov-settings-read", (tx) =>
      readOrgAppNamespace(tx, orgId, APP),
    )
  }

  test("writes a declared org field; re-apply reports unchanged; its admin scope is required", async () => {
    const { ctx, orgId } = await orgWithSettingsApp()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [{ name: APP, enable: true, settings: { history: true } }],
    }
    try {
      expect(requiredScopesFor(orgId, "apps", config)).toEqual(
        expect.arrayContaining(["kernel:apps:admin", `${APP}:admin`]),
      )
      expect(await planAppSettings(ctx, APP, { history: true })).toEqual([
        `set app '${APP}' setting 'history' to true`,
      ])
      const r1 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(r1.changed ?? []).toContain(`apps.${APP}.settings.history`)
      expect((await storedNamespace(orgId)).history).toBe(true)

      const r2 = await appsProvisioner.apply(ctx, { actions: [] }, config)
      expect(r2.unchanged ?? []).toContain(`apps.${APP}.settings.history`)
      expect(await planAppSettings(ctx, APP, { history: true })).toEqual([])
    } finally {
      appSettingsRegistry.delete([orgId, APP])
    }
  })

  test("an undeclared path, a config-kept field or a wrong type is a usage error, nothing written", async () => {
    const { ctx, orgId } = await orgWithSettingsApp()
    try {
      for (const bad of [{ other: true }, { url: "https://x.example" }, { history: "yes" }]) {
        const config: ProvisioningConfig = {
          org: { slug: "x", name: "X" },
          apps: [{ name: APP, enable: true, settings: bad }],
        }
        await expect(appsProvisioner.plan(ctx, config)).rejects.toBeInstanceOf(ConfigError)
        await expect(appsProvisioner.apply(ctx, { actions: [] }, config)).rejects.toBeInstanceOf(
          ConfigError,
        )
      }
      expect(await storedNamespace(orgId)).toEqual({})
    } finally {
      appSettingsRegistry.delete([orgId, APP])
    }
  })
})
