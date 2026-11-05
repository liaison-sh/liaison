// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import {
  _resetBranding,
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
} from "~/modules/shell/branding-store"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { activateTab, closeTab, openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function TestWrapper(props: { children: any }) {
  return <PanelProvider>{props.children}</PanelProvider>
}

describe("MainPanel", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("renders TabBar when tabs exist", () => {
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByRole("tablist")).toBeInTheDocument()
    expect(screen.getByText("Home")).toBeInTheDocument()
  })

  it("renders tab content area", () => {
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByTestId("main-panel")).toBeInTheDocument()
    expect(screen.getByTestId("tab-content-area")).toBeInTheDocument()
  })

  it("provides per-tab active state to keep-alive content", () => {
    registerTabType("probe", {
      component: (props) => (
        <div data-testid={`probe-${props.entityId}`}>
          {props.entityId}:{useTabIsActive()() ? "active" : "inactive"}
        </div>
      ),
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })
    // Permanent tabs — this exercises keep-alive rendering of multiple mounted
    // tabs, independent of the ephemeral-preview (single-slot) behavior. Both
    // tabs are activated at least once (openTab latches its target, and the
    // explicit activateTab below latches "second") so both mount under B2's
    // lazy-first-mount gate — this test is about isActive() truthiness, not
    // the mount gate itself (see the dedicated "lazy first mount" tests below).
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })
    openTab({ type: "probe", entityId: "second", label: "Second", preview: false })
    activateTab("probe:first")
    activateTab("probe:second")

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    expect(screen.getByTestId("probe-first")).toHaveTextContent("first:inactive")
    expect(screen.getByTestId("probe-second")).toHaveTextContent("second:active")
  })

  it("inactive tab container has display:none (J10)", () => {
    registerTabType("probe", {
      component: (props) => <div data-testid={`probe-${props.entityId}`}>{props.entityId}</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })
    // Permanent tabs — this exercises keep-alive rendering of multiple mounted
    // tabs, independent of the ephemeral-preview (single-slot) behavior. Both
    // activated once so both are mounted (see lazy first-mount tests below for
    // the never-activated case).
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })
    openTab({ type: "probe", entityId: "second", label: "Second", preview: false })
    activateTab("probe:first")
    activateTab("probe:second")

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    const firstContainer = screen.getByTestId("probe-first").closest("[data-tab-active]")
    const secondContainer = screen.getByTestId("probe-second").closest("[data-tab-active]")
    expect(firstContainer).toHaveStyle({ display: "none" })
    expect(secondContainer).not.toHaveStyle({ display: "none" })
  })

  // ─── Lazy first-mount for keep-alive tabs (B2) ──────────────────────
  //
  // These tests simulate a REHYDRATED session (tabs restored from
  // localStorage, none of them ever activated in the current runtime) rather
  // than tabs freshly opened via `openTab` — `openTab` always makes its
  // target the active tab, so it always latches it (correctly: it WAS just
  // activated). A page-load rehydrate is the one path where a tab can enter
  // the store already-open but never-activated. `vi.resetModules()` +
  // dynamic re-import forces tab-store to re-run `loadFromStorage()` against
  // a seeded `liaison:tabs` value, mirroring tab-store.test.ts's own pattern.
  it("boot with rehydrated background tabs mounts only the active tab's component", async () => {
    vi.resetModules()
    const storage: Record<string, string> = {
      "liaison:tabs": JSON.stringify({
        tabs: [
          {
            type: "kernel:home",
            entityId: "home",
            label: "Home",
            isPreview: false,
            routePath: "/",
          },
          { type: "probe", entityId: "first", label: "First", isPreview: false },
          { type: "probe", entityId: "second", label: "Second", isPreview: false },
          { type: "probe", entityId: "third", label: "Third", isPreview: false },
        ],
        activeTabId: "probe:third",
      }),
    }
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        storage[key] = val
      }),
      removeItem: vi.fn((key: string) => delete storage[key]),
    })

    const { registerTabType: registerTabTypeFresh, resetRegistry: resetRegistryFresh } =
      await import("~/framework/app-registry")
    const { MainPanel: MainPanelFresh } = await import("~/modules/shell/MainPanel")
    // The fresh MainPanel resolves a fresh router module, and DemoHost reads its
    // location: the Router it renders under must be that same module's.
    const { Route: RouteFresh, Router: RouterFresh } = await import("@solidjs/router")
    const { PanelProvider: PanelProviderFresh } = await import("~/modules/shell/PanelContext")

    resetRegistryFresh()
    registerTabTypeFresh("kernel:home", {
      component: () => <div>Home</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })
    const mountSpy = vi.fn()
    registerTabTypeFresh("probe", {
      component: (props: { entityId: string }) => {
        mountSpy(props.entityId)
        return <div data-testid={`probe-${props.entityId}`}>{props.entityId}</div>
      },
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })

    render(() => (
      <RouterFresh>
        <RouteFresh
          path="/*"
          component={() => (
            <PanelProviderFresh>
              <MainPanelFresh />
            </PanelProviderFresh>
          )}
        />
      </RouterFresh>
    ))

    expect(screen.queryByTestId("probe-first")).not.toBeInTheDocument()
    expect(screen.queryByTestId("probe-second")).not.toBeInTheDocument()
    expect(screen.getByTestId("probe-third")).toBeInTheDocument()
    expect(mountSpy).toHaveBeenCalledExactlyOnceWith("third")
  })

  it("activating a background tab mounts it; switching away keeps it mounted (keep-alive)", async () => {
    vi.resetModules()
    const storage: Record<string, string> = {
      "liaison:tabs": JSON.stringify({
        tabs: [
          {
            type: "kernel:home",
            entityId: "home",
            label: "Home",
            isPreview: false,
            routePath: "/",
          },
          { type: "probe", entityId: "first", label: "First", isPreview: false },
          { type: "probe", entityId: "second", label: "Second", isPreview: false },
        ],
        activeTabId: "probe:first",
      }),
    }
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        storage[key] = val
      }),
      removeItem: vi.fn((key: string) => delete storage[key]),
    })

    const { registerTabType: registerTabTypeFresh, resetRegistry: resetRegistryFresh } =
      await import("~/framework/app-registry")
    const { MainPanel: MainPanelFresh } = await import("~/modules/shell/MainPanel")
    // The fresh MainPanel resolves a fresh router module, and DemoHost reads its
    // location: the Router it renders under must be that same module's.
    const { Route: RouteFresh, Router: RouterFresh } = await import("@solidjs/router")
    const { PanelProvider: PanelProviderFresh } = await import("~/modules/shell/PanelContext")
    const { activateTab: activateTabFresh } = await import("~/modules/shell/tab-store")

    resetRegistryFresh()
    registerTabTypeFresh("kernel:home", {
      component: () => <div>Home</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })
    registerTabTypeFresh("probe", {
      component: (props: { entityId: string }) => (
        <div data-testid={`probe-${props.entityId}`}>{props.entityId}</div>
      ),
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })

    render(() => (
      <RouterFresh>
        <RouteFresh
          path="/*"
          component={() => (
            <PanelProviderFresh>
              <MainPanelFresh />
            </PanelProviderFresh>
          )}
        />
      </RouterFresh>
    ))

    // "second" was never activated in this session — not mounted at boot.
    expect(screen.queryByTestId("probe-second")).not.toBeInTheDocument()

    activateTabFresh("probe:second")
    expect(screen.getByTestId("probe-second")).toBeInTheDocument()

    // Switch back to "first" — "second" stays mounted (keep-alive), just hidden.
    activateTabFresh("probe:first")
    const secondContainer = screen.getByTestId("probe-second").closest("[data-tab-active]")
    expect(secondContainer).toHaveStyle({ display: "none" })
  })

  it("re-opening a tab after close mounts it fresh (latch pruned on close)", () => {
    const mountSpy = vi.fn()
    registerTabType("probe", {
      component: (props) => {
        mountSpy(props.entityId)
        return <div data-testid={`probe-${props.entityId}`}>{props.entityId}</div>
      },
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByTestId("probe-first")).toBeInTheDocument()

    closeTab("probe:first")
    expect(screen.queryByTestId("probe-first")).not.toBeInTheDocument()

    // Re-open — a fresh tab mounts (not a dangling latch from before close).
    openTab({ type: "probe", entityId: "first", label: "First", preview: false })
    expect(screen.getByTestId("probe-first")).toBeInTheDocument()
  })

  it("a tab closed before ever being activated never mounts", async () => {
    vi.resetModules()
    const storage: Record<string, string> = {
      "liaison:tabs": JSON.stringify({
        tabs: [
          {
            type: "kernel:home",
            entityId: "home",
            label: "Home",
            isPreview: false,
            routePath: "/",
          },
          { type: "probe", entityId: "first", label: "First", isPreview: false },
          { type: "probe", entityId: "second", label: "Second", isPreview: false },
        ],
        activeTabId: "probe:second",
      }),
    }
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        storage[key] = val
      }),
      removeItem: vi.fn((key: string) => delete storage[key]),
    })

    const { registerTabType: registerTabTypeFresh, resetRegistry: resetRegistryFresh } =
      await import("~/framework/app-registry")
    const { MainPanel: MainPanelFresh } = await import("~/modules/shell/MainPanel")
    // The fresh MainPanel resolves a fresh router module, and DemoHost reads its
    // location: the Router it renders under must be that same module's.
    const { Route: RouteFresh, Router: RouterFresh } = await import("@solidjs/router")
    const { PanelProvider: PanelProviderFresh } = await import("~/modules/shell/PanelContext")
    const { closeTab: closeTabFresh } = await import("~/modules/shell/tab-store")

    resetRegistryFresh()
    registerTabTypeFresh("kernel:home", {
      component: () => <div>Home</div>,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })
    const mountSpy = vi.fn()
    registerTabTypeFresh("probe", {
      component: (props: { entityId: string }) => {
        mountSpy(props.entityId)
        return <div data-testid={`probe-${props.entityId}`}>{props.entityId}</div>
      },
      sidebar: null,
      icon: () => null,
      urlPattern: "/probe/:entityId",
      defaultLabel: "Probe",
    })

    // "first" was never activated in this session (rehydrated background tab);
    // close it before it ever mounts.
    closeTabFresh("probe:first")

    render(() => (
      <RouterFresh>
        <RouteFresh
          path="/*"
          component={() => (
            <PanelProviderFresh>
              <MainPanelFresh />
            </PanelProviderFresh>
          )}
        />
      </RouterFresh>
    ))

    expect(mountSpy).not.toHaveBeenCalledWith("first")
  })
})

describe("MainPanel - phone tier single pane", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/threads/thread-1")
  })
  afterEach(() => {
    window.history.pushState({}, "", "/")
    cleanup()
  })

  const renderPanel = (tier: "desktop" | "tablet" | "phone") =>
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <MainPanel tier={tier} />
            </TestWrapper>
          )}
        />
      </Router>
    ))

  it("renders a back control instead of the tab strip on a detail route at phone tier", () => {
    renderPanel("phone")
    expect(screen.getByTestId("main-panel-back")).toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("keeps the tab strip and shows no back control at desktop tier", () => {
    renderPanel("desktop")
    expect(screen.queryByTestId("main-panel-back")).not.toBeInTheDocument()
    expect(screen.getByRole("tablist")).toBeInTheDocument()
  })

  it("shows the list pane with no back control at phone tier on a list route", () => {
    window.history.pushState({}, "", "/")
    renderPanel("phone")
    expect(screen.queryByTestId("main-panel-back")).not.toBeInTheDocument()
  })

  it("names the screen in the phone top bar, truncating rather than wrapping", () => {
    // The walk: a 93pt band with one chevron in it and nothing that said
    // which screen, which workspace or which server this was.
    renderPanel("phone")
    const title = screen.getByTestId("phone-top-bar-title")
    expect(title.textContent?.trim().length).toBeGreaterThan(0)
    expect(title.getAttribute("class")).toContain("truncate")
  })

  it("carries the workspace name from branding once it has been read", async () => {
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Fabrikam" } }),
    })) as never)
    renderPanel("phone")
    expect(screen.getByTestId("phone-top-bar-org").textContent).toBe("Fabrikam")
    _resetBranding()
  })

  // The bar printed "Default Organization" on a box carrying more than one org:
  // that is the PUBLIC branding name, which resolves by Host slug and otherwise
  // answers with the oldest org present. The signed-in org wins here.
  it("prints the SIGNED IN org, not the deployment's public name", async () => {
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Default Organization" } }),
    })) as never)
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant Audio Labs" } }))
    renderPanel("phone")
    expect(screen.getByTestId("phone-top-bar-org").textContent).toBe("Resonant Audio Labs")
    _resetBranding()
  })

  it("carries no title bar at desktop tier, where the tab strip names the screen", () => {
    renderPanel("desktop")
    expect(screen.queryByTestId("phone-top-bar-title")).not.toBeInTheDocument()
  })
})
