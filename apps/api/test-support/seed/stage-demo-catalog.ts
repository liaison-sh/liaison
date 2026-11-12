// SPDX-License-Identifier: FSL-1.1-ALv2
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_APPS } from "~/seed/tiers/demo/demo-apps"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"

/** The demo's catalog apps: the ones `bundled-apps/` ships as `.liaisonapp` bundles. */
export const DEMO_CATALOG_APPS = DEMO_APPS.filter((name) =>
  ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"].includes(name),
)

/**
 * A first-party catalog from the CURRENT bundled-app sources, in a new temp
 * folder, so a seeded world installs its catalog apps as the image would.
 * Without one (`app-catalog/` is not checked in) the seed finds no catalog,
 * installs only the in-tree apps and every layer that needs a catalog app
 * (commerce's invoicing, the sales routine's quote) fails to seed.
 * Point `LIAISON_APP_CATALOG_DIR` at the returned folder; delete it after.
 */
/**
 * Catalog apps a demo layer installs itself (the warehouse layer's `database`
 * app), staged beside the demo's.
 */
export const DEMO_LAYER_CATALOG_APPS = ["database"] as const

export function stageDemoCatalog(
  prefix: string,
  apps: readonly string[] = [...DEMO_CATALOG_APPS, ...DEMO_LAYER_CATALOG_APPS],
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-catalog-`))
  const repo = path.join(import.meta.dir, "..", "..", "..", "..")
  const entries = apps.map((name) => {
    const manifest = JSON.parse(
      readFileSync(path.join(repo, "bundled-apps", name, "app.manifest.json"), "utf8"),
    ) as {
      displayName?: string
      version: string
      scopes?: string[]
      connections?: Record<string, unknown>
    }
    const tarball = ensureBundledAppBuilt(name)
    const file = path.basename(tarball)
    copyFileSync(tarball, path.join(dir, file))
    return {
      name,
      displayName: manifest.displayName,
      version: manifest.version,
      file,
      scopes: manifest.scopes ?? [],
      connections: Object.keys(manifest.connections ?? {}),
    }
  })
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(entries, null, 2))
  return dir
}
