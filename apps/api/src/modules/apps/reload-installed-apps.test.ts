// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness P1 — verify that `reloadInstalledApps(orgId)` picks up
// an app installed at runtime (via `installAppFromTarball`) and makes its
// tools queryable in the same worker process, without requiring a kernel
// restart.
//
// This is the load-bearing primitive for the Phase 16 Shopify Playwright
// fixture (`installShopifyApp`): the worker installs `shopify-0.1.0.liaisonapp`
// at the start of a test, then calls `reloadInstalledApps` to bring the new
// app into the runtime registries, then drives the scenario.
//
// The install-service unit tests already cover the disk + DB row writes;
// this test specifically pins the "reload makes the app registered" half
// of the round-trip.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { manifestRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"

const TEST_ORG = "00000000-0000-0000-0000-00000016b001"
const TEST_USER = "00000000-0000-0000-0000-00000016b002"
const APP_NAME = "reload-test"
const ADMIN = "00000000-0000-0000-0000-000000000001"

let installRoot: string

function makeBundleTarball(name: string, version: string): string {
  const work = mkdtempSync(join(tmpdir(), "reload-pkg-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  const manifest = {
    name,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: [`${name}:items:read`],
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop\n")
  const tar = join(work, `${name}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}

beforeEach(async () => {
  installRoot = mkdtempSync(join(tmpdir(), "reload-install-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'Reload Test Org', 'reload-test-org')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${TEST_USER}, ${TEST_ORG}, 'reload@test.com', 'hash', 'Reload', 'active')
    ON CONFLICT (id) DO NOTHING`
})

afterEach(async () => {
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await withSystemDb("reload-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP_NAME))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME))
  })
  resetAppRegistries()
  await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("reloadInstalledApps: E2E harness primitive", () => {
  it("registers an app installed after the initial boot, in the same process", async () => {
    // First, boot the org runtime with the in-tree app set. The newly-created
    // `reload-test` app does not exist yet, so it must not appear in the
    // registry at this point.
    await ensureAppsForOrg(TEST_ORG)
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])).toBeUndefined()

    // Install the app at runtime (mirrors what the Playwright harness does
    // before the first scenario action).
    await installAppFromTarball({
      tarballPath: makeBundleTarball(APP_NAME, "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: [`${APP_NAME}:items:read`],
      requireSignature: false,
    })

    // The install activated it in every org already initialized in this
    // process (activation.ts), without a reload or a restart.
    expect(manifestRegistry.get([TEST_ORG, APP_NAME])?.name).toBe(APP_NAME)

    // Reload stays idempotent: it is what registers an org not yet initialized.
    await reloadInstalledApps(TEST_ORG)

    // Now the manifest registry contains the newly-installed app, scoped to
    // this org. (Tool / handler registration is exercised separately by the
    // in-tree `ensureAppsForOrg` test — here we pin the install→reload→present
    // hand-off, which is the only piece that was previously gated on a process
    // restart.) Version lives in the apps_installed row, not in the in-memory
    // manifest registry.
    const reg = manifestRegistry.get([TEST_ORG, APP_NAME])
    expect(reg).toBeDefined()
    expect(reg?.name).toBe(APP_NAME)

    const installedRows = await withSystemDb("reload-test-assert", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP_NAME)),
    )
    expect(installedRows).toHaveLength(1)
    expect(installedRows[0].version).toBe("1.0.0")
  })
})
