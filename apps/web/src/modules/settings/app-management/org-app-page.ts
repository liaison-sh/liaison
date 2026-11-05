// SPDX-License-Identifier: FSL-1.1-ALv2
// The settings page entry of an app the manifests feed does not carry for
// this admin: the feed omits an app turned Off (S19, A7), so its page is built
// from `GET /api/org/apps` (name, version, kind, settings) to stay reachable,
// read-only, with the management header to turn it back on.
import { appSettingsLabelKey } from "~/framework/define-app"
import type { AppSettingsPageEntry, AppSettingsSchema } from "../app-page/types"
import type { OrgApp } from "./org-apps-store"

function settingsSchema(settings: OrgApp["settings"]): AppSettingsSchema | undefined {
  if (!settings || !Array.isArray(settings.sections)) return undefined
  return settings as AppSettingsSchema
}

export function orgAppPageEntry(app: OrgApp): AppSettingsPageEntry {
  return {
    appId: app.name,
    manifest: {
      name: app.name,
      displayName: app.displayName ?? undefined,
      version: app.version ?? undefined,
      author: app.listing?.publisher,
      kind: app.kind === "connector" ? "connector" : "app",
      settings: settingsSchema(app.settings),
    },
    label: app.displayName ?? app.name,
    labelKey: appSettingsLabelKey(app.name, app.displayName),
  }
}
