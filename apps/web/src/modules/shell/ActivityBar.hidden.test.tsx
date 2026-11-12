// SPDX-License-Identifier: FSL-1.1-ALv2
// The rail leaves out the apps the person hid from their sidebar (0293), and
// an app's right-click menu (or the ContextMenu key) hides it. Hiding never
// touches access: the entry is still registered, only the rail skips it.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getActivityBarEntries, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import {
  applyRemoteSidebarVisibility,
  hiddenSidebarApps,
  hydrateSidebarVisibility,
  resetSidebarVisibility,
} from "~/modules/shell/sidebar-visibility"
import { WsProvider } from "~/modules/shell/WsContext"

const [wsStatus] = createSignal<"connected" | "disconnected">("connected")

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

function renderBar() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <WsProvider send={vi.fn()} status={wsStatus}>
            <ActivityBar />
          </WsProvider>
        )}
      />
    </Router>
  ))
}

const railEntry = (id: string) => document.querySelector<HTMLElement>(`[data-rail-entry="${id}"]`)

describe("ActivityBar hidden apps", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    cleanup()
    resetSidebarVisibility()
    vi.restoreAllMocks()
  })

  it("leaves a hidden app out of the rail, still registered, and brings it back when shown", () => {
    renderBar()
    expect(railEntry("dashboards")).not.toBeNull()
    applyRemoteSidebarVisibility({ hiddenSidebarApps: ["dashboards"] })
    expect(railEntry("dashboards")).toBeNull()
    expect(getActivityBarEntries().some((e) => e.id === "dashboards")).toBe(true)
    // Settings (a bottom entry) is never filtered.
    expect(screen.getByLabelText("Settings")).toBeInTheDocument()
    applyRemoteSidebarVisibility({ hiddenSidebarApps: [] })
    expect(railEntry("dashboards")).not.toBeNull()
  })

  it("hides an app from its right-click menu and saves the list", async () => {
    const getMock = vi.fn(async (_p: string): Promise<unknown> => ({ hiddenSidebarApps: [] }))
    const api = {
      get: getMock as <T>(path: string) => Promise<T>,
      put: vi.fn(async (_p: string, _b: unknown): Promise<unknown> => ({})),
    }
    await hydrateSidebarVisibility(api)
    renderBar()
    const entry = railEntry("dashboards")
    expect(entry).not.toBeNull()
    fireEvent.contextMenu(entry as HTMLElement)
    const hide = await screen.findByTestId("activity-entry-hide")
    expect(hide).toHaveTextContent("Hide from sidebar")
    hide.focus()
    fireEvent.keyDown(hide, { key: "Enter" })
    await waitFor(() => expect(railEntry("dashboards")).toBeNull())
    expect(hiddenSidebarApps()).toEqual(["dashboards"])
    expect(api.put).toHaveBeenCalledWith("/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["dashboards"],
    })
  })

  it("opens the same menu from the keyboard (Shift+F10)", async () => {
    renderBar()
    const entry = railEntry("sessions") as HTMLElement
    fireEvent.keyDown(entry, { key: "F10", shiftKey: true })
    expect(await screen.findByTestId("activity-entry-menu")).toBeInTheDocument()
  })
})
