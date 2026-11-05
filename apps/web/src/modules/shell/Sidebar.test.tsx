// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import {
  activeSidebarComponent,
  closePhoneNavigator,
  openPhoneNavigator,
} from "~/modules/shell/phone-navigator-store"
import { Sidebar } from "~/modules/shell/Sidebar"
import { ACTIVITY_RAIL_WIDTH } from "~/modules/shell/shell-tier"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import {
  closeTabletSidebar,
  tabletSidebarOpen,
  toggleTabletSidebar,
} from "~/modules/shell/tablet-sidebar-store"
import { WsProvider } from "~/modules/shell/WsContext"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

describe("Sidebar — registry-driven", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })

  afterEach(() => cleanup())

  it("renders the sidebar element for tab types that declare one", () => {
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
  })

  // A framed app's sidebar is an iframe as tall as its content: the column must scroll it,
  // since the aside clips. An in-page sidebar fills the same box and scrolls its own list.
  it("puts the sidebar in a column that scrolls when its content outgrows it", () => {
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))
    const scroll = screen.getByTestId("sidebar-scroll")
    expect(scroll.parentElement).toBe(screen.getByTestId("sidebar"))
    expect(scroll.className).toContain("overflow-y-auto")
    expect(scroll.className).toContain("min-h-0")
    expect(scroll.className).toContain("flex-1")
  })

  it("renders the registered settings sidebar for settings tabs", async () => {
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))

    expect(await screen.findByText("Settings")).toBeInTheDocument()
  })

  it("does not render the aside when the active tab type has no sidebar", () => {
    openTab({ type: "unknown-app" as any, entityId: "x", label: "Unknown" })
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument()
  })
})

describe("Sidebar - layout tiers", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closeTabletSidebar()
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
  })

  afterEach(() => {
    closeTabletSidebar()
    cleanup()
  })

  it("renders border-r not border-b at any tier", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))
    const sidebar = screen.getByTestId("sidebar")
    // Token match: "border-border" contains the substring "border-b".
    expect(sidebar.classList.contains("border-r")).toBe(true)
    expect(sidebar.classList.contains("border-b")).toBe(false)
  })

  it("renders nothing inline at phone tier until the navigator is opened", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="phone" />} />
      </Router>
    ))
    // No inline column: the phone shell is one pane wide.
    expect(document.querySelector('[data-testid="sidebar"]')).toBeNull()
    openPhoneNavigator()
    const sidebar = screen.getByTestId("sidebar")
    expect(sidebar.closest('[data-overlay-sheet][data-variant="bottom"]')).not.toBeNull()
    closePhoneNavigator()
  })

  it("renders no rail width class at desktop tier", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="desktop" />} />
      </Router>
    ))
    expect(screen.getByTestId("sidebar").className).not.toContain("w-12")
  })

  it("renders nothing at tablet tier until the drawer is opened", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="tablet" />} />
      </Router>
    ))
    // A 48px strip cannot hold a sidebar: every app sidebar needs ~90px for its
    // own rows, so a rail that renders one only overflows it. At tablet the
    // sidebar IS the drawer, reached from the activity bar toggle.
    expect(document.querySelector('[data-testid="sidebar"]')).toBeNull()
    toggleTabletSidebar()
    expect(screen.getByTestId("sidebar").className).not.toContain("w-12")
    expect(screen.getByTestId("sidebar").closest("[data-overlay-sheet]")).not.toBeNull()
  })

  it("the open tablet drawer renders inside a focus trapped overlay region", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="tablet" />} />
      </Router>
    ))
    toggleTabletSidebar()
    const sheet = document.querySelector("[data-overlay-sheet]")
    expect(sheet).not.toBeNull()
    expect(sheet?.contains(screen.getByTestId("sidebar"))).toBe(true)
    // The drawer carries no title, so it renders no header band and no lone X
    // with it: the rail entry that opened it, the scrim and Escape are its
    // ways out, and an empty 61 px band at the top is only noise.
    expect(document.querySelector('[data-testid="overlay-sheet-close"]')).toBeNull()
  })

  it("the closed tablet tier renders neither a rail nor an overlay region", () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="tablet" />} />
      </Router>
    ))
    expect(document.querySelector("[data-overlay-sheet]")).toBeNull()
    expect(document.querySelector('[data-testid="sidebar"]')).toBeNull()
  })

  it("Escape closes the open tablet drawer", async () => {
    render(() => (
      <Router>
        <Route path="/*" component={() => <Sidebar tier="tablet" />} />
      </Router>
    ))
    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(true)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await Promise.resolve()
    expect(tabletSidebarOpen()).toBe(false)
  })
})

describe("Sidebar - the tablet drawer closes, it is not unmounted (FX3)", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closeTabletSidebar()
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
  })

  afterEach(() => {
    closeTabletSidebar()
    cleanup()
  })

  const renderTablet = () =>
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={vi.fn()} status={() => "connected" as const}>
              <ActivityBar tier="tablet" />
              <Sidebar tier="tablet" />
            </WsProvider>
          )}
        />
      </Router>
    ))

  it("returns focus to the activity bar toggle when the drawer closes", async () => {
    // A dialog that is UNMOUNTED on close never runs its focus restore: the
    // tablet user is dropped on document.body and the next Tab starts from the
    // top of the page, with no way back to the control they opened.
    renderTablet()
    const toggle = screen.getByTestId("activity-sidebar-toggle") as HTMLElement
    toggle.focus()
    fireEvent.click(toggle)
    expect(tabletSidebarOpen()).toBe(true)
    // Stand in for the focus trap: while the sheet is open the focus is
    // inside it, so closing has somewhere to restore FROM. The untitled
    // drawer has no close control of its own, so the focus goes to the sheet
    // panel and the RAIL closes it, which is the gesture a tablet user
    // actually makes.
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(panel).not.toBeNull()
    panel.focus()
    expect(document.activeElement).toBe(panel)
    fireEvent.click(toggle)
    await new Promise((r) => setTimeout(r, 50))
    expect(tabletSidebarOpen()).toBe(false)
    expect(document.activeElement).toBe(toggle)
  })
})

describe("Sidebar - the tablet drawer opens BESIDE the rail, not over it", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closeTabletSidebar()
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
  })

  afterEach(() => {
    closeTabletSidebar()
    cleanup()
  })

  const renderTablet = () =>
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={vi.fn()} status={() => "connected" as const}>
              <ActivityBar tier="tablet" />
              <Sidebar tier="tablet" />
            </WsProvider>
          )}
        />
      </Router>
    ))

  const openDrawer = () => {
    fireEvent.click(screen.getByTestId("activity-sidebar-toggle"))
    expect(tabletSidebarOpen()).toBe(true)
  }

  it("offsets the drawer and its scrim by exactly the activity rail width", () => {
    renderTablet()
    openDrawer()
    // The drawer starts where the rail ends. Both read the SAME constant the
    // shell grid lays the rail's track out with, so they cannot drift.
    const drawer = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(document.querySelector("[data-overlay-sheet]")?.getAttribute("data-variant")).toBe(
      "side",
    )
    expect(drawer.style.marginLeft).toBe(ACTIVITY_RAIL_WIDTH)
    expect(screen.getByTestId("overlay-sheet-scrim").style.left).toBe(ACTIVITY_RAIL_WIDTH)
    expect(ACTIVITY_RAIL_WIDTH).toBe("48px")
  })

  it("keeps the rail visible and clickable while the drawer is open", async () => {
    renderTablet()
    openDrawer()
    await new Promise((r) => setTimeout(r, 30))
    const rail = screen.getByTestId("activity-bar")
    expect(rail.isConnected).toBe(true)
    // A modal drawer would hide the rail from assistive tech and switch the
    // page's pointer events off underneath it.
    expect(rail.closest("[aria-hidden='true']")).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe("none")
    const home = screen.getByLabelText("Home")
    home.focus()
    expect(document.activeElement).toBe(home)
  })

  it("the drawer's container does not cover the rail: the band over it is inert", () => {
    renderTablet()
    openDrawer()
    // The sheet's positioning container is `fixed inset-0`, so it spans the
    // rail's 0 to 48 px band as well as the drawer. jsdom lays nothing out,
    // so `document.elementFromPoint(24, 226)` cannot be used to prove the tap
    // reaches the rail entry; the classes below are what decides it in a
    // browser. A live container there swallows every rail tap and, because it
    // has no `[data-activity-rail]` ancestor, `keepOpenOutside` reads the tap
    // as "outside" and closes the drawer instead of swapping it.
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    const positioner = panel.parentElement as HTMLElement
    expect(positioner.className).toContain("pointer-events-none")
    expect(panel.className).toContain("pointer-events-auto")
    expect(screen.getByTestId("overlay-sheet-scrim").className).toContain("pointer-events-auto")
    // And the rail itself is outside the drawer's subtree, so nothing the
    // sheet does to its own children can reach it.
    expect(panel.contains(screen.getByTestId("activity-bar"))).toBe(false)
  })

  it("tapping ANOTHER rail entry swaps the drawer content without closing it", async () => {
    renderTablet()
    openDrawer()
    const settingsSidebar = activeSidebarComponent()
    expect(settingsSidebar).not.toBeNull()

    // The tap has to be able to LAND: a modal drawer switches the page's
    // pointer events off, so there is no swap to make in the first place.
    await new Promise((r) => setTimeout(r, 30))
    expect(document.body.style.pointerEvents).not.toBe("none")
    fireEvent.click(screen.getByLabelText("Home"))

    expect(tabletSidebarOpen()).toBe(true)
    expect(document.querySelector("[data-overlay-sheet]")).not.toBeNull()
    expect(activeSidebarComponent()).not.toBe(settingsSidebar)
  })

  it("tapping the scrim over the content area closes the drawer", async () => {
    renderTablet()
    openDrawer()
    await new Promise((r) => setTimeout(r, 30))
    const scrim = screen.getByTestId("overlay-sheet-scrim")
    fireEvent.pointerDown(scrim)
    fireEvent.mouseDown(scrim)
    await new Promise((r) => setTimeout(r, 30))
    expect(tabletSidebarOpen()).toBe(false)
  })

  it("tapping the ACTIVE rail entry closes the drawer", () => {
    renderTablet()
    fireEvent.click(screen.getByLabelText("Home"))
    openDrawer()

    fireEvent.click(screen.getByLabelText("Home"))

    expect(tabletSidebarOpen()).toBe(false)
    expect(document.querySelector("[data-overlay-sheet]")).toBeNull()
  })

  it("the rail entry the drawer is already showing re-opens it once closed", () => {
    renderTablet()
    fireEvent.click(screen.getByLabelText("Home"))
    expect(tabletSidebarOpen()).toBe(false)

    fireEvent.click(screen.getByLabelText("Home"))
    expect(tabletSidebarOpen()).toBe(true)
  })
})
