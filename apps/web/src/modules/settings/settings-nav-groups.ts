// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings column's shape (settings overhaul S12, D26): five headed
// groups, You, AI, Workspace, Apps and Connectors, always in that order. A
// kernel section lands in the group its `group` names (`user` -> You, `ai` ->
// AI, `admin` -> Workspace, `connectors` -> Connectors); every app is ONE row
// under Apps, the apps in rail order and then by name, with no sub-headings.
// The Connectors heading is itself the link to the Connectors page, so that
// group carries a link and no rows.
//
// The desktop sidebar and the phone You screen both render this, so the two
// can never list different rows. This file owns which row sits where; the
// pixels belong to the components.
import {
  type ActivityBarEntry,
  registryLabel,
  type SettingsSection,
} from "~/framework/app-registry"
import { humanizeId } from "~/lib/app-label"

export type SettingsNavGroupId = "you" | "ai" | "workspace" | "apps" | "connectors"

export const SETTINGS_NAV_GROUP_ORDER: readonly SettingsNavGroupId[] = [
  "you",
  "ai",
  "workspace",
  "apps",
  "connectors",
]

/** Catalog keys of the group headings. */
export const SETTINGS_NAV_GROUP_LABEL_KEY: Record<SettingsNavGroupId, string> = {
  you: "kernel.nav.groupYou",
  ai: "kernel.nav.groupAi",
  workspace: "kernel.nav.groupWorkspace",
  apps: "kernel.nav.groupApps",
  connectors: "kernel.nav.groupConnectors",
}

export interface SettingsNavRow {
  /** Stable key: the section id for a kernel page, `app:<appId>` for an app. */
  key: string
  href: string
  label: string
  /** The section the row opens. */
  section: SettingsSection
  /** Apps only. */
  appId?: string
  /** Every href that makes this row the current one (an app's former pages). */
  hrefs: string[]
}

export interface SettingsNavGroup {
  id: SettingsNavGroupId
  rows: SettingsNavRow[]
  /** Connectors: the heading itself is this link. */
  link?: SettingsNavRow
}

type Translate = (key: string) => string

function isKernelSection(section: SettingsSection): boolean {
  return !section.appId || section.appId === "kernel"
}

/** The group a section is listed under. */
export function settingsNavGroupOf(section: SettingsSection): SettingsNavGroupId {
  if (!isKernelSection(section)) return "apps"
  switch (section.group) {
    case "ai":
      return "ai"
    case "admin":
      return "workspace"
    case "app":
      return "apps"
    case "connectors":
      return "connectors"
    default:
      return "you"
  }
}

/** A catalog value, or undefined when the catalog has no such key. */
function translated(t: Translate, key: string): string | undefined {
  const value = t(key)
  return value === key ? undefined : value
}

/**
 * The name of an app's row: its rail label (translated when it has a key),
 * else `kernel.nav.app.<appId>` for an app with no rail entry, else the label
 * its settings page carries (the manifest's display name), else the id in
 * words ("acme_tool" reads "Acme tool"), never the raw id.
 */
export function settingsAppName(
  appId: string,
  sections: readonly SettingsSection[],
  activityEntries: readonly ActivityBarEntry[],
  t: Translate,
): string {
  const entry = activityEntries.find((e) => e.appId === appId)
  if (entry) return registryLabel(t, entry)
  const fromCatalog = translated(t, `kernel.nav.app.${appId}`)
  if (fromCatalog) return fromCatalog
  const page = sections.find((s) => s.appId === appId && s.pageSections)
  if (page) return registryLabel(t, page)
  return humanizeId(appId)
}

/**
 * The groups that have at least one row, in the fixed order. `sections` is
 * what this viewer may see (already filtered for access, edition and
 * `hidden`); it is sorted here by `order`.
 */
export function buildSettingsNavGroups(
  sections: readonly SettingsSection[],
  activityEntries: readonly ActivityBarEntry[],
  t: Translate,
): SettingsNavGroup[] {
  const sorted = [...sections].sort((a, b) => a.order - b.order)
  const byGroup = new Map<SettingsNavGroupId, SettingsSection[]>()
  for (const section of sorted) {
    const id = settingsNavGroupOf(section)
    const list = byGroup.get(id) ?? []
    list.push(section)
    byGroup.set(id, list)
  }

  const kernelRow = (section: SettingsSection): SettingsNavRow => ({
    key: section.id,
    href: section.href,
    label: registryLabel(t, section),
    section,
    hrefs: [section.href],
  })

  const groups: SettingsNavGroup[] = []
  for (const id of SETTINGS_NAV_GROUP_ORDER) {
    const list = byGroup.get(id)
    if (!list || list.length === 0) continue
    if (id === "connectors") {
      groups.push({ id, rows: [], link: kernelRow(list[0]) })
      continue
    }
    if (id !== "apps") {
      groups.push({ id, rows: list.map(kernelRow) })
      continue
    }
    // One row per app. An app with a declarative page has that one section;
    // an app still on its former pages opens on its first one.
    const perApp = new Map<string, SettingsSection[]>()
    for (const section of list) {
      const appId = section.appId ?? "kernel"
      perApp.set(appId, [...(perApp.get(appId) ?? []), section])
    }
    const railOrder = (appId: string | undefined) =>
      activityEntries.find((e) => e.appId === appId)?.order
    const rows = [...perApp.entries()].map<SettingsNavRow>(([appId, appSections]) => {
      const page = appSections.find((s) => s.pageSections) ?? appSections[0]
      return {
        key: `app:${appId}`,
        href: page.href,
        label: settingsAppName(appId, appSections, activityEntries, t),
        section: page,
        appId,
        hrefs: appSections.map((s) => s.href),
      }
    })
    rows.sort((a, b) => {
      const ra = railOrder(a.appId)
      const rb = railOrder(b.appId)
      if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb
      if (ra !== undefined && rb === undefined) return -1
      if (ra === undefined && rb !== undefined) return 1
      return a.label.localeCompare(b.label)
    })
    groups.push({ id, rows })
  }
  return groups
}
