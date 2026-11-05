// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The You screen at phone width: the profile row, the agent group named by the
// agents directory, the Notifications row, and the admin rows last.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  canAccessScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Alex Rivera", roles: ["Admin"] }),
}))

const apiGet = vi.fn(async (_path: string) => ({}))
const apiPut = vi.fn(async (_path: string, _body: unknown) => ({}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: apiGet, put: apiPut, post: vi.fn(), patch: vi.fn() }),
  useOptionalApi: () => ({ get: apiGet, put: apiPut }),
}))

vi.mock("~/modules/shell/branding-store", () => ({
  orgName: () => "Fabrikam",
  ensureBrandingLoaded: async () => {},
}))

const personalAgent = { value: { name: "Nova" } as { name: string } | undefined }
vi.mock("~/modules/threads/agent-directory", () => ({
  loadAgentDirectory: async () => {},
  personalAgentFor: () => personalAgent.value,
}))

const openTab = vi.fn()
vi.mock("~/modules/shell/tab-store", () => ({ openTab: (...args: unknown[]) => openTab(...args) }))

const addToast = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (...args: unknown[]) => addToast(...args),
}))

const appLock = { available: false, enabled: false, setEnabledImpl: async (_v: boolean) => {} }
vi.mock("~/lib/app-lock", () => ({
  isAvailable: async () => appLock.available,
  getEnabled: async () => appLock.enabled,
  setEnabled: async (v: boolean) => appLock.setEnabledImpl(v),
}))

import { registerSettingsSection, resetRegistry } from "~/framework/app-registry"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { popSettingsSection, pushedSection } from "~/modules/settings/phone-settings-nav"
import { identityLine, YouScreen } from "~/modules/settings/YouScreen"

const Noop = () => null

function registerSections(): void {
  registerSettingsSection({
    id: "profile",
    label: "Profile",
    href: "/settings",
    component: Noop,
    group: "user",
    order: 0,
  })
  registerSettingsSection({
    id: "security",
    label: "Security",
    href: "/settings/security",
    component: Noop,
    group: "user",
    order: 10,
  })
  registerSettingsSection({
    id: "notifications",
    label: "Notifications",
    href: "/settings/notifications",
    component: Noop,
    group: "user",
    order: 15,
  })
  registerSettingsSection({
    id: "connections",
    label: "Connections",
    href: "/settings/connections",
    component: Noop,
    group: "user",
    order: 18,
  })
  registerSettingsSection({
    id: "users",
    label: "Users",
    href: "/settings/admin/users",
    component: Noop,
    group: "admin",
    order: 20,
  })
}

describe("YouScreen", () => {
  beforeEach(() => {
    resetRegistry()
    popSettingsSection()
    openTab.mockClear()
    apiPut.mockClear()
    apiPut.mockImplementation(async () => ({}))
    addToast.mockClear()
    apiGet.mockClear()
    appLock.available = false
    appLock.enabled = false
    appLock.setEnabledImpl = async () => {}
    personalAgent.value = { name: "Nova" }
    registerSections()
  })

  afterEach(() => cleanup())

  it("drops a role id rather than printing it over the workspace and server", () => {
    // The token carries role IDs, not names: printed raw, the line is a UUID
    // and the two things the viewer can actually use are pushed off the end.
    expect(
      identityLine({
        role: "039492fa-5b93-459f-a2dc-fda57582ae11",
        org: "Fabrikam",
        host: "liaison.local",
      }),
    ).toBe("Fabrikam · liaison.local")
    expect(identityLine({ role: "Admin", org: "Fabrikam", host: "liaison.local" })).toBe(
      "Admin · Fabrikam · liaison.local",
    )
    expect(identityLine({ org: null, host: "liaison.local" })).toBe("liaison.local")
  })

  it("names the viewer and says which role, workspace and server this is", async () => {
    render(() => <YouScreen />)
    expect(screen.getByTestId("you-title")).toHaveTextContent("You")
    expect(screen.getByTestId("you-profile-name")).toHaveTextContent("Alex Rivera")
    const identity = screen.getByTestId("you-profile-identity").textContent ?? ""
    expect(identity).toContain("Admin")
    expect(identity).toContain("Fabrikam")
  })

  it("opens the profile section from the profile row", async () => {
    render(() => <YouScreen />)
    fireEvent.click(screen.getByTestId("you-profile-row"))
    expect(pushedSection()).toBe("/settings")
  })

  it("drops the agent app's own surfaces from the You root", async () => {
    render(() => <YouScreen />)
    expect(screen.queryByTestId("you-row-agent-skills")).toBeNull()
    expect(screen.queryByTestId("you-row-agent-memory")).toBeNull()
    expect(screen.queryByTestId("you-row-agent-connectors")).toBeNull()
    // No heading above the single link, so "NOVA" no longer heads a settings
    // group made of another app's tabs.
    expect(screen.getByTestId("you-group-agent")).not.toHaveTextContent("Nova")
  })

  it("opens the Agents app on the personal agent from the one Agents row", async () => {
    render(() => <YouScreen />)
    fireEvent.click(screen.getByTestId("you-row-agent-app"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agents:agent",
        entityId: "self",
        routePath: "/agents/self",
      }),
    )
    expect(pushedSection()).toBeNull()
  })

  it("marks an app that is off, as the desktop column does (NAV-09)", async () => {
    registerSettingsSection({
      id: "kpi:settings",
      label: "KPI",
      href: "/settings/apps/kpi",
      component: Noop,
      group: "app",
      appId: "kpi",
      order: 40,
      badge: "Off",
      badgeKey: "kernel.appManagement.offBadge",
    })
    render(() => <YouScreen />)
    const row = await screen.findByTestId("you-row-apps-kpi")
    expect(within(row).getByTestId("you-row-badge-apps-kpi")).toHaveTextContent("Off")
  })

  it("opens Settings > Notifications from the one Notifications row", async () => {
    render(() => <YouScreen />)
    const row = await screen.findByTestId("you-row-you-notifications")
    expect(row).toHaveTextContent("Notifications")
    fireEvent.click(row)
    expect(pushedSection()).toBe("/settings/notifications")
    expect(openTab).not.toHaveBeenCalled()
  })

  it("no longer carries the old push and digest switches", async () => {
    render(() => <YouScreen />)
    await screen.findByTestId("you-group-you")
    expect(screen.queryByTestId("you-toggle-notifications-push")).toBeNull()
    expect(screen.queryByTestId("you-toggle-notifications-digest")).toBeNull()
    expect(screen.queryByTestId("you-row-notifications-push")).toBeNull()
    expect(screen.queryByTestId("you-row-notifications-digest")).toBeNull()
    // The digest preference is no longer read here at all.
    expect(apiGet).not.toHaveBeenCalledWith("/user/preferences")
  })

  it("never shows the Face ID row in a plain browser (isAvailable resolves false)", async () => {
    appLock.available = false
    render(() => <YouScreen />)
    await screen.findByTestId("you-group-you")
    expect(screen.queryByTestId("you-row-you-app-lock")).toBeNull()
  })

  it("shows the Face ID row, with its current state, when the shell offers one", async () => {
    appLock.available = true
    appLock.enabled = true
    render(() => <YouScreen />)
    const toggle = await screen.findByTestId("you-toggle-you-app-lock")
    expect(toggle).toHaveAttribute("aria-checked", "true")
  })

  it("toggles Face ID through app-lock.setEnabled and reflects the new state", async () => {
    appLock.available = true
    appLock.enabled = false
    const setEnabled = vi.fn(async (v: boolean) => {
      appLock.enabled = v
    })
    appLock.setEnabledImpl = setEnabled
    render(() => <YouScreen />)
    const toggle = await screen.findByTestId("you-toggle-you-app-lock")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true))
    await waitFor(() =>
      expect(screen.getByTestId("you-toggle-you-app-lock")).toHaveAttribute("aria-checked", "true"),
    )
  })

  it("springs the Face ID switch back and says so when saving the preference fails", async () => {
    appLock.available = true
    appLock.enabled = false
    appLock.setEnabledImpl = async () => {
      throw new Error("keychain unavailable")
    }
    render(() => <YouScreen />)
    const toggle = await screen.findByTestId("you-toggle-you-app-lock")
    fireEvent.click(toggle)
    await waitFor(() => expect(addToast).toHaveBeenCalled())
    expect(screen.getByTestId("you-toggle-you-app-lock")).toHaveAttribute("aria-checked", "false")
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }))
  })

  it("puts the organisation's sections in the Workspace group, after You", async () => {
    render(() => <YouScreen />)
    const groups = Array.from(document.querySelectorAll("[data-testid^='you-group-']")).map((el) =>
      el.getAttribute("data-testid"),
    )
    expect(groups[groups.length - 1]).toBe("you-group-workspace")
    expect(groups.indexOf("you-group-you")).toBeLessThan(groups.indexOf("you-group-workspace"))
    expect(screen.getByTestId("you-row-workspace-users")).toHaveTextContent("Users")
  })

  it("puts the phone's servers right under the profile, before every other group", async () => {
    // Found on the simulator (2026-09-28): rendered after the admin tables,
    // the group sat under twenty rows and nobody found it.
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      servers: {
        list: async () => ({
          current: "https://liaison.example.com",
          servers: [{ address: "https://liaison.example.com", label: "Example" }],
        }),
        add: async () => {},
        switchTo: async () => {},
        remove: async () => {},
        signOut: async () => {},
      },
    }
    try {
      render(() => <YouScreen />)
      await screen.findByTestId("you-group-servers")
      const groups = Array.from(document.querySelectorAll("[data-testid^='you-group-']")).map(
        (el) => el.getAttribute("data-testid"),
      )
      expect(groups[0]).toBe("you-group-servers")
      expect(groups.indexOf("you-group-servers")).toBeLessThan(groups.indexOf("you-group-agent"))
      expect(groups.indexOf("you-group-servers")).toBeLessThan(groups.indexOf("you-group-you"))
      expect(groups[groups.length - 1]).toBe("you-group-workspace")
    } finally {
      delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
    }
  })

  it("names the opened agent tab generically until the directory answers", async () => {
    personalAgent.value = undefined
    render(() => <YouScreen />)
    fireEvent.click(screen.getByTestId("you-row-agent-app"))
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ label: "Your agent" }))
  })
  // The identity line used to end in `window.location.host`, which on a
  // browser tab reads "localhost:18080": a port number under the viewer's own
  // name. The workspace is the answer to "where am I"; the SERVER is only
  // worth a line when the shell was pointed at one, and then by hostname
  // alone.
  describe("the line under the name", () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
    })

    it("names the workspace and never the raw host of the default deployment", () => {
      render(() => <YouScreen />)
      const identity = screen.getByTestId("you-profile-identity").textContent ?? ""
      expect(identity).toContain("Fabrikam")
      expect(identity).not.toContain("localhost")
      expect(identity).not.toContain(":")
    })

    it("names a custom server by hostname alone: no scheme, no port", () => {
      ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ =
        "https://liaison.acme.com:8443"
      render(() => <YouScreen />)
      const identity = screen.getByTestId("you-profile-identity").textContent ?? ""
      expect(identity).toContain("Fabrikam")
      expect(identity).toContain("liaison.acme.com")
      expect(identity).not.toContain("8443")
      expect(identity).not.toContain("https://")
    })
  })
})
