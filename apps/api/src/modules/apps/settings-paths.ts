// SPDX-License-Identifier: FSL-1.1-ALv2
// Where the web app shows one app's settings, decided by its manifest: a
// connector's card on the Connectors page, an app's own settings page, or the
// App store for an app that has neither. Server-side links point here (OAuth
// callbacks and their errors, connection attention rows, a shell connect's
// landing page), and they are stored where nothing rewrites them later, which
// is why the web keeps every former path as an alias (settings-aliases.ts).
import { manifestRegistry } from "~/modules/apps/app-registries"

/** The Connectors page. */
export const SETTINGS_CONNECTORS_PATH = "/settings/connectors"
/** The App store. */
export const SETTINGS_STORE_PATH = "/settings/store"

export function appSettingsPath(orgId: string, appName: string): string {
  const manifest = manifestRegistry.get([orgId, appName])
  const app = encodeURIComponent(appName)
  if (manifest?.kind === "connector") return `${SETTINGS_CONNECTORS_PATH}?open=${app}`
  if (manifest?.settings) return `/settings/apps/${app}`
  return SETTINGS_STORE_PATH
}
