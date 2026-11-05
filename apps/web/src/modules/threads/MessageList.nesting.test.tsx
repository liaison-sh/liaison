// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T14: an agent to agent exchange renders nested under the turn that
// started it, and the human facing sequence is untouched.
//
// The asymmetry is the whole rule (Buzz's audience threading): a human asked,
// so the answer belongs at the thread root where the room reads it; an agent
// asked another agent, so that exchange belongs under the message that
// triggered it, collapsed behind one line.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
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

const THREAD = "thread-nesting"

function msg(opts: {
  id: string
  content: string
  minute: number
  agentId?: string | null
  parentMessageId?: string | null
  metadata?: Record<string, unknown>
}) {
  return {
    id: opts.id,
    threadId: THREAD,
    authorId: "u1",
    authorName: opts.agentId ? "Callee's agent" : "Alex",
    authorAvatarUrl: null,
    authorType: opts.agentId ? ("agent" as const) : ("user" as const),
    authorAgentId: opts.agentId ?? null,
    parentMessageId: opts.parentMessageId ?? null,
    content: opts.content,
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(2024, 0, 1, 12, opts.minute).toISOString(),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  }
}

/**
 * One human question, one flat human facing answer, and the two level agent to
 * agent chain the server actually writes: the question hangs under the human
 * turn, the answer hangs under the question. A one level grouping drops the
 * ANSWER, which is the message the room most wants to read.
 */
const FIXTURE = [
  msg({ id: "m1", content: "has the pallet shipped", minute: 0 }),
  msg({
    id: "q1",
    content: "asking the logistics agent",
    minute: 1,
    agentId: "agent-caller",
    parentMessageId: "m1",
  }),
  msg({
    id: "a1",
    content: "it left on tuesday",
    minute: 2,
    agentId: "agent-callee",
    // The server parents the ANSWER to the QUESTION, not to the human turn:
    // the chain is two levels deep (human turn <- question <- answer).
    parentMessageId: "q1",
  }),
  msg({ id: "m2", content: "It shipped on Tuesday.", minute: 3, agentId: "agent-caller" }),
]

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

describe("MessageList nesting", () => {
  afterEach(() => {
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("a message with no parent renders at the top level", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByText("has the pallet shipped")).toBeTruthy())
    expect(screen.getByText("It shipped on Tuesday.")).toBeTruthy()
  })

  it("a nested agent message does not render as a top level row", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByText("has the pallet shipped")).toBeTruthy())
    expect(screen.queryByText("asking the logistics agent")).toBeNull()
    expect(screen.queryByText("it left on tuesday")).toBeNull()
  })

  it("the collapsed line names the nested message count", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByTestId("nested-exchange-toggle")).toBeTruthy())
    expect(screen.getByTestId("nested-exchange-toggle").textContent).toBe(
      "2 messages between agents",
    )
  })

  it("expanding the collapsed line renders each nested message with its agent handle", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByTestId("nested-exchange-toggle")).toBeTruthy())
    fireEvent.click(screen.getByTestId("nested-exchange-toggle"))
    await waitFor(() => expect(screen.getByTestId("nested-exchange")).toBeTruthy())
    const nested = screen.getByTestId("nested-exchange")
    expect(nested.textContent).toContain("asking the logistics agent")
    expect(nested.textContent).toContain("it left on tuesday")
  })

  it("a grandchild of the top level message is still nested under it", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByTestId("nested-exchange-toggle")).toBeTruthy())
    fireEvent.click(screen.getByTestId("nested-exchange-toggle"))
    await waitFor(() => expect(screen.getByTestId("nested-exchange")).toBeTruthy())
    const rows = screen.getByTestId("nested-exchange").querySelectorAll("[data-nested-depth]")
    expect([...rows].map((el) => el.getAttribute("data-nested-depth"))).toEqual(["1", "2"])
  })

  it("W2-D8: a finished session's post-back under its card renders as a top level message, never folded", async () => {
    loadMessagesIntoStore(THREAD, [
      msg({ id: "h1", content: "fix the cart test on my computer", minute: 0 }),
      msg({
        id: "card",
        content: "Started on Mac. Follow it in the card above.",
        minute: 1,
        agentId: "agent-personal",
      }),
      msg({
        id: "back",
        content: "Finished on Mac: Fix the cart test.",
        minute: 9,
        agentId: "agent-personal",
        parentMessageId: "card",
        metadata: { kind: "node_session_result", sessionId: "s1" },
      }),
    ])
    renderList()
    await waitFor(() =>
      expect(screen.getByText("Finished on Mac: Fix the cart test.")).toBeTruthy(),
    )
    expect(screen.queryByTestId("nested-exchange-toggle")).toBeNull()
  })

  it("nesting does not reorder the top level messages", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    const { container } = renderList()
    await waitFor(() => expect(screen.getByText("has the pallet shipped")).toBeTruthy())
    const order = [...container.querySelectorAll("[data-index]")].map((el) =>
      (el.textContent ?? "").includes("has the pallet shipped")
        ? "m1"
        : (el.textContent ?? "").includes("It shipped on Tuesday.")
          ? "m2"
          : "other",
    )
    expect(order.filter((o) => o !== "other")).toEqual(["m1", "m2"])
  })
})
