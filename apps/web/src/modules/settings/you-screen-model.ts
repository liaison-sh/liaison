// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The You screen's shape (M2-3 T18, settings overhaul S12), kept out of the
// component so the part worth pinning is pinned: WHICH groups exist, in which
// order, and which rows they carry. It is the desktop column's own groups
// (settings-nav-groups.ts), so a section this viewer cannot reach never
// becomes a row and the phone never lists a row the desktop does not.
//
// The component owns pixels and the toggles' live values; this file owns the
// list.
import { registryLabel, type SettingsSection } from "~/framework/app-registry"
import {
  SETTINGS_NAV_GROUP_LABEL_KEY,
  type SettingsNavGroup,
  type SettingsNavRow,
} from "./settings-nav-groups"

/** What tapping a row does. */
export type YouRowTarget =
  /** Push a registered settings section (its `href`). */
  | { kind: "section"; href: string }
  /** Open a tab route outside settings (the agent page's sub routes). */
  | { kind: "route"; path: string }
  /** A switch the component wires to its own store. */
  | { kind: "toggle"; toggle: "appLock" }

export interface YouRow {
  id: string
  label: string
  /** Right-aligned current value, when the row shows one (theme, locale). */
  value?: string
  /** The desktop row's marker (an app that is Off), in the reader's language. */
  badge?: string
  target: YouRowTarget
}

export interface YouGroup {
  id: string
  label: string
  rows: YouRow[]
}

export interface YouScreenInput {
  /** The settings column's groups, as the desktop sidebar builds them. */
  navGroups: SettingsNavGroup[]
  /** Whether the shell offers a biometric lock (resolved async; false until it answers). */
  appLockAvailable: boolean
  t: (key: string) => string
}

/** The Agents app, opened on the viewer's personal agent. Skills, routines,
 *  memory and connectors are that app's own surfaces and are reached there;
 *  You links to it rather than restating three of its tabs as settings rows. */
export const YOU_AGENTS_PATH = "/agents/self"

/** A section's id is namespaced by the app that registered it
 *  (`kernel:security`), so row ids are built on the last segment. */
export function sectionKey(section: SettingsSection): string {
  const parts = section.id.split(":")
  return parts[parts.length - 1]
}

/** Organisation-shaped pages: AI, Workspace and Connectors. */
function isAdminLike(section: SettingsSection): boolean {
  return section.group === "admin" || section.group === "ai" || section.group === "connectors"
}

/** Is this href an organisation page, i.e. does it get the phone notice? */
export function isAdminHref(sections: SettingsSection[], href: string | null): boolean {
  if (!href) return false
  return sections.some((s) => isAdminLike(s) && !s.hidden && s.href === href)
}

/** The section the profile row opens: Profile when it is registered. */
export function profileSection(sections: SettingsSection[]): SettingsSection | null {
  return sections.find((s) => sectionKey(s) === "profile") ?? null
}

function rowId(groupId: string, row: SettingsNavRow): string {
  return row.appId ? `${groupId}-${row.appId}` : `${groupId}-${sectionKey(row.section)}`
}

/**
 * The phone's settings root: the Agents link, then exactly the desktop
 * column's groups and rows (settings overhaul S12, A22), plus the app-lock
 * switch under You when the shell offers one. The Connectors heading is a
 * link on desktop; here it is one unheaded row.
 */
export function buildYouGroups(input: YouScreenInput): YouGroup[] {
  const t = input.t
  const groups: YouGroup[] = [
    {
      id: "agent",
      label: "",
      rows: [
        {
          id: "agent-app",
          label: t("kernel.youRowAgents"),
          target: { kind: "route", path: YOU_AGENTS_PATH },
        },
      ],
    },
  ]

  for (const group of input.navGroups) {
    const rows = group.rows.map<YouRow>((row) => ({
      id: rowId(group.id, row),
      label: row.label,
      ...(row.section.badge
        ? { badge: registryLabel(t, { label: row.section.badge, labelKey: row.section.badgeKey }) }
        : {}),
      target: { kind: "section", href: row.href },
    }))
    if (group.link) {
      rows.push({
        id: group.id,
        label: t(SETTINGS_NAV_GROUP_LABEL_KEY[group.id]),
        target: { kind: "section", href: group.link.href },
      })
    }
    if (group.id === "you" && input.appLockAvailable) {
      rows.push({
        id: "you-app-lock",
        label: t("kernel.youRowAppLock"),
        target: { kind: "toggle", toggle: "appLock" },
      })
    }
    if (rows.length === 0) continue
    groups.push({
      id: group.id,
      label: group.link ? "" : t(SETTINGS_NAV_GROUP_LABEL_KEY[group.id]),
      rows,
    })
  }
  return groups
}
