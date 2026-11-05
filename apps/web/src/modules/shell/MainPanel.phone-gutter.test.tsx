// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone top bar's right gutter. The org name sat in a bar padded by 4px,
// so on a device the workspace name touched the right edge of the screen.
// The bar carries the same 16px gutter as the rest of the phone chrome.
//
// jsdom has no Tailwind, so the utilities the bar uses are declared here in
// the same order Tailwind emits them and the assertion reads the COMPUTED
// padding in pixels: what the class means, not which class was written.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({ userId: "me", name: "Tester" }),
  }
})

vi.mock("~/modules/shell/branding-store", () => ({
  orgName: () => "Fabrikam",
  ensureBrandingLoaded: async () => {},
  demoMode: () => false,
  demoOrgSurfaces: () => false,
}))

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

/** The spacing utilities the bar can carry, in Tailwind's own emit order. */
const SPACING_CSS = `
.p-1{padding:4px}
.px-1{padding-left:4px;padding-right:4px}
.py-1{padding-top:4px;padding-bottom:4px}
.pl-1{padding-left:4px}
.pr-1{padding-right:4px}
.pr-1\\.5{padding-right:6px}
.pr-4{padding-right:16px}
`

let styleEl: HTMLStyleElement | undefined

function renderPanel() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <PanelProvider>
              <MainPanel tier="phone" />
            </PanelProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("the phone top bar's gutter", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    styleEl = document.createElement("style")
    styleEl.textContent = SPACING_CSS
    document.head.appendChild(styleEl)
  })
  afterEach(() => {
    styleEl?.remove()
    cleanup()
  })

  it("keeps the org name a 16px gutter off the right screen edge", async () => {
    registerTabType("tickets:inbox", {
      component: () => <div data-testid="tickets-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets",
      defaultLabel: "Tickets",
    })
    openTab({ type: "tickets:inbox", entityId: "inbox", label: "Tickets", preview: false })
    renderPanel()

    const org = await waitFor(() => screen.getByTestId("phone-top-bar-org"))
    expect(org.textContent).toBe("Fabrikam")
    // The bar itself is the only box between that name and the screen edge.
    const bar = org.parentElement as HTMLElement
    expect(bar).toBeTruthy()
    expect(getComputedStyle(bar).paddingRight).toBe("16px")
    // The name must not be pushed away from the bar's own left edge: the
    // title owns that room.
    expect(getComputedStyle(bar).paddingLeft).toBe("4px")
  })
})
