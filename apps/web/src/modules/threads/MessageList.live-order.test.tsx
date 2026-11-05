// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE LIVE TURN IS DRAWN LIKE THE PERSISTED ONE (S28, path 1).
//
// The live block received no timeline, so it drew all thinking, then every
// tool, then the answer text; when the turn ended the persisted row redrew the
// real interleave and the conversation visibly reshuffled. The live block now
// draws its items where they were written, text included.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import {
  handleWsAgentStreamEvent,
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

const THREAD = "thread-live-order"
const base = { threadId: THREAD, agentId: "agent-1", turnId: "ask-1", askId: "ask-1" }

const SCRIPT: Array<[string, Record<string, unknown>]> = [
  ["reasoning", { delta: "Let me look.", seq: 1, itemId: "r0", itemKind: "reasoning" }],
  [
    "tool_call",
    {
      toolCallId: "A",
      toolName: "search_tickets",
      args: {},
      seq: 2,
      itemId: "A",
      itemKind: "tool",
    },
  ],
  ["tool_result", { toolCallId: "A", result: { ok: true }, seq: 3, itemId: "A", itemKind: "tool" }],
  ["delta", { delta: "Found the ticket. ", seq: 4, itemId: "t2", itemKind: "text" }],
  ["reasoning", { delta: "Now the order.", seq: 5, itemId: "r3", itemKind: "reasoning" }],
  [
    "tool_call",
    { toolCallId: "B", toolName: "get_order", args: {}, seq: 6, itemId: "B", itemKind: "tool" },
  ],
  ["tool_result", { toolCallId: "B", result: { ok: true }, seq: 7, itemId: "B", itemKind: "tool" }],
  ["delta", { delta: "It shipped yesterday.", seq: 8, itemId: "t5", itemKind: "text" }],
]

const KINDS = ["thinking-block", "tool-call-row", "agent-activity-text"]

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

/** The live block's items in DOM order, by test id. */
function liveOrder(): string[] {
  const block = screen.getByTestId("agent-stream-block")
  const selector = KINDS.map((id) => `[data-testid="${id}"]`).join(",")
  return Array.from(block.querySelectorAll(selector)).map(
    (el) => el.getAttribute("data-testid") ?? "",
  )
}

describe("MessageList live turn order", () => {
  afterEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("draws the live block's items in the order they were written", async () => {
    loadMessagesIntoStore(THREAD, [])
    renderList()
    handleWsAgentStreamEvent("start", { ...base })
    for (const [action, data] of SCRIPT) handleWsAgentStreamEvent(action, { ...base, ...data })

    await waitFor(() => expect(screen.getAllByTestId("agent-activity-text")).toHaveLength(2))
    expect(liveOrder()).toEqual([
      "thinking-block",
      "tool-call-row",
      "agent-activity-text",
      "thinking-block",
      "tool-call-row",
      "agent-activity-text",
    ])
    const runs = screen.getAllByTestId("agent-activity-text")
    const texts = runs.map((el) => el.textContent?.replace("▋", "").trim())
    expect(texts).toEqual(["Found the ticket.", "It shipped yesterday."])
    // The streaming caret follows the last text run, not the first.
    expect(runs[1]?.querySelector('[data-testid="agent-stream-caret"]')).not.toBeNull()
    expect(runs[0]?.querySelector('[data-testid="agent-stream-caret"]')).toBeNull()
    // The answer is drawn once, where it was written.
    expect(screen.getByTestId("agent-stream-block").textContent).not.toContain(
      "Found the ticket. It shipped yesterday.",
    )
  })

  it("does not draw the reply's outbox copy beside the live block", async () => {
    loadMessagesIntoStore(THREAD, [])
    renderList()
    handleWsAgentStreamEvent("start", { ...base })
    for (const [action, data] of SCRIPT) handleWsAgentStreamEvent(action, { ...base, ...data })
    handleWsMessageEvent("create", {
      id: "reply-1",
      threadId: THREAD,
      authorId: "agent-user",
      authorName: "Desk",
      authorType: "agent",
      authorAgentId: base.agentId,
      content: "Found the ticket. It shipped yesterday.",
      metadata: null,
      createdAt: new Date().toISOString(),
    })
    await waitFor(() => expect(screen.getAllByTestId("agent-activity-text")).toHaveLength(2))
    const list = document.body.textContent ?? ""
    expect(list.split("It shipped yesterday.").length - 1).toBe(1)
  })
})
