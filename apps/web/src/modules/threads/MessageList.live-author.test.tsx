// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TWO LIVE TURNS ARE TWO AGENTS (A29/A30, surface 19).
//
// A room that names two agents streams two blocks at once. They carried the
// acting agent as `data-agent-id` and nothing a reader could see, so until the
// rows landed the two turns were indistinguishable on screen.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import MessageList from "~/modules/threads/MessageList"
import {
  handleWsAgentStreamEvent,
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

const THREAD = "thread-live-authors"

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

describe("MessageList concurrent live turns", () => {
  afterEach(() => {
    resetMessageStore()
    resetAgentDirectory()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("names each streaming agent, so two live blocks carry two different names", async () => {
    await loadAgentDirectory({
      get: async () => [
        { id: "agent-desk", handle: "@desk", displayName: "Support Desk", avatarUrl: null },
        { id: "agent-ops", handle: "@ops", displayName: "Shipping Ops", avatarUrl: null },
      ],
    })
    loadMessagesIntoStore(THREAD, [])
    renderList()

    for (const agentId of ["agent-desk", "agent-ops"]) {
      handleWsAgentStreamEvent("start", { threadId: THREAD, agentId })
      handleWsAgentStreamEvent("delta", {
        threadId: THREAD,
        agentId,
        delta: `working on it from ${agentId}`,
      })
    }

    await waitFor(() => expect(screen.getAllByTestId("agent-stream-block")).toHaveLength(2))
    const names = screen
      .getAllByTestId("agent-stream-author-name")
      .map((el) => el.textContent?.trim())
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain("Support Desk")
    expect(names).toContain("Shipping Ops")
  })
})
