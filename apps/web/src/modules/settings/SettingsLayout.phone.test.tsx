// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings tab at phone width (M2-3 T18): a push stack rooted on the You
// screen, and an admin section that warns instead of blanking.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ),
)

import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { resetPhoneSettingsNav } from "~/modules/settings/phone-settings-nav"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"

function signIn(scopes: string[]): void {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Alex Rivera",
      roles: ["Admin"],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  setTokens(`${header}.${body}.fake`, "refresh")
}

async function renderSettings(path: string) {
  window.history.pushState({}, "", path)
  const SettingsLayout = (await import("~/modules/settings/SettingsLayout")).default
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <SettingsLayout entityId="settings" />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("SettingsLayout at phone width", () => {
  beforeEach(() => {
    clearAuth()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetPhoneSettingsNav()
    signIn(["*"])
  })

  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("roots the settings tab on the You screen, not on the profile form", async () => {
    setShellTier("phone")
    await renderSettings("/settings")
    expect(await screen.findByTestId("you-screen")).toBeInTheDocument()
    expect(screen.queryByTestId("settings-content")).toBeNull()
  })

  it("keeps the desktop layout on the section content", async () => {
    setShellTier("desktop")
    await renderSettings("/settings")
    expect(await screen.findByTestId("settings-content")).toBeInTheDocument()
    expect(screen.queryByTestId("you-screen")).toBeNull()
  })

  it("pushes a section from a You row and comes back with the back control", async () => {
    setShellTier("phone")
    await renderSettings("/settings")
    fireEvent.click(await screen.findByTestId("you-row-you-security"))
    await waitFor(() => expect(screen.getByTestId("settings-content")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("settings-phone-back"))
    await waitFor(() => expect(screen.getByTestId("you-screen")).toBeInTheDocument())
  })

  it("warns above an admin table at phone width, and lets the viewer continue", async () => {
    setShellTier("phone")
    await renderSettings("/settings/admin/users")
    const notice = await screen.findByTestId("settings-admin-notice")
    expect(notice).toHaveTextContent("Best on a larger screen")
    // The table itself is never hidden behind the notice.
    expect(screen.getByTestId("settings-content")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("settings-admin-continue"))
    await waitFor(() => expect(screen.queryByTestId("settings-admin-notice")).toBeNull())
  })

  it("warns above an AI section at phone width, like an admin one", async () => {
    setShellTier("phone")
    await renderSettings("/settings/ai/agent-behavior")
    expect(await screen.findByTestId("settings-admin-notice")).toBeInTheDocument()
    expect(screen.getByTestId("settings-content")).toBeInTheDocument()
  })

  it("never shows the notice on a non-admin section", async () => {
    setShellTier("phone")
    await renderSettings("/settings/security")
    await screen.findByTestId("settings-content")
    expect(screen.queryByTestId("settings-admin-notice")).toBeNull()
  })

  it("never shows the notice at desktop width", async () => {
    setShellTier("desktop")
    await renderSettings("/settings/admin/users")
    await screen.findByTestId("settings-content")
    expect(screen.queryByTestId("settings-admin-notice")).toBeNull()
    expect(screen.queryByTestId("settings-phone-back")).toBeNull()
  })
})

// S12/A22: the phone You screen lists exactly the desktop column's rows.
describe("phone parity with the desktop column", () => {
  beforeEach(() => {
    clearAuth()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetPhoneSettingsNav()
    registerAppFromManifest(
      {
        name: "tickets",
        kind: "app",
        settings: {
          sections: [{ id: "signature", title: "Signature", scope: "user", blocks: [] }],
        },
        views: { activityBar: { icon: "Icon", label: "Tickets", order: 11 } },
      } as unknown as Parameters<typeof registerAppFromManifest>[0],
      new Proxy({}, { get: () => () => null, has: () => true }) as Record<string, unknown>,
    )
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it.each([
    ["an admin", ["*"]],
    ["a member", [] as string[]],
  ])("for %s, the You rows are the sidebar rows", async (_who, scopes) => {
    signIn(scopes)
    setShellTier("desktop")
    const sidebar = render(() => (
      <Router>
        <Route path="/*" component={() => <SettingsSidebar />} />
      </Router>
    ))
    const desktop = [...document.querySelectorAll("[data-testid^='settings-link-']")].map(
      (a) => a.textContent,
    )
    sidebar.unmount()

    setShellTier("phone")
    await renderSettings("/settings")
    await screen.findByTestId("you-screen")
    const phone = [...document.querySelectorAll("[data-testid^='you-row-']")]
      .filter((el) => el.getAttribute("data-testid") !== "you-row-agent-app")
      .map((el) => el.textContent?.trim())
    expect(desktop.length).toBeGreaterThan(4)
    expect(phone).toEqual(desktop)
  })
})
