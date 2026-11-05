// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where a seed outside the runtime image finds the app catalog and unpacks the
 * apps it installs. The image bakes the catalog at `/app/app-catalog` and
 * mounts a writable `/var/lib/liaison/apps`; a source checkout has neither, so
 * a seed there defaults to the checkout's own `app-catalog/` (built by
 * `scripts/build-app-catalog.ts`) and `.liaison-apps/apps` (the folder
 * `bun run dev` uses). When the seed writes the commerce layer, a catalog
 * that is missing stops it with the variable to set: without one the commerce
 * apps are never installed and the seed fails half way on their missing
 * tables.
 */
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

export const IMAGE_CATALOG_DIR = "/app/app-catalog"

export interface SeedAppDirsInput {
  env: Record<string, string | undefined>
  /** The repository root of this checkout. */
  repoRoot: string
  /** The seed installs catalog apps whose tables it writes (the commerce layer). */
  needsCatalog: boolean
  /** Whether the image catalog exists (a running image). Default: checks the path. */
  inImage?: boolean
}

export type SeedAppDirs = { ok: true; set: Record<string, string> } | { ok: false; message: string }

export function resolveSeedAppDirs(input: SeedAppDirsInput): SeedAppDirs {
  const { env, repoRoot } = input
  const set: Record<string, string> = {}

  const catalogEnv = env.LIAISON_APP_CATALOG_DIR
  if (catalogEnv) {
    if (!existsSync(path.join(catalogEnv, "catalog.json"))) {
      return {
        ok: false,
        message: `LIAISON_APP_CATALOG_DIR is ${catalogEnv}, which has no catalog.json. Point it at an app catalog folder, or unset it to use this checkout's app-catalog/.`,
      }
    }
  }
  const inImage = input.inImage ?? existsSync(IMAGE_CATALOG_DIR)
  if (inImage) return { ok: true, set }

  if (!catalogEnv) {
    const local = path.join(repoRoot, "app-catalog")
    if (existsSync(path.join(local, "catalog.json"))) {
      set.LIAISON_APP_CATALOG_DIR = local
    } else if (input.needsCatalog) {
      return {
        ok: false,
        message: `No app catalog: LIAISON_APP_CATALOG_DIR is not set and ${local} has no catalog.json. Build it with \`bun run scripts/build-app-catalog.ts\` from ${repoRoot}, or set LIAISON_APP_CATALOG_DIR to a catalog folder.`,
      }
    }
  }
  if (!env.LIAISON_APPS_DIR) {
    const apps = path.join(repoRoot, ".liaison-apps", "apps")
    try {
      mkdirSync(apps, { recursive: true })
    } catch (err) {
      return {
        ok: false,
        message: `LIAISON_APPS_DIR is not set and ${apps} cannot be created (${err instanceof Error ? err.message : String(err)}). Set LIAISON_APPS_DIR to a writable folder.`,
      }
    }
    set.LIAISON_APPS_DIR = apps
  }
  return { ok: true, set }
}
