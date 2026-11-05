// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / S20: a direct route into an app Off or restricted away renders the unavailable
// notice instead of the app's page.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerTabType,
  resetRegistry,
  setManifestAppsSettled,
  unregisterTabType,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { setUnavailableApps } from "~/framework/unavailable-apps"
import { ApiError } from "~/lib/api-error"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function renderPanel() {
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <PanelProvider>
            <MainPanel />
          </PanelProvider>
        )}
      />
    </Router>
  ))
}

describe("MainPanel: unavailable app route", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    registerTabType("invoicing:home", {
      component: () => <div data-testid="invoicing-page">Invoices</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/invoicing",
      defaultLabel: "Invoicing",
      appId: "invoicing",
    })
  })
  afterEach(() => {
    setUnavailableApps([])
    setManifestAppsSettled(false)
    cleanup()
  })

  // MGT-11 after a reload: the tab was persisted, but the restricted (or Off, or
  // removed) app is absent from the manifests, so its tab type is never registered.
  // The restored tab says why, never "Unknown tab type".
  describe("a restored tab whose app is absent from the manifests", () => {
    beforeEach(() => {
      unregisterTabType("invoicing:home")
    })

    it("restricted or Off: shows the no-access notice, not Unknown tab type", () => {
      setUnavailableApps(["invoicing"])
      setManifestAppsSettled(true)
      openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
      renderPanel()
      expect(screen.getByTestId("app-unavailable-notice")).toHaveTextContent(
        "You no longer have access to this app",
      )
      expect(screen.queryByText(/Unknown tab type/)).not.toBeInTheDocument()
    })

    it("removed (not listed at all) once the manifests settled: the same notice", () => {
      setManifestAppsSettled(true)
      openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
      renderPanel()
      expect(screen.getByTestId("app-unavailable-notice")).toBeInTheDocument()
      expect(screen.queryByText(/Unknown tab type/)).not.toBeInTheDocument()
    })

    it("discriminator: before the manifests settle, neither notice nor error shows yet", () => {
      openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
      renderPanel()
      expect(screen.queryByTestId("app-unavailable-notice")).not.toBeInTheDocument()
      expect(screen.queryByText(/Unknown tab type/)).not.toBeInTheDocument()
    })
  })

  it("discriminator: a visible app's route renders its page", () => {
    openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
    renderPanel()
    expect(screen.getByTestId("invoicing-page")).toBeInTheDocument()
    expect(screen.queryByTestId("app-unavailable-notice")).not.toBeInTheDocument()
  })

  it("an app page keeps the band the floating dock covers clear, so its footer stays reachable", () => {
    openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
    renderPanel()
    expect(screen.getByTestId("app-tab-scroll").style.paddingBottom).toBe(
      "var(--shell-dock-clearance, 0px)",
    )
  })

  it("an unavailable app's route renders the no-access notice and not the page", () => {
    setUnavailableApps(["invoicing"])
    openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
    renderPanel()
    expect(screen.getByTestId("app-unavailable-notice")).toHaveTextContent(
      "You no longer have access to this app",
    )
    expect(screen.queryByTestId("invoicing-page")).not.toBeInTheDocument()
  })

  // MGT-11: the page was open when an admin restricted the app (403
  // app_restricted) or turned it off (410 app_disabled): its next request
  // fails before the shell's resync lands. The tab says so calmly, not the
  // generic "Something went wrong" with the raw error.
  for (const [status, code] of [
    [403, "app_restricted"],
    [410, "app_disabled"],
  ] as const) {
    it(`a page whose request is refused with ${status} ${code} shows the no-access notice`, () => {
      registerTabType("invoicing:list", {
        component: () => {
          throw new ApiError("This app is restricted by your admin.", status, code)
        },
        sidebar: null,
        icon: () => null,
        urlPattern: "/invoicing/list",
        defaultLabel: "Invoices",
        appId: "invoicing",
      })
      openTab({ type: "invoicing:list", entityId: "list", label: "Invoices", preview: false })
      renderPanel()
      expect(screen.getByTestId("app-unavailable-notice")).toHaveTextContent(
        "You no longer have access to this app",
      )
      expect(screen.queryByText(/ApiError/)).not.toBeInTheDocument()
    })
  }

  it("discriminator: another refusal keeps the tab's error screen", () => {
    registerTabType("invoicing:list", {
      component: () => {
        throw new ApiError("Nope", 403, "forbidden")
      },
      sidebar: null,
      icon: () => null,
      urlPattern: "/invoicing/list",
      defaultLabel: "Invoices",
      appId: "invoicing",
    })
    openTab({ type: "invoicing:list", entityId: "list", label: "Invoices", preview: false })
    renderPanel()
    expect(screen.queryByTestId("app-unavailable-notice")).not.toBeInTheDocument()
  })
})
