// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import {
  cleanup,
  within as domWithin,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { resetLocalPrompts } from "~/modules/desktop/LocalPermissionCard"
import { ApiProvider } from "~/modules/shell/ApiContext"
import ConversationTab from "~/modules/shell/ConversationTab"
import * as dockStoreModule from "~/modules/shell/dock-store"
import * as tabStoreModule from "~/modules/shell/tab-store"
import { WsProvider } from "~/modules/shell/WsContext"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import { resetMessageStore } from "~/modules/threads/message-store"
import { handlePresenceUpdate, resetPresenceStore } from "~/modules/threads/presence-store"
import { addThread, handleTypingEvent, resetThreadStore } from "~/modules/threads/thread-store"

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")
const mockWsSend = vi.fn()

// The signed in viewer is the human seat of every thread seeded below, which
// is what makes a two seat room a DM rather than a room with two other seats
// (`soleAgentCounterpart`, packages/shared).
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u1", name: "Test User" }) }
})

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

/** Every read answered 200 with an empty payload: the default for this file. */
function stubOkFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(200, { data: null }))),
  )
}

stubOkFetch()

function renderTab(tab: dockStoreModule.DockTab) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <WsProvider send={mockWsSend} status={mockWsStatus}>
            <ApiProvider>
              <ConversationTab tab={tab} />
            </ApiProvider>
          </WsProvider>
        )}
      />
    </Router>
  ))
}

function makeTab(
  threadId: string,
  overrides: Partial<dockStoreModule.DockTab> = {},
): dockStoreModule.DockTab {
  return { threadId, expanded: true, openedAt: 1, lastActiveAt: 1, ...overrides }
}

describe("ConversationTab", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    resetPresenceStore()
  })
  afterEach(() => cleanup())

  it("an expanded tab renders ThreadView and ComposeBar for its thread", async () => {
    addThread({
      id: "conv-1",
      handle: "conv-1",
      title: "Design Review",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })

    renderTab(makeTab("conv-1"))

    // ThreadView's real ComposeBar mounts (the point of this test: the real
    // view, not a stub) and the compact header shows the thread's name.
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    // The name is on the bar item AND in the window's compact header.
    expect(screen.getAllByText("Design Review")).toHaveLength(2)
    expect(
      domWithin(screen.getByTestId("dock-window-header")).getByText("Design Review"),
    ).toBeInTheDocument()
    // The dock surface renders no second ThreadHeader (ThreadView already
    // guarantees this); this only confirms the dock's own compact header.
    expect(screen.queryByTestId("participant-count")).not.toBeInTheDocument()
  })

  it("Open in Home opens the thread tab and closes the dock tab", async () => {
    addThread({
      id: "conv-2",
      handle: "conv-2",
      title: "Ops Sync",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })

    const openTabSpy = vi.spyOn(tabStoreModule, "openTab")
    const closeSpy = vi.spyOn(dockStoreModule, "close")

    renderTab(makeTab("conv-2"))

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: "Open in Home" }))

    expect(openTabSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread", entityId: "conv-2" }),
    )
    expect(closeSpy).toHaveBeenCalledWith("conv-2")

    openTabSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it("an open window offers collapse and Open in Home, but closes only from the bar", async () => {
    addThread({
      id: "conv-3",
      handle: "conv-3",
      title: "Pricing",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })

    renderTab(makeTab("conv-3"))

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    // A close control at the top of the window is too easy to hit when
    // collapsing was meant: the window header has none, the bar item keeps it.
    const header = domWithin(screen.getByTestId("dock-window-header"))
    expect(header.getByRole("button", { name: "Collapse" })).toBeInTheDocument()
    expect(header.getByRole("button", { name: "Open in Home" })).toBeInTheDocument()
    expect(header.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    expect(screen.getByTestId("dock-tab-close")).toBeInTheDocument()
  })

  it("a collapsed tab shows the name and the unread count", () => {
    addThread({
      id: "conv-3",
      handle: "conv-3",
      title: "Launch Plan",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
      unreadCount: 4,
    })

    renderTab(makeTab("conv-3", { expanded: false }))

    expect(screen.getByText("Launch Plan")).toBeInTheDocument()
    expect(screen.getByTestId("dock-tab-unread")).toHaveTextContent("4")
    expect(screen.getByTestId("dock-tab-unread").className).toBe(dockStoreModule.DOCK_BADGE_CLASS)
    // Unread reads heavier than read.
    expect(screen.getByTestId("dock-tab-name").className).toContain("font-semibold")
    // Collapsed: no compose bar, no window.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByTestId("dock-window")).not.toBeInTheDocument()
    // The bar's item geometry, shared with the Chats item.
    const item = screen.getByText("Launch Plan").closest("[data-dock-pill]") as HTMLElement
    expect(item).not.toBeNull()
    expect(item.className).toContain("h-full")
    expect(item.getAttribute("style")).toContain("max-width: 170px")
  })

  it("the item opens its window and stays on the bar, marked active", async () => {
    addThread({
      id: "conv-item",
      handle: "conv-item",
      title: "Item Room",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    const expandSpy = vi.spyOn(dockStoreModule, "expand")
    const collapseSpy = vi.spyOn(dockStoreModule, "collapse")

    const { unmount } = renderTab(makeTab("conv-item", { expanded: false }))
    expect(screen.queryByTestId("dock-tab-active-line")).toBeNull()
    fireEvent.click(screen.getByTestId("dock-tab-toggle"))
    expect(expandSpy).toHaveBeenCalledWith("conv-item")
    unmount()

    renderTab(makeTab("conv-item"))
    // Open: the item is still there, active, with the window above it.
    const tab = document.querySelector('[data-dock-tab="conv-item"]') as HTMLElement
    expect(tab.getAttribute("data-active")).toBe("true")
    expect(domWithin(tab).getByTestId("dock-tab-toggle")).toHaveAttribute("aria-expanded", "true")
    expect(domWithin(tab).getByTestId("dock-tab-active-line")).toBeInTheDocument()
    expect(domWithin(tab).getByTestId("dock-window")).toBeInTheDocument()
    // The close control is always shown on the active item.
    expect(domWithin(tab).getByTestId("dock-tab-close").className).toContain("opacity-100")
    // Pressing the active item minimises it.
    fireEvent.click(domWithin(tab).getByTestId("dock-tab-toggle"))
    expect(collapseSpy).toHaveBeenCalledWith("conv-item")

    expandSpy.mockRestore()
    collapseSpy.mockRestore()
  })

  it("the item's close control closes the conversation and names it", () => {
    addThread({
      id: "conv-close",
      handle: "conv-close",
      title: "Closing Room",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    const closeSpy = vi.spyOn(dockStoreModule, "close")

    renderTab(makeTab("conv-close", { expanded: false }))
    const button = screen.getByLabelText("Close Closing Room")
    // Hidden until hover or focus on an inactive item.
    expect(button.className).toContain("opacity-0")
    fireEvent.click(button)
    expect(closeSpy).toHaveBeenCalledWith("conv-close")

    closeSpy.mockRestore()
  })

  it("a DM with a person online wears the green dot and says Active now", async () => {
    addThread({
      id: "conv-person",
      handle: "conv-person",
      title: null,
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        { id: "u2", name: "Alice Martin", avatarUrl: null, participantType: "user" },
      ],
    })
    handlePresenceUpdate("u2", "online")

    renderTab(makeTab("conv-person"))

    const header = screen.getByTestId("dock-window-header")
    expect(domWithin(header).getByTestId("dock-presence-dot")).toHaveAttribute(
      "data-state",
      "online",
    )
    expect(domWithin(header).getByTestId("dock-window-status")).toHaveTextContent("Active now")
    // The avatar is the person's initials, not a generic mark.
    expect(domWithin(header).getByText("AM")).toBeInTheDocument()
  })

  it("a channel's window says how many members it has and wears no presence dot", () => {
    addThread({
      id: "conv-channel",
      handle: "#general",
      title: "General",
      type: "channel",
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        { id: "u2", name: "Alice", avatarUrl: null },
        { id: "u3", name: "Bob", avatarUrl: null },
      ],
    })

    renderTab(makeTab("conv-channel"))

    const header = screen.getByTestId("dock-window-header")
    expect(domWithin(header).getByTestId("dock-window-status")).toHaveTextContent("3 members")
    expect(domWithin(header).queryByTestId("dock-presence-dot")).toBeNull()
  })

  // A35: a DM has no title and is named by its participants. The tab named it
  // with `threadDisplayName` alone, and the untitled agent DM the dock opens
  // came out as its auto handle instead of the agent.
  it("an agent DM tab is named by its agent, never by the handle", () => {
    addThread({
      id: "conv-dm-name",
      handle: "thread-19",
      title: null,
      type: "agent_chat",
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        {
          id: "agent-seat-9",
          name: "Shipping Bot",
          avatarUrl: null,
          participantType: "agent",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
        },
      ],
    })

    renderTab(makeTab("conv-dm-name", { expanded: false }))

    expect(screen.getByText("Shipping Bot")).toBeInTheDocument()
    expect(screen.queryByText("thread-19")).not.toBeInTheDocument()
  })

  it("an agent DM tab shows the agent state label", async () => {
    addThread({
      id: "conv-4",
      handle: "conv-4",
      title: null,
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        {
          id: "agent-seat-1",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
    })
    // Announce a turn so AgentStateLabel has something other than "idle" to
    // show (same mechanism AgentStateLabel.test.tsx uses).
    handleTypingEvent({
      type: "typing:start",
      threadId: "conv-4",
      userId: "actor",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      authorType: "agent",
    })

    const { container } = renderTab(makeTab("conv-4"))

    // The tab's OWN header label, scoped: ThreadView renders the same state in
    // the message stream below, so an unscoped lookup finds both.
    const header = domWithin(container).getByTestId("dock-window-header")
    await waitFor(() => {
      expect(domWithin(header).getByTestId("agent-state")).toBeInTheDocument()
    })
    expect(domWithin(header).getByText("Queued")).toBeInTheDocument()
    // An agent at work pulses on the avatar too, on the bar and in the window.
    const dots = domWithin(container).getAllByTestId("dock-presence-dot")
    expect(dots.length).toBeGreaterThanOrEqual(1)
    for (const dot of dots) expect(dot).toHaveAttribute("data-state", "working")
  })

  // P4c-T39: in a DM with an agent the dock tab's header name IS that agent,
  // so pressing it opens the agent's page, the same tab the sidebar row, the
  // participant row and a mention chip open. A tab that names people has no
  // one page to go to and keeps a plain label.
  it("the dock tab header name opens the agent's page", async () => {
    tabStoreModule.resetTabStore()
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            handle: "@liaison",
            displayName: "Liaison",
            kind: "personal",
          },
        ],
      }),
    })
    addThread({
      id: "conv-5",
      handle: "conv-5",
      title: null,
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        {
          id: "agent-seat-1",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
    })
    const { getByTestId } = renderTab(makeTab("conv-5"))
    getByTestId("dock-tab-agent-name").click()
    expect(
      tabStoreModule.tabStore.tabs.map((t: any) => ({ type: t.type, entityId: t.entityId })),
    ).toContainEqual({ type: "agents:agent", entityId: "@liaison" })
  })

  it("a dock tab for a conversation between people has no agent name control", () => {
    addThread({
      id: "conv-6",
      handle: "conv-6",
      title: null,
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        { id: "u2", name: "Alice", avatarUrl: null },
      ],
    })
    const { queryByTestId } = renderTab(makeTab("conv-6"))
    expect(queryByTestId("dock-tab-agent-name")).toBeNull()
  })
})

// P4c-T19: A LOCAL SESSION STARTS FROM THE TAB IT BELONGS TO.
//
// The dock tab holds a whole conversation, so it holds the same offer the
// thread header holds in Home: where this conversation's turns run. Both mount
// ThreadRuntimeSlot, so the predicate is written once, and the thread id the
// tab hands it is its OWN: a local session claims a (thread, agent) pair (A32),
// and a tab that started a session against the thread Home has open behind it
// would claim the wrong conversation.
describe("ConversationTab mounts the runtime control for its own thread (P4c-T19)", () => {
  const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const RUNTIME_LABEL = "Where the turns of this conversation run"

  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    resetPresenceStore()
  })

  afterEach(() => {
    cleanup()
    uninstallFakeBridge()
  })

  function seedDm(threadId: string) {
    addThread({
      id: threadId,
      handle: threadId,
      title: null,
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        {
          id: "agent-seat-1",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: AGENT_ID,
        },
      ],
    })
  }

  it("a dock tab for an agent DM offers the runtime control on the desktop", async () => {
    installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/someone/work" })
    seedDm("conv-runtime-1")

    renderTab(makeTab("conv-runtime-1"))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: RUNTIME_LABEL })).toBeInTheDocument()
    })
  })

  it("a dock tab renders no runtime control in the browser", async () => {
    // No bridge: a browser has no shell to run anything on.
    seedDm("conv-runtime-2")

    renderTab(makeTab("conv-runtime-2"))

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    expect(screen.queryByRole("button", { name: RUNTIME_LABEL })).not.toBeInTheDocument()
  })

  it("starting a local session from a dock tab claims that thread id", async () => {
    const fake = installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/someone/work" })
    seedDm("conv-runtime-3")

    renderTab(makeTab("conv-runtime-3"))

    const trigger = await screen.findByRole("button", { name: RUNTIME_LABEL })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    const start = domWithin(menu).getByText("Start a session here").closest('[role="menuitem"]')
    expect(start).not.toBeNull()
    fireEvent.keyDown(start as HTMLElement, { key: "Enter" })

    await waitFor(() =>
      expect(fake.calls.started).toEqual([
        { threadId: "conv-runtime-3", agentId: AGENT_ID, folderId: undefined },
      ]),
    )
  })
})

/**
 * A dock tab outlives the thread behind it: the dock persists its tabs in
 * localStorage, so a conversation deleted server side (or one the viewer was
 * removed from) came back on every page load and its ConversationTab asked for
 * it again, forever. The tab closes on a DEFINITIVE refusal only.
 */
describe("ConversationTab whose thread the server refuses", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    resetPresenceStore()
    dockStoreModule.resetDockStore()
  })
  afterEach(() => {
    cleanup()
    stubOkFetch()
  })

  /** The thread ids in the newest dock blob written to localStorage. */
  function persistedTabIds(): string[] {
    const setItem = localStorage.setItem as unknown as { mock: { calls: string[][] } }
    const last = [...setItem.mock.calls].reverse().find((c) => c[0] === "liaison.dock.v1")
    if (!last) return []
    const parsed = JSON.parse(last[1]) as { tabs: Array<{ threadId: string }> }
    return parsed.tabs.map((t) => t.threadId)
  }

  function stubDetailStatus(threadId: string, status: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new RegExp(`/threads/${threadId}(\\?|$)`).test(String(url))
            ? jsonResponse(status, { error: { message: "nope" } })
            : jsonResponse(200, { data: null }),
        ),
      ),
    )
  }

  it("closes a tab whose thread answers 404 and stops persisting it", async () => {
    dockStoreModule.openConversation("gone-404")
    expect(dockStoreModule.tabs().map((t) => t.threadId)).toEqual(["gone-404"])
    stubDetailStatus("gone-404", 404)

    renderTab(makeTab("gone-404"))

    await waitFor(() => expect(dockStoreModule.tabs()).toHaveLength(0))
    expect(persistedTabIds()).toEqual([])
  })

  it("closes a tab whose thread answers 403", async () => {
    dockStoreModule.openConversation("gone-403")
    stubDetailStatus("gone-403", 403)

    renderTab(makeTab("gone-403"))

    await waitFor(() => expect(dockStoreModule.tabs()).toHaveLength(0))
    expect(persistedTabIds()).toEqual([])
  })

  it("keeps a tab whose thread answers 500", async () => {
    dockStoreModule.openConversation("transient-500")
    stubDetailStatus("transient-500", 500)

    renderTab(makeTab("transient-500"))

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(dockStoreModule.tabs().map((t) => t.threadId)).toEqual(["transient-500"])
    expect(persistedTabIds()).toEqual(["transient-500"])
  })

  it("keeps a tab whose thread read fails with a network error", async () => {
    dockStoreModule.openConversation("offline-1")
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    )

    renderTab(makeTab("offline-1"))

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(dockStoreModule.tabs().map((t) => t.threadId)).toEqual(["offline-1"])
  })
})

// A COLLAPSED CONVERSATION PARKED ON A QUESTION SAYS SO (2026-09-23). A local
// turn waiting on an Allow gave its pill no sign at all, and the turn sat there
// unnoticed for ten minutes.
describe("ConversationTab, a local turn waiting on a permission", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    resetPresenceStore()
    addThread({
      id: "conv-local",
      handle: "conv-local",
      title: "Rapports",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
  })
  afterEach(() => {
    uninstallFakeBridge()
    resetLocalPrompts()
    cleanup()
  })

  const PROMPT = { requestId: "perm-1", toolName: "Bash", summary: "command: ls", toolUseId: "t1" }

  it("badges the collapsed pill of the conversation whose turn is waiting", async () => {
    installFakeBridge(liveSession("conv-local", "agent-1", { pendingPermissions: [PROMPT] }))
    renderTab(makeTab("conv-local", { expanded: false }))
    const badge = await screen.findByTestId("dock-tab-permission")
    expect(badge.getAttribute("aria-label")).toBe("Waiting for your permission")
  })

  it("draws no badge once the question is answered, nor on another conversation", async () => {
    const fake = installFakeBridge(
      liveSession("conv-other", "agent-1", { pendingPermissions: [PROMPT] }),
    )
    renderTab(makeTab("conv-local", { expanded: false }))
    await screen.findByText("Rapports")
    expect(screen.queryByTestId("dock-tab-permission")).toBeNull()
    fake.push({ threadId: "conv-local", pendingPermissions: [] })
    await Promise.resolve()
    expect(screen.queryByTestId("dock-tab-permission")).toBeNull()
  })
})
