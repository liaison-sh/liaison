// SPDX-License-Identifier: FSL-1.1-ALv2
// An agent tagged in a task's discussion shows its work exactly as in a chat
// thread: the discussion draws the thread view's own stream, so an agent
// message carries its tool-call rows and its inline approval card, a turn in
// progress streams with its tool calls and the working state, and a plain
// comment still reads as a comment. Fixtures are the thread view's own
// (MessageList.test.tsx), fed through the real store and socket handlers.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskDiscussion } from "~/modules/projects/TaskDiscussion"
import { ApiProvider } from "~/modules/shell/ApiContext"
import {
  handleWsAgentStreamEvent,
  loadMessagesIntoStore,
  resetMessageStore,
} from "~/modules/threads/message-store"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u1", name: "Alex" }),
}))

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

const THREAD = "thread-task"

function makeMessage(index: number) {
  return {
    id: `m-${index + 1}`,
    threadId: THREAD,
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

function renderDiscussion() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TaskDiscussion threadId={THREAD} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

afterEach(() => {
  cleanup()
  resetMessageStore()
})

describe("TaskDiscussion shows an agent's turn like a chat thread", () => {
  it("an agent message renders its tool-call rows and the inline approval card", async () => {
    loadMessagesIntoStore(THREAD, [
      makeMessage(0),
      {
        ...makeMessage(1),
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

    renderDiscussion()

    const agentRow = await screen.findByTestId("task-discussion.message-m-2")
    await waitFor(() => expect(within(agentRow).getByTestId("tool-call-row")).toBeInTheDocument())
    expect(within(agentRow).getByTestId("approval-card")).toBeInTheDocument()
    // The thread view's own row, inside the discussion's list.
    expect(screen.getByTestId("task-discussion.messages").contains(agentRow)).toBe(true)
  })

  it("a turn in progress streams live with its tool calls and the working state", async () => {
    loadMessagesIntoStore(THREAD, [{ ...makeMessage(0), content: "@Support Desk can you check?" }])
    renderDiscussion()
    await waitFor(() => expect(screen.getByTestId("task-discussion.message-m-1")).toBeVisible())

    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: "a-1" })
    handleWsAgentStreamEvent("tool_call", {
      threadId: THREAD,
      agentId: "a-1",
      toolCallId: "tc1",
      toolName: "search_threads",
      args: { q: "demo" },
    })
    handleWsAgentStreamEvent("delta", { threadId: THREAD, agentId: "a-1", delta: "Looking now, " })

    const block = await screen.findByTestId("agent-stream-block")
    // Streaming text with its cursor, and the tool call as it runs.
    await waitFor(() => expect(within(block).getByText("▋")).toBeInTheDocument())
    // The text reveals as it streams (the newest character waits for the next).
    await waitFor(() => expect(block.textContent).toContain("Looking now"))
    expect(within(block).getByTestId("tool-call-row")).toBeInTheDocument()
    // The working state, under the newest comment, inside the discussion.
    const state = screen.getByTestId("agent-state")
    expect(state.dataset.state).toBe("working")
    expect(screen.getByTestId("task-discussion.scroller").contains(block)).toBe(true)
    expect(screen.getByTestId("task-discussion.scroller").contains(state)).toBe(true)

    // The turn ends: the live block goes, the working state with it.
    handleWsAgentStreamEvent("done", { threadId: THREAD, agentId: "a-1" })
    await waitFor(() => expect(screen.queryByTestId("agent-state")).toBeNull())
  })

  it("a plain user comment still renders as a comment, with no turn furniture", async () => {
    loadMessagesIntoStore(THREAD, [{ ...makeMessage(0), content: "Shipping Friday." }])
    renderDiscussion()

    const row = await screen.findByTestId("task-discussion.message-m-1")
    expect(within(row).getByTestId("task-discussion.message-body")).toHaveTextContent(
      "Shipping Friday.",
    )
    expect(within(row).getByText("Alex")).toBeInTheDocument()
    expect(screen.queryByTestId("tool-call-row")).toBeNull()
    expect(screen.queryByTestId("agent-stream-block")).toBeNull()
    expect(screen.queryByTestId("agent-state")).toBeNull()
    expect(screen.queryByTestId("task-discussion.empty")).toBeNull()
  })
})
