// SPDX-License-Identifier: FSL-1.1-ALv2
// The conversation on screen: what every "new message" notice checks before
// it interrupts, in the page (notify frames) and in the phone shell (a push
// that lands with the app open), which is told through the native bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { collapse, openConversation, resetDockStore, toggleChats } from "~/modules/shell/dock-store"
import { syncShellTier, TABLET_QUERY } from "~/modules/shell/shell-tier"
import { makeTabId, openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { closeReplyPanel, openReplyPanel } from "~/modules/threads/reply-panel-store"
import {
  installThreadOnScreenReport,
  installViewingReport,
  replyRootOfRoute,
  threadOfRoute,
  threadOnScreen,
  threadsBeingRead,
  viewingReport,
} from "./thread-on-screen"

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("the conversation on screen", () => {
  let reported: Array<string | null>
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    reported = []
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      setThreadOnScreen: (id: string | null) => reported.push(id),
    }
    setVisibility("visible")
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetTabStore()
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
    setVisibility("visible")
    vi.restoreAllMocks()
  })

  it("is the thread of the active tab while the page is visible", () => {
    openTab({ type: "thread", entityId: "t-open", label: "Ops" })
    expect(tabStore.activeTabId).toBe(makeTabId("thread", "t-open"))
    expect(threadOnScreen()).toBe("t-open")
    setVisibility("hidden")
    expect(threadOnScreen()).toBeNull()
  })

  it("is nothing when the active tab is not a conversation", () => {
    openTab({ type: "thread", entityId: "t-open", label: "Ops" })
    openTab({ type: "settings", entityId: "profile", label: "Settings" })
    expect(threadOnScreen()).toBeNull()
  })

  it("reports every change to the native shell, and null once the page is hidden", () => {
    uninstall = installThreadOnScreenReport()
    openTab({ type: "thread", entityId: "t-open", label: "Ops" })
    openTab({ type: "thread", entityId: "t-next", label: "Sales" })
    setVisibility("hidden")
    setVisibility("visible")
    expect(reported).toEqual([null, "t-open", "t-next", null, "t-next"])
  })

  // P4 (P-D3): the same on-screen slot carries the session on screen, so the
  // phone shell can hold back a push for the session the user is watching.
  it("an active, visible session tab reports its id", () => {
    uninstall = installThreadOnScreenReport()
    openTab({ type: "kernel:session", entityId: "s-open", label: "Fix the sum" })
    expect(threadOnScreen()).toBe("s-open")
    expect(reported).toEqual([null, "s-open"])
  })

  it("a hidden page reports null for a session", () => {
    uninstall = installThreadOnScreenReport()
    openTab({ type: "kernel:session", entityId: "s-open", label: "Fix the sum" })
    setVisibility("hidden")
    expect(threadOnScreen()).toBeNull()
    expect(reported).toEqual([null, "s-open", null])
  })

  it("a session open in a background tab reports null", () => {
    openTab({ type: "kernel:session", entityId: "s-open", label: "Fix the sum" })
    openTab({ type: "settings", entityId: "profile", label: "Settings" })
    expect(threadOnScreen()).toBeNull()
  })

  it("reads the thread a notify route names", () => {
    expect(threadOfRoute("thread/abc")).toBe("abc")
    expect(threadOfRoute("thread/abc?replyRoot=r1")).toBe("abc")
    expect(threadOfRoute("/threads/abc")).toBe("abc")
    expect(threadOfRoute("/approvals/1")).toBeNull()
    expect(threadOfRoute(undefined)).toBeNull()
  })
})

// What the page tells the SERVER it shows, so a device push for a thread the
// user is reading here is held back: the active tab, the dock's open window
// (where the personal agent chat lives), and whether the window has focus.
describe("the viewing report", () => {
  let focused = true
  let changes = 0
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    focused = true
    changes = 0
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused)
    setVisibility("visible")
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetTabStore()
    resetDockStore()
    for (const id of ["t-main", "t-agent"]) closeReplyPanel(id)
    setVisibility("visible")
    vi.restoreAllMocks()
    syncShellTier()
  })

  function blur(): void {
    focused = false
    window.dispatchEvent(new Event("blur"))
  }

  it("carries the conversation open in the dock window, focused", () => {
    openConversation("t-agent")
    expect(viewingReport()).toEqual({ threadIds: ["t-agent"], focused: true })
    openTab({ type: "thread", entityId: "t-main", label: "Ops" })
    expect(viewingReport().threadIds).toEqual(["t-main", "t-agent"])
    collapse("t-agent")
    expect(viewingReport().threadIds).toEqual(["t-main"])
  })

  it("is unfocused when the window lost focus, and empty when the page is hidden", () => {
    openConversation("t-agent")
    blur()
    expect(viewingReport()).toEqual({ threadIds: ["t-agent"], focused: false })
    setVisibility("hidden")
    expect(viewingReport()).toEqual({ threadIds: [], focused: false })
  })

  // A desktop window left open on a conversation behind other apps stays
  // `visible` (macOS keeps an occluded window's page visible): the user is not
  // reading it, so the notice for that conversation must still be raised.
  it("reads a conversation only while the window has focus", () => {
    openTab({ type: "thread", entityId: "t-main", label: "Ops" })
    openConversation("t-agent")
    expect(threadsBeingRead()).toEqual(["t-main", "t-agent"])
    blur()
    expect(threadsBeingRead()).toEqual([])
    focused = true
    setVisibility("hidden")
    expect(threadsBeingRead()).toEqual([])
  })

  it("tells the server at once on every change, not only at the heartbeat", () => {
    uninstall = installViewingReport(() => {
      changes += 1
    })
    expect(changes).toBe(0)
    openConversation("t-agent")
    expect(changes).toBe(1)
    blur()
    expect(changes).toBe(2)
    setVisibility("hidden")
    expect(changes).toBe(3)
  })

  it("does not report the dock window the Chats roster covers", () => {
    openConversation("t-agent")
    toggleChats()
    expect(viewingReport().threadIds).toEqual([])
    toggleChats()
    expect(viewingReport().threadIds).toEqual(["t-agent"])
  })

  it("reports an open reply pane by its root: beside a tab, and instead of the dock's conversation", () => {
    openTab({ type: "thread", entityId: "t-main", label: "Ops" })
    expect(viewingReport().threadIds).toEqual(["t-main"])
    openReplyPanel("t-main", "root-1")
    expect(viewingReport().threadIds).toEqual(["t-main", "root-1"])

    openConversation("t-agent")
    openReplyPanel("t-agent", "root-2")
    // The pane covers the conversation in the dock window.
    expect(viewingReport().threadIds).toEqual(["t-main", "root-1", "root-2"])
  })

  it("reports the conversation the tablet Chats sheet shows", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === TABLET_QUERY,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    )
    syncShellTier()
    openConversation("t-sheet", { keepChats: true })
    expect(viewingReport().threadIds).toEqual(["t-sheet"])
  })

  it("reads the reply root a notify route names", () => {
    expect(replyRootOfRoute("thread/abc?replyRoot=r1")).toBe("r1")
    expect(replyRootOfRoute("thread/abc")).toBeNull()
  })
})
