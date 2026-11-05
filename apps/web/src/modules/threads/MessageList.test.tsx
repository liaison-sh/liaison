// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import {
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  loadMessagesIntoStore,
  setHiddenRuns,
} from "~/modules/threads/message-store"

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

function makeMessage(index: number) {
  return {
    id: `m-${index + 1}`,
    threadId: "thread-flow",
    authorId: "u1",
    authorName: "Alex",
    authorAvatarUrl: null,
    authorType: "user" as const,
    authorAgentId: null,
    content: `Message ${index + 1}`,
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(2024, 0, 1, 12, index).toISOString(),
  }
}

function renderList(isActive: () => boolean = () => true, threadId = "thread-flow") {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={isActive}>
              <div style={{ display: "flex", height: "480px", "flex-direction": "column" }}>
                <MessageList threadId={threadId} currentUserId="u1" />
              </div>
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("MessageList natural-flow rendering", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-flow", [])
    cleanup()
  })

  it("renders the whole loaded window in document flow — no estimate-based virtualization", async () => {
    // The bug we replaced: an absolute-positioned virtualizer positioned rows by
    // a fixed size estimate, so variable-height messages overlapped and the
    // scroll geometry was wrong. Natural flow renders every loaded row at its
    // true height — both the newest and an older message are present in the DOM.
    loadMessagesIntoStore(
      "thread-flow",
      Array.from({ length: 60 }, (_, index) => makeMessage(index)),
    )

    const view = renderList()

    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-index]").length).toBeGreaterThanOrEqual(60),
    )
    expect(screen.getByText("Message 1")).toBeInTheDocument()
    expect(screen.getByText("Message 60")).toBeInTheDocument()
    // No absolute positioning / translateY offsets — rows are laid out normally.
    const firstRow = view.container.querySelector<HTMLElement>('[data-index="1"]')
    expect(firstRow?.style.position).toBe("")
    expect(firstRow?.style.transform).toBe("")
  })

  it("keeps existing rows mounted when a new message arrives (no full-list remount)", async () => {
    // Regression: `items()` used to wrap every message in a fresh
    // `{ kind, msg, grouped }` object on each recompute, so `<For>` (which keys
    // by referential identity) disposed and recreated EVERY row on any new
    // message — remounting an inline ApprovalCard and making the whole thread
    // visibly flicker on each agent reply. The stable wrapper cache must reuse a
    // row's element across an append, so its DOM node identity is preserved.
    loadMessagesIntoStore(
      "thread-flow",
      Array.from({ length: 4 }, (_, index) => makeMessage(index)),
    )
    const view = renderList()
    await waitFor(() => expect(screen.getByText("Message 2")).toBeInTheDocument())

    const rowBefore = screen.getByText("Message 2").closest("[data-index]")
    expect(rowBefore).not.toBeNull()

    // A real WS append (produce-based) preserves the existing message proxies —
    // the same shape a live agent reply takes.
    handleWsMessageEvent("create", makeMessage(4))
    await waitFor(() => expect(screen.getByText("Message 5")).toBeInTheDocument())

    const rowAfter = screen.getByText("Message 2").closest("[data-index]")
    // Same physical element — the row was NOT torn down and rebuilt.
    expect(rowAfter).toBe(rowBefore)
  })

  it("renders a live agent turn while the thread stream is in progress", async () => {
    renderList()

    handleWsAgentStreamEvent("start", { threadId: "thread-flow" })
    handleWsAgentStreamEvent("delta", { threadId: "thread-flow", delta: "Streaming reply" })

    await waitFor(() => {
      expect(screen.getByText("▋")).toBeInTheDocument()
    })
  })
})

// P4c-T10: the thread view is the ONLY agent surface once the side panel is
// retired, so the turn's own furniture has to render here — the tool activity
// the run produced and the approval card a gated call raised.
describe("MessageList agent turn parity with the retired panel (P4c-T10)", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-flow", [])
    cleanup()
  })

  it("an agent turn in the thread view renders tool call rows and the approval card", async () => {
    loadMessagesIntoStore("thread-flow", [
      {
        ...makeMessage(0),
        authorType: "agent" as const,
        authorAgentId: "a-1",
        content: "I need approval to send that reply.",
        metadata: {
          timeline: [{ kind: "tool", toolCallId: "call-1" }],
          toolCalls: [
            {
              toolCallId: "call-1",
              toolName: "mail__reply",
              status: "completed",
              args: { conversationId: "c-1" },
              result: { blocked: true, approvalRequestId: "req-1" },
            },
          ],
        },
      } as never,
    ])

    renderList()

    await waitFor(() => expect(screen.getByTestId("tool-call-row")).toBeInTheDocument())
    expect(screen.getByTestId("approval-card")).toBeInTheDocument()
  })
})

describe("MessageList auto-add system line (FX4)", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-flow", [])
    cleanup()
  })

  /** The exact row GET /api/threads/:id/messages returns for the line S9's
   *  auto-add writes: author_type 'system', the adder as the author, no agent. */
  const autoAddLine = {
    id: "m-sys-1",
    threadId: "thread-flow",
    authorId: "u1",
    authorName: "Alex",
    authorAvatarUrl: null,
    authorType: "system" as const,
    authorAgentId: null,
    content: "Alex added @finance (mentioned)",
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(2024, 0, 1, 12, 5).toISOString(),
  }

  it("renders the line from a loaded page", async () => {
    loadMessagesIntoStore("thread-flow", [autoAddLine])
    renderList()
    await waitFor(() =>
      expect(screen.getByText("Alex added @finance (mentioned)")).toBeInTheDocument(),
    )
  })

  it("renders the line when it arrives live on message:create", async () => {
    renderList()
    handleWsMessageEvent("create", autoAddLine)
    await waitFor(() =>
      expect(screen.getByText("Alex added @finance (mentioned)")).toBeInTheDocument(),
    )
  })
})

describe("MessageList hidden-messages marker (P4b-T25)", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-flow", [])
    setHiddenRuns("thread-flow", [])
    cleanup()
  })

  it("renders the singular hidden-messages string for a hidden count of 1", async () => {
    loadMessagesIntoStore("thread-flow", [makeMessage(0), makeMessage(1)])
    setHiddenRuns("thread-flow", [{ afterMessageId: "m-1", count: 1 }])
    renderList()
    await waitFor(() => expect(screen.getByText("1 message hidden")).toBeInTheDocument())
  })

  it("renders the plural hidden-messages string with the correct number for a hidden count of 3", async () => {
    loadMessagesIntoStore("thread-flow", [makeMessage(0), makeMessage(1)])
    setHiddenRuns("thread-flow", [{ afterMessageId: "m-1", count: 3 }])
    renderList()
    await waitFor(() => expect(screen.getByText("3 messages hidden")).toBeInTheDocument())
  })

  it("a run anchored to nothing renders above the first message", async () => {
    loadMessagesIntoStore("thread-flow", [makeMessage(0)])
    setHiddenRuns("thread-flow", [{ afterMessageId: null, count: 2 }])
    const view = renderList()
    await waitFor(() => expect(screen.getByText("2 messages hidden")).toBeInTheDocument())
    const rows = Array.from(view.container.querySelectorAll("[data-index]"))
    const markerIndex = rows.findIndex((el) => el.textContent?.includes("2 messages hidden"))
    const messageIndex = rows.findIndex((el) => el.textContent?.includes("Message 1"))
    expect(markerIndex).toBeLessThan(messageIndex)
  })

  it("renders no marker when the thread reports no hidden runs", async () => {
    loadMessagesIntoStore("thread-flow", [makeMessage(0)])
    setHiddenRuns("thread-flow", [])
    renderList()
    await waitFor(() => expect(screen.getByText("Message 1")).toBeInTheDocument())
    expect(screen.queryByTestId("hidden-messages-marker")).not.toBeInTheDocument()
  })
})

describe("MessageList mounts the withheld-capability card (P4b-T31)", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-flow", [])
    cleanup()
  })

  it("renders the card under a message whose turn withheld a capability", async () => {
    loadMessagesIntoStore("thread-flow", [
      {
        ...makeMessage(0),
        authorType: "agent" as const,
        authorAgentId: "a-1",
        metadata: { withheld: { items: [{ label: "finance data" }] } },
      } as never,
    ])
    renderList()
    await waitFor(() =>
      expect(screen.getByText("Some capabilities are unavailable here")).toBeInTheDocument(),
    )
  })

  it("renders no card for a message that withheld nothing", async () => {
    loadMessagesIntoStore("thread-flow", [makeMessage(0)])
    renderList()
    await waitFor(() => expect(screen.getByText("Message 1")).toBeInTheDocument())
    expect(screen.queryByTestId("withheld-card")).not.toBeInTheDocument()
  })

  // P6d-FX3 (W7), found driving the walk. The turn block mounted on the SERVER
  // agent stream alone. A local session runs the turn on the operator's own
  // machine and opens no server stream, so the block never mounted, the tool
  // activity rows had nowhere to render and the inline permission card with
  // them: the turn sat blocked on a prompt the window could not draw.
  it("renders the local turn's tool rows while a session on this machine is running", async () => {
    loadMessagesIntoStore("thread-local", [{ ...makeMessage(0), threadId: "thread-local" }])
    const fake = installFakeBridge({
      sessionStatus: "running",
      threadId: "thread-local",
      agentId: "agent-1",
      toolActivity: [
        {
          id: "call-1",
          toolName: "Write",
          summary: "file_path: hello3.txt",
          status: "running",
          startedAt: 1,
        },
      ],
    })
    try {
      renderList(() => true, "thread-local")
      await waitFor(() => expect(screen.getByText("Message 1")).toBeInTheDocument())
      await waitFor(() => expect(screen.getByTestId("tool-call-row")).toBeInTheDocument())
    } finally {
      fake.calls.stopped
      uninstallFakeBridge()
      cleanup()
    }
  })

  // A session claimed for ANOTHER conversation is none of this thread's
  // business (A32), and a block mounted for it would paint a folder on the
  // operator's machine into a room that never ran it.
  it("renders nothing here for a local session running in another conversation", async () => {
    loadMessagesIntoStore("thread-elsewhere", [{ ...makeMessage(0), threadId: "thread-elsewhere" }])
    installFakeBridge({
      sessionStatus: "running",
      threadId: "another-thread",
      agentId: "agent-1",
      toolActivity: [
        {
          id: "call-1",
          toolName: "Write",
          summary: "file_path: hello3.txt",
          status: "running",
          startedAt: 1,
        },
      ],
    })
    try {
      renderList(() => true, "thread-elsewhere")
      await waitFor(() => expect(screen.getByText("Message 1")).toBeInTheDocument())
      expect(screen.queryByTestId("tool-call-row")).not.toBeInTheDocument()
    } finally {
      uninstallFakeBridge()
      cleanup()
    }
  })
})
