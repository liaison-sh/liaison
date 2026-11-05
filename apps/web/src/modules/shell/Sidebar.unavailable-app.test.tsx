// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / S20: an app Off or restricted away has no navigation left. Its direct route shows
// the unavailable notice (MainPanel), and its own sidebar (sections, "+ New ..."
// actions) is not rendered beside it, on any tier.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { setUnavailableApps } from "~/framework/unavailable-apps"
import { activeSidebarComponent } from "~/modules/shell/phone-navigator-store"
import { Sidebar } from "~/modules/shell/Sidebar"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function renderSidebar() {
  render(() => (
    <Router>
      <Route path="/*" component={() => <Sidebar tier="desktop" />} />
    </Router>
  ))
}

describe("Sidebar: unavailable app", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    registerTabType("invoicing:home", {
      component: () => <div>Invoices</div>,
      sidebar: () => <button type="button">+ New quote</button>,
      icon: () => null,
      urlPattern: "/invoicing",
      defaultLabel: "Invoicing",
      appId: "invoicing",
    })
    openTab({ type: "invoicing:home", entityId: "home", label: "Invoicing", preview: false })
  })
  afterEach(() => {
    setUnavailableApps([])
    cleanup()
  })

  it("discriminator: a visible app's sidebar renders", () => {
    renderSidebar()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.getByText("+ New quote")).toBeInTheDocument()
  })

  it("an unavailable app's sidebar is not rendered (no sections, no create action)", () => {
    setUnavailableApps(["invoicing"])
    renderSidebar()
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument()
    expect(screen.queryByText("+ New quote")).not.toBeInTheDocument()
  })

  it("the phone navigator has no sidebar for an unavailable app either", () => {
    setUnavailableApps(["invoicing"])
    expect(activeSidebarComponent()).toBeNull()
  })
})
