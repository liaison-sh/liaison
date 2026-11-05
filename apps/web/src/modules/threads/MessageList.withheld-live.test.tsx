// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WITHHELD CARD DRAWS WHEN THE TURN ENDS, not on the next open.
//
// A turn that left capabilities out ends with two `message:create` events for
// the same row: the outbox one, queued at INSERT before the metadata is
// written (so `metadata` is null), and the end of turn copy that carries what
// the turn produced. The card comes from `metadata.withheld`, and the end of
// turn copy did not carry it, so the room showed the answer with no card until
// the thread was fetched again.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import {
  handleWsMessageEvent,
  loadMessagesIntoStore,
  resetMessageStore,
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

const THREAD = "thread-withheld-live"

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

const OUTBOX_CREATE = {
  id: "m-agent",
  threadId: THREAD,
  authorId: "u1",
  authorName: "Support Desk",
  authorType: "agent",
  authorAgentId: "agent-desk",
  content: "Here is what I can say about it.",
  metadata: null,
  createdAt: new Date(2024, 0, 1, 12, 0).toISOString(),
}

const TURN_END_CREATE = {
  ...OUTBOX_CREATE,
  metadata: {
    modelId: "test-model",
    finishReason: "stop",
    withheld: {
      requesterId: "u1",
      turnId: "m-user",
      items: [{ label: "Advertising" }],
    },
  },
}

describe("MessageList withheld card on the turn that just ended", () => {
  afterEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("renders the card from the turn-end event, with no reload", async () => {
    loadMessagesIntoStore(THREAD, [])
    renderList()
    handleWsMessageEvent("create", OUTBOX_CREATE)
    await waitFor(() => expect(screen.getByText("Here is what I can say about it.")).toBeTruthy())
    // No card yet: the outbox copy carries no metadata at all.
    expect(screen.queryByTestId("withheld-card")).toBeNull()

    handleWsMessageEvent("create", TURN_END_CREATE)
    await waitFor(() => expect(screen.getByTestId("withheld-card")).toBeTruthy())
  })
})
