// SPDX-License-Identifier: FSL-1.1-ALv2
// One record per app with a declarative settings page (define-app): the Apps
// row, the page entry and a connector's card come from the same registration,
// handed to the settings pages module once it is wired, and removed with the app.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getConnectorApps, getSettingsSections, resetRegistry } from "~/framework/app-registry"
import {
  type AppManifest,
  type AppSettingsPageRegistration,
  appSettingsLabelKey,
  registerAppFromManifest,
  registerAppSettingsRoute,
  resetAppIndex,
  unregisterApp,
} from "~/framework/define-app"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const Icon = () => null
const Quota = () => null

function manifest(name: string, kind: "app" | "connector"): AppManifest {
  return {
    name,
    kind,
    displayName: `${name} display`,
    version: "1.2.3",
    author: "Publisher",
    settings: {
      sections: [
        {
          id: "general",
          title: "General",
          scope: "org",
          adminScope: `${name}:settings:admin`,
          blocks: [{ block: "custom", component: "Quota", reason: "computed view" }],
        },
      ],
    },
    views:
      kind === "app" ? { activityBar: { icon: "Icon", label: "Fixture", order: 5 } } : undefined,
  }
}

function wire() {
  const pages = new Map<string, AppSettingsPageRegistration>()
  const registerPage = vi.fn((e: AppSettingsPageRegistration) => pages.set(e.appId, e))
  const unregisterPage = vi.fn((id: string) => pages.delete(id))
  registerAppSettingsRoute({ page: () => null, registerPage, unregisterPage })
  return { pages, registerPage, unregisterPage }
}

beforeEach(() => {
  resetRegistry()
  resetAppIndex()
})

describe("declarative settings page registration", () => {
  it("registers an app's page entry and its ONE Apps row from the same manifest", () => {
    const { pages } = wire()
    registerAppFromManifest(manifest("fixture", "app"), { Icon, Quota })
    const entry = pages.get("fixture")
    expect(entry?.manifest).toMatchObject({
      name: "fixture",
      kind: "app",
      version: "1.2.3",
      author: "Publisher",
    })
    expect(entry?.label).toBe("Fixture")
    expect(entry?.icon).toBe(Icon)
    expect(entry?.exports?.Quota).toBe(Quota)
    const rows = getSettingsSections().filter((s) => s.id.startsWith("fixture:"))
    expect(rows.map((r) => r.href)).toEqual(["/settings/apps/fixture"])
    expect(rows[0].pageSections).toEqual([{ scope: "org", adminScope: "fixture:settings:admin" }])
  })

  it("registers a connector's entry and card access, with no Apps row", () => {
    const { pages } = wire()
    registerAppFromManifest(manifest("probe", "connector"), { Quota })
    expect(pages.get("probe")?.manifest.kind).toBe("connector")
    expect(getConnectorApps().map((c) => c.appId)).toEqual(["probe"])
    expect(getSettingsSections().some((s) => s.id.startsWith("probe:"))).toBe(false)
  })

  it("hands over registrations made before the pages module was wired", () => {
    registerAppFromManifest(manifest("early", "app"), { Icon, Quota })
    const { registerPage } = wire()
    expect(registerPage).toHaveBeenCalledWith(expect.objectContaining({ appId: "early" }))
  })

  it("removes the entry, the row and the card when the app is unregistered", () => {
    const { pages, unregisterPage } = wire()
    registerAppFromManifest(manifest("fixture", "app"), { Icon, Quota })
    registerAppFromManifest(manifest("probe", "connector"), { Quota })
    unregisterApp("fixture")
    unregisterApp("probe")
    expect(unregisterPage).toHaveBeenCalledWith("fixture")
    expect(unregisterPage).toHaveBeenCalledWith("probe")
    expect(pages.size).toBe(0)
    expect(getConnectorApps()).toEqual([])
    expect(getSettingsSections().some((s) => s.id.startsWith("fixture:"))).toBe(false)
  })

  it("names an app with no display name from the catalog, never by its package id", () => {
    const { pages } = wire()
    const bare: AppManifest = {
      ...manifest("mcp-manager", "app"),
      displayName: undefined,
      views: {},
    }
    registerAppFromManifest(bare, { Quota })
    expect(pages.get("mcp-manager")?.labelKey).toBe("kernel.capabilities.apps.mcp-manager")
    const row = getSettingsSections().find((s) => s.href === "/settings/apps/mcp-manager")
    expect(row?.labelKey).toBe("kernel.capabilities.apps.mcp-manager")
  })

  it("keeps a declared display name as the app's own", () => {
    expect(appSettingsLabelKey("mcp-manager", "Our MCP hub")).toBeUndefined()
    expect(appSettingsLabelKey("unknown-app")).toBeUndefined()
  })

  it("registers no entry for an app without settings", () => {
    const { pages } = wire()
    registerAppFromManifest({ name: "plain", views: {} }, {})
    expect(pages.has("plain")).toBe(false)
  })
})
