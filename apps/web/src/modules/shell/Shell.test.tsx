// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Must be hoisted before module evaluation to prevent auth-store from failing
vi.hoisted(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  } as any
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as any

  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

import { registerPanel, registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { openConversation, resetDockStore, toggleChats } from "~/modules/shell/dock-store"
import {
  clearActivePanel,
  panelOpen,
  resetPanelStore,
  setActivePanel,
  togglePanel,
} from "~/modules/shell/panel-store"
import { Shell } from "~/modules/shell/Shell"
import { syncShellTier } from "~/modules/shell/shell-tier"
import { activateTab, closeTab, makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import { tabletSidebarOpen, toggleTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"

// Counts grid tracks in a template string: function arguments (clamp, minmax)
// carry their own spaces, so they are stripped before splitting.
const trackCount = (template: string) =>
  template
    .replace(/\([^)]*\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length

// Splits a grid template into its tracks, keeping each function argument list
// (clamp, minmax) with the track it belongs to.
const gridTracks = (template: string): string[] => {
  const tracks: string[] = []
  let depth = 0
  let current = ""
  for (const char of template) {
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (char === " " && depth === 0) {
      if (current) tracks.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) tracks.push(current)
  return tracks
}

// A tab type with no sidebar: it collapses the sidebar track to 0px, which
// keeps the desktop template free of clamp() (jsdom's CSS parser drops any
// declaration containing it) and gives the dock a non-Home surface to sit on.
function registerSidebarlessTabType() {
  registerTabType("tickets:ticket", {
    component: () => <div data-testid="ticket-body" />,
    sidebar: null,
    icon: () => null,
    urlPattern: "/tickets/:entityId",
    defaultLabel: "Ticket",
    localType: "tickets:ticket",
  })
}

// The one panel variant the side column still hosts: a plugin's app panel.
const APP_PANEL = { type: "app-panel", appName: "tickets", panelType: "filters" } as const

function registerAppPanel() {
  registerPanel("tickets:filters", {
    component: () => <div data-testid="app-panel-body" />,
    label: "Filters",
    appId: "tickets",
    localType: "filters",
  })
}

type ShellTierName = "desktop" | "tablet" | "phone"

// Query-aware matchMedia mock: each of the shell's three tier queries reports
// `matches` only for the tier being simulated, so the shell resolves exactly
// one tier the way a real browser would.
function mockShellTierMediaQuery(initialTier: ShellTierName = "desktop") {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQueries: Array<MediaQueryList & { matches: boolean; media: string }> = []
  let tier: ShellTierName = initialTier

  const tierOf = (query: string): ShellTierName =>
    query.includes("min-width: 1024px")
      ? "desktop"
      : query.includes("max-width: 639px")
        ? "phone"
        : "tablet"

  vi.mocked(window.matchMedia).mockImplementation(((query: string) => {
    const mediaQuery = {
      get matches() {
        return tierOf(query) === tier
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.add(listener)
      }),
      removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.delete(listener)
      }),
      addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      ),
      removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      ),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList & { matches: boolean; media: string }

    mediaQueries.push(mediaQuery)
    return mediaQuery
  }) as typeof window.matchMedia)

  // The tier signal is module scope now (modules/shell/shell-tier.ts) and its
  // matchMedia listeners were attached at import time, before this mock
  // existed. Forcing the tier therefore re-reads the queries explicitly rather
  // than relying on a "change" event reaching a listener bound to the real
  // matchMedia. The listener wiring itself is covered by shell-tier.test.ts.
  syncShellTier()

  return {
    setTier(next: ShellTierName) {
      tier = next
      for (const listener of listeners) {
        listener({ matches: true, media: "" } as MediaQueryListEvent)
      }
      syncShellTier()
    },
  }
}

describe("Shell", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetBootstrap()
    resetRegistry()
    clearAuth()
    resetDockStore()
  })

  it("renders all three layout regions", () => {
    // The shell now collapses the sidebar column when the active tab type
    // declares no sidebar. Open a kernel tab (home) so the sidebar renders.
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })
    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    expect(screen.getByTestId("activity-bar")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("main-panel")).toBeInTheDocument()
    // The fourth region is gone: chats moved into the dock over the main
    // panel, and the remaining side panel is a plugin's app panel, mounted
    // only while one is open.
    expect(screen.queryByTestId("agent-panel")).toBeNull()
  })

  it("renders as a grid with correct structure", () => {
    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    const shell = container.querySelector("[data-shell]")
    expect(shell).toBeInTheDocument()
    expect(shell).toBeTruthy()
  })

  // index.html opts the whole app into `viewport-fit=cover`, so under a native
  // shell the page is drawn UNDER the status bar and the home indicator. Only
  // the login page padded itself for that; every signed-in route renders in
  // this root, where the activity bar and the bottom tab bar sat under the
  // system chrome on a phone.
  it("pads the shell root with the safe-area insets", () => {
    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    const shell = container.querySelector("[data-shell]") as HTMLElement
    for (const side of ["top", "left", "right"]) {
      expect(shell.className).toContain(`env(safe-area-inset-${side})`)
    }
    // The bottom one is a style: it gives way to the native keyboard, which
    // covers the home indicator (Shell.keyboard.phone.test.tsx).
    expect(shell.style.paddingBottom).toContain("env(safe-area-inset-bottom")
  })

  it("shell tier reports desktop at 1280px width", () => {
    mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.dataset.shellTier).toBe("desktop")
  })

  it("shell tier reports tablet at 800px width", () => {
    mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.dataset.shellTier).toBe("tablet")
  })

  it("shell tier reports phone at 375px width", () => {
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.dataset.shellTier).toBe("phone")
  })

  it("shell never renders a data-compact-shell attribute", () => {
    mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.hasAttribute("data-compact-shell")).toBe(false)
  })

  it("desktop grid has no agent column", () => {
    mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    // A sidebar-less tab type keeps every track free of clamp(), which jsdom's
    // CSS parser drops, so the template string itself is readable here.
    registerSidebarlessTabType()
    openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.style.gridTemplateRows).toBe("minmax(0, 1fr)")
    // Activity bar, sidebar (collapsed by this tab type) and content are the
    // shell's columns. The fourth track is the APP PANEL's alone and is zero
    // while none is open: with the agent column gone, `panelOpen()` no longer
    // reserves width on its own, and nothing is placed in column 4.
    const tracks = gridTracks(shell.style.gridTemplateColumns)
    expect(tracks).toEqual(["48px", "0px", "minmax(0, 1fr)", "0px"])
    expect((screen.getByTestId("activity-bar") as HTMLElement).style.gridColumn).toBe("1")
    expect((screen.getByTestId("main-panel") as HTMLElement).style.gridColumn).toBe("3")
    expect(container.querySelector('[style*="grid-column: 4"]')).toBeNull()
  })

  it("the dock is absent at tablet and phone tiers", async () => {
    const mediaQuery = mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    registerSidebarlessTabType()
    // A non-Home surface, and the URL to match: the shell's URL sync would
    // otherwise activate Home and hide the dock for the wrong reason.
    window.history.pushState({}, "", "/tickets/t-1")
    openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    await waitFor(() => expect(tabStore.activeTabId).toBe("tickets:ticket:t-1"))
    expect(shell.dataset.shellTier).toBe("tablet")
    expect(container.querySelector("[data-chat-dock]")).toBeNull()

    mediaQuery.setTier("phone")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("phone"))
    expect(container.querySelector("[data-chat-dock]")).toBeNull()

    // The same surface at desktop DOES carry the dock, so the two assertions
    // above are about the tier and not about the surface.
    mediaQuery.setTier("desktop")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("desktop"))
    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()
  })

  // P4c FX-B2 (D1). Below 1024px the Chats sheet is the ONLY way to reach a
  // conversation. It used to be mounted inside `panelContent()`, which at
  // tablet and phone renders only INSIDE the app-panel overlay sheet: with no
  // app panel open the sheet was not in the DOM at all, so every conversation
  // was unreachable. It belongs to the shell, not to the panel.
  it("the Chats sheet mounts at tablet with no app panel open", async () => {
    mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    registerSidebarlessTabType()
    window.history.pushState({}, "", "/tickets/t-1")
    openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    await waitFor(() => expect(tabStore.activeTabId).toBe("tickets:ticket:t-1"))
    // No app panel: the only sheet that may appear is the Chats one.
    expect(panelOpen()).toBe(false)
    expect(screen.queryByTestId("overlay-sheet-close")).toBeNull()

    toggleChats()

    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())
    expect(screen.getByText("Chats")).toBeInTheDocument()
    resetDockStore()
  })

  // P4c FX-B2 (D7). The side column hosts a plugin's APP panel, not the agent
  // panel it was named after. Nothing opens one any more, so the tab bar has no
  // toggle for it (2026-09-24), even while one is open.
  it("draws no panel toggle, even while a panel is open", async () => {
    mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    registerSidebarlessTabType()
    registerAppPanel()
    openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    setActivePanel(APP_PANEL)
    await waitFor(() => expect(panelOpen()).toBe(true))

    expect(screen.queryByLabelText("Close panel")).toBeNull()
    expect(screen.queryByLabelText("Close agent panel")).toBeNull()
    clearActivePanel()
  })

  it("tablet grid template columns never stack sidebar above content", () => {
    mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    // One row only: sidebar and content share it, side by side.
    expect(shell.style.gridTemplateRows).toBe("minmax(0, 1fr)")
    const sidebar = screen.queryByTestId("sidebar")
    const mainPanel = screen.getByTestId("main-panel") as HTMLElement
    // The middle track is the sidebar's, collapsed while the drawer is closed:
    // nothing legible fits in a 48px strip, so the tablet sidebar is the
    // drawer and the activity bar toggle is its way in.
    expect(shell.style.gridTemplateColumns).toBe("48px 0px minmax(0, 1fr)")
    expect(mainPanel.style.gridColumn).toBe("3")
    expect(sidebar).toBeNull()
  })

  it("phone grid template rows reserve a bottom bar row", () => {
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.style.gridTemplateColumns).toBe("minmax(0, 1fr)")
    expect(shell.style.gridTemplateRows).toBe("minmax(0, 1fr) 56px")
    expect(trackCount(shell.style.gridTemplateRows)).toBe(2)
    // The bottom row is the PHONE TAB BAR's, not the activity bar's: phone
    // tier seats five fixed tabs and renders no rail at all (M1-A T2,
    // PhoneTabBar.tsx). This assertion still named `activity-bar` and had
    // been failing ever since that swap.
    expect(screen.queryByTestId("activity-bar")).toBeNull()
    const bottomBar = screen.getByTestId("phone-tab-bar") as HTMLElement
    expect(bottomBar.style.gridRow).toBe("2")
  })

  it("renders the app panel inside an overlay sheet at tablet tier", () => {
    mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })
    registerAppPanel()

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    // The sheet tiers start closed (it covers the whole viewport), so the user
    // opening a panel is what puts the sheet on screen.
    setActivePanel(APP_PANEL)
    expect(panelOpen()).toBe(true)

    const sheet = document.querySelector('[data-overlay-sheet][data-variant="full"]') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(sheet.contains(screen.getByTestId("app-panel-body"))).toBe(true)
    clearActivePanel()
  })

  it("renders the app panel inside an overlay sheet at phone tier", () => {
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })
    registerAppPanel()

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    // The sheet tiers start closed (it covers the whole viewport), so the user
    // opening a panel is what puts the sheet on screen.
    setActivePanel(APP_PANEL)
    expect(panelOpen()).toBe(true)

    const sheet = document.querySelector('[data-overlay-sheet][data-variant="full"]') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(sheet.contains(screen.getByTestId("app-panel-body"))).toBe(true)
    clearActivePanel()
  })

  it("renders the app panel as a docked grid column at desktop tier", () => {
    mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })
    registerAppPanel()

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    setActivePanel(APP_PANEL)

    expect(screen.getByTestId("app-panel-body").closest("[data-overlay-sheet]")).toBeNull()
    const panelContainer = screen.getByTestId("app-panel-body").closest("[style]") as HTMLElement
    expect(panelContainer.style.gridColumn).toBe("4")
    clearActivePanel()
  })

  it("closing the overlay sheet at phone tier closes the panel", async () => {
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell).toBeTruthy()
    togglePanel()
    expect(panelOpen()).toBe(true)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    await waitFor(() => {
      expect(panelOpen()).toBe(false)
      expect(document.querySelector('[data-overlay-sheet][data-variant="full"]')).toBeNull()
    })
  })

  it("the agent panel sheet at phone tier shows a close control that closes the panel", async () => {
    resetPanelStore()
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell).toBeTruthy()
    togglePanel()
    expect(panelOpen()).toBe(true)
    const close = document.querySelector('[data-testid="overlay-sheet-close"]') as HTMLElement
    expect(close).toBeTruthy()

    fireEvent.click(close)

    await waitFor(() => {
      expect(panelOpen()).toBe(false)
    })
    resetPanelStore()
  })

  it("leaving the tablet tier resets the sidebar drawer so it does not reopen on return", async () => {
    const mediaQuery = mockShellTierMediaQuery("tablet")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.dataset.shellTier).toBe("tablet")

    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(true)

    mediaQuery.setTier("desktop")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("desktop"))
    expect(tabletSidebarOpen()).toBe(false)

    mediaQuery.setTier("tablet")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("tablet"))
    expect(tabletSidebarOpen()).toBe(false)
  })

  it("updates the shell tier when the viewport crosses a tier boundary", async () => {
    const mediaQuery = mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell.dataset.shellTier).toBe("desktop")

    mediaQuery.setTier("tablet")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("tablet"))

    mediaQuery.setTier("phone")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("phone"))

    mediaQuery.setTier("desktop")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("desktop"))
  })
})

describe("Shell — tab keyboard shortcuts", () => {
  afterEach(() => vi.restoreAllMocks())

  it("Cmd+W closes the active tab", () => {
    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    openTab({ type: "thread", entityId: "t1", label: "Test Thread" })
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeTruthy()

    fireEvent.keyDown(window, { key: "w", metaKey: true })
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeUndefined()
  })

  it("Cmd+Shift+T reopens last closed tab", () => {
    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    openTab({ type: "thread", entityId: "t1", label: "Test Thread" })
    closeTab(makeTabId("thread", "t1"))
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeUndefined()

    fireEvent.keyDown(window, { key: "t", metaKey: true, shiftKey: true })
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeTruthy()
  })
})

describe("Shell — preserveSubRoutes", () => {
  afterEach(() => vi.restoreAllMocks())

  it("restores a settings sub-route when returning to the tab", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/settings/security")

    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(makeTabId("settings", "settings"))
    })

    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })

    await waitFor(() => {
      expect(window.location.pathname).toBe("/threads/t1")
    })

    activateTab(makeTabId("settings", "settings"))

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/security")
    })
  })
})

describe("Shell — legacy agent chat routes", () => {
  afterEach(() => vi.restoreAllMocks())

  it("/agent/chat/:id redirects to the thread", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/agent/chat/dm-42")

    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    await waitFor(() => {
      expect(window.location.pathname).toBe("/threads/dm-42")
    })
    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(makeTabId("thread", "dm-42"))
    })
  })
})

// P4c-T39: the flat agent screens are tabs of an agent's page now, so the
// links that named no agent have to acquire one. A list screen was always the
// VIEWER'S own, so it resolves to the viewer's personal agent; a profile link
// already names its agent, by id, and the page is addressed by handle.
describe("Shell - legacy agent surface routes", () => {
  const ME = "u-legacy"
  const DIRECTORY = [
    { id: "ag-mine", handle: "@ada", displayName: "Ada", kind: "personal", ownerUserId: ME },
    { id: "ag-support", handle: "@support", displayName: "Support", kind: "role" },
  ]

  beforeEach(async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetAgentDirectory()
    await loadAgentDirectory({ get: async () => ({ data: DIRECTORY }) })
    setTokens(
      `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${btoa(
        JSON.stringify({
          userId: ME,
          orgId: "o1",
          name: "Me",
          roles: [],
          scopes: [],
          dimensionGrants: {},
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      )}.fake`,
      "refresh",
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearAuth()
    resetAgentDirectory()
  })

  function renderAt(path: string) {
    window.history.pushState({}, "", path)
    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))
  }

  // There is no agents DIRECTORY screen any more: the sidebar is the roster,
  // so the bare `/agents` path opens the viewer's own agent instead of a list
  // that repeated the sidebar beside it.
  it("/agents opens the viewer's own agent rather than a directory", async () => {
    renderAt("/agents")
    await waitFor(() => {
      expect(window.location.pathname).toBe("/agents/@ada")
    })
    expect(tabStore.activeTabId).toBe(makeTabId("agents:agent", "@ada"))
  })

  it("/agent/skills redirects to the personal agent's Skills tab", async () => {
    renderAt("/agent/skills")
    await waitFor(() => {
      expect(window.location.pathname).toBe("/agents/@ada/skills")
    })
  })

  // P4c FX-F2: the sub route has to survive the trip through the tab store,
  // not just the URL bar. `/agents/:handle` declares `preserveSubRoutes`, so
  // the tab the URL opens carries the deeper path (and its query) the way a
  // `/settings/<section>` tab does; a tab store holding the bare page is what
  // sent every deep link to Overview.
  it("a direct load of /agents/:handle/<tab> keeps the sub route in the tab store", async () => {
    renderAt("/agents/@ada/skills?selected=sk-1")

    const tabId = makeTabId("agents:agent", "@ada")
    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(tabId)
    })
    expect(tabStore.tabs.find((t) => t.id === tabId)?.routePath).toBe(
      "/agents/@ada/skills?selected=sk-1",
    )
    expect(window.location.pathname).toBe("/agents/@ada/skills")
  })

  // P4c FX-F3: ONE AGENT, ONE TAB. `self` and the personal agent's handle are
  // two spellings of the same agent, and a legacy link that resolved to the
  // handle used to open a SECOND page beside the `self` tab already sitting
  // there.
  it("a legacy skill link reuses the open agent tab", async () => {
    // The tab a session opens before the directory can name the handle.
    openTab({ type: "agents:agent", entityId: "self", label: "Agent", preview: false })
    const before = tabStore.tabs.filter((t) => t.type === "agents:agent").length
    expect(before).toBe(1)

    renderAt("/agent/skill/sk-1")
    await waitFor(() => {
      expect(window.location.pathname).toBe("/agents/@ada/skills")
    })
    const tabId = makeTabId("agents:agent", "@ada")
    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(tabId)
    })
    const agentTabs = tabStore.tabs.filter((t) => t.type === "agents:agent")
    expect(agentTabs.length).toBe(1)
    expect(agentTabs[0]!.entityId).toBe("@ada")
    closeTab(agentTabs[0]!.id)
  })

  it("/agent/profile/:id redirects to /agents/:handle", async () => {
    renderAt("/agent/profile/ag-support")
    await waitFor(() => {
      expect(window.location.pathname).toBe("/agents/@support")
    })
  })
})

describe("Shell — deferred manifest routes", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // The live-nav case opens a dock conversation; without this the tab and
    // the roster state leak into the phone tier cases below it.
    resetDockStore()
  })

  it("does not rewrite an unresolved deep link to home before its tab type registers", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/mail/conv-1")

    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    await Promise.resolve()
    expect(window.location.pathname).toBe("/mail/conv-1")

    registerTabType("mail:conversation", {
      component: () => <div data-testid="manifest-mail-conversation" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/mail/:entityId",
      defaultLabel: "Conversation",
      localType: "mail:conversation",
    })

    await waitFor(() => {
      expect(tabStore.activeTabId).toBe("mail:conversation:conv-1")
    })
    expect(window.location.pathname).toBe("/mail/conv-1")
  })

  it("browser navigation to an existing app tab preserves its dynamic label", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerTabType("mail:conversation", {
      component: () => <div data-testid="manifest-mail-conversation" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/mail/:entityId",
      defaultLabel: "mail:conversation",
      localType: "mail:conversation",
    })
    window.history.pushState({}, "", "/mail/conv-1")

    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))

    openTab({ type: "mail:conversation", entityId: "conv-1", label: "Q3 Budget Proposal" })
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    await waitFor(() => {
      expect(window.location.pathname).toBe("/threads/t1")
    })
    window.history.back()

    await waitFor(() => {
      expect(tabStore.activeTabId).toBe("mail:conversation:conv-1")
    })
    expect(tabStore.tabs.find((t) => t.id === "mail:conversation:conv-1")?.label).toBe(
      "Q3 Budget Proposal",
    )
  })

  // A framed app's sidebar selects by navigating within its singleton tab: the tab must
  // move onto the new entity, or its main view (another frame) never sees the selection.
  it("a path naming another entity of an open singleton tab moves the tab onto it", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerTabType("kpi:definitions", {
      component: () => <div />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/kpi-catalogue/:entityId+",
      defaultLabel: "KPI",
      localType: "definitions",
      appId: "kpi",
      singleton: true,
    })
    window.history.pushState({}, "", "/kpi-catalogue/definitions")

    render(() => (
      <Router>
        <Route path="/*" component={Shell} />
      </Router>
    ))
    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(makeTabId("kpi:definitions", "definitions"))
    })

    window.history.pushState({}, "", "/kpi-catalogue/metric/panier_moyen")
    window.dispatchEvent(new PopStateEvent("popstate"))

    await waitFor(() => {
      expect(tabStore.activeTabId).toBe(makeTabId("kpi:definitions", "metric/panier_moyen"))
    })
    const kpiTabs = tabStore.tabs.filter((t) => t.type === "kpi:definitions")
    expect(kpiTabs.map((t) => t.entityId)).toEqual(["metric/panier_moyen"])
  })

  it("shell.live-nav-debounce-and-referenceable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerTabType("tickets:ticket", {
      component: () => <div />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      localType: "ticket",
      appId: "tickets",
      referenceable: true,
    })

    const fetchMock = vi.fn((..._args: [string | URL | Request, RequestInit?]) =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    )
    vi.stubGlobal("fetch", fetchMock as any)

    setTokens("fake.jwt.token")
    // The live-nav reference effect follows the dock's active conversation
    // since P4c-T17 retired the panel and its per-session chat.
    // Collapsed: this case is about the reference POST, not about mounting a
    // whole ThreadView inside the dock under fake timers.
    openConversation("agent-chat-1", { expand: false })

    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    // Burst of activations to referenceable tabs collapses into a single POST
    // for the final entity after the 250ms debounce.
    fetchMock.mockClear()
    openTab({ type: "tickets:ticket", entityId: "A", label: "Ticket A" })
    openTab({ type: "tickets:ticket", entityId: "B", label: "Ticket B" })
    openTab({ type: "tickets:ticket", entityId: "C", label: "Ticket C" })
    await vi.advanceTimersByTimeAsync(300)
    const referencePosts = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/threads/agent-chat-1/references"),
    )
    expect(referencePosts.length).toBe(1)
    const body = JSON.parse(String(referencePosts[0][1]?.body ?? "{}"))
    expect(body).toEqual({ app: "tickets", entityType: "ticket", entityId: "C" })

    vi.useRealTimers()
  })

  it("the agent panel sheet is closed at phone tier until the user opens it", () => {
    resetPanelStore()
    mockShellTierMediaQuery("phone")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(shell).toBeTruthy()
    expect(panelOpen()).toBe(false)
    expect(document.querySelector('[data-overlay-sheet][data-variant="full"]')).toBeNull()
    expect(screen.getByTestId("main-panel")).toBeInTheDocument()
    resetPanelStore()
  })

  it("narrowing to a sheet tier closes the panel instead of covering the screen", async () => {
    resetPanelStore()
    const mediaQuery = mockShellTierMediaQuery("desktop")
    resetRegistry()
    bootstrapKernelApps()
    openTab({ type: "home", entityId: "home", label: "Home" })

    const { container } = render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))

    const shell = container.querySelector("[data-shell]") as HTMLElement
    expect(panelOpen()).toBe(true)

    mediaQuery.setTier("tablet")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("tablet"))
    expect(panelOpen()).toBe(false)
    expect(document.querySelector('[data-overlay-sheet][data-variant="full"]')).toBeNull()

    // Back at desktop the docked column returns: the compact close is a tier
    // adaptation, not a preference the user expressed.
    mediaQuery.setTier("desktop")
    await waitFor(() => expect(shell.dataset.shellTier).toBe("desktop"))
    expect(panelOpen()).toBe(true)
    resetPanelStore()
  })
})
