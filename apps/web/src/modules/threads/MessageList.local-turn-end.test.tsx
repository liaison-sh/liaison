// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A FINISHED LOCAL TURN IS NOT A RUNNING ONE.
//
// The live block for a turn running on this machine mounts on the tool
// activity rows, and those rows outlive the turn on purpose: they are the only
// place a local turn's calls are drawn. Read as "a turn is live" they left the
// block streaming forever, so every finished local turn kept a "Generating..."
// under the agent's own reply for the rest of the session.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList from "~/modules/threads/MessageList"
import { loadMessagesIntoStore, resetMessageStore } from "~/modules/threads/message-store"

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

const THREAD = "thread-local-turn-end"
const AGENT = "agent-personal"

const WROTE_A_FILE = [
  {
    id: "toolu_1",
    toolName: "Write",
    summary: "file_path: summary.md",
    status: "done" as const,
    startedAt: 1,
  },
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

describe("a local turn that ended", () => {
  afterEach(() => {
    uninstallFakeBridge()
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("keeps the rows it made and stops saying it is generating", async () => {
    installFakeBridge(liveSession(THREAD, AGENT, { toolActivity: WROTE_A_FILE, turnActive: false }))
    loadMessagesIntoStore(THREAD, [])
    renderList()

    await waitFor(() => expect(screen.getByTestId("agent-stream-block")).toBeInTheDocument())
    expect(screen.queryByText("Generating...")).toBeNull()
    // The rows are the only record of what the turn did, so an ended turn
    // keeps them: an empty block under the reply says less than no block.
    expect(screen.getByText("Write")).toBeInTheDocument()
  })

  it("says it is generating while the turn is still running", async () => {
    installFakeBridge(liveSession(THREAD, AGENT, { toolActivity: WROTE_A_FILE, turnActive: true }))
    loadMessagesIntoStore(THREAD, [])
    renderList()

    await waitFor(() => expect(screen.getByText("Generating...")).toBeInTheDocument())
  })

  it("offers no Stop once the turn has ended", async () => {
    installFakeBridge(liveSession(THREAD, AGENT, { toolActivity: WROTE_A_FILE, turnActive: false }))
    loadMessagesIntoStore(THREAD, [])
    renderList()
    await waitFor(() => expect(screen.getByTestId("agent-stream-block")).toBeInTheDocument())
    expect(screen.queryByTestId("local-turn-stop")).toBeNull()
  })
})

// A TURN PARKED ON A QUESTION ALWAYS HAS A WAY OUT, and it is labelled with the
// agent the session runs as (it read "Personal agent" in a Data DM).
describe("a local turn that is still running", () => {
  afterEach(() => {
    uninstallFakeBridge()
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("can be stopped from the window, even while parked on a permission question", async () => {
    const fake = installFakeBridge(
      liveSession(THREAD, AGENT, {
        toolActivity: [{ ...WROTE_A_FILE[0], status: "running" as const }],
        pendingPermissions: [
          {
            requestId: "req-1",
            toolName: "Write",
            summary: "file_path: summary.md",
            toolUseId: "toolu_1",
          },
        ],
        turnActive: true,
      }),
    )
    loadMessagesIntoStore(THREAD, [])
    renderList()
    const stop = await screen.findByTestId("local-turn-stop")
    fireEvent.click(stop)
    await waitFor(() => expect(fake.calls.interrupted).toBe(1))
  })

  it("names the agent the session runs as, not nobody", async () => {
    installFakeBridge(liveSession(THREAD, AGENT, { toolActivity: WROTE_A_FILE, turnActive: true }))
    loadMessagesIntoStore(THREAD, [])
    renderList()
    const author = await screen.findByTestId("agent-stream-author")
    expect(author.getAttribute("data-agent-id")).toBe(AGENT)
  })
})
