// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-A T1: the phone navigator. Before it, Sidebar rendered nothing at phone
// tier and every registry-declared sidebar (mail folders, settings sections)
// was unreachable below 640px.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { closePhoneNavigator, phoneNavigatorOpen } from "~/modules/shell/phone-navigator-store"
import { Sidebar } from "~/modules/shell/Sidebar"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function renderPhoneShell() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <PanelProvider>
            <MainPanel tier="phone" />
            <Sidebar tier="phone" />
          </PanelProvider>
        )}
      />
    </Router>
  ))
}

describe("phone navigator", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closePhoneNavigator()
    registerTabType("nav-probe", {
      component: () => <div>probe body</div>,
      sidebar: () => (
        <div data-testid="probe-sidebar">
          probe sidebar
          {/* Simulates picking the ALREADY-ACTIVE entry: a click that does not
              change tabStore.activeTabId or the route at all, so the
              navigation-effect backstop never fires. */}
          <button type="button" data-testid="probe-sidebar-noop">
            already active
          </button>
        </div>
      ),
      icon: () => null,
      urlPattern: "/nav-probe",
      defaultLabel: "Probe",
      singleton: true,
    })
    registerTabType("nav-bare", {
      component: () => <div>bare body</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/nav-bare",
      defaultLabel: "Bare",
      singleton: true,
    })
  })

  afterEach(() => {
    closePhoneNavigator()
    cleanup()
  })

  it("hides the opener when the active tab type registers no sidebar", () => {
    openTab({ type: "nav-bare", entityId: "bare", label: "Bare" })
    renderPhoneShell()
    expect(screen.queryByTestId("phone-navigator-opener")).toBeNull()
  })

  it("shows the opener when the active tab type registers a sidebar", () => {
    openTab({ type: "nav-probe", entityId: "probe", label: "Probe" })
    renderPhoneShell()
    expect(screen.getByTestId("phone-navigator-opener")).toBeInTheDocument()
  })

  it("opening renders the REGISTERED sidebar inside the overlay sheet", () => {
    openTab({ type: "nav-probe", entityId: "probe", label: "Probe" })
    renderPhoneShell()
    expect(document.querySelector('[data-testid="probe-sidebar"]')).toBeNull()

    fireEvent.click(screen.getByTestId("phone-navigator-opener"))

    const sheet = document.querySelector('[data-overlay-sheet][data-variant="bottom"]')
    expect(sheet).not.toBeNull()
    const rendered = document.querySelector('[data-testid="probe-sidebar"]')
    expect(rendered).not.toBeNull()
    expect(sheet?.contains(rendered as Node)).toBe(true)
    // The sheet's own 44px close control comes from OverlaySheet.
    expect(document.querySelector('[data-testid="overlay-sheet-close"]')).not.toBeNull()
  })

  it("a navigation closes the open navigator", async () => {
    openTab({ type: "nav-probe", entityId: "probe", label: "Probe" })
    renderPhoneShell()
    fireEvent.click(screen.getByTestId("phone-navigator-opener"))
    expect(phoneNavigatorOpen()).toBe(true)

    // What a mail folder row does: re-open the app's singleton under a new
    // entityId. The sheet must not stay over the result.
    openTab({ type: "nav-probe", entityId: "probe-other", label: "Probe" })
    await Promise.resolve()
    expect(phoneNavigatorOpen()).toBe(false)
  })

  it("closes on any activation inside the sheet, even picking the already-active entry", () => {
    openTab({ type: "nav-probe", entityId: "probe", label: "Probe" })
    renderPhoneShell()
    fireEvent.click(screen.getByTestId("phone-navigator-opener"))
    expect(phoneNavigatorOpen()).toBe(true)

    // No navigation happens here at all: same tab type, same entityId, same
    // route. The navigation-effect backstop stays silent; the capture-phase
    // click handler on the sheet body must close it anyway.
    fireEvent.click(screen.getByTestId("probe-sidebar-noop"))
    expect(phoneNavigatorOpen()).toBe(false)
  })

  it("renders no phone navigator control at desktop tier", () => {
    openTab({ type: "nav-probe", entityId: "probe", label: "Probe" })
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <PanelProvider>
              <MainPanel tier="desktop" />
              <Sidebar tier="desktop" />
            </PanelProvider>
          )}
        />
      </Router>
    ))
    expect(screen.queryByTestId("phone-navigator-opener")).toBeNull()
    // Desktop still docks the sidebar inline, not in a sheet.
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar").closest("[data-overlay-sheet]")).toBeNull()
  })
})
