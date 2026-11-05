// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Must be hoisted before module evaluation: the stores read localStorage and
// matchMedia while they are being imported.
vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any

  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // Desktop tier: the dock is available and the shell docks its columns.
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    userFromToken: () => ({
      userId: "u1",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

import { getTabType, registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth } from "~/modules/auth/auth-store"
import {
  activeThreadId,
  tabs as dockTabs,
  openConversation,
  resetDockStore,
} from "~/modules/shell/dock-store"
import { Shell } from "~/modules/shell/Shell"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"

const PERSONAL_DM_ID = "dm-1"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// Installed ONCE, on globalThis, exactly the way Shell.test.tsx does it, and
// never unstubbed. `vi.stubGlobal` + `vi.unstubAllGlobals()` in afterEach tore
// fetch down while thread-store's `loadThreads()` was still in flight: the
// next call hit a fetch that no longer existed, api-client turned it into a
// rejected `ApiError("Network error")` nobody was awaiting, and the file left
// 17 unhandled rejections behind that failed the whole vitest run.
function installFetchMock() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input)
    if (url.includes("/threads/dm")) return jsonResponse({ data: { id: PERSONAL_DM_ID } })
    // The feed's real shape: the shell's attention load stores `data.items`, and
    // a bare `[]` left the store's items undefined, so whichever test imported
    // Home after that load resolved threw in Home's sections memo.
    if (url.includes("/attention-items")) return jsonResponse({ data: { items: [], errors: [] } })
    if (url.includes("/agents")) {
      return jsonResponse({
        data: [
          {
            id: "agent-mine",
            handle: "@mine",
            displayName: "Liaison",
            kind: "personal",
            ownerUserId: "u1",
          },
        ],
      })
    }
    return jsonResponse({ data: [] })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function renderShell() {
  return render(() => (
    <Router>
      <Route path="*" component={Shell} />
    </Router>
  ))
}

function pressToggleChat() {
  fireEvent.keyDown(window, { key: ".", metaKey: true })
}

describe("Shell chat dock", () => {
  beforeEach(() => {
    resetDockStore()
    resetPersonalDmStore()
    resetAgentDirectory()
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    installFetchMock()
    // Each test starts on "/" — the shell navigates, and the next Router would
    // otherwise restore the previous test's route.
    window.history.pushState({}, "", "/")
  })

  afterEach(() => {
    // No `vi.unstubAllGlobals()`: fetch must outlive the test, see
    // installFetchMock. `restoreAllMocks` leaves globalThis.fetch alone.
    vi.restoreAllMocks()
    resetDockStore()
    resetPersonalDmStore()
    clearAuth()
  })

  it("mod+. opens the personal agent dock tab outside Home", async () => {
    renderShell()
    // Leave the Home surface: the shell's URL sync activates Home on mount, so
    // the search tab is opened after the first render.
    openTab({ type: "kernel:search", entityId: "search", label: "Search" })
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:search:search"))
    expect(activeThreadId()).toBeNull()

    pressToggleChat()

    await waitFor(() => expect(activeThreadId()).toBe(PERSONAL_DM_ID))
    expect(dockTabs().map((t) => t.threadId)).toEqual([PERSONAL_DM_ID])
    // The DM is a dock tab, not a main-panel tab, off a Home surface.
    expect(tabStore.tabs.some((t) => t.entityId === PERSONAL_DM_ID)).toBe(false)
  })

  it("mod+. focuses the thread composer on Home", async () => {
    const { container } = renderShell()
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))

    // The Home surface renders a conversation with its composer; stand in for
    // it with the same markup ComposeBar publishes inside the active tab.
    const activeTab = await waitFor(() => {
      const el = container.querySelector('[data-tab-active="true"]') as HTMLElement | null
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    const editor = document.createElement("div")
    editor.setAttribute("data-testid", "compose-editor")
    editor.setAttribute("contenteditable", "true")
    editor.tabIndex = 0
    activeTab.appendChild(editor)
    const focusSpy = vi.spyOn(editor, "focus")

    pressToggleChat()

    await waitFor(() => expect(focusSpy).toHaveBeenCalled())
    // Focusing the composer is the whole gesture on Home: no dock tab opens.
    expect(activeThreadId()).toBeNull()
    expect(dockTabs()).toHaveLength(0)
  })

  it("the dock is mounted on a Tickets tab, on Home and on a thread tab", async () => {
    registerTabType("tickets:ticket", {
      component: () => <div data-testid="ticket-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      localType: "tickets:ticket",
    })
    const { container } = renderShell()

    // Home and a thread tab show their conversation twice, and that is the
    // deliberate trade: a strip that came and went as the user walked Home
    // was read as the chat bar breaking.
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()

    openTab({ type: "tickets:ticket", entityId: "t-1", label: "Ticket" })
    await waitFor(() => expect(tabStore.activeTabId).toBe("tickets:ticket:t-1"))
    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()

    openTab({ type: "thread", entityId: "th-1", label: "Thread" })
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:thread:th-1"))
    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()
  })

  it("data-chat-dock-open mirrors the dock", async () => {
    openTab({ type: "home", entityId: "home", label: "Home" })
    const { container } = renderShell()
    const shell = container.querySelector("[data-shell]") as HTMLElement

    expect(shell.dataset.chatDockOpen).toBe("false")

    openConversation("thread-7")
    await waitFor(() => expect(shell.dataset.chatDockOpen).toBe("true"))

    resetDockStore()
    await waitFor(() => expect(shell.dataset.chatDockOpen).toBe("false"))
  })

  // P4c-T15, revised. The rule was once "Home and a thread tab carry no dock,
  // because the conversation is already the screen". It is now simply: ON
  // DESKTOP THE DOCK IS ALWAYS THERE. A bar that disappeared as the user
  // walked Home and reappeared on the next click read as a bug, and a
  // conversation shown twice costs less than that. The agent panel is still
  // gone everywhere (the dock replaced it), and mod+. on Home still focuses
  // the composer rather than opening a dock tab: only the dock's VISIBILITY
  // changed, never the gesture.
  it("Home renders the dock, no sheet opener and still no agent panel root", async () => {
    const { container } = renderShell()

    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))

    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()
    // The round opener is the COMPACT tiers' entry to the same chats: at
    // desktop the strip is that entry, so the two are never both on screen.
    // Its Home behaviour at tablet is pinned in Shell.phone-opener.test.tsx.
    expect(container.querySelector('[data-testid="chats-sheet-opener"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-panel"]')).toBeNull()
  })

  it("a thread tab renders the dock, no sheet opener and no agent panel root", async () => {
    const { container } = renderShell()
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))

    openTab({ type: "thread", entityId: "th-1", label: "Thread" })
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:thread:th-1"))

    expect(container.querySelector("[data-chat-dock]")).not.toBeNull()
    expect(container.querySelector('[data-testid="chats-sheet-opener"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-panel"]')).toBeNull()
  })

  it("Home's landing component is unchanged", async () => {
    const reg = getTabType("kernel:home")
    expect(reg).toBeTruthy()

    // `component` is a solid-js lazy() wrapper; `.preload()` resolves the
    // same dynamic import it renders from, without mounting anything — a
    // module-identity pin rather than a DOM assertion.
    const preload = (reg!.component as unknown as { preload: () => Promise<{ default: unknown }> })
      .preload
    const registered = await preload()
    const direct = await import("~/modules/shell/Home")

    expect(registered.default).toBe(direct.default)
  })
})
