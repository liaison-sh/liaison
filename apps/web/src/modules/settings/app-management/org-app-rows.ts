// SPDX-License-Identifier: FSL-1.1-ALv2
// The admin's Apps rows for apps the manifests feed does not carry (S24, A7).
// An app turned Off is omitted from the feed for everyone, so its own page
// and row are gone; for `kernel:apps:admin` this keeps one row per such app,
// badged "Off", opening its read-only page with the switch to turn it back on.
// An added, On app without a declarative page of its own gets a route but no
// row, so the App store's "Open settings" reaches its management header.
// Removed apps and connectors (their card is on Connectors) get neither, nor
// does a retired app (its package is gone from the server): the App store
// lists it as no longer available, with Remove.
//
// The rows are settings sections with `org-app:` ids, kept in step with the
// workspace's app list and with the sections the apps register themselves:
// an app's own page always wins its href.
import { createComponent, createEffect, lazy, untrack } from "solid-js"
import {
  getSettingsSections,
  registerSettingsSection,
  type SettingsSection,
  unregisterSettingsSection,
} from "~/framework/app-registry"
import { appSettingsLabelKey } from "~/framework/define-app"
import { orgAppsStore } from "./org-apps-store"

const ID_PREFIX = "org-app:"
const APPS_ADMIN = "kernel:apps:admin"

const AppSettingsPage = lazy(() =>
  import("../app-page/AppSettingsPage").then((m) => ({ default: m.AppSettingsPage })),
)

function sectionFor(
  app: { name: string; displayName: string | null },
  off: boolean,
): SettingsSection {
  return {
    id: `${ID_PREFIX}${app.name}`,
    label: app.displayName ?? app.name,
    labelKey: appSettingsLabelKey(app.name, app.displayName),
    href: `/settings/apps/${app.name}`,
    group: "app",
    appId: app.name,
    adminScope: APPS_ADMIN,
    pageSections: [{ scope: "org", adminScope: APPS_ADMIN }],
    order: 0,
    hidden: !off,
    ...(off ? { badge: "Off", badgeKey: "kernel.appManagement.offBadge" } : {}),
    component: () => createComponent(AppSettingsPage, { appId: app.name }),
  }
}

function sameRow(a: SettingsSection, b: SettingsSection): boolean {
  return (
    a.label === b.label &&
    a.labelKey === b.labelKey &&
    a.hidden === b.hidden &&
    a.badgeKey === b.badgeKey
  )
}

/** Keep the rows in step; call once, inside a reactive root. */
export function startOrgAppRows(): void {
  createEffect(() => {
    const apps = orgAppsStore.apps()
    const sections = getSettingsSections()
    const taken = new Set(sections.filter((s) => !s.id.startsWith(ID_PREFIX)).map((s) => s.href))
    const mine = new Map(
      sections.filter((s) => s.id.startsWith(ID_PREFIX)).map((s) => [s.id, s] as const),
    )
    const wanted = new Map<string, SettingsSection>()
    for (const app of apps) {
      if (
        app.name === "kernel" ||
        app.kind === "connector" ||
        app.status === "removed" ||
        app.retired === true
      )
        continue
      const section = sectionFor(app, app.status === "disabled")
      if (taken.has(section.href)) continue
      wanted.set(section.id, section)
    }
    untrack(() => {
      for (const id of mine.keys()) if (!wanted.has(id)) unregisterSettingsSection(id)
      for (const [id, section] of wanted) {
        const current = mine.get(id)
        if (!current || !sameRow(current, section)) registerSettingsSection(section)
      }
    })
  })
}
