// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wiring half of the credits storm fix: ThreadView must read the session
// credits store, not open its own resource per mounted conversation. Ten
// conversations on screen (Home plus a dock strip plus the phone sheet, and
// every remount of any of them) used to be ten balance reads and ten model
// reads, which is how the box got to 15 500 and 6 800 in forty minutes.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, For } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import { resetCreditsStore } from "~/modules/agent/credits/credits-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { WsProvider } from "~/modules/shell/WsContext"
import ThreadView from "~/modules/threads/ThreadView"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u1", name: "Test User" }) }
})

function jsonOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

/** A 429 the credits store parks on, leaving the balance null. */
function rateLimited() {
  return {
    ok: false,
    status: 429,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "retry-after"
            ? "60"
            : null,
    },
    text: () => Promise.resolve(JSON.stringify({ error: { message: "Too many requests" } })),
    json: () => Promise.resolve({ error: { message: "Too many requests" } }),
  }
}

describe("ThreadView credits reads", () => {
  beforeEach(() => {
    resetThreadStore()
    resetCreditsStore()
  })
  afterEach(() => cleanup())

  it("ten agent conversations on screen issue one models read and one balance read", async () => {
    const paths: string[] = []
    const ids = Array.from({ length: 10 }, (_, i) => `conv-${i}`)
    for (const id of ids) {
      addThread({
        id,
        handle: id,
        title: null,
        type: "agent_chat",
        isPinned: false,
        isMuted: false,
        participants: [
          { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
          { id: "agent-1", name: "Assistant", avatarUrl: null, participantType: "agent" },
        ],
        updatedAt: new Date().toISOString(),
      })
    }
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = String(url)
        paths.push(path)
        if (path.includes("/credits/models")) return Promise.resolve(jsonOk(SERVED_MODELS_FIXTURE))
        if (path.includes("/credits/balance")) {
          return Promise.resolve(
            jsonOk({ data: { included: "0", purchased: "0", currency: "EUR" } }),
          )
        }
        const detail = /\/threads\/(conv-\d+)$/.exec(path)
        if (detail) {
          return Promise.resolve(
            jsonOk({
              data: {
                id: detail[1],
                handle: detail[1],
                title: null,
                type: "agent_chat",
                isPinned: false,
                participants: [
                  { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
                  { id: "agent-1", name: "Assistant", avatarUrl: null, participantType: "agent" },
                ],
                lastMessage: null,
                unreadCount: 0,
                updatedAt: new Date().toISOString(),
              },
            }),
          )
        }
        return Promise.resolve(jsonOk({ data: null }))
      }),
    )

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={vi.fn()} status={mockWsStatus}>
              <ApiProvider>
                <For each={ids}>{(id) => <ThreadView entityId={id} />}</For>
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => expect(paths.some((p) => p.includes("/credits/models"))).toBe(true))
    expect(paths.filter((p) => p.includes("/credits/models"))).toHaveLength(1)
    expect(paths.filter((p) => p.includes("/credits/balance"))).toHaveLength(1)
  })

  // THE MAIN TAB IS A MODEL CONTROL TOO. A conversation opened as a shell tab
  // rendered a dead grey "Auto" with no picker whenever the balance was still
  // unknown, which is every session whose one balance read is slow or parked
  // behind a 429, while the chip's own attribute carried the real model.
  it("main tab names the effective model and opens the picker with the balance unknown", async () => {
    addThread({
      id: "conv-main",
      handle: "conv-main",
      title: null,
      type: "agent_chat",
      isPinned: false,
      isMuted: false,
      participants: [
        { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
        { id: "agent-1", name: "Assistant", avatarUrl: null, participantType: "agent" },
      ],
      updatedAt: new Date().toISOString(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = String(url)
        if (path.includes("/credits/models")) return Promise.resolve(jsonOk(SERVED_MODELS_FIXTURE))
        // The balance read never lands: rate limited, exactly as the live box
        // answered it. The store keeps its null, and the chip must cope.
        if (path.includes("/credits/balance")) return Promise.resolve(rateLimited())
        if (/\/threads\/conv-main$/.test(path)) {
          return Promise.resolve(
            jsonOk({
              data: {
                id: "conv-main",
                handle: "conv-main",
                title: null,
                type: "agent_chat",
                isPinned: false,
                participants: [
                  { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" },
                  { id: "agent-1", name: "Assistant", avatarUrl: null, participantType: "agent" },
                ],
                agentModelId: null,
                agentDefaultModelId: "gemini-flash-lite-latest",
                lastMessage: null,
                unreadCount: 0,
                updatedAt: new Date().toISOString(),
              },
            }),
          )
        }
        return Promise.resolve(jsonOk({ data: null }))
      }),
    )

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={vi.fn()} status={mockWsStatus}>
              <ApiProvider>
                {/* No `surface` prop: the plain shell tab. */}
                <ThreadView entityId="conv-main" />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))

    const chip = await screen.findByTestId("thread-model-chip")
    expect(chip.getAttribute("data-effective-model")).toBe("gemini-flash-lite-latest")
    // The chip says "Default"; the model it resolves to is its title.
    await waitFor(() =>
      expect(screen.getByTestId("model-selector-label").textContent).toBe("Default"),
    )
    await waitFor(() =>
      expect(
        (screen.getByTestId("model-selector-label").closest("button") as HTMLElement).title,
      ).toBe("Default (Gemini Flash-Lite)"),
    )
    expect(screen.getByTestId("model-selector-label").dataset.locked).toBeUndefined()
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    expect(await screen.findByRole("menu")).toBeInTheDocument()
  })
})

// Between PEOPLE the model pill leaves the composer for the "..." menu: in a
// DM with a colleague where someone invoked an agent, a pill beside send made
// the chat read like a chat with a bot. Channels and agent chats keep it.
describe("ThreadView model control by conversation kind", () => {
  beforeEach(() => {
    resetThreadStore()
    resetCreditsStore()
  })
  afterEach(() => cleanup())

  const u1 = { id: "u1", name: "Test User", avatarUrl: null, participantType: "user" as const }
  const u2 = { id: "u2", name: "Alice Chen", avatarUrl: null, participantType: "user" as const }
  const agent = {
    id: "agent-1",
    name: "Assistant",
    avatarUrl: null,
    participantType: "agent" as const,
  }

  function mount(conv: {
    title: string | null
    type: string
    participants: (typeof u1 | typeof agent)[]
  }) {
    const id = "conv-kind"
    addThread({
      id,
      handle: id,
      title: conv.title,
      type: conv.type,
      isPinned: false,
      isMuted: false,
      participants: conv.participants,
      updatedAt: new Date().toISOString(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = String(url)
        if (path.includes("/credits/models")) return Promise.resolve(jsonOk(SERVED_MODELS_FIXTURE))
        if (path.includes("/credits/balance")) return Promise.resolve(rateLimited())
        if (path.endsWith(`/threads/${id}`)) {
          return Promise.resolve(
            jsonOk({
              data: {
                id,
                handle: id,
                title: conv.title,
                type: conv.type,
                isPinned: false,
                participants: conv.participants,
                agentModelId: null,
                agentDefaultModelId: "gemini-flash-lite-latest",
                lastMessage: null,
                unreadCount: 0,
                updatedAt: new Date().toISOString(),
              },
            }),
          )
        }
        return Promise.resolve(jsonOk({ data: null }))
      }),
    )
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <WsProvider send={vi.fn()} status={mockWsStatus}>
              <ApiProvider>
                <ThreadView entityId={id} />
              </ApiProvider>
            </WsProvider>
          )}
        />
      </Router>
    ))
  }

  it("a DM between people with an invoked agent has no composer pill; the menu offers it", async () => {
    mount({ title: null, type: "thread", participants: [u1, u2, agent] })

    // The agent seat is known (the control is published for the menu)...
    await screen.findByTestId("thread-model-menu-anchor")
    // ...and still the composer carries no pill.
    expect(screen.queryByTestId("thread-model-chip")).toBeNull()

    fireEvent.click(screen.getByLabelText("Thread actions"))
    const entry = await screen.findByTestId("thread-invoked-model")
    expect(entry.textContent).toContain("Invoked model")
    await waitFor(() =>
      expect(screen.getByTestId("thread-invoked-model-label").textContent).toBe("Flash-Lite"),
    )

    // Choosing it closes the menu and opens the composer's own selector.
    fireEvent.click(entry)
    await waitFor(() => expect(screen.queryByTestId("thread-invoked-model")).toBeNull())
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("Default (Gemini Flash-Lite)")
  })

  it("an agent chat keeps the composer pill", async () => {
    mount({ title: null, type: "agent_chat", participants: [u1, agent] })
    expect(await screen.findByTestId("thread-model-chip")).toBeInTheDocument()
  })

  it("a channel keeps the composer pill", async () => {
    mount({ title: "Engineering", type: "thread", participants: [u1, u2, agent] })
    expect(await screen.findByTestId("thread-model-chip")).toBeInTheDocument()
  })
})
