// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LOCAL SESSION THAT STARTED NEW BECAUSE THE AGENT CHANGED SAYS SO, QUIETLY,
// ON THE CONVERSATION (2026-09-23).
//
// The shell resumes a stored session only under the agent definition it was
// created with. When the org changed the agent, the next start is a new
// session, and the conversation carries one line over its first turn.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopFreshSession } from "~/lib/desktop-shell-contract"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { I18nProvider } from "~/modules/i18n/i18n-context"
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

const THREAD = "thread-local-session-fresh"
const AGENT = "agent-data"

const FRESH: DesktopFreshSession = {
  threadId: THREAD,
  agentId: AGENT,
  reason: "definition_changed",
}

function running(fresh: DesktopFreshSession | null = FRESH) {
  return {
    runtimeLocation: "local" as const,
    sessionStatus: "running" as const,
    threadId: THREAD,
    agentId: AGENT,
    folderPath: "/Users/someone/reports",
    freshSession: fresh,
  }
}

function renderList(threadId = THREAD, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <TabVisibilityProvider value={() => true}>
                <div style={{ display: "flex", height: "480px", "flex-direction": "column" }}>
                  <MessageList threadId={threadId} currentUserId="u1" />
                </div>
              </TabVisibilityProvider>
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

describe("a local session new because the agent changed", () => {
  afterEach(() => {
    uninstallFakeBridge()
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("is said on the conversation, quietly", async () => {
    installFakeBridge(running())
    loadMessagesIntoStore(THREAD, [])
    renderList()
    const note = await screen.findByTestId("local-session-fresh")
    expect(note.getAttribute("role")).toBe("status")
    expect(note.textContent).toBe("The agent was updated: new session.")
  })

  it("is said in French to a French reader", async () => {
    installFakeBridge(running())
    loadMessagesIntoStore(THREAD, [])
    renderList(THREAD, "fr")
    const note = await screen.findByTestId("local-session-fresh")
    expect(note.textContent).toBe("L'agent a été mis à jour : nouvelle session.")
  })

  it("says nothing for a session that resumed", async () => {
    installFakeBridge(running(null))
    loadMessagesIntoStore(THREAD, [])
    renderList()
    await waitFor(() => expect(screen.queryByTestId("message-load-error")).toBeNull())
    expect(screen.queryByTestId("local-session-fresh")).toBeNull()
  })

  it("belongs to its own conversation and to no other", async () => {
    installFakeBridge(running())
    loadMessagesIntoStore("another-thread", [])
    renderList("another-thread")
    await waitFor(() => expect(screen.queryByTestId("message-load-error")).toBeNull())
    expect(screen.queryByTestId("local-session-fresh")).toBeNull()
  })
})
