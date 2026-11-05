// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AGENT CONTEXT BOUNDARY ROW (card 19, A50, spec.md copy table "Thread
// view, agent context boundary row").
//
// After the warm window the chat still shows the whole conversation while the
// agent is fed the brief plus the tail, and this row is where that divergence
// starts: it follows the message the agent's checkpoint covers. The API side
// (`agentContextFrom` on the thread payload) is pinned in routes.test.ts; this
// is the render, which had no test at all: on the live box the row never
// appeared and there was nothing here to say whether the renderer or the
// payload was at fault.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import { loadMessagesIntoStore } from "~/modules/threads/message-store"

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

const THREAD = "thread-boundary"

const msg = (id: string, content: string, minute: number) => ({
  id,
  threadId: THREAD,
  authorId: "u1",
  authorName: "Alex",
  authorAvatarUrl: null,
  authorType: "user" as const,
  authorAgentId: null,
  parentMessageId: null,
  content,
  mentions: null,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(2024, 0, 1, 12, minute).toISOString(),
})

const FIXTURE = [
  msg("m1", "what did we decide about the pallet", 0),
  msg("m2", "it ships tuesday", 1),
  msg("m3", "and the customs form", 2),
]

function renderList(props: { agentContextFrom?: string | null; agentName?: string | null }) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={() => true}>
              <div style={{ display: "flex", height: "480px", "flex-direction": "column" }}>
                <MessageList
                  threadId={THREAD}
                  currentUserId="u1"
                  agentContextFrom={props.agentContextFrom ?? null}
                  agentContextAgentName={props.agentName ?? null}
                />
              </div>
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("MessageList agent context boundary", () => {
  afterEach(() => {
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("renders the boundary row after the message the checkpoint covers", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList({ agentContextFrom: "m2", agentName: "Support Desk" })
    await waitFor(() => expect(screen.getByTestId("agent-context-boundary")).toBeTruthy())
    const row = screen.getByTestId("agent-context-boundary")
    // The copy table string, with the agent named. No dash punctuation.
    expect(row.textContent).toBe(
      "Earlier messages are summarized for Support Desk. It can search them.",
    )
  })

  it("renders nothing when the thread has no checkpoint", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList({ agentContextFrom: null, agentName: "Support Desk" })
    await waitFor(() => expect(screen.getByText("it ships tuesday")).toBeTruthy())
    expect(screen.queryByTestId("agent-context-boundary")).toBeNull()
  })

  it("renders nothing when no agent is named, rather than a row naming nobody", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList({ agentContextFrom: "m2", agentName: null })
    await waitFor(() => expect(screen.getByText("it ships tuesday")).toBeTruthy())
    expect(screen.queryByTestId("agent-context-boundary")).toBeNull()
  })

  // THE READER HAS TO SEE IT (surface 19). The row renders in flow, which on a
  // long conversation is thousands of pixels above the fold while the view
  // opens at the bottom: measured on the live box the row sat at top -5075 px,
  // 29 messages back, and nobody ever met it.
  describe("the above-the-fold notice", () => {
    /** Put the boundary row above the scrollport's top edge. */
    function pinBoundaryAboveFold(above: boolean) {
      const row = screen.getByTestId("agent-context-boundary")
      const container = screen.getByTestId("message-scroll-container")
      container.getBoundingClientRect = () => ({ top: 0, bottom: 480 }) as DOMRect
      row.getBoundingClientRect = () =>
        (above ? { top: -80, bottom: -60 } : { top: 100, bottom: 120 }) as DOMRect
      container.dispatchEvent(new Event("scroll"))
    }

    it("rides at the top of the viewport while the row is above the fold, and scrolls to it", async () => {
      loadMessagesIntoStore(THREAD, FIXTURE)
      renderList({ agentContextFrom: "m1", agentName: "Support Desk" })
      await waitFor(() => expect(screen.getByTestId("agent-context-boundary")).toBeTruthy())
      pinBoundaryAboveFold(true)

      await waitFor(() => expect(screen.getByTestId("agent-context-boundary-notice")).toBeTruthy())
      const notice = screen.getByTestId("agent-context-boundary-notice")
      // Two messages follow the boundary in the fixture.
      expect(notice.textContent).toBe("The agent's context starts 2 messages up")

      const row = screen.getByTestId("agent-context-boundary")
      const scrolled: unknown[] = []
      ;(row as HTMLElement).scrollIntoView = (arg?: unknown) => {
        scrolled.push(arg)
      }
      notice.click()
      expect(scrolled).toHaveLength(1)
    })

    it("stays hidden while the row is on screen", async () => {
      loadMessagesIntoStore(THREAD, FIXTURE)
      renderList({ agentContextFrom: "m1", agentName: "Support Desk" })
      await waitFor(() => expect(screen.getByTestId("agent-context-boundary")).toBeTruthy())
      pinBoundaryAboveFold(false)
      await waitFor(() => expect(screen.getByText("it ships tuesday")).toBeTruthy())
      expect(screen.queryByTestId("agent-context-boundary-notice")).toBeNull()
    })
  })

  it("moves with the checkpoint", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    const { unmount } = renderList({ agentContextFrom: "m1", agentName: "Support Desk" })
    await waitFor(() => expect(screen.getByTestId("agent-context-boundary")).toBeTruthy())
    unmount()
    renderList({ agentContextFrom: "m3", agentName: "Support Desk" })
    await waitFor(() => expect(screen.getByTestId("agent-context-boundary")).toBeTruthy())
    // The row follows the LAST message now, so nothing renders after it.
    const rows = screen.getAllByTestId("agent-context-boundary")
    expect(rows).toHaveLength(1)
  })
})
