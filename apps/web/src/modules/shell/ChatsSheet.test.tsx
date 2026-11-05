// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ChatsSheet } from "~/modules/shell/ChatsSheet"
import {
  activeThreadId,
  chatsOpen,
  dockAvailable,
  openConversation,
  resetDockStore,
  tabs,
  toggleChats,
} from "~/modules/shell/dock-store"
import { syncShellTier } from "~/modules/shell/shell-tier"
import { resetTabStore } from "~/modules/shell/tab-store"
import { WsProvider } from "~/modules/shell/WsContext"
import { resetMessageStore } from "~/modules/threads/message-store"
import { resetPresenceStore } from "~/modules/threads/presence-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")
const mockWsSend = vi.fn()

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
      json: () => Promise.resolve({ data: null }),
    }),
  ),
)

/** Same shape Shell.chat-dock.test.tsx uses: a fake matchMedia the test flips
 *  between the tier queries dock-store and ChatsSheet both read through
 *  `dockAvailable()` / `shellTier()`. */
function setTier(tier: "desktop" | "tablet" | "phone") {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        tier === "desktop"
          ? query.includes("min-width: 1024px")
          : tier === "tablet"
            ? query.includes("min-width: 640px") && query.includes("max-width: 1023px")
            : query.includes("max-width: 639px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  syncShellTier()
}

function renderSheet() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <WsProvider send={mockWsSend} status={mockWsStatus}>
            <ApiProvider>
              <ChatsSheet />
            </ApiProvider>
          </WsProvider>
        )}
      />
    </Router>
  ))
}

function seedThread(overrides: Record<string, unknown> = {}) {
  addThread({
    id: "t1",
    handle: "@thread-1",
    title: "Design Review",
    isPinned: false,
    isMuted: false,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    updatedAt: new Date().toISOString(),
    ...overrides,
  })
}

describe("ChatsSheet (P4c-T14)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    resetPresenceStore()
    resetTabStore()
    resetDockStore()
    setTier("tablet")
  })

  afterEach(() => {
    cleanup()
    setTier("desktop")
    resetDockStore()
  })

  it("at tablet tier toggle-chat opens the Chats sheet with the list", async () => {
    seedThread()
    renderSheet()

    expect(screen.queryByTestId("overlay-sheet-close")).not.toBeInTheDocument()

    toggleChats()

    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())
    expect(screen.getByText("Design Review")).toBeInTheDocument()
    expect(activeThreadId()).toBeNull()
  })

  it("selecting a row shows the thread and back returns to the list", async () => {
    seedThread()
    renderSheet()
    toggleChats()
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())

    fireEvent.click(screen.getByText("Design Review"))

    await waitFor(() => expect(activeThreadId()).toBe("t1"))
    await waitFor(() => expect(screen.getByTestId("chats-sheet-back")).toBeInTheDocument())
    // The list row is gone: the thread view replaced it, not layered over it.
    // The name still appears once, in the header, which is what names the
    // open conversation now.
    // The sheet header is the one place the name still shows: it names the
    // open conversation instead of reading "Chats".
    expect(screen.queryAllByText("Design Review")).toHaveLength(1)
    expect(document.querySelector("[data-overlay-sheet] h2")?.textContent).toBe("Design Review")

    fireEvent.click(screen.getByTestId("chats-sheet-back"))

    await waitFor(() => expect(activeThreadId()).toBeNull())
    // The sheet itself stayed open, back on the list.
    expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())
  })

  it("the sheet has a close control and closes on Escape", async () => {
    seedThread()
    renderSheet()
    openConversation("t1")

    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("overlay-sheet-close"))

    await waitFor(() => expect(screen.queryByTestId("overlay-sheet-close")).not.toBeInTheDocument())
    expect(activeThreadId()).toBeNull()
    expect(chatsOpen()).toBe(false)

    // Escape closes it too, from the list-open state.
    toggleChats()
    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("overlay-sheet-close")).not.toBeInTheDocument())
    expect(chatsOpen()).toBe(false)
  })

  // P4c FX-B4 (N4). The back button unmounts itself, so focus fell out of the
  // dialog onto document.body and Kobalte's Escape handling never fired: the
  // sheet became keyboard-inescapable after a single back gesture.
  it("Escape closes the sheet after back returns to the list", async () => {
    seedThread()
    renderSheet()
    toggleChats()
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())

    fireEvent.click(screen.getByText("Design Review"))
    await waitFor(() => expect(activeThreadId()).toBe("t1"))

    fireEvent.click(screen.getByTestId("chats-sheet-back"))
    await waitFor(() => expect(activeThreadId()).toBeNull())
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())

    // Focus stayed inside the sheet, so the dialog still owns the key. Asserted
    // synchronously, not polled: the whole defect is the window between the
    // back gesture and whatever eventually reclaims focus, during which a key
    // press goes to document.body outside the dialog.
    const sheet = screen.getByTestId("overlay-sheet-close").closest("[data-overlay-sheet]")
    expect(sheet?.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("overlay-sheet-close")).not.toBeInTheDocument())
    expect(chatsOpen()).toBe(false)
  })

  // P4c FX-B2 (D8). Back is a navigation gesture: it used to call the same
  // destructive `close()` the dock's own X does, so the conversation was gone
  // and a later widen to desktop opened on an empty dock.
  it("back keeps the conversation, so widening to desktop still has the tab", async () => {
    seedThread()
    renderSheet()
    toggleChats()
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Design Review"))
    await waitFor(() => expect(activeThreadId()).toBe("t1"))

    fireEvent.click(screen.getByTestId("chats-sheet-back"))

    await waitFor(() => expect(activeThreadId()).toBeNull())

    setTier("desktop")
    expect(dockAvailable()).toBe(true)
    expect(tabs().map((t) => t.threadId)).toEqual(["t1"])
  })

  it("no dock root renders under 1024 px", async () => {
    seedThread()
    const { container } = renderSheet()
    openConversation("t1")

    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())
    expect(container.querySelector("[data-chat-dock]")).toBeNull()
  })

  // F6. The sheet header was pinned to "Chats", so an open conversation was
  // anonymous: the only thing in the thread bar was a back chevron.
  it("the header names the open conversation and goes back to Chats on back", async () => {
    seedThread()
    renderSheet()
    toggleChats()
    await waitFor(() => expect(screen.getByText("Design Review")).toBeInTheDocument())

    const heading = () =>
      (document.querySelector("[data-overlay-sheet] h2") as HTMLElement | null)?.textContent ?? ""
    expect(heading()).toBe("Chats")

    fireEvent.click(screen.getByText("Design Review"))
    await waitFor(() => expect(activeThreadId()).toBe("t1"))

    await waitFor(() => expect(heading()).toBe("Design Review"))
    expect(screen.getByTestId("chats-sheet-back")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("chats-sheet-back"))
    await waitFor(() => expect(heading()).toBe("Chats"))
    expect(screen.getByText("Design Review")).toBeInTheDocument()
  })

  it("names a DM exactly the way its roster row does", async () => {
    addThread({
      id: "t-dm",
      handle: "@dm",
      title: null,
      isPinned: false,
      isMuted: false,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        { id: "u2", name: "Bob Martinez", avatarUrl: null },
      ],
      updatedAt: new Date().toISOString(),
    })
    renderSheet()
    toggleChats()
    await waitFor(() => expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument())

    // Whatever the roster calls it, the header must call it the same.
    const rowLabel = await waitFor(() => {
      const el = screen.getByText(/Bob/)
      return el.textContent ?? ""
    })

    fireEvent.click(screen.getByText(/Bob/))
    await waitFor(() => expect(activeThreadId()).toBe("t-dm"))

    await waitFor(() =>
      expect(document.querySelector("[data-overlay-sheet] h2")?.textContent).toBe(rowLabel),
    )
  })
})
