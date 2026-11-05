// SPDX-License-Identifier: FSL-1.1-ALv2
//
// First-party app catalog: list + one-click install. Mirrors the
// `reload-installed-apps.test.ts` harness — a minimal self-made `.liaisonapp`
// (no shell freeze) installed from a temp catalog dir — and pins:
//   - `listCatalog` / `getCatalogDir` read the env-pointed catalog index;
//   - `listCatalogWithState` flips `installed` false -> true after an install;
//   - `installCatalogApp` writes the apps_installed/active rows AND hot-registers
//     the app for the org (no restart), and 404s on an unknown name.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { filesSelectPolicyRebuildStats, rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger } from "~/lib/logger"
import { summarizeEnableApp } from "~/modules/agent/tools/kernel-summarizers"
import { handleEnableApp } from "~/modules/agent/tools/org-config-tools"
import {
  ActivationSyncTestAccess,
  initAppActivationSync,
  syncActiveVersionsFromDb,
} from "~/modules/apps/activation"
import {
  manifestRegistry,
  registeredAppVersions,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import {
  catalogInstallAction,
  getCatalogDir,
  installCatalogApp,
  listCatalog,
  listCatalogWithState,
  reconcileCatalogApps,
  resetCatalogCache,
} from "~/modules/apps/catalog"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { enableApp, getEnabledApps } from "~/modules/apps/enabled-apps"
import {
  activeInstalledApps,
  ensureAppsForOrg,
  readInstalledAppDescriptor,
  reloadInstalledApps,
} from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { switchAppRegistration } from "~/modules/apps/runtime"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const TEST_ORG = "00000000-0000-0000-0000-0000000ca701"
const TEST_USER = "00000000-0000-0000-0000-0000000ca702"
const APP_NAME = "catalog-test-app"
const VERSION = "0.1.0"
const NEXT_VERSION = "0.2.0"
const SCOPE = `${APP_NAME}:items:read`

let catalogDir: string
let installRoot: string

/** A minimal valid `.liaisonapp` tarball staged into the catalog dir. */
function writeCatalogTarball(version: string = VERSION, name: string = APP_NAME): string {
  const file = `${name}-${version}.liaisonapp`
  const stage = mkdtempSync(join(tmpdir(), "catalog-stage-"))
  const manifest = {
    name,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: [name === APP_NAME ? SCOPE : `${name}:items:read`],
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop\n")
  spawnSync("tar", ["-czf", join(catalogDir, file), "-C", stage, "app.manifest.json", "bundle.js"])
  rmSync(stage, { recursive: true, force: true })
  return file
}

/** Re-bake the catalog index (and its tarball) at a NEWER version -- the
 *  deploy-bumped-a-bundled-app case that a boot reconcile has to pick up. */
function bakeNewerCatalogVersion(version: string): void {
  const file = writeCatalogTarball(version)
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([
      {
        name: APP_NAME,
        description: "A catalog test app",
        version,
        file,
        scopes: [SCOPE],
        connections: [],
      },
    ]),
  )
  resetCatalogCache()
}

beforeEach(async () => {
  catalogDir = mkdtempSync(join(tmpdir(), "catalog-dir-"))
  installRoot = mkdtempSync(join(tmpdir(), "catalog-install-root-"))
  process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  process.env.LIAISON_APPS_DIR = installRoot
  resetCatalogCache()

  const file = writeCatalogTarball()
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([
      {
        name: APP_NAME,
        description: "A catalog test app",
        version: VERSION,
        file,
        scopes: [SCOPE],
        connections: [],
      },
    ]),
  )

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'Catalog Test Org', 'catalog-test-org')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${TEST_USER}, ${TEST_ORG}, 'catalog@test.com', 'hash', 'Catalog', 'active')
    ON CONFLICT (id) DO NOTHING`
})

afterEach(async () => {
  // A test's own announcements are handled before its state goes away, not
  // under the next test (this process follows them once any file imported the app).
  await ActivationSyncTestAccess.settle()
  rmSync(catalogDir, { recursive: true, force: true })
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  delete process.env.LIAISON_APPS_DIR
  resetCatalogCache()
  await withSystemDb("catalog-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP_NAME))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME))
  })
  resetAppRegistries()
  await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("app catalog", () => {
  it("reads the env-pointed catalog dir and lists its entries", () => {
    expect(getCatalogDir()).toBe(catalogDir)
    const entries = listCatalog()
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(APP_NAME)
    expect(entries[0].scopes).toEqual([SCOPE])
  })

  it("installCatalogApp installs the tarball, hot-registers it, and flips installed-state", async () => {
    // Boot the org runtime first; the catalog app is not installed yet.
    await ensureAppsForOrg(TEST_ORG)
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeUndefined()

    const before = await listCatalogWithState()
    expect(before.find((e) => e.name === APP_NAME)?.installed).toBe(false)

    const result = await installCatalogApp({
      orgId: TEST_ORG,
      name: APP_NAME,
      installedBy: TEST_USER,
    })
    expect(result.name).toBe(APP_NAME)
    expect(result.version).toBe(VERSION)

    // Active-version row written.
    const active = await withSystemDb("catalog-test-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME)),
    )
    expect(active).toHaveLength(1)
    expect(active[0].version).toBe(VERSION)

    // Hot-registered for the org WITHOUT a restart (the one-click promise).
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeDefined()

    // Catalog state now reports installed, and carries the active on-instance
    // version (so a caller can detect when the baked catalog version is newer).
    const after = await listCatalogWithState()
    const entry = after.find((e) => e.name === APP_NAME)
    expect(entry?.installed).toBe(true)
    expect(entry?.installedVersion).toBe(VERSION)
  })

  it("reports installedVersion + detects an available upgrade when the catalog version is newer", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })

    const installedState = await listCatalogWithState()
    const e1 = installedState.find((e) => e.name === APP_NAME)
    expect(e1?.installed).toBe(true)
    expect(e1?.installedVersion).toBe(VERSION)

    // Ship a NEWER baked catalog index (0.2.0) -- the deploy-updated-a-bundled-app
    // case. Only the index version matters to listCatalogWithState; the tarball ref
    // can stay (no re-install happens in this test).
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        {
          name: APP_NAME,
          description: "A catalog test app",
          version: "0.2.0",
          file: `${APP_NAME}-${VERSION}.liaisonapp`,
          scopes: [SCOPE],
          connections: [],
        },
      ]),
    )
    resetCatalogCache()

    // Catalog advertises 0.2.0 while 0.1.0 is installed: installed:true but
    // installedVersion !== version -- the exact skew the apps provisioner keys
    // `needsUpgrade` on to re-install (upgrade) a bundled app on deploy.
    const skew = await listCatalogWithState()
    const e2 = skew.find((e) => e.name === APP_NAME)
    expect(e2?.version).toBe("0.2.0")
    expect(e2?.installed).toBe(true)
    expect(e2?.installedVersion).toBe(VERSION)
    expect(e2?.installedVersion).not.toBe(e2?.version)
  })

  it("kernel:enable_app installs a catalog app the instance lacks, then enables it (the App store's install)", async () => {
    await ensureAppsForOrg(TEST_ORG)
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeUndefined()
    const r = await handleEnableApp(
      { appName: APP_NAME },
      { orgId: TEST_ORG, userId: TEST_USER, approverUserId: TEST_USER },
    )
    expect(r).toMatchObject({ enabled: APP_NAME, installed: true })
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeDefined()
    expect(await getEnabledApps(TEST_ORG)).toContain(APP_NAME)
    const [row] = await withSystemDb("catalog-test-installed-by", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP_NAME)),
    )
    expect(row?.installedBy).toBe(TEST_USER)
  })

  for (const [label, multiTenant] of [
    ["the managed edition", () => _setEdition("managed")],
    ["demo mode", () => DemoModeTestAccess.set(true)],
  ] as const) {
    it(`kernel:enable_app on ${label}: an org that is not the instance operator's is refused (403), nothing installed`, async () => {
      const savedOperator = env.LIAISON_OPERATOR_ORG_ID
      ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = NIL_UUID
      resetOperatorOrgCache()
      multiTenant()
      try {
        await ensureAppsForOrg(TEST_ORG)
        const r = await handleEnableApp(
          { appName: APP_NAME },
          { orgId: TEST_ORG, userId: TEST_USER, approverUserId: TEST_USER },
        )
        expect(r).toMatchObject({ error: { code: "app_install_refused", status: 403 } })
        const rows = await withSystemDb("catalog-test-no-install", (db) =>
          db.select().from(appsInstalled).where(eq(appsInstalled.name, APP_NAME)),
        )
        expect(rows).toHaveLength(0)
        expect(await getEnabledApps(TEST_ORG)).not.toContain(APP_NAME)
      } finally {
        _setEdition(null)
        DemoModeTestAccess.set(null)
        ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = savedOperator
        resetOperatorOrgCache()
      }
    })
  }

  it("the enable_app card says when the app is installed on the instance first, and when it is only turned on (en, fr)", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const card = (appName: string) =>
      summarizeEnableApp({ appName }, { orgId: TEST_ORG, userId: TEST_USER } as never)
    const install = await card(APP_NAME)
    expect(install.title).toBe(`Install the ${APP_NAME} app and turn it on`)
    expect(install.lines.join(" ")).toContain("installed from the app catalog first")
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    const enable = await card(APP_NAME)
    expect(enable.title).toBe(`Turn on the ${APP_NAME} app for the workspace`)
    expect(enable.lines.join(" ")).toContain("only turned on for this workspace")
    await sql`UPDATE kernel.organizations SET default_locale = 'fr' WHERE id = ${TEST_ORG}`
    const fr = await card(APP_NAME)
    expect(fr.title).toBe(`Activer l'application ${APP_NAME} pour l'espace de travail`)
  })

  it("404s on an unknown catalog app", async () => {
    await expect(
      installCatalogApp({ orgId: TEST_ORG, name: "no-such-app", installedBy: TEST_USER }),
    ).rejects.toThrow(/No catalog app named 'no-such-app'/)
  })
})

describe("reconcileCatalogApps (rebuild-repair)", () => {
  it("is a no-op with empty repaired/ok when no catalog app is enabled by any org", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).not.toContain(APP_NAME)
  })

  it("repairs a catalog app whose on-disk bundle is missing (simulated image rebuild) while apps_installed/apps_active_version rows still exist", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)

    // Simulate a fresh container image: the DB rows persist (durable), but the
    // unpacked bundle under the install root is gone (ephemeral container fs).
    rmSync(join(getInstallRoot(), APP_NAME), { recursive: true, force: true })

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toContain(APP_NAME)

    // Repaired: the bundle is back on disk and the active version still matches.
    const active = await withSystemDb("catalog-test-reconcile-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME)),
    )
    expect(active[0]?.version).toBe(VERSION)

    // Idempotent: a second run reports it already consistent (ok), not repaired again.
    const second = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(second.ok).toContain(APP_NAME)
    expect(second.repaired).not.toContain(APP_NAME)
  })

  it("leaves an already-consistent catalog app alone (reports ok, not repaired)", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.ok).toContain(APP_NAME)
    expect(result.repaired).not.toContain(APP_NAME)
  })

  it("falls back to fallbackInstalledBy attribution when an enabled app has no prior apps_installed row at all", async () => {
    // Enabled but never installed: a dangling enabledApps flag with nothing to
    // inherit installedBy from (e.g. a restored DB missing the install row).
    await ensureAppsForOrg(TEST_ORG)
    await enableApp(TEST_ORG, APP_NAME)

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toContain(APP_NAME)

    const installedRows = await withSystemDb("catalog-test-reconcile-installedby", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP_NAME)),
    )
    expect(installedRows[0]?.installedBy).toBe(NIL_UUID)
  })
  it("upgrades an enabled catalog app when the baked catalog version is newer, and it stays enabled and registered", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)

    bakeNewerCatalogVersion(NEXT_VERSION)

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toContain(APP_NAME)

    const active = await withSystemDb("catalog-test-reconcile-bump-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME)),
    )
    expect(active[0]?.version).toBe(NEXT_VERSION)
    expect(await getEnabledApps(TEST_ORG)).toContain(APP_NAME)
    // Still registered for the org, at the NEW version (a bump must not drop it).
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeDefined()
    const registered = await sql`
      SELECT version FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP_NAME}`
    expect(registered[0]?.version).toBe(NEXT_VERSION)
  })

  it("repairs an INSTALLED catalog app that no org has in enabledApps (surface curation is not an install record)", async () => {
    // `enabledApps` is surface curation only; an app can be installed, running
    // and serving an org without ever being listed there. Keying the boot
    // reconcile on it alone leaves such an app unrepaired after a container
    // rebuild, and the app silently vanishes from the product.
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(await getEnabledApps(TEST_ORG)).not.toContain(APP_NAME)

    // Fresh container image: DB rows persist, the unpacked bundle does not.
    rmSync(join(getInstallRoot(), APP_NAME), { recursive: true, force: true })

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toContain(APP_NAME)
    expect(existsSync(join(getInstallRoot(), APP_NAME, VERSION, "app.manifest.json"))).toBe(true)
  })

  it("upgrades an INSTALLED but not-enabled catalog app on a version bump", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(await getEnabledApps(TEST_ORG)).not.toContain(APP_NAME)

    bakeNewerCatalogVersion(NEXT_VERSION)

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toContain(APP_NAME)

    const active = await withSystemDb("catalog-test-reconcile-unenabled-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME)),
    )
    expect(active[0]?.version).toBe(NEXT_VERSION)
  })
})

describe("reconcileCatalogApps: the kernel.files policy is rebuilt once per run", () => {
  const SECOND = "catalog-second-app"

  afterEach(async () => {
    await withSystemDb("catalog-test-second-cleanup", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, SECOND))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, SECOND))
    })
  })

  function bakeCatalog(version: string): void {
    const entries = [APP_NAME, SECOND].map((name) => ({
      name,
      description: name,
      version,
      file: writeCatalogTarball(version, name),
      scopes: [name === APP_NAME ? SCOPE : `${name}:items:read`],
      connections: [],
    }))
    writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(entries))
    resetCatalogCache()
  }

  it("upgrading N bundled apps evaluates the policy once, and runs no DDL when it is unchanged", async () => {
    bakeCatalog(VERSION)
    await ensureAppsForOrg(TEST_ORG)
    for (const name of [APP_NAME, SECOND]) {
      await installCatalogApp({ orgId: TEST_ORG, name, installedBy: TEST_USER })
      await enableApp(TEST_ORG, name)
    }
    await rebuildFilesSelectPolicy()

    // The deploy bumped both bundled apps.
    bakeCatalog(NEXT_VERSION)
    const evaluated = filesSelectPolicyRebuildStats.evaluated
    const applied = filesSelectPolicyRebuildStats.applied

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.repaired).toEqual(expect.arrayContaining([APP_NAME, SECOND]))
    expect(filesSelectPolicyRebuildStats.evaluated).toBe(evaluated + 1)
    // Neither app declares a file parent: the policy is the same, no DDL.
    expect(filesSelectPolicyRebuildStats.applied).toBe(applied)
  })
})

describe("reconcileCatalogApps: one failing app does not stop the others", () => {
  const BROKEN = "catalog-broken-app"

  afterEach(async () => {
    await withSystemDb("catalog-test-broken-cleanup", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, BROKEN))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, BROKEN))
    })
  })

  it("logs the throwing app as failed and still upgrades the app after it", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)

    // A catalog that lists a broken app FIRST: its artifact is not a tarball,
    // so its install throws. The healthy app after it has a newer version.
    const brokenFile = `${BROKEN}-0.1.0.liaisonapp`
    writeFileSync(join(catalogDir, brokenFile), "not a tarball")
    const nextFile = writeCatalogTarball(NEXT_VERSION)
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        { name: BROKEN, description: "broken", version: "0.1.0", file: brokenFile, scopes: [] },
        {
          name: APP_NAME,
          description: "A catalog test app",
          version: NEXT_VERSION,
          file: nextFile,
          scopes: [SCOPE],
          connections: [],
        },
      ]),
    )
    resetCatalogCache()
    await enableApp(TEST_ORG, BROKEN)

    const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(result.failed.map((f) => f.name)).toEqual([BROKEN])
    expect(result.repaired).toContain(APP_NAME)
    const active = await withSystemDb("catalog-test-broken-next-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME)),
    )
    expect(active[0]?.version).toBe(NEXT_VERSION)
  })
})

/** Make an installed version's on-disk manifest one this platform's contract now
 *  refuses: the shape a manifest has once a contract change (a new required
 *  declaration, a retired field) lands after that version was installed. */
function stalenessUnderTheContract(name: string, version: string): void {
  const path = join(getInstallRoot(), name, version, "app.manifest.json")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...manifest, retiredContractField: true }))
}

/** The "Invalid app descriptor" error lines logged while `fn` runs. */
async function invalidDescriptorErrors(fn: () => Promise<unknown>): Promise<unknown[]> {
  const lines: unknown[] = []
  const spy = spyOn(appsLogger, "error").mockImplementation(((obj: unknown, msg?: string) => {
    if (msg === "Invalid app descriptor") lines.push(obj)
  }) as never)
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return lines
}

describe("reconcileCatalogApps: a deploy validates only the versions that will run", () => {
  const SECOND = "catalog-second-app"

  afterEach(async () => {
    await withSystemDb("catalog-test-stale-cleanup", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, SECOND))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, SECOND))
    })
  })

  function bakeCatalog(version: string): void {
    const entries = [APP_NAME, SECOND].map((name) => ({
      name,
      description: name,
      version,
      file: writeCatalogTarball(version, name),
      scopes: [name === APP_NAME ? SCOPE : `${name}:items:read`],
      connections: [],
    }))
    writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(entries))
    resetCatalogCache()
  }

  it("upgrading apps whose stored versions predate a contract change logs no invalid descriptor", async () => {
    bakeCatalog(VERSION)
    await ensureAppsForOrg(TEST_ORG)
    for (const name of [APP_NAME, SECOND]) {
      await installCatalogApp({ orgId: TEST_ORG, name, installedBy: TEST_USER })
      await enableApp(TEST_ORG, name)
    }
    // The deploy ships a contract the stored versions no longer meet, and new
    // catalog versions that do. Upgrading the first app used to re-register
    // every installed app, so the second app's about-to-be-replaced version was
    // validated (and refused, at ERROR) before its own upgrade ran.
    stalenessUnderTheContract(APP_NAME, VERSION)
    stalenessUnderTheContract(SECOND, VERSION)
    bakeCatalog(NEXT_VERSION)

    let result: Awaited<ReturnType<typeof reconcileCatalogApps>> | undefined
    const errors = await invalidDescriptorErrors(async () => {
      result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    })
    expect(errors).toEqual([])
    expect(result?.repaired).toEqual(expect.arrayContaining([APP_NAME, SECOND]))
    const registered = await sql<{ name: string; version: string }[]>`
      SELECT name, version FROM kernel.apps
      WHERE org_id = ${TEST_ORG} AND name IN (${APP_NAME}, ${SECOND}) ORDER BY name`
    expect(registered.map((r) => [r.name, r.version])).toEqual([
      [SECOND, NEXT_VERSION],
      [APP_NAME, NEXT_VERSION],
    ])
  })

  it("an installed version that stays (no newer catalog version) is still refused loudly, with the way out", async () => {
    bakeCatalog(VERSION)
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    stalenessUnderTheContract(APP_NAME, VERSION)

    const errors = await invalidDescriptorErrors(() => reloadInstalledApps(TEST_ORG))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      app: APP_NAME,
      version: VERSION,
      error: expect.stringContaining("additional properties"),
      action: expect.stringContaining(`${APP_NAME} ${VERSION}`),
    })
  })
})

/** Point the image's catalog back at `version` (an old image beside a new one). */
function bakeCatalogAt(version: string): void {
  const file = writeCatalogTarball(version)
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([
      {
        name: APP_NAME,
        description: "A catalog test app",
        version,
        file,
        scopes: [SCOPE],
        connections: [],
      },
    ]),
  )
  resetCatalogCache()
}

async function activeVersionOf(name: string): Promise<string | undefined> {
  const rows = await withSystemDb("catalog-test-active-of", (db) =>
    db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
  )
  return rows[0]?.version
}

async function sourceUrlOf(name: string, version: string): Promise<string | undefined> {
  const rows = await withSystemDb("catalog-test-source-of", (db) =>
    db
      .select({ sourceUrl: appsInstalled.sourceUrl })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version))),
  )
  return rows[0]?.sourceUrl
}

// During a rolling deploy old and new processes share one install root and one
// apps_active_version row. A version directory is written once, atomically, and
// never rewritten; an old process never moves the active version back down.
describe("a shared install root across process generations (M5)", () => {
  it("two concurrent unpacks of one version leave one complete directory", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await Promise.all([
      installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER }),
      installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER }),
    ])
    const appDir = join(getInstallRoot(), APP_NAME)
    expect(readdirSync(appDir)).toEqual([VERSION])
    expect(readdirSync(join(appDir, VERSION)).sort()).toEqual(["app.manifest.json", "bundle.js"])
    expect(await activeVersionOf(APP_NAME)).toBe(VERSION)
  })

  it("a version directory holding other files is never rewritten in place", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    const bundle = join(getInstallRoot(), APP_NAME, VERSION, "bundle.js")
    writeFileSync(bundle, "// another build of the same version\n")
    await expect(
      installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER }),
    ).rejects.toThrow("never rewritten in place")
    expect(readFileSync(bundle, "utf8")).toBe("// another build of the same version\n")
  })

  it("a version directory missing some of its files is completed atomically", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    const versionDir = join(getInstallRoot(), APP_NAME, VERSION)
    rmSync(join(versionDir, "bundle.js"))
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(readFileSync(join(versionDir, "bundle.js"), "utf8")).toBe("// noop\n")
    expect(readdirSync(join(getInstallRoot(), APP_NAME))).toEqual([VERSION])
  })

  it("an old-catalog reconcile that meets a newer active version does not write it", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)
    // The new image's migrate step moved the app to NEXT_VERSION...
    bakeNewerCatalogVersion(NEXT_VERSION)
    await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)

    // ...then an old process restarts, with the old image's catalog.
    bakeCatalogAt(VERSION)
    const warned: unknown[] = []
    const spy = spyOn(appsLogger, "warn").mockImplementation(((obj: unknown, msg?: string) => {
      if (msg === "app_version_ahead") warned.push(obj)
    }) as never)
    let result: Awaited<ReturnType<typeof reconcileCatalogApps>> | undefined
    try {
      result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
    } finally {
      spy.mockRestore()
    }
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
    expect(result?.repaired).not.toContain(APP_NAME)
    expect(result?.ahead).toEqual([{ name: APP_NAME, active: NEXT_VERSION, catalog: VERSION }])
    expect(warned).toEqual([
      expect.objectContaining({ app: APP_NAME, active: NEXT_VERSION, catalog: VERSION }),
    ])
    // Both version directories are still there: the new processes load the new one.
    expect(readdirSync(join(getInstallRoot(), APP_NAME)).sort()).toEqual([VERSION, NEXT_VERSION])
  })

  it("an old process registers the version its own catalog carries, not the newer active one", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    bakeNewerCatalogVersion(NEXT_VERSION)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
    // The newer release's catalog installed it: the rule below is for that case only.
    expect(await sourceUrlOf(APP_NAME, NEXT_VERSION)).toBe(`catalog:${APP_NAME}@${NEXT_VERSION}`)

    bakeCatalogAt(VERSION)
    const apps = await activeInstalledApps()
    expect(apps.filter((a) => a.name === APP_NAME).map((a) => a.version)).toEqual([VERSION])
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
  })

  it("an old process that follows a newer activation keeps the version it has loaded, also after a rollback", async () => {
    // This process follows announcements, as a server does (and as it does in
    // any batch where an earlier file imported the app).
    await initAppActivationSync()
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    // The new release's migrate step activates NEXT_VERSION (and announces it)...
    bakeNewerCatalogVersion(NEXT_VERSION)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
    // ...and that process (this one, so far) has handled its own announcements
    // before it turns into the old one: delivered late, they would follow under it.
    await ActivationSyncTestAccess.settle()
    // ...while this process is an old one: its catalog and its registration are VERSION.
    bakeCatalogAt(VERSION)
    const old = await readInstalledAppDescriptor(APP_NAME, VERSION)
    if (!old) throw new Error("the old version is not on disk")
    expect((await switchAppRegistration(old, TEST_ORG)).ok).toBe(true)
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP_NAME}`)).toBe(VERSION)

    const warned: unknown[] = []
    const spy = spyOn(appsLogger, "warn").mockImplementation(((obj: unknown, msg?: string) => {
      if (msg === "app_version_ahead") warned.push(obj)
    }) as never)
    const followed = spyOn(appsLogger, "info")
    try {
      // The announcement arrives, twice (every later publish re-checks).
      await syncActiveVersionsFromDb()
      await syncActiveVersionsFromDb()
      expect(registeredAppVersions.get(`${TEST_ORG}:${APP_NAME}`)).toBe(VERSION)
      // The descriptor this process resolves for the app is its own release's.
      expect((await readInstalledAppDescriptor(APP_NAME))?.version).toBe(VERSION)

      // A rollback moves the pointer back down: still nothing to switch.
      await withSystemDb("catalog-test-rollback-pointer", (db) =>
        db
          .update(appsActiveVersion)
          .set({ version: VERSION, previousVersion: NEXT_VERSION })
          .where(eq(appsActiveVersion.name, APP_NAME)),
      )
      await syncActiveVersionsFromDb()
      expect(registeredAppVersions.get(`${TEST_ORG}:${APP_NAME}`)).toBe(VERSION)
      expect(
        followed.mock.calls.filter((c) => c[1] === "Following an app version activated elsewhere"),
      ).toHaveLength(0)
    } finally {
      spy.mockRestore()
      followed.mockRestore()
    }
    expect(warned).toHaveLength(1)
    expect(warned[0]).toEqual(
      expect.objectContaining({ app: APP_NAME, active: NEXT_VERSION, catalog: VERSION }),
    )
  })

  it("an uploaded version newer than this image's catalog stays the one every process runs", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    const loaded = await readInstalledAppDescriptor(APP_NAME, VERSION)
    if (!loaded) throw new Error("the catalog version is not on disk")
    expect((await switchAppRegistration(loaded, TEST_ORG)).ok).toBe(true)
    // An image whose catalog does not carry the app, where an operator uploads a
    // newer version of it (not a catalog install).
    writeFileSync(join(catalogDir, "catalog.json"), "[]")
    resetCatalogCache()
    const uploaded = join(catalogDir, writeCatalogTarball(NEXT_VERSION))
    await installAppFromTarball({
      tarballPath: uploaded,
      installedBy: TEST_USER,
      grantedScopes: [SCOPE],
      requireSignature: false,
      sourceUrl: `https://apps.example.com/${APP_NAME}-${NEXT_VERSION}.liaisonapp`,
    })
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)

    // Any process whose catalog carries the app at the older version (this
    // image's, an old process's, or a later image's) runs the uploaded one.
    bakeCatalogAt(VERSION)
    const apps = await activeInstalledApps()
    expect(apps.filter((a) => a.name === APP_NAME).map((a) => a.version)).toEqual([NEXT_VERSION])
    expect((await readInstalledAppDescriptor(APP_NAME))?.version).toBe(NEXT_VERSION)
    await syncActiveVersionsFromDb()
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP_NAME}`)).toBe(NEXT_VERSION)
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
  })

  // A rollback: release B's catalog upgraded the app, then release A (whose
  // catalog carries the older version) runs again and a NEW org is set up,
  // as a demo seed or `config apply` does. The install step must not try to
  // put A's older package over B's active one (refused, so the seed failed);
  // the new org registers the version this process runs.
  async function rollBackBelowACatalogUpgrade(newOrg: string): Promise<string | undefined> {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    await enableApp(TEST_ORG, APP_NAME)
    bakeNewerCatalogVersion(NEXT_VERSION)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
    bakeCatalogAt(VERSION)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${newOrg}, 'Org after the rollback', ${`catalog-rollback-${newOrg.slice(-4)}`})
      ON CONFLICT (id) DO NOTHING`
    const state = (await listCatalogWithState()).find((c) => c.name === APP_NAME)
    if (!state) throw new Error("the catalog lost the app")
    // What the seed and the provisioner ask before installing: nothing to install.
    expect(catalogInstallAction(state)).toBe("ahead")
    await enableApp(newOrg, APP_NAME)
    await ensureAppsForOrg(newOrg)
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
    return registeredAppVersions.get(`${newOrg}:${APP_NAME}`)
  }

  it("after a rollback below a catalog upgrade, a new org registers the app at this release's version", async () => {
    const newOrg = "00000000-0000-0000-0000-0000000ca7a1"
    try {
      expect(await rollBackBelowACatalogUpgrade(newOrg)).toBe(VERSION)
    } finally {
      await sql`DELETE FROM kernel.organizations WHERE id = ${newOrg}`
    }
  })

  it("after a rollback, with only the newer version's files in the install root, a new org registers that one", async () => {
    const newOrg = "00000000-0000-0000-0000-0000000ca7a2"
    try {
      // The older version's directory is not there (release B's install root
      // never held it): the new org runs the active version's files.
      await ensureAppsForOrg(TEST_ORG)
      bakeNewerCatalogVersion(NEXT_VERSION)
      await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
      await enableApp(TEST_ORG, APP_NAME)
      bakeCatalogAt(VERSION)
      expect(readdirSync(join(getInstallRoot(), APP_NAME))).toEqual([NEXT_VERSION])
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${newOrg}, 'Org after the rollback', 'catalog-rollback-only-new')
        ON CONFLICT (id) DO NOTHING`
      const state = (await listCatalogWithState()).find((c) => c.name === APP_NAME)
      if (!state) throw new Error("the catalog lost the app")
      expect(catalogInstallAction(state)).toBe("ahead")
      await enableApp(newOrg, APP_NAME)
      await ensureAppsForOrg(newOrg)
      expect(registeredAppVersions.get(`${newOrg}:${APP_NAME}`)).toBe(NEXT_VERSION)
    } finally {
      await sql`DELETE FROM kernel.organizations WHERE id = ${newOrg}`
    }
  })

  it("the install decision: install when absent, upgrade only to a newer catalog version", () => {
    expect(catalogInstallAction({ installed: false, version: VERSION })).toBe("install")
    expect(
      catalogInstallAction({ installed: true, installedVersion: VERSION, version: VERSION }),
    ).toBe("current")
    expect(
      catalogInstallAction({ installed: true, installedVersion: VERSION, version: NEXT_VERSION }),
    ).toBe("upgrade")
    expect(
      catalogInstallAction({ installed: true, installedVersion: NEXT_VERSION, version: VERSION }),
    ).toBe("ahead")
  })

  it("installing an old catalog version over a newer active one is refused", async () => {
    await ensureAppsForOrg(TEST_ORG)
    bakeNewerCatalogVersion(NEXT_VERSION)
    await installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER })
    bakeCatalogAt(VERSION)
    await expect(
      installCatalogApp({ orgId: TEST_ORG, name: APP_NAME, installedBy: TEST_USER }),
    ).rejects.toThrow(`active ${NEXT_VERSION} is newer`)
    expect(await activeVersionOf(APP_NAME)).toBe(NEXT_VERSION)
  })
})
