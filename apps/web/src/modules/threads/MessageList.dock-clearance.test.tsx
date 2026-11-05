// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIF-3: the message list reserves what floats over the main panel's bottom
// right corner (the dock strip, or the open dock window), so scrolling to the
// end lands the last message above it. jsdom lays nothing out, so this proves
// the wiring: the reserve class, the offset the list publishes, the window
// signal the shell's variable reads, and the re-pin when a window opens.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import {
  collapse,
  DOCK_GAP,
  DOCK_STRIP_HEIGHT,
  DOCK_TAB_HEIGHT,
  DOCK_WINDOW_CLEARANCE,
  DOCK_WINDOW_GAP,
  dockWindowOpen,
  openConversation,
  resetDockStore,
  toggleChats,
} from "~/modules/shell/dock-store"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import MessageList, { dockPaneOffset, MESSAGE_SCROLL_CLASS } from "~/modules/threads/MessageList"
import { resetMessageStore } from "~/modules/threads/message-store"

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

function renderList(inMainPanel: boolean) {
  const list = () => <MessageList threadId="thread-dock" currentUserId="u1" />
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={() => true}>
              {inMainPanel ? <main data-testid="main-panel">{list()}</main> : list()}
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("message list dock clearance", () => {
  beforeEach(() => {
    resetDockStore()
    resetMessageStore()
  })
  afterEach(() => cleanup())

  it("the scrollport's bottom padding is the dock reserve, not a fixed py-3", () => {
    expect(MESSAGE_SCROLL_CLASS.split(" ")).toContain("pb-dock-window-clearance")
    expect(MESSAGE_SCROLL_CLASS.split(" ")).not.toContain("py-3")
    renderList(true)
    const scroller = screen.getByTestId("message-scroll-container")
    expect(scroller.className).toContain("pb-dock-window-clearance")
  })

  it("publishes how far it ends above the main panel, and opts out outside it", () => {
    expect(dockPaneOffset(700, 820)).toBe(120)
    expect(dockPaneOffset(820, 820)).toBe(0)
    expect(dockPaneOffset(830, 820)).toBe(0)

    renderList(true)
    // jsdom: both rects are zero, so the list reaches the panel's bottom.
    expect(
      screen.getByTestId("message-scroll-container").style.getPropertyValue("--dock-pane-offset"),
    ).toBe("0px")
    cleanup()

    renderList(false)
    const outside = screen
      .getByTestId("message-scroll-container")
      .style.getPropertyValue("--dock-pane-offset")
    // Outside the main panel nothing floats over it: an offset no reserve exceeds.
    expect(Number.parseFloat(outside)).toBeGreaterThan(DOCK_WINDOW_CLEARANCE)
  })

  it("the window reserve covers the strip, the window and its gaps", () => {
    expect(DOCK_WINDOW_CLEARANCE).toBe(
      DOCK_STRIP_HEIGHT + DOCK_WINDOW_GAP + DOCK_TAB_HEIGHT + DOCK_GAP,
    )
  })

  it("dockWindowOpen follows a conversation window and the Chats roster", () => {
    expect(dockWindowOpen()).toBe(false)
    openConversation("t1")
    expect(dockWindowOpen()).toBe(true)
    collapse("t1")
    expect(dockWindowOpen()).toBe(false)
    toggleChats()
    expect(dockWindowOpen()).toBe(true)
    toggleChats()
    expect(dockWindowOpen()).toBe(false)
  })

  it("a window opening re-pins a reader following the newest message", async () => {
    renderList(true)
    const el = screen.getByTestId("message-scroll-container")
    let top = 0
    let height = 1000
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height })
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 })
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      },
    })
    // Let the mount's own pin pass first.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    top = 600
    // The window's reserve grows the scroll height without a scroll event.
    height = 1500
    openConversation("t1")
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    // Pinned to the bottom (a browser clamps the write to scrollHeight - clientHeight).
    expect(top).toBeGreaterThanOrEqual(1100)
  })
})
