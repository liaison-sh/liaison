// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LOCAL TURN THAT DIED WITH ITS SIDECAR IS SAID ON THE CONVERSATION
// (2026-09-23).
//
// A stale sidecar refused its arguments and exited. The message had been
// posted, the turn was sent into a closed pipe, and the conversation showed the
// user's message with no reply and no error, for ever. The shell now ends the
// session and releases the claim; the page names what happened where the
// message is, and offers the same message again.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopTurnFailure } from "~/lib/desktop-shell-contract"
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

const THREAD = "thread-local-turn-failed"
const AGENT = "agent-personal"

const FAILURE: DesktopTurnFailure = {
  threadId: THREAD,
  agentId: AGENT,
  messageId: "m1",
  reason: "unknown permission mode: auto",
}

/** The session the sidecar's death stopped, with the folder it ran in. */
function afterTheCrash(failure: DesktopTurnFailure | null = FAILURE) {
  return {
    runtimeLocation: "local" as const,
    sessionStatus: "stopped" as const,
    threadId: null,
    agentId: null,
    folderPath: "/Users/someone/code/acme-monorepo",
    turnFailure: failure,
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

describe("a local turn the sidecar took with it", () => {
  afterEach(() => {
    uninstallFakeBridge()
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("is said on the conversation, with what the sidecar said", async () => {
    installFakeBridge(afterTheCrash())
    loadMessagesIntoStore(THREAD, [])
    renderList()
    const alert = await screen.findByTestId("local-turn-failed")
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.textContent).toContain(
      "The assistant on this computer stopped: unknown permission mode: auto",
    )
    expect(screen.getByTestId("local-turn-retry").textContent).toBe("Retry")
  })

  it("is said in French to a French reader", async () => {
    installFakeBridge(afterTheCrash())
    loadMessagesIntoStore(THREAD, [])
    renderList(THREAD, "fr")
    const alert = await screen.findByTestId("local-turn-failed")
    expect(alert.textContent).toContain(
      "L'assistant sur cet ordinateur s'est arrêté : unknown permission mode: auto",
    )
    expect(screen.getByTestId("local-turn-retry").textContent).toBe("Réessayer")
  })

  it("Retry starts the conversation's session again and runs the same message", async () => {
    const fake = installFakeBridge(afterTheCrash())
    loadMessagesIntoStore(THREAD, [])
    renderList()
    fireEvent.click(await screen.findByTestId("local-turn-retry"))
    await waitFor(() => expect(fake.calls.turns).toEqual(["m1"]))
    expect(fake.calls.started).toHaveLength(1)
    expect(fake.calls.started[0]).toMatchObject({ threadId: THREAD, agentId: AGENT })
    // The running session is the answer, so the failure is gone.
    await waitFor(() => expect(screen.queryByTestId("local-turn-failed")).toBeNull())
  })

  it("belongs to its own conversation and to no other", async () => {
    installFakeBridge(afterTheCrash())
    loadMessagesIntoStore("another-thread", [])
    renderList("another-thread")
    await waitFor(() => expect(screen.queryByTestId("message-load-error")).toBeNull())
    expect(screen.queryByTestId("local-turn-failed")).toBeNull()
  })

  // 2026-09-23, production: a finished turn's answer was refused by the server
  // and the conversation showed nothing. The answer EXISTS and is kept on this
  // computer, which is a different thing to say than a turn that stopped, and
  // its Retry posts it rather than running the turn again.
  it("an answer that could not be posted is said as kept, not as a stopped turn", async () => {
    installFakeBridge(
      afterTheCrash({
        ...FAILURE,
        reason: "the server refused it (409: this conversation is not claimed)",
        kind: "undelivered",
      }),
    )
    loadMessagesIntoStore(THREAD, [])
    renderList()
    const alert = await screen.findByTestId("local-turn-failed")
    expect(alert.textContent).toContain("The answer from this computer was not posted")
    expect(alert.textContent).toContain("It is kept on this computer.")
    expect(alert.textContent).not.toContain("stopped")
    expect(screen.getByTestId("local-turn-retry").getAttribute("aria-label")).toBe(
      "Post the answer kept on this computer",
    )
  })
})

// A LOCAL TURN, READ BACK (2026-09-23). After a relaunch, on another device or
// in the browser, the conversation is what the server stored: the agent's
// message with the turn's tool calls on it, drawn the way a cloud turn's are.
describe("a local turn read back from the server", () => {
  afterEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(THREAD, [])
    cleanup()
  })

  it("draws the tool calls the turn stored, like a cloud turn's", async () => {
    loadMessagesIntoStore(THREAD, [
      {
        id: "q1",
        threadId: THREAD,
        authorId: "u1",
        authorName: "Avery",
        authorAvatarUrl: null,
        authorType: "user" as const,
        authorAgentId: null,
        parentMessageId: null,
        content: "Passage du Havre, August report",
        mentions: null,
        reactions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: new Date(2026, 8, 23, 22, 12, 41).toISOString(),
      },
      {
        id: "a1",
        threadId: THREAD,
        authorId: "u1",
        authorName: "Data",
        authorAvatarUrl: null,
        authorType: "agent" as const,
        authorAgentId: AGENT,
        parentMessageId: null,
        content: "Verdict : GREEN",
        mentions: null,
        reactions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: new Date(2026, 8, 23, 22, 13, 31).toISOString(),
        metadata: {
          runLocation: "local",
          modelId: "claude-haiku-4-5",
          toolCalls: [
            {
              toolCallId: "toolu_1",
              toolName: "kpi__kpi_list_hubs",
              args: { query: "Havre" },
              result: "Passage du Havre (hub 42)",
              status: "completed",
            },
            {
              toolCallId: "toolu_2",
              toolName: "Bash",
              args: { command: "bun run verify" },
              result: "REPORT VERDICT GREEN",
              status: "completed",
            },
          ],
        },
      },
    ] as never)
    renderList()
    await screen.findByText("Verdict : GREEN")
    fireEvent.click(await screen.findByTestId("message-row-tools-toggle"))
    await waitFor(() => expect(screen.getAllByTestId("tool-call-row")).toHaveLength(2))
  })
})
