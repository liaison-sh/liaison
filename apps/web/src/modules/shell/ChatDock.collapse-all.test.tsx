// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The control at the far left of the dock bar folds every open chat into
// Chats and brings them back. Each item (the open window first, then the bar
// items nearest Chats first) shrinks into Chats over 280ms, 40ms apart; with
// reduced motion they only fade.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetThreadStore } from "~/modules/threads/thread-store"
import { ChatDock } from "./ChatDock"
import { DockWindow } from "./DockWindow"
import {
  allCollapsed,
  collapseAll,
  type DockTab,
  expandAll,
  openConversation,
  resetDockStore,
  surfaceIncoming,
  visibleTabs,
} from "./dock-store"

interface AnimateCall {
  el: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

let calls: AnimateCall[] = []
let reduced = false

function installAnimate() {
  calls = []
  ;(Element.prototype as unknown as { animate: unknown }).animate = function (
    this: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    calls.push({ el: this, keyframes, options })
    return { finished: Promise.resolve(), cancel: () => {} } as unknown as Animation
  }
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduced : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })),
  )
}

// A tab with its window, as the Shell's ConversationTab renders one.
function Tab(tab: DockTab) {
  return (
    <div class="relative flex h-full" data-dock-tab={tab.threadId}>
      <span data-dock-pill>{tab.threadId}</span>
      {tab.expanded ? (
        <DockWindow data-testid={`window-${tab.threadId}`}>
          <div />
        </DockWindow>
      ) : null}
    </div>
  )
}

const renderDock = () => render(() => <ChatDock renderTab={Tab} />)
const toggle = () => screen.getByTestId("dock-collapse-all")
const tabIds = () =>
  [...document.querySelectorAll("[data-dock-tab]")].map((el) => el.getAttribute("data-dock-tab"))

describe("dock collapse-all", () => {
  beforeEach(() => {
    resetDockStore()
    resetThreadStore()
    reduced = false
    installAnimate()
  })
  afterEach(() => {
    cleanup()
    resetDockStore()
    delete (Element.prototype as unknown as { animate?: unknown }).animate
    vi.unstubAllGlobals()
  })

  it("is absent while the dock holds no conversation", () => {
    renderDock()
    expect(screen.queryByTestId("dock-collapse-all")).toBeNull()
  })

  it("sits at the far left of the bar, after every conversation", () => {
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: false })
    renderDock()
    const bar = document.querySelector("[data-dock-bar]") as HTMLElement
    // The bar runs right to left: its last child is its leftmost item.
    expect(bar.lastElementChild?.contains(toggle())).toBe(true)
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(toggle().getAttribute("aria-label")).toBe("Collapse all chats into Chats")
  })

  it("folds every chat into Chats, each shrinking into it 40ms after the last", async () => {
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: false })
    openConversation("t3", { expand: true })
    renderDock()
    fireEvent.click(toggle())
    await waitFor(() => expect(tabIds()).toEqual([]))
    // The window first, then the three bar items.
    expect(calls).toHaveLength(4)
    expect(calls[0]!.el.hasAttribute("data-dock-window")).toBe(true)
    calls.forEach((c, i) => {
      expect(c.options.duration).toBe(280)
      expect(c.options.delay).toBe(i * 40)
      expect(String(c.keyframes[1]!.transform)).toMatch(/translate\(.*\) scale\(/)
      expect(c.keyframes[1]!.opacity).toBe(0)
    })
    expect(allCollapsed()).toBe(true)
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(toggle().getAttribute("aria-label")).toBe("Show 3 chats")
    expect(screen.getByTestId("dock-collapse-all-count").textContent).toBe("3")
    expect(screen.getByTestId("dock-collapse-all-status").textContent).toContain("3")
  })

  it("brings them back, the window that was open open again", async () => {
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: true })
    renderDock()
    fireEvent.click(toggle())
    await waitFor(() => expect(tabIds()).toEqual([]))
    calls = []
    fireEvent.click(toggle())
    await waitFor(() => expect(tabIds()).toEqual(["t2", "t1"]))
    expect(screen.getByTestId("window-t2")).toBeTruthy()
    expect(allCollapsed()).toBe(false)
    // Out of Chats: from the shrunk state back to none, staggered.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(String(calls[0]!.keyframes[0]!.transform)).toMatch(/scale\(/)
    expect(calls[0]!.keyframes[1]!.transform).toBe("none")
  })

  it("with reduced motion the chats fade in place, nothing moves", async () => {
    reduced = true
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: true })
    renderDock()
    fireEvent.click(toggle())
    await waitFor(() => expect(tabIds()).toEqual([]))
    expect(calls.length).toBe(3)
    for (const c of calls) {
      expect(c.options.duration).toBe(120)
      expect(c.options.delay ?? 0).toBe(0)
      for (const frame of c.keyframes) expect(frame.transform).toBeUndefined()
      expect(c.keyframes[1]!.opacity).toBe(0)
    }
  })

  it("collapsed, an incoming chat stays folded and counts; opening one shows the bar again", () => {
    openConversation("t1", { expand: false })
    collapseAll()
    expect(visibleTabs()).toEqual([])
    surfaceIncoming("t2")
    expect(visibleTabs()).toEqual([])
    openConversation("t3")
    expect(allCollapsed()).toBe(false)
    expect(visibleTabs().map((t) => t.threadId)).toContain("t3")
    collapseAll()
    expandAll()
    expect(visibleTabs().length).toBe(3)
  })
})
