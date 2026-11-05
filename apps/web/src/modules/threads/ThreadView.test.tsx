// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import * as authStoreModule from "~/modules/auth/auth-store"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import * as mailboxRuntimeModule from "~/modules/mailbox/mailbox-agent-runtime"
import { ApiProvider } from "~/modules/shell/ApiContext"
import * as entityOpenerModule from "~/modules/shell/entity-opener"
import { openTab } from "~/modules/shell/tab-store"
import { WsProvider } from "~/modules/shell/WsContext"
import ThreadView from "~/modules/threads/ThreadView"
import * as threadStoreModule from "~/modules/threads/thread-store"

// These tests read as a user at the window. jsdom gives its document no focus,
// and read marks wait for a focused window (the unfocused case is tested on
// its own below).
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
})
afterEach(() => {
  vi.mocked(document.hasFocus).mockRestore?.()
})

/** Replace the message with `text`, typed through the composer's real
 *  RichEditor (a raw textContent write never reaches its document, so the
 *  composer would see an empty field and send nothing). */
function typeInEditor(editor: HTMLElement, text: string) {
  const ed = editorOf(editor)
  ed.commands.clearContent()
  typeInto(ed, text)
}

/**
 * Capture what actually leaves the browser. The assertions read the POST body
 * the api client serializes, not the opts object the view handed over: a field
 * the message store drops on the floor is invisible to a spy on sendMessage.
 */
function interceptSendWire(onPost?: () => void) {
  const bodies: Record<string, unknown>[] = []
  const previousFetch = globalThis.fetch
  const okResponse = {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: () => Promise.resolve("{}"),
    json: () => Promise.resolve({ data: null }),
  }
  const fetchSpy = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    if (typeof url === "string" && url.endsWith("/messages") && init?.method === "POST") {
      bodies.push(JSON.parse(init.body ?? "{}"))
      onPost?.()
    }
    return Promise.resolve(okResponse)
  })
  vi.stubGlobal("fetch", fetchSpy)
  return {
    bodies,
    restore: () => vi.stubGlobal("fetch", previousFetch),
  }
}

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")
const mockWsSend = vi.fn()

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve("{}"),
    }),
  ),
)

describe("ThreadView — prop-driven", () => {
  afterEach(() => cleanup())

  it("renders fallback when thread is not in the store", () => {
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-1" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))
    // Thread is not in the store, so fallback should render
    expect(screen.getByText("Select a thread from the sidebar")).toBeInTheDocument()
    // Compose bar should NOT be present
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("shows compose bar when thread is loaded in store", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-1",
      handle: "test",
      title: "Test Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-1" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    // Should show the compose area, not the "select a thread" fallback
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    expect(screen.queryByText("Select a thread from the sidebar")).not.toBeInTheDocument()
  })

  it("renders an approval thread without a separate top approval-card section (approvals now render inline in the message stream)", async () => {
    // An approval thread is opened by id, never listed: the view reads its
    // detail from the server, and that detail does not make it a chat row.
    const { allThreads } = await import("~/modules/threads/thread-store")
    const detail = {
      id: "test-thread-approval",
      handle: "test-approval",
      title: "Approval Thread",
      type: "approval",
      hiddenFromList: true,
      createdFrom: null,
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    }
    const previousFetch = globalThis.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const isDetail =
          typeof url === "string" && /\/threads\/test-thread-approval(\?|$)/.test(url)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: () => Promise.resolve(JSON.stringify(isDetail ? { data: detail } : { data: [] })),
        })
      }),
    )
    onTestFinished(() => {
      vi.stubGlobal("fetch", previousFetch)
    })

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-approval" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    // The thread mounts (compose bar present) but there is no separate top
    // header/cards region: approvals now render inline in MessageList at each
    // "approval-created" post, chronologically — the same treatment agent chats
    // give a gated tool call. No cards-on-top vs non-clickable-list-below split.
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("approval-thread-header")).not.toBeInTheDocument()
    expect(allThreads().some((t) => t.id === "test-thread-approval")).toBe(false)
  })

  it("clears attention rows for the thread on mount when the tab is active and visible (markAttentionRead(kernel, thread, id))", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-attn-mount",
      handle: "test-attn-mount",
      title: "Attention Mount Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    // Activate the thread's tab before mount — ThreadView's mark-read effect
    // is gated on isActiveTab() && document.visibilityState === "visible".
    openTab({ type: "thread", entityId: "test-thread-attn-mount", label: "Attention Mount Thread" })

    const markAttentionReadSpy = vi
      .spyOn(entityOpenerModule, "markAttentionRead")
      .mockImplementation(() => {})

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-attn-mount" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(markAttentionReadSpy).toHaveBeenCalledWith(
        expect.anything(),
        "kernel",
        "thread",
        "test-thread-attn-mount",
      )
    })

    markAttentionReadSpy.mockRestore()
  })

  it("clears attention rows for the thread when the tab becomes visible again (visibilitychange path)", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-attn-visible",
      handle: "test-attn-visible",
      title: "Attention Visibility Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    openTab({
      type: "thread",
      entityId: "test-thread-attn-visible",
      label: "Attention Visibility Thread",
    })

    const markAttentionReadSpy = vi
      .spyOn(entityOpenerModule, "markAttentionRead")
      .mockImplementation(() => {})

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-attn-visible" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(markAttentionReadSpy).toHaveBeenCalled()
    })
    // The mount-time effect already covers the "active + visible" case above;
    // isolate the visibilitychange listener's own call by clearing first.
    markAttentionReadSpy.mockClear()

    const visibilityStateSpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible")
    document.dispatchEvent(new Event("visibilitychange"))

    expect(markAttentionReadSpy).toHaveBeenCalledWith(
      expect.anything(),
      "kernel",
      "thread",
      "test-thread-attn-visible",
    )

    visibilityStateSpy.mockRestore()
    markAttentionReadSpy.mockRestore()
  })
})

// P4c-T51 (A50): after a cold resume the chat still shows the whole
// conversation while the agent is fed the brief plus the tail. The reader sees
// where that boundary is instead of being surprised by it.
describe("ThreadView — agent context boundary", () => {
  beforeEach(() => {
    // "The OTHER member" is only answerable against a signed in viewer; the
    // rest of this file never needed one.
    vi.spyOn(authStoreModule, "userFromToken").mockReturnValue({
      userId: "u1",
      name: "Test User",
      scopes: [],
    } as unknown as ReturnType<typeof authStoreModule.userFromToken>)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  function seedMessages(threadId: string, ids: string[]) {
    return import("~/modules/threads/message-store").then(({ loadMessagesIntoStore }) =>
      loadMessagesIntoStore(
        threadId,
        ids.map((id, index) => ({
          id,
          threadId,
          authorId: "u1",
          authorName: "Test User",
          authorAvatarUrl: null,
          authorType: "user" as const,
          authorAgentId: null,
          content: `Body of ${id}`,
          mentions: null,
          reactions: [],
          editedAt: null,
          deletedAt: null,
          createdAt: new Date(2024, 0, 1, 12, index).toISOString(),
        })),
      ),
    )
  }

  function renderThread(entityId: string) {
    return render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId={entityId} />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))
  }

  it("a DM with an agent checkpoint renders the boundary row at uptoMessageId", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    await seedMessages("t-boundary-dm", ["m-1", "m-2", "m-3"])
    addThread({
      id: "t-boundary-dm",
      handle: "boundary-dm",
      title: null,
      type: "agent_chat",
      isPinned: false,
      agentContextFrom: "m-2",
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        {
          id: "a1",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a1",
        },
      ],
    })

    const view = renderThread("t-boundary-dm")

    const row = await waitFor(() => screen.getByTestId("agent-context-boundary"))
    expect(row).toHaveTextContent(
      "Earlier messages are summarized for Liaison. It can search them.",
    )
    // Exactly one, and it sits at the checkpoint: everything ABOVE it is what
    // the agent reads as a summary, so it follows the message it is stamped on.
    expect(screen.getAllByTestId("agent-context-boundary")).toHaveLength(1)
    expect(row.getAttribute("data-upto-message-id")).toBe("m-2")
    const indexed = [...view.container.querySelectorAll<HTMLElement>("[data-index]")]
    const boundaryIndex = indexed.findIndex((el) =>
      el.querySelector("[data-testid='agent-context-boundary']"),
    )
    const secondMessageIndex = indexed.findIndex((el) => el.textContent?.includes("Body of m-2"))
    const thirdMessageIndex = indexed.findIndex((el) => el.textContent?.includes("Body of m-3"))
    expect(boundaryIndex).toBeGreaterThan(secondMessageIndex)
    expect(boundaryIndex).toBeLessThan(thirdMessageIndex)
    // Not a message and not selectable: no row actions, nothing focusable.
    expect(row.querySelector("button")).toBeNull()
    expect(row.getAttribute("aria-hidden")).toBeNull()
  })

  it("a DM without a checkpoint renders none", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    await seedMessages("t-boundary-nocp", ["n-1", "n-2"])
    addThread({
      id: "t-boundary-nocp",
      handle: "boundary-nocp",
      title: null,
      type: "agent_chat",
      isPinned: false,
      agentContextFrom: null,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        { id: "a1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a1" },
      ],
    })

    renderThread("t-boundary-nocp")

    await waitFor(() => expect(screen.getByText("Body of n-2")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-context-boundary")).not.toBeInTheDocument()
  })

  it("a room with two agents renders the boundary, named for the agent it belongs to", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    await seedMessages("t-boundary-channel", ["c-1", "c-2"])
    // The view used to refuse the row a second time from its own roster (it
    // demanded a SOLE agent counterpart), so a DM that had picked up a second
    // agent by mention could never show it. The server names whose boundary it
    // is and the view draws that.
    addThread({
      id: "t-boundary-channel",
      handle: "boundary-channel",
      title: "Ops room",
      type: "thread",
      discoverable: true,
      isPinned: false,
      agentContextFrom: "c-1",
      agentContextAgentId: "a2",
      agentContextAgentName: "Support",
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        { id: "a1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a1" },
        { id: "a2", name: "Support", avatarUrl: null, participantType: "agent", agentId: "a2" },
      ],
    })

    renderThread("t-boundary-channel")

    const row = await waitFor(() => screen.getByTestId("agent-context-boundary"))
    expect(row).toHaveTextContent(
      "Earlier messages are summarized for Support. It can search them.",
    )
    expect(row.getAttribute("data-upto-message-id")).toBe("c-1")
  })
})

describe("ThreadView — dock surface", () => {
  afterEach(() => cleanup())

  it("dock surface treats the view as active when its tab is expanded", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-dock-active",
      handle: "test-dock-active",
      title: "Dock Active Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })

    const markThreadReadSpy = vi
      .spyOn(threadStoreModule, "markThreadRead")
      .mockImplementation(() => {})
    const [isExpanded, setIsExpanded] = createSignal(false)

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView
                  entityId="test-thread-dock-active"
                  surface="dock"
                  isActive={isExpanded}
                />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    // Collapsed dock tab: NOT marked read, even though it's mounted.
    expect(markThreadReadSpy).not.toHaveBeenCalled()

    setIsExpanded(true)

    await waitFor(() => {
      expect(markThreadReadSpy).toHaveBeenCalledWith(expect.anything(), "test-thread-dock-active")
    })

    markThreadReadSpy.mockRestore()
  })

  // A message arriving in a thread open in the dock (or the tablet Chats sheet)
  // is not "the visible active TAB" to the socket handler, so it bumped the
  // count and nothing told the server: the pill reappeared on the list and on
  // every other device. On screen means read, on the server too.
  it("a message arriving while the dock conversation is expanded is marked read on the server", async () => {
    const { addThread, handleMessageEvent, getThread } = await import(
      "~/modules/threads/thread-store"
    )
    addThread({
      id: "test-thread-dock-arrival",
      handle: "test-dock-arrival",
      title: "Dock Arrival Thread",
      isPinned: false,
      unreadCount: 0,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    const markThreadReadSpy = vi.spyOn(threadStoreModule, "markThreadRead")
    const [isExpanded, setIsExpanded] = createSignal(true)

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView
                  entityId="test-thread-dock-arrival"
                  surface="dock"
                  isActive={isExpanded}
                />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    markThreadReadSpy.mockClear()

    // The bootstrap handler's own verdict for a dock thread: not the active tab.
    const arrive = (n: number) =>
      handleMessageEvent(
        "create",
        {
          id: `m-${n}`,
          threadId: "test-thread-dock-arrival",
          content: `hello ${n}`,
          authorId: "someone-else",
          authorType: "user",
          createdAt: new Date().toISOString(),
        },
        { isVisibleActiveThread: false, isOwnAction: false },
      )

    arrive(1)
    await waitFor(() => {
      expect(markThreadReadSpy).toHaveBeenCalledWith(expect.anything(), "test-thread-dock-arrival")
    })
    expect(getThread("test-thread-dock-arrival")?.unreadCount).toBe(0)

    // Collapsed: the conversation is not on screen, so the message stays unread.
    setIsExpanded(false)
    markThreadReadSpy.mockClear()
    arrive(2)
    await new Promise((r) => setTimeout(r, 20))
    expect(markThreadReadSpy).not.toHaveBeenCalled()
    expect(getThread("test-thread-dock-arrival")?.unreadCount).toBe(1)

    markThreadReadSpy.mockRestore()
  })

  // A window left open on a conversation, behind other apps or on a Mac nobody
  // is in front of, keeps its page `visible`. Its read mark cleared the unread
  // pill on the reader's phone before they had seen the message. Read means the
  // window has the focus; coming back to the window reads what landed.
  it("a message arriving while the window has no focus stays unread until the window is focused", async () => {
    const { addThread, handleMessageEvent, getThread } = await import(
      "~/modules/threads/thread-store"
    )
    addThread({
      id: "test-thread-unfocused",
      handle: "test-unfocused",
      title: "Unfocused Thread",
      isPinned: false,
      unreadCount: 0,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const markThreadReadSpy = vi
      .spyOn(threadStoreModule, "markThreadRead")
      .mockImplementation((_api, id) => threadStoreModule.setThreadUnreadCount(id, 0))
    const [isExpanded] = createSignal(true)

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-unfocused" surface="dock" isActive={isExpanded} />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    markThreadReadSpy.mockClear()

    focus.mockReturnValue(false)
    window.dispatchEvent(new Event("blur"))
    handleMessageEvent(
      "create",
      {
        id: "m-unfocused-1",
        threadId: "test-thread-unfocused",
        content: "well done",
        authorId: "someone-else",
        authorType: "user",
        createdAt: new Date().toISOString(),
      },
      { isVisibleActiveThread: false, isOwnAction: false },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(markThreadReadSpy).not.toHaveBeenCalled()
    expect(getThread("test-thread-unfocused")?.unreadCount).toBe(1)

    focus.mockReturnValue(true)
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => {
      expect(markThreadReadSpy).toHaveBeenCalledWith(expect.anything(), "test-thread-unfocused")
    })
    expect(getThread("test-thread-unfocused")?.unreadCount).toBe(0)

    markThreadReadSpy.mockRestore()
    focus.mockRestore()
  })

  it("dock surface renders no ThreadHeader", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-dock-noheader",
      handle: "test-dock-noheader",
      title: "Dock No Header Thread",
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        { id: "u2", name: "Other User", avatarUrl: null },
      ],
    })

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView
                  entityId="test-thread-dock-noheader"
                  surface="dock"
                  isActive={() => true}
                />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
    // participant-count only exists inside ThreadHeader — its absence means
    // the dock surface did not render a ThreadHeader of its own.
    expect(screen.queryByTestId("participant-count")).not.toBeInTheDocument()
  })

  it("the send body's currentView is the main panel's active tab even from the dock", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-dock-send",
      handle: "test-dock-send",
      title: "Dock Send Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    // The main panel's active tab is some OTHER entity entirely (an app tab,
    // not this thread and not the dock) — the dock has no tab-store entry.
    openTab({ type: "thread", entityId: "main-panel-thread", label: "Main Panel Thread" })

    const { bodies, restore } = interceptSendWire()

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-dock-send" surface="dock" isActive={() => true} />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    const editor = await waitFor(() => screen.getByRole("textbox"))
    typeInEditor(editor, "hello from the dock")
    fireEvent.keyDown(editor, { key: "Enter" })

    await waitFor(() => {
      expect(bodies).toHaveLength(1)
    })
    // The panel's shape, not a bare tab id: the agent turn reads tabType +
    // entityId, and a string is dropped on the floor by the API schema.
    expect(bodies[0].currentView).toEqual({ tabType: "thread", entityId: "main-panel-thread" })

    restore()
  })

  // P4c FX-B3 (D5): the scope used to close when the POST settled. The api
  // answers the POST and only THEN dispatches the agent turn, so every mailbox
  // decrypt request the turn makes arrives after that: the browser refused them
  // all. The scope now lives as long as the turn, as the thread stream sees it.
  it("a thread send binds the mailbox turn nonce and holds it until the agent turn completes", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    addThread({
      id: "test-thread-nonce",
      handle: "test-nonce",
      title: "Nonce Thread",
      isPinned: false,
      participants: [{ id: "u1", name: "Test User", avatarUrl: null }],
    })
    openTab({ type: "thread", entityId: "main-panel-thread", label: "Main Panel Thread" })

    const order: string[] = []
    const beginSpy = vi
      .spyOn(mailboxRuntimeModule, "beginMailboxAgentTurn")
      .mockImplementation(() => {
        order.push("begin")
        return "nonce-abcdef12"
      })
    const endSpy = vi.spyOn(mailboxRuntimeModule, "endMailboxAgentTurn").mockImplementation(() => {
      order.push("end")
    })
    const { bodies, restore } = interceptSendWire(() => order.push("post"))

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-nonce" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    const editor = await waitFor(() => screen.getByRole("textbox"))
    typeInEditor(editor, "decrypt my mail please")
    fireEvent.keyDown(editor, { key: "Enter" })

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].turnNonce).toBe("nonce-abcdef12")
    expect(order.indexOf("begin")).toBeLessThan(order.indexOf("post"))

    // The POST has settled. The turn has not: the scope stays open.
    await new Promise((r) => setTimeout(r, 20))
    expect(endSpy).not.toHaveBeenCalled()

    // The turn ending on the thread stream is what closes it.
    const { handleWsAgentStreamEvent } = await import("~/modules/threads/message-store")
    handleWsAgentStreamEvent("done", { threadId: "test-thread-nonce" })
    await waitFor(() => expect(endSpy).toHaveBeenCalledWith("nonce-abcdef12"))
    expect(order.indexOf("post")).toBeLessThan(order.indexOf("end"))

    // No mailbox session live ⇒ no nonce at all, and no `turnNonce` key on the
    // wire (an undefined one would read as "a nonce this browser forgot").
    beginSpy.mockImplementation(() => null)
    typeInEditor(editor, "and again with no mailbox session")
    fireEvent.keyDown(editor, { key: "Enter" })
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).not.toHaveProperty("turnNonce")

    restore()
    beginSpy.mockRestore()
    endSpy.mockRestore()
  })
})

// THE REPORTED DEFECT, through the real composer: a DM with an agent whose
// runtime control says "This machine", no folder ever chosen. The message used
// to be posted as a Liaison one and the server's agent answered it. Now the
// picker opens, and closing it posts nothing, says so, and hands the draft back.
describe("ThreadView — a conversation that runs on this machine", () => {
  beforeEach(() => {
    vi.spyOn(authStoreModule, "userFromToken").mockReturnValue({
      userId: "u1",
      name: "Test User",
      scopes: [],
    } as unknown as ReturnType<typeof authStoreModule.userFromToken>)
  })
  afterEach(async () => {
    const { uninstallFakeBridge } = await import("~/modules/desktop/fake-bridge")
    uninstallFakeBridge()
    vi.restoreAllMocks()
    cleanup()
  })

  it("posts nothing to the server when the local session cannot start, and gives the draft back", async () => {
    const { addThread } = await import("~/modules/threads/thread-store")
    const { installFakeBridge } = await import("~/modules/desktop/fake-bridge")
    const { toasts, resetToastStore } = await import("~/modules/shell/toast-store")
    resetToastStore()
    addThread({
      id: "test-thread-local-dm",
      handle: "dm-data",
      title: null,
      type: "agent_chat",
      isPinned: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null },
        {
          id: "seat-data",
          name: "Data",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a-data",
        },
      ],
    })
    const shell = installFakeBridge({ runtimeLocation: "local" }, { pickFolderResult: null })
    const { bodies, restore } = interceptSendWire()

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={mockWsSend} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId="test-thread-local-dm" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    const editor = await waitFor(() => screen.getByRole("textbox", { name: "Write a message" }))
    typeInEditor(editor, "make the monthly report")
    fireEvent.keyDown(editor, { key: "Enter" })

    await waitFor(() => expect(editor.textContent).toBe("make the monthly report"))
    expect(shell.calls.pickedFolder).toBe(1)
    expect(bodies).toHaveLength(0)
    expect(toasts().map((toast) => toast.message)).toContain(
      "Not sent. This conversation runs on this machine: choose a folder for it, then send again.",
    )
    restore()
  })
})
