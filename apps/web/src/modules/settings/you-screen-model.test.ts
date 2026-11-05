// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The You screen's SHAPE (settings overhaul S12, A22): the phone root lists the
// same groups and rows as the desktop column, built by the same function, plus
// the two things only a phone has (the Agents link, the app lock). A row
// invented here rather than derived from the registry is a row that outlives
// the section it points at.
import type { Component } from "solid-js"
import { describe, expect, it } from "vitest"
import type { SettingsSection } from "~/framework/app-registry"
import { buildSettingsNavGroups } from "./settings-nav-groups"
import { buildYouGroups, isAdminHref, YOU_AGENTS_PATH, type YouGroup } from "./you-screen-model"

const Noop = (() => null) as unknown as Component

function section(over: Partial<SettingsSection> & { id: string; href: string }): SettingsSection {
  return {
    label: over.id,
    component: Noop,
    order: 0,
    appId: "kernel",
    ...over,
  } as SettingsSection
}

const SECTIONS: SettingsSection[] = [
  section({ id: "kernel:profile", label: "Profile", href: "/settings", group: "user", order: 0 }),
  section({
    id: "kernel:security",
    label: "Security",
    href: "/settings/security",
    group: "user",
    order: 10,
  }),
  section({
    id: "kernel:notifications",
    label: "Notifications",
    href: "/settings/notifications",
    group: "user",
    order: 15,
  }),
  section({
    id: "kernel:ai-models",
    label: "Models",
    href: "/settings/ai-models",
    group: "ai",
    order: 24,
  }),
  section({
    id: "kernel:org",
    label: "Organization",
    href: "/settings/admin/org",
    group: "admin",
    order: 19,
  }),
  section({
    id: "kernel:users",
    label: "Users",
    href: "/settings/admin/users",
    group: "admin",
    order: 20,
  }),
  section({
    id: "kernel:connectors",
    label: "Connectors",
    href: "/settings/connectors",
    group: "connectors",
    order: 200,
  }),
  section({
    id: "tickets:settings",
    label: "Tickets",
    href: "/settings/apps/tickets",
    group: "app",
    appId: "tickets",
  }),
  section({
    id: "mail:email-accounts",
    label: "Email accounts",
    href: "/settings/mail/accounts",
    group: "app",
    appId: "mail",
  }),
  section({
    id: "mail:providers",
    label: "Providers",
    href: "/settings/mail/providers",
    group: "app",
    appId: "mail",
    order: 1,
  }),
]

const t = (key: string) => key

function you(over: Partial<Parameters<typeof buildYouGroups>[0]> = {}): YouGroup[] {
  return buildYouGroups({
    navGroups: buildSettingsNavGroups(SECTIONS, [], t),
    appLockAvailable: false,
    t,
    ...over,
  })
}

function sectionHrefs(groups: YouGroup[]): string[] {
  return groups.flatMap((g) =>
    g.rows.flatMap((r) => (r.target.kind === "section" ? [r.target.href] : [])),
  )
}

describe("buildYouGroups: the desktop column, on a phone", () => {
  it("lists the same rows as the desktop column, in the same order", () => {
    const desktop = buildSettingsNavGroups(SECTIONS, [], t).flatMap((g) => [
      ...g.rows.map((r) => r.href),
      ...(g.link ? [g.link.href] : []),
    ])
    expect(sectionHrefs(you())).toEqual(desktop)
  })

  it("orders the groups agent link, You, AI, Workspace, Apps, Connectors", () => {
    expect(you().map((g) => g.id)).toEqual([
      "agent",
      "you",
      "ai",
      "workspace",
      "apps",
      "connectors",
    ])
  })

  it("heads each group like the desktop column", () => {
    const labels = Object.fromEntries(you().map((g) => [g.id, g.label]))
    expect(labels).toEqual({
      agent: "",
      you: "kernel.nav.groupYou",
      ai: "kernel.nav.groupAi",
      workspace: "kernel.nav.groupWorkspace",
      apps: "kernel.nav.groupApps",
      // The Connectors heading is a link on desktop: one unheaded row here.
      connectors: "",
    })
  })

  it("gives an app ONE row, as the desktop column does", () => {
    const apps = you().find((g) => g.id === "apps")
    // No rail entries here: by name.
    expect(apps?.rows.map((r) => r.id)).toEqual(["apps-mail", "apps-tickets"])
  })

  it("carries the desktop row's Off marker for an app that is off (NAV-09)", () => {
    const off = section({
      id: "kpi:settings",
      label: "KPI",
      href: "/settings/apps/kpi",
      group: "app",
      appId: "kpi",
      order: 2,
      badge: "Off",
      badgeKey: "kernel.appManagement.offBadge",
    })
    const groups = buildYouGroups({
      navGroups: buildSettingsNavGroups([...SECTIONS, off], [], t),
      appLockAvailable: false,
      t: (key) => (key === "kernel.appManagement.offBadge" ? "Désactivée" : key),
    })
    const rows = groups.find((g) => g.id === "apps")?.rows ?? []
    expect(rows.find((r) => r.id === "apps-kpi")?.badge).toBe("Désactivée")
    expect(rows.find((r) => r.id === "apps-mail")?.badge).toBeUndefined()
  })

  it("carries ONE Agents link, unheaded", () => {
    const agent = you()[0]
    expect(agent.label).toBe("")
    expect(agent.rows).toEqual([
      expect.objectContaining({
        id: "agent-app",
        target: { kind: "route", path: YOU_AGENTS_PATH },
      }),
    ])
  })

  it("appends the app-lock toggle to You only when the shell offers one", () => {
    const without = you().find((g) => g.id === "you")
    expect(without?.rows.some((r) => r.target.kind === "toggle")).toBe(false)
    const withLock = you({ appLockAvailable: true }).find((g) => g.id === "you")
    expect(withLock?.rows.at(-1)).toEqual(
      expect.objectContaining({
        id: "you-app-lock",
        target: { kind: "toggle", toggle: "appLock" },
      }),
    )
  })

  it("keeps the row ids on the bare key, so a testid never carries a namespace", () => {
    const ids = you().flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).toContain("you-security")
    expect(ids).toContain("workspace-users")
    expect(ids.some((id) => id.includes(":"))).toBe(false)
  })

  it("drops a group with no row for this viewer", () => {
    const member = SECTIONS.filter((s) => s.group === "user" || s.group === "app")
    const groups = buildYouGroups({
      navGroups: buildSettingsNavGroups(member, [], t),
      appLockAvailable: false,
      t,
    })
    expect(groups.map((g) => g.id)).toEqual(["agent", "you", "apps"])
  })
})

describe("admin notice", () => {
  it("is for the organisation's pages: AI, Workspace and Connectors", () => {
    expect(isAdminHref(SECTIONS, "/settings/admin/users")).toBe(true)
    expect(isAdminHref(SECTIONS, "/settings/ai-models")).toBe(true)
    expect(isAdminHref(SECTIONS, "/settings/connectors")).toBe(true)
    expect(isAdminHref(SECTIONS, "/settings/security")).toBe(false)
    expect(isAdminHref(SECTIONS, "/settings/apps/tickets")).toBe(false)
    expect(isAdminHref(SECTIONS, null)).toBe(false)
  })
})
