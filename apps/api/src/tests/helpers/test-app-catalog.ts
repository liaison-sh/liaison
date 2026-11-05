// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What makes an install first-party is the image's app catalog: the installed
// artifact is byte-identical to the tarball the catalog bakes for that
// (name, version) (`isCatalogArtifact`, `install-trust.ts`). Outside apps, anything
// else, may not take a first-party app's name, labels or publisher.
//
// A test process has no baked catalog, so a bundled app's built `.liaisonapp`
// would install as an outside app, which it is not. Tests that install a bundled
// app as the first-party app it is first bake its tarball into a test catalog,
// the same entry `scripts/build-app-catalog.ts` writes, and install the catalog's
// copy: the production trust path, with no test-only exemption in the checks.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CatalogEntry,
  getCatalogDir,
  isCatalogArtifact,
  listCatalog,
  resetCatalogCache,
} from "~/modules/apps/catalog"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"

interface PackagedManifest {
  name: string
  version: string
  displayName?: string
  description?: string
  kind?: CatalogEntry["kind"]
  license?: string
  author?: string
  listing?: CatalogEntry["listing"]
  scopes?: string[]
  connections?: Record<string, unknown>
}

function readPackagedManifest(tarballPath: string): PackagedManifest {
  const dir = mkdtempSync(join(tmpdir(), "test-catalog-peek-"))
  try {
    const r = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "app.manifest.json"], {
      stdio: "pipe",
    })
    if (r.status !== 0) {
      throw new Error(`reading the manifest of ${tarballPath} failed: ${r.stderr?.toString()}`)
    }
    return JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8")) as PackagedManifest
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A catalog dir this process owns, created on first use and removed at exit. */
function ownCatalogDir(): string {
  const existing = process.env.LIAISON_APP_CATALOG_DIR
  if (existing) return existing
  const dir = mkdtempSync(join(tmpdir(), "liaison-test-catalog-"))
  // Keep whatever catalog the process already resolved (a dev-built app-catalog/).
  const carried = listCatalog()
  const from = getCatalogDir()
  for (const entry of carried) copyFileSync(join(from, entry.file), join(dir, entry.file))
  writeFileSync(join(dir, "catalog.json"), `${JSON.stringify(carried, null, 2)}\n`)
  process.env.LIAISON_APP_CATALOG_DIR = dir
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Bake `tarballPath` into this process's app catalog, replacing any entry of the
 * same name, and return the catalog's copy, the path to install from. A tarball
 * already in the catalog is returned as it is.
 */
export function bakeIntoTestCatalog(tarballPath: string): string {
  const manifest = readPackagedManifest(tarballPath)
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex")
  if (isCatalogArtifact(manifest.name, manifest.version, sha256)) {
    const entry = listCatalog().find(
      (e) => e.name === manifest.name && e.version === manifest.version,
    )
    if (entry) return join(getCatalogDir(), entry.file)
  }
  const dir = ownCatalogDir()
  const file = `${manifest.name}-${manifest.version}.liaisonapp`
  const target = join(dir, file)
  if (tarballPath !== target) copyFileSync(tarballPath, target)
  const entry: CatalogEntry = {
    name: manifest.name,
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    version: manifest.version,
    ...(manifest.kind ? { kind: manifest.kind } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.listing ? { listing: manifest.listing } : {}),
    file,
    scopes: manifest.scopes ?? [],
    connections: Object.keys(manifest.connections ?? {}),
  }
  const entries = listCatalog().filter((e) => e.name !== manifest.name)
  writeFileSync(join(dir, "catalog.json"), `${JSON.stringify([...entries, entry], null, 2)}\n`)
  resetCatalogCache()
  resetInstallTrustCache(manifest.name)
  return target
}

/**
 * The first-party package of bundled app `name`: its current build (built when
 * missing), baked into this process's catalog. Install from the returned path.
 */
export function firstPartyAppTarball(name: string): string {
  return bakeIntoTestCatalog(ensureBundledAppBuilt(name))
}
