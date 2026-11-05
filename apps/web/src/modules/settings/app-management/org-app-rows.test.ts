// SPDX-License-Identifier: FSL-1.1-ALv2
// The admin's Apps rows (S24, A7): an app turned Off is absent from the
// manifests feed, so its row comes from the workspace's app list with an "Off"
// badge; an added app with no settings page of its own stays reachable from
// the App store but gets no row; members never load the list, so never see an
// Off or restricted app. A WebSocket update moves the badge at once.
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getSettingsSections,
  registerSettingsSection,
  resetRegistry,
} from "~/framework/app-registry"

const state = vi.hoisted(() => ({ scopes: ["*"] as string[] }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return { ...actual, hasScope: has, canAccessScope: (s?: string | null) => !s || has(s) }
})

import { buildSettingsNavGroups } from "../settings-nav-groups"
import { visibleSettingsSections } from "../visible-settings-sections"
import { startOrgAppRows } from "./org-app-rows"
import { type OrgApp, orgAppsStore } from "./org-apps-store"

function org(name: string, over: Partial<OrgApp> = {}): OrgApp {
  return {
    name,
    displayName: name[0].toUpperCase() + name.slice(1),
    version: "1.0.0",
    kind: "app",
    status: "active",
    accessMode: "everyone",
    principals: { roleIds: [], userIds: [] },
    hasOwnScopes: true,
    dependents: [],
    installSource: "in-tree",
    listing: null,
    settings: null,
    ...over,
  }
}

const t = (k: string) => k

function appRows() {
  const groups = buildSettingsNavGroups(
    visibleSettingsSections().filter((s) => !s.hidden),
    [],
    t,
  )
  return groups.find((g) => g.id === "apps")?.rows ?? []
}

let dispose: () => void = () => {}

beforeEach(() => {
  state.scopes = ["*"]
  resetRegistry()
  orgAppsStore.reset()
  dispose = createRoot((d) => {
    startOrgAppRows()
    return d
  })
})

afterEach(() => {
  dispose()
  orgAppsStore.reset()
  resetRegistry()
})

describe("admin Apps rows", () => {
  it("an Off app gets a row with an Off badge; an app with its own page keeps its own row", () => {
    // Tickets is On: its manifest registered its page.
    registerSettingsSection({
      id: "tickets:settings",
      label: "Tickets",
      href: "/settings/apps/tickets",
      group: "app",
      appId: "tickets",
      order: 0,
      pageSections: [{ scope: "org" }],
      component: () => null,
    })
    orgAppsStore.set([org("tickets"), org("social", { status: "disabled", displayName: "Social" })])
    const rows = appRows()
    expect(rows.map((r) => r.appId)).toEqual(["social", "tickets"])
    const social = rows.find((r) => r.appId === "social")
    expect(social?.href).toBe("/settings/apps/social")
    expect(social?.section.badgeKey).toBe("kernel.appManagement.offBadge")
    expect(rows.find((r) => r.appId === "tickets")?.section.badge).toBeUndefined()
    // One page per href: no second section for tickets.
    expect(getSettingsSections().filter((s) => s.href === "/settings/apps/tickets")).toHaveLength(1)
  })

  it("an On app with no page of its own is reachable but has no row; removed apps and connectors have neither", () => {
    orgAppsStore.set([
      org("contacts"),
      org("calls", { status: "removed" }),
      org("gitlab", { kind: "connector", status: "disabled" }),
      org("kernel"),
    ])
    expect(appRows()).toEqual([])
    const hrefs = getSettingsSections().map((s) => s.href)
    expect(hrefs).toContain("/settings/apps/contacts")
    expect(hrefs).not.toContain("/settings/apps/calls")
    expect(hrefs).not.toContain("/settings/apps/gitlab")
    expect(hrefs).not.toContain("/settings/apps/kernel")
  })

  it("a retired app (its package gone from the server) gets no row and no page", () => {
    orgAppsStore.set([
      org("meta-ads", { status: "disabled", displayName: null, retired: true }),
      org("social", { status: "disabled" }),
    ])
    expect(appRows().map((r) => r.appId)).toEqual(["social"])
    expect(getSettingsSections().map((s) => s.href)).not.toContain("/settings/apps/meta-ads")
  })

  it("a WebSocket update turning an app Off adds its badged row; back On, the badge goes", () => {
    orgAppsStore.set([org("social", { status: "active" })])
    expect(appRows()).toEqual([])
    orgAppsStore.applyUpdate({ app: "social", status: "disabled", accessMode: "everyone" })
    expect(appRows().map((r) => r.appId)).toEqual(["social"])
    orgAppsStore.applyUpdate({ app: "social", status: "active", accessMode: "everyone" })
    expect(appRows()).toEqual([])
  })

  it("the row gives way when the app's own page registers again", () => {
    orgAppsStore.set([org("social", { status: "disabled" })])
    expect(getSettingsSections().filter((s) => s.href === "/settings/apps/social")).toHaveLength(1)
    registerSettingsSection({
      id: "social:settings",
      label: "Social",
      href: "/settings/apps/social",
      group: "app",
      appId: "social",
      order: 0,
      pageSections: [{ scope: "org" }],
      component: () => null,
    })
    const social = getSettingsSections().filter((s) => s.href === "/settings/apps/social")
    expect(social.map((s) => s.id)).toEqual(["social:settings"])
  })
})

describe("members", () => {
  it("never see an Off app's row", () => {
    state.scopes = ["tickets:tickets:read"]
    // A member's list is never loaded; even a stale one yields no row for them.
    orgAppsStore.set([org("social", { status: "disabled" })])
    expect(appRows()).toEqual([])
  })
})
