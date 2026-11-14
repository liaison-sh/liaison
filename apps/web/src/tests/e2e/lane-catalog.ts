// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The app catalog the Playwright lanes boot with.
 *
 * A production image bakes a first-party catalog (`scripts/build-app-catalog.ts`,
 * `app-catalog/catalog.json` plus one `.liaisonapp` per app) and an admin installs
 * an app from it with one click (`POST /api/apps/catalog/:name/install`, the App
 * store's button). A Playwright lane has no baked catalog, so the apps that ship
 * only as catalog apps (the GitLab, Google Drive and API connectors) were absent
 * from every lane and the scenarios that drive them failed.
 *
 * global-setup stages a catalog of those apps from their current builds and points
 * every lane at it (`LIAISON_APP_CATALOG_DIR`); the lane's seed then installs them
 * through the App store route, as an admin, before the world is snapshotted. Other
 * bundled apps stay out of the catalog: their scenarios install them per test.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "./bundled-app-tarball"

/** The catalog apps every lane installs (they ship only through the catalog). */
export const LANE_CATALOG_APPS = ["api-connector", "gitlab", "google-drive"] as const

/** The env variable the API reads its catalog directory from (modules/apps/catalog.ts). */
export const APP_CATALOG_DIR_ENV = "LIAISON_APP_CATALOG_DIR"

interface PackagedManifest {
  name: string
  version: string
  displayName?: string
  description?: string
  kind?: string
  license?: string
  author?: string
  listing?: unknown
  scopes?: string[]
  connections?: Record<string, unknown>
}

/** The manifest inside a built package, the one the install reads. */
function packagedManifest(tarball: string): PackagedManifest {
  const r = spawnSync("tar", ["-xzOf", tarball, "app.manifest.json"], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`reading the manifest of ${tarball} failed: ${r.stderr}`)
  return JSON.parse(r.stdout) as PackagedManifest
}

/**
 * Write a catalog of `apps` (each already built under `bundled-apps/<name>/dist`) in a
 * new temp directory, with the entries `build-app-catalog.ts` writes. Returns the
 * directory; the caller removes it.
 */
export function stageLaneCatalog(
  liaisonRoot: string,
  apps: readonly string[] = LANE_CATALOG_APPS,
): string {
  const dir = mkdtempSync(join(tmpdir(), "liaison-pw-catalog-"))
  try {
    const entries = apps.map((name) => {
      const tarball = bundledAppTarball(liaisonRoot, name)
      const manifest = packagedManifest(tarball)
      const file = basename(tarball)
      copyFileSync(tarball, join(dir, file))
      return {
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
    })
    writeFileSync(join(dir, "catalog.json"), `${JSON.stringify(entries, null, 2)}\n`)
    return dir
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** The lane catalog's env for an API server, when global-setup staged one. */
export function laneCatalogEnv(): Record<string, string> {
  const dir = process.env[APP_CATALOG_DIR_ENV]
  return dir ? { [APP_CATALOG_DIR_ENV]: resolve(dir) } : {}
}

/**
 * Install the lane's catalog apps as `token`'s admin through the App store's
 * one-click route. A lane without a staged catalog installs nothing.
 */
export async function installLaneCatalogApps(serverUrl: string, token: string): Promise<void> {
  if (!process.env[APP_CATALOG_DIR_ENV]) return
  for (const name of LANE_CATALOG_APPS) {
    const res = await api(serverUrl, `/api/apps/catalog/${name}/install`, {
      method: "POST",
      token,
    })
    if (res.status !== 200) {
      throw new Error(
        `installing catalog app ${name} failed: ${res.status} ${JSON.stringify(res.body)}`,
      )
    }
  }
}
