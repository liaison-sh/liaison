// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression test for the sandbox-isolation guarantee: an installed
// (`.liaisonapp`) app must ALWAYS register as untrusted, so its handlers run in
// the process-isolated worker pool — never the in-process QuickJS tier. The
// coercion lives in `installedAppDescriptor` (init.ts) because discovery
// re-reads the on-disk manifest at every boot.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion } from "~/db/schema/kernel/apps-installed"
import { bumpCatalogGeneration } from "./catalog-generation"
import { getDefaultApps } from "./init"

describe("installed apps are forced untrusted", () => {
  let root = ""
  const appsDirBefore = process.env.LIAISON_APPS_DIR

  afterEach(async () => {
    await withSystemDb("t", (db) =>
      db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "evil-app")),
    )
    if (root) rmSync(root, { recursive: true, force: true })
    root = ""
    // Assigning undefined would leave the string "undefined" as the install root.
    if (appsDirBefore === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = appsDirBefore
    // The catalog cached while evil-app was active must not outlive this test.
    bumpCatalogGeneration()
  })

  it("coerces an installed app's descriptor to trusted:false even if its manifest claims trusted:true", async () => {
    root = mkdtempSync(join(tmpdir(), "trust-root-"))
    process.env.LIAISON_APPS_DIR = root
    const verDir = join(root, "evil-app", "1.0.0")
    mkdirSync(verDir, { recursive: true })
    writeFileSync(
      join(verDir, "app.manifest.json"),
      JSON.stringify({
        name: "evil-app",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [],
        // A malicious package claiming in-process trust — must be ignored.
        trusted: true,
      }),
    )
    writeFileSync(join(verDir, "bundle.js"), "// noop")
    // Discovery registers the active version only, as recorded at install.
    await withSystemDb("t", (db) =>
      db.insert(appsActiveVersion).values({ name: "evil-app", version: "1.0.0" }),
    )
    // An install bumps the catalog generation; this test writes the row itself,
    // so it bumps it too, or a catalog cached by an earlier caller is served.
    bumpCatalogGeneration()

    const apps = await getDefaultApps()
    const evil = apps.find((a) => (a as { name?: string }).name === "evil-app")
    expect(evil).toBeDefined()
    // runtime.ts gates the in-process tier on `desc.trusted !== false`; the
    // descriptor MUST carry an explicit `false`, not `undefined`.
    expect((evil as { trusted?: unknown }).trusted).toBe(false)
  })
})
