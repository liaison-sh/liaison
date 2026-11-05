// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { isTabLoading, resetTabLoading, TabSuspenseFallback } from "~/modules/shell/tab-loading"
import { activateTab, openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function renderPanel() {
  return render(() => (
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

/** Tab component that suspends until the promise stashed per entityId resolves. */
function registerSuspendingType(resolvers: Map<string, (v: string) => void>) {
  registerTabType("probe", {
    component: (props) => {
      const [data] = createResource(
        () =>
          new Promise<string>((resolve) => {
            resolvers.set(props.entityId, resolve)
          }),
      )
      return <div data-testid={`content-${props.entityId}`}>{data()}</div>
    },
    sidebar: null,
    icon: () => null,
    urlPattern: "/probe/:entityId",
    defaultLabel: "Probe",
  })
}

describe("tab loading bar", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetTabLoading()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("shows while the active tab's content is suspended, hides once it resolves", async () => {
    const resolvers = new Map<string, (v: string) => void>()
    registerSuspendingType(resolvers)
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })

    renderPanel()

    const bar = screen.getByTestId("tab-loading-bar")
    expect(bar).toHaveAttribute("data-loading", "true")

    resolvers.get("first")?.("loaded")
    await waitFor(() => expect(bar).toHaveAttribute("data-loading", "false"))
    expect(screen.getByTestId("content-first")).toHaveTextContent("loaded")
  })

  it("ignores loading in inactive (keep-alive) background tabs", async () => {
    const resolvers = new Map<string, (v: string) => void>()
    registerSuspendingType(resolvers)
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })
    openTab({ type: "probe", entityId: "second", label: "Second", preview: false })
    activateTab("probe:second")

    renderPanel()

    const bar = screen.getByTestId("tab-loading-bar")
    // Both tabs are pending; the bar reflects the ACTIVE one (second).
    expect(bar).toHaveAttribute("data-loading", "true")

    // Resolving only the active tab hides the bar even though "first" (a
    // hidden background tab) is still loading.
    resolvers.get("second")?.("done")
    await waitFor(() => expect(bar).toHaveAttribute("data-loading", "false"))

    // Switching back to the still-pending tab shows it again.
    activateTab("probe:first")
    await waitFor(() => expect(bar).toHaveAttribute("data-loading", "true"))
  })
})

// P4c-T47: `rehydrateTabs` re-keys an open tab (FX-F4), so the fallback's
// `tabId` prop can change while the tab is still suspended. The old code read
// the prop once in the component body and once again at cleanup, which flagged
// the id it was given first and cleared whichever id it held last: after a
// re-key the ORIGINAL id stayed in the loading set forever.
describe("TabSuspenseFallback follows a tab re-key", () => {
  beforeEach(() => {
    resetTabLoading()
  })
  afterEach(() => {
    cleanup()
    resetTabLoading()
  })

  it("leaves no stale id behind when the tab is re-keyed while suspended", () => {
    const [tabId, setTabId] = createSignal("probe:old")
    render(() => <TabSuspenseFallback tabId={tabId()} />)

    expect(isTabLoading("probe:old")).toBe(true)
    expect(isTabLoading("probe:new")).toBe(false)

    setTabId("probe:new")

    expect(isTabLoading("probe:new")).toBe(true)
    expect(isTabLoading("probe:old")).toBe(false)
  })

  it("clears the id it currently holds when it unmounts after a re-key", () => {
    const [tabId, setTabId] = createSignal("probe:old")
    render(() => <TabSuspenseFallback tabId={tabId()} />)
    setTabId("probe:new")

    cleanup()

    expect(isTabLoading("probe:old")).toBe(false)
    expect(isTabLoading("probe:new")).toBe(false)
  })
})
