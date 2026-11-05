// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ROW GROUPING KEYS ON THE SPEAKER, AND AN AGENT'S SPEAKER IS ITS AGENT ID.
//
// Every agent row in a room carries the same `authorId` (the human whose turn
// it is), so grouping on `authorId` plus `authorType` read a Support Desk reply
// and a Finance Desk reply 1.6 s apart as one speaker: the second one rendered
// with no header, no avatar and no AGENT badge, live and after a reload.
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

const THREAD = "thread-grouping"

const row = (over: Record<string, unknown>) => ({
  id: "x",
  threadId: THREAD,
  authorId: "u1",
  authorName: "Alex",
  authorAvatarUrl: null,
  authorType: "user" as const,
  authorAgentId: null,
  parentMessageId: null,
  content: "hello",
  mentions: null,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(2024, 0, 1, 12, 0, 0).toISOString(),
  ...over,
})

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

describe("MessageList grouping keys on the author agent", () => {
  afterEach(() => {
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("two agents answering seconds apart each keep their own header and badge", async () => {
    loadMessagesIntoStore(THREAD, [
      row({ id: "m1", content: "@support @finance where is the pallet" }),
      row({
        id: "m2",
        authorType: "agent",
        authorAgentId: "agent-support",
        authorName: "Support Desk",
        content: "It left on Tuesday.",
        createdAt: new Date(2024, 0, 1, 12, 0, 4).toISOString(),
      }),
      row({
        id: "m3",
        authorType: "agent",
        authorAgentId: "agent-finance",
        authorName: "Finance Desk",
        content: "The invoice is settled.",
        createdAt: new Date(2024, 0, 1, 12, 0, 6).toISOString(),
      }),
    ])
    renderList()
    await waitFor(() => expect(screen.getByText("The invoice is settled.")).toBeTruthy())
    // The second agent is a second speaker: it keeps its own badge and name.
    expect(screen.getByTestId("message-agent-badge-m2")).toBeTruthy()
    expect(screen.getByTestId("message-agent-badge-m3")).toBeTruthy()
    expect(screen.getByText("Finance Desk")).toBeTruthy()
  })

  it("a message after a nested agent exchange keeps its author header", async () => {
    // The production DM: the person's question, the agents' nested exchange
    // under it, then the person's second question 12 s later. Grouped onto the
    // first, it rendered with no name, glued under the "between agents" block.
    loadMessagesIntoStore(THREAD, [
      row({ id: "q1", content: "What are my notification settings?" }),
      row({
        id: "a1",
        parentMessageId: "q1",
        authorType: "agent",
        authorAgentId: "agent-personal",
        authorName: "Personal agent",
        content: "Nested answer.",
        createdAt: new Date(2024, 0, 1, 12, 0, 4).toISOString(),
      }),
      row({
        id: "q2",
        content: "What are my settings, again?",
        createdAt: new Date(2024, 0, 1, 12, 0, 12).toISOString(),
      }),
    ])
    renderList()
    await waitFor(() => expect(screen.getByText("What are my settings, again?")).toBeTruthy())
    // Two top level rows by the same person, each with its own name.
    expect(screen.getAllByText("Alex")).toHaveLength(2)
  })

  it("the same person twice in a row with nothing nested still groups", async () => {
    loadMessagesIntoStore(THREAD, [
      row({ id: "p1", content: "First line." }),
      row({
        id: "p2",
        content: "Second line.",
        createdAt: new Date(2024, 0, 1, 12, 0, 12).toISOString(),
      }),
    ])
    renderList()
    await waitFor(() => expect(screen.getByText("Second line.")).toBeTruthy())
    expect(screen.getAllByText("Alex")).toHaveLength(1)
  })

  it("one agent answering twice in a row still groups", async () => {
    loadMessagesIntoStore(THREAD, [
      row({ id: "n1", content: "@support two questions" }),
      row({
        id: "n2",
        authorType: "agent",
        authorAgentId: "agent-support",
        authorName: "Support Desk",
        content: "First answer.",
        createdAt: new Date(2024, 0, 1, 12, 0, 4).toISOString(),
      }),
      row({
        id: "n3",
        authorType: "agent",
        authorAgentId: "agent-support",
        authorName: "Support Desk",
        content: "Second answer.",
        createdAt: new Date(2024, 0, 1, 12, 0, 6).toISOString(),
      }),
    ])
    renderList()
    await waitFor(() => expect(screen.getByText("Second answer.")).toBeTruthy())
    expect(screen.getByTestId("message-agent-badge-n2")).toBeTruthy()
    expect(screen.queryByTestId("message-agent-badge-n3")).toBeNull()
  })
})
