// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tab route ownership on the server: an app's tab `urlPattern`s must sit under a first segment
 * it owns (`@liaison/shared` `tabRouteRefusal` has the rule). The install and the upgrade
 * refuse an app that breaks it, and the boot registration leaves such an installed app out, so
 * one installed before the rule cannot take another app's deep links either.
 */
import { readFileSync } from "node:fs"
import {
  manifestTabRouteRefusal,
  manifestTabUrlPatterns,
  type TabRouteOwner,
} from "@liaison/shared"
import { appsLogger as log } from "~/lib/logger"
import { type DiscoveredApp, discoverInTreeApps } from "~/modules/apps/discover-apps"

function readManifest(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/** An app and the tab patterns its manifest on disk declares. */
export function tabRouteOwnerOf(app: DiscoveredApp): TabRouteOwner {
  return {
    name: app.name,
    patterns: manifestTabUrlPatterns(app.name, readManifest(app.manifestPath)),
  }
}

/** Every app but `name` the shell registers: the in-tree apps and the active installed ones. */
async function otherAppsTabRoutes(name: string): Promise<TabRouteOwner[]> {
  const { activeInstalledApps } = await import("~/modules/apps/init")
  const apps = [...(await discoverInTreeApps()), ...(await activeInstalledApps())]
  return apps.filter((app) => app.name !== name).map(tabRouteOwnerOf)
}

/** Refuse the install or upgrade of `name` when one of its tab patterns is not its own. */
export async function assertTabRoutesOwned(name: string, manifest: unknown): Promise<void> {
  const refusal = manifestTabRouteRefusal(name, manifest, await otherAppsTabRoutes(name))
  if (refusal) throw new Error(`Cannot install '${name}': its ${refusal}.`)
}

/**
 * The installed apps the boot registration may register: one whose tab pattern is not its own
 * (against the in-tree apps, every installed app's name, and the patterns of the installed apps
 * kept before it, in name order) is left out, loudly.
 */
export function installedAppsOwningTheirRoutes(
  inTree: readonly DiscoveredApp[],
  installed: readonly DiscoveredApp[],
): DiscoveredApp[] {
  const kept: TabRouteOwner[] = inTree.map(tabRouteOwnerOf)
  const names: TabRouteOwner[] = installed.map((app) => ({ name: app.name, patterns: [] }))
  const out: DiscoveredApp[] = []
  for (const app of [...installed].sort((a, b) => a.name.localeCompare(b.name))) {
    const refusal = manifestTabRouteRefusal(app.name, readManifest(app.manifestPath), [
      ...kept,
      ...names,
    ])
    if (refusal) {
      log.error(
        { app: app.name, version: app.version, refusal },
        `Installed app not registered: its ${refusal}`,
      )
      continue
    }
    kept.push(tabRouteOwnerOf(app))
    out.push(app)
  }
  // Registration order is the discovery order, not the check's.
  return installed.filter((app) => out.includes(app))
}
