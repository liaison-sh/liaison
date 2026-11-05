// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approval DECISION lands on the originating thread as a system message,
// and the room reads it as its own row: "Approved by X. Tool executed
// successfully." is the outcome everybody was waiting on. It must keep the
// `message-row-system-decision` testid even in a thread that also carries a
// normal post and an agent turn with a nested agent to agent exchange, because
// the muted centered line the expiry job's notices get has no such row.
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

const THREAD = "thread-decision-row"

function msg(opts: {
  id: string
  content: string
  minute: number
  authorType?: "user" | "agent" | "system"
  authorName?: string
  agentId?: string | null
  parentMessageId?: string | null
  metadata?: Record<string, unknown> | null
}) {
  return {
    id: opts.id,
    threadId: THREAD,
    authorId: "u1",
    authorName: opts.authorName ?? "Alex",
    authorAvatarUrl: null,
    authorType: opts.authorType ?? ("user" as const),
    authorAgentId: opts.agentId ?? null,
    parentMessageId: opts.parentMessageId ?? null,
    content: opts.content,
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(2024, 0, 1, 12, opts.minute).toISOString(),
    metadata: opts.metadata ?? null,
  }
}

// A person asks, an agent turn answers (with the agent to agent exchange the
// server nests under it), then the decision notice arrives.
const FIXTURE = [
  msg({ id: "m1", content: "please ship the pallet", minute: 0 }),
  msg({
    id: "q1",
    content: "asking the logistics agent",
    minute: 1,
    authorType: "agent",
    agentId: "agent-caller",
    parentMessageId: "m1",
  }),
  msg({
    id: "m2",
    content: "Raised an approval for the carrier booking.",
    minute: 2,
    authorType: "agent",
    agentId: "agent-caller",
  }),
  msg({
    id: "d1",
    content: "Approved by CrossThread Approver. Tool executed successfully.",
    minute: 3,
    authorType: "system",
    authorName: "Alex",
    metadata: { type: "approval-decision", decision: "approved", actorId: "u2" },
  }),
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

describe("MessageList - an approval decision keeps its own row", () => {
  afterEach(() => {
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("renders the decision as a message-row-system-decision row", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByText("please ship the pallet")).toBeTruthy())
    const row = await waitFor(() => screen.getByTestId("message-row-system-decision"))
    expect(row.textContent).toContain("Approved by CrossThread Approver")
  })

  it("leaves the normal post and the agent turn untouched", async () => {
    loadMessagesIntoStore(THREAD, FIXTURE)
    renderList()
    await waitFor(() => expect(screen.getByText("please ship the pallet")).toBeTruthy())
    expect(screen.getByText("Raised an approval for the carrier booking.")).toBeTruthy()
    // The agent to agent question stays collapsed under the turn that asked it.
    expect(screen.queryByText("asking the logistics agent")).toBeNull()
    expect(screen.getByTestId("nested-exchange-toggle").textContent).toBe(
      "1 message between agents",
    )
  })

  it("keeps an undecided notice (an expiry) as a muted system line", async () => {
    loadMessagesIntoStore(THREAD, [
      msg({ id: "m1", content: "please ship the pallet", minute: 0 }),
      msg({
        id: "e1",
        content: "Expired without decision.",
        minute: 1,
        authorType: "system",
        authorName: "Alex",
        metadata: { type: "approval-decision", decision: "expired", requestHandle: "request-42" },
      }),
    ])
    renderList()
    await waitFor(() => expect(screen.getByTestId("message-row-system-line")).toBeTruthy())
    expect(screen.queryByTestId("message-row-system-decision")).toBeNull()
  })
})
