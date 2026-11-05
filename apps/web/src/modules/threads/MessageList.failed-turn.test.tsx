// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A FAILED TURN IS NOT AN EMPTY ROOM (card 8).
//
// On the Failed capture the room showed the red banner and the state line over
// nothing at all: the user's own message row was missing, and so was the empty
// state, which was gated on the agent stream being IDLE (a failed turn is not).
// A messages load that had failed rendered nothing either: no rows, no line.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import {
  handleWsAgentStreamEvent,
  loadMessages,
  loadMessagesIntoStore,
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

const THREAD = "thread-failed-turn"

const userRow = {
  id: "u1m",
  threadId: THREAD,
  authorId: "u1",
  authorName: "Alex",
  authorAvatarUrl: null,
  authorType: "user" as const,
  authorAgentId: null,
  parentMessageId: null,
  content: "Say hello in one word.",
  mentions: null,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(2024, 0, 1, 12, 0).toISOString(),
}

function renderList() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={() => true}>
              <div style={{ display: "flex", height: "480px", "flex-direction": "column" }}>
                <MessageList threadId={THREAD} currentUserId="u1" />
              </div>
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("MessageList after a failed turn", () => {
  afterEach(() => {
    loadMessagesIntoStore(THREAD, [])
    handleWsAgentStreamEvent("clear", { threadId: THREAD })
    cleanup()
  })

  it("keeps the user's own message under the Failed banner", async () => {
    loadMessagesIntoStore(THREAD, [userRow])
    handleWsAgentStreamEvent("error", {
      threadId: THREAD,
      message: "Model not available",
      agentId: "a1",
    })
    renderList()
    await waitFor(() =>
      expect(screen.getAllByText("Model not available").length).toBeGreaterThan(0),
    )
    expect(screen.getByText("Say hello in one word.")).toBeTruthy()
  })

  it("says the room is empty after a failed turn instead of rendering nothing", async () => {
    loadMessagesIntoStore(THREAD, [])
    handleWsAgentStreamEvent("error", {
      threadId: THREAD,
      message: "Model not available",
      agentId: "a1",
    })
    renderList()
    await waitFor(() =>
      expect(screen.getAllByText("Model not available").length).toBeGreaterThan(0),
    )
    expect(screen.getByText("No messages yet. Start the conversation!")).toBeTruthy()
  })

  it("an unpaid renewal (payment_required) says so with a link to Billing", async () => {
    loadMessagesIntoStore(THREAD, [userRow])
    handleWsAgentStreamEvent("error", {
      threadId: THREAD,
      message: "Usage is paused until the open invoice is paid.",
      code: "payment_required",
      agentId: "a1",
    })
    renderList()
    const notice = await waitFor(() => screen.getByTestId("payment-required-notice"))
    expect(notice.textContent).toContain("AI features are paused until the open invoice is paid.")
    expect(screen.getByTestId("payment-required-billing-link").getAttribute("href")).toBe(
      "/settings/billing",
    )
  })

  it("renders the load failure, with the retry that recovers the rows", async () => {
    loadMessagesIntoStore(THREAD, [])
    await loadMessages(
      {
        get: () => Promise.reject(new Error("Session expired")),
      } as never,
      THREAD,
    )
    renderList()
    const row = await waitFor(() => screen.getByTestId("message-load-error"))
    expect(row.textContent).toContain("Session expired")
    expect(row.querySelector("button")).toBeTruthy()
    // Not the empty state: the room is not empty, it could not be read.
    expect(screen.queryByText("No messages yet. Start the conversation!")).toBeNull()
  })
})
