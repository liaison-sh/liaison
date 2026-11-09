// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The test-only trail of what rebuilds a tab's content: a forced re-key of the
// keyed Show (the registry handing back another component) is recorded with the
// tab, the cause and the changed source; and with no trail installed nothing is.

import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { formatTabTrail } from "~/modules/shell/tab-teardown-trail"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function PageOne() {
  return <div data-testid="page-one" />
}
function PageTwo() {
  return <div data-testid="page-two" />
}

function reg(component: () => import("solid-js").JSX.Element) {
  return {
    component,
    sidebar: null,
    icon: () => null,
    urlPattern: "/trail-under-test",
    defaultLabel: "Trail",
    appId: "kernel",
  }
}

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

describe("MainPanel tab teardown trail", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    registerTabType("kernel:trail-under-test", reg(PageOne))
  })
  afterEach(() => {
    cleanup()
    delete window.__LIAISON_TAB_TRAIL__
  })

  it("records a forced re-key with its tab, cause and source", async () => {
    window.__LIAISON_TAB_TRAIL__ = []
    openTab({
      type: "kernel:trail-under-test",
      entityId: "e1",
      label: "Trail",
      preview: false,
    })
    renderPanel()
    await screen.findByTestId("page-one")
    const before = window.__LIAISON_TAB_TRAIL__.length

    registerTabType("kernel:trail-under-test", reg(PageTwo))
    await screen.findByTestId("page-two")

    const trail = window.__LIAISON_TAB_TRAIL__.slice(before)
    const text = formatTabTrail(trail)
    const id = tabStore.activeTabId
    expect(trail.some((e) => e.cause === "keyed-show" && e.event === "source-changed")).toBe(true)
    expect(text).toContain("PageOne -> PageTwo")
    expect(trail.some((e) => e.cause === "keyed-show" && e.event === "disposed")).toBe(true)
    expect(
      trail.some(
        (e) => e.cause === "keyed-show" && e.event === "created" && e.detail === "PageTwo",
      ),
    ).toBe(true)
    expect(trail.every((e) => e.tab === id && /^\d\d:\d\d:\d\d\.\d{3}$/.test(e.at))).toBe(true)
    // The For item and the gate were not rebuilt by a registry change.
    expect(trail.some((e) => e.cause === "for-item" || e.cause === "active-gate")).toBe(false)
  })

  it("records nothing when no test installed the trail", async () => {
    openTab({ type: "kernel:trail-under-test", entityId: "e1", label: "Trail", preview: false })
    renderPanel()
    await screen.findByTestId("page-one")
    registerTabType("kernel:trail-under-test", reg(PageTwo))
    await screen.findByTestId("page-two")
    expect(window.__LIAISON_TAB_TRAIL__).toBeUndefined()
  })
})
