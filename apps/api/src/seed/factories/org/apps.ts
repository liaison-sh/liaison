// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app factory: install (catalog apps) and enable a list of apps in an org,
// one at a time, through the catalog and enablement services the admin UI
// calls. One refusing bundle is reported on its row and the others still land,
// so a tier decides what a failed app means rather than this loop aborting.
import { withPrivilegedDb } from "~/db/privileged"
import {
  catalogInstallAction,
  installCatalogApp,
  listCatalogWithState,
  noteVersionAhead,
} from "~/modules/apps/catalog"
import { enableApp } from "~/modules/apps/enabled-apps"
import { shouldEnableApp } from "./app-enablement"

export interface SeededApp {
  name: string
  enabled: boolean
  installed: boolean
  error?: string
}

export async function installApps(
  orgId: string,
  installedBy: string,
  appNames: readonly string[],
  log: (msg: string) => void,
): Promise<SeededApp[]> {
  const catalogState = new Map((await listCatalogWithState()).map((c) => [c.name, c] as const))
  const results: SeededApp[] = []

  for (const name of appNames) {
    const state = catalogState.get(name)
    let installed = false
    let error: string | undefined

    if (state) {
      const action = catalogInstallAction(state)
      try {
        if (action === "install" || action === "upgrade") {
          await installCatalogApp({ orgId, name, installedBy })
          log(`app '${name}': installed from catalog (v${state.version})`)
          catalogState.set(name, { ...state, installed: true, installedVersion: state.version })
        } else if (action === "ahead") {
          // A newer release set the active version (a rollback, or an old
          // process in a rolling deploy): this image's older package would be
          // refused, and the org registers the version this process runs.
          noteVersionAhead(name, state.installedVersion ?? "", state.version)
          log(
            `app '${name}': active v${state.installedVersion} is newer than this release's catalog (v${state.version}), kept`,
          )
        } else {
          log(`app '${name}': already installed (v${state.installedVersion})`)
        }
        installed = true
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        log(`app '${name}': install refused (${error})`)
      }
    }

    let enabled = false
    if (!shouldEnableApp({ isCatalogApp: state !== undefined, installed })) {
      log(`app '${name}': not enabled, because its install failed`)
    } else {
      try {
        await enableApp(orgId, name)
        enabled = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        error = error ? `${error}; ${message}` : message
        log(`app '${name}': enable refused (${message})`)
      }
    }

    results.push({ name, enabled, installed, ...(error !== undefined ? { error } : {}) })
  }
  return results
}

/**
 * The saved views the installed apps' manifests declare: the same
 * post-bootstrap step a first registration runs. Idempotent; needs the apps
 * registered first.
 */
export async function seedSavedViewDefaults(orgId: string): Promise<void> {
  const { seedManifestDefaults } = await import("~/modules/saved-views/seed")
  await withPrivilegedDb(orgId, "seed-saved-views", (tx) => seedManifestDefaults(tx, orgId))
}
