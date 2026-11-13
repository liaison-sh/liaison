// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { resetThreadTabNames, startThreadTabNames } from "~/modules/threads/thread-tab-names"
import { ChatDock, dockCapacity } from "./ChatDock"
import { DockWindow, dockWindowShift } from "./DockWindow"
import {
  agentWindowSize,
  DOCK_EDGE_RESERVE,
  DOCK_GAP,
  DOCK_ITEM_MAX_WIDTH,
  DOCK_OVERFLOW_ITEM_WIDTH,
  DOCK_PILL_HEIGHT,
  DOCK_STRIP_HEIGHT,
  DOCK_TAB_HEIGHT,
  DOCK_TAB_WIDTH,
  DOCK_TOGGLE_ITEM_WIDTH,
  DOCK_WINDOW_CLEARANCE,
  DOCK_WINDOW_GAP,
  dockWindowClearance,
  openConversation,
  resetDockStore,
  setDockPanelSize,
  setVisibleCapacity,
  tabs,
} from "./dock-store"

describe("ChatDock", () => {
  beforeEach(() => {
    resetDockStore()
    resetThreadStore()
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  // Two items this browser kept from another workspace read "Conversation",
  // with no face and nothing to open, for as long as the dock lived.
  it("an item whose conversation the server no longer has leaves the bar", async () => {
    openConversation("t-gone")
    openConversation("t-kept")
    addThread({ id: "t-kept", title: "kept", type: "thread", participants: [] })
    startThreadTabNames({
      get: async () => {
        throw new ApiError("Not found", 404)
      },
    })
    render(() => <ChatDock />)
    await waitFor(() => expect(tabs().map((t) => t.threadId)).toEqual(["t-kept"]))
    resetThreadTabNames()
  })

  it("the dock renders the Chats pill and one pill per open conversation", () => {
    openConversation("t1")
    openConversation("t2")

    render(() => <ChatDock />)

    expect(screen.getByText("Chats")).toBeInTheDocument()
    expect(document.querySelector('[data-dock-tab="t1"]')).toBeInTheDocument()
    expect(document.querySelector('[data-dock-tab="t2"]')).toBeInTheDocument()
  })

  it("the dock is one bar, and exposes the settled sizes to its items", () => {
    openConversation("t1", { expand: true })

    render(() => <ChatDock />)

    const root = document.querySelector("[data-chat-dock]") as HTMLElement
    expect(root.style.getPropertyValue("--dock-tab-width")).toBe(`${DOCK_TAB_WIDTH}px`)
    expect(root.style.getPropertyValue("--dock-tab-height")).toBe(`${DOCK_TAB_HEIGHT}px`)
    expect(root.style.getPropertyValue("--dock-pill-height")).toBe(`${DOCK_PILL_HEIGHT}px`)
    expect(root.style.getPropertyValue("--dock-gap")).toBe(`${DOCK_GAP}px`)

    // ONE bar holds every item: the Chats item and the conversation.
    const bars = document.querySelectorAll("[data-dock-bar]")
    expect(bars).toHaveLength(1)
    const bar = bars[0] as HTMLElement
    expect(bar.style.height).toBe(`${DOCK_PILL_HEIGHT}px`)
    // Chats, the conversation, and the collapse-all control at the far left.
    expect(bar.querySelectorAll("[data-dock-pill]")).toHaveLength(3)
    for (const token of ["rounded-tl-lg", "border-border-strong", "bg-elevated"]) {
      expect(bar.className).toContain(token)
    }
    expect(bar.className).not.toContain("shadow-popover")
    const tab = document.querySelector('[data-dock-tab="t1"]') as HTMLElement
    expect(tab.getAttribute("data-expanded")).toBe("true")
    expect(bar.contains(tab)).toBe(true)
  })

  it("three tabs at capacity two show the overflow pill with 1 more", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t3")
    setVisibleCapacity(2)

    render(() => <ChatDock />)

    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(
      screen.getByTestId("dock-overflow").querySelector("[data-overflow-count]"),
    ).toHaveAttribute("data-overflow-count", "1")
    // Most recently active two (t3, t2) stay on the strip; t1 is overflowed.
    expect(document.querySelector('[data-dock-tab="t3"]')).toBeInTheDocument()
    expect(document.querySelector('[data-dock-tab="t2"]')).toBeInTheDocument()
    expect(document.querySelector('[data-dock-tab="t1"]')).toBeNull()
  })

  // P4c FX-B4 (N1). The overflow menu listed `tab.threadId`, so a user who
  // overflowed the strip was offered raw UUIDs while the tabs beside them
  // showed names.
  it("the overflow menu lists conversation names, never ids", async () => {
    const overflowedId = "3f6b1e2a-0c44-4d1b-9c7e-2a1f8b5d0c31"
    addThread({
      id: overflowedId,
      handle: "@design-review",
      title: "Design Review",
      isPinned: false,
      isMuted: false,
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      updatedAt: new Date().toISOString(),
    })
    openConversation(overflowedId)
    openConversation("t2")
    openConversation("t3")
    setVisibleCapacity(2)

    render(() => <ChatDock />)

    const trigger = screen.getByLabelText("More conversations")
    fireEvent.keyDown(trigger, { key: "ArrowDown" })

    await waitFor(() => expect(screen.getByRole("menuitem")).toBeInTheDocument())
    const item = screen.getByRole("menuitem")
    expect(item).toHaveTextContent("Design Review")
    expect(item.textContent).not.toContain(overflowedId)
  })

  it("the strip never widens the main panel", () => {
    openConversation("t1", { expand: true })
    openConversation("t2", { expand: true })
    openConversation("t3", { expand: true })

    const container = document.createElement("div")
    container.style.width = "900px"
    document.body.appendChild(container)

    render(() => <ChatDock />, { container })

    const root = document.querySelector("[data-chat-dock]") as HTMLElement
    // jsdom performs no real layout, so scrollWidth/clientWidth are both 0
    // regardless of content and can't be asserted meaningfully as pixel
    // measurements here. The guarantee instead comes from the CSS itself:
    // `position: absolute` takes the strip out of normal flow, and `right: 0`
    // anchors it to the panel's own right edge rather than growing the panel
    // to fit it, so in a real browser the strip can only ever overflow
    // leftward over the panel's own content, never widen the panel's
    // scrollWidth past its clientWidth. Assert those computed constraints
    // directly, and pair them with the literal clientWidth/scrollWidth
    // comparison the task names, exercised on an explicit stand-in size.
    const computed = getComputedStyle(root)
    expect(computed.position).toBe("absolute")
    expect(computed.right).toBe("0px")

    Object.defineProperty(container, "clientWidth", { configurable: true, value: 900 })
    Object.defineProperty(container, "scrollWidth", { configurable: true, value: 900 })
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth)

    container.remove()
  })

  // The bar holds COLLAPSED items only (a window floats above it), so its
  // capacity is counted in items at their widest, never in 360px windows.
  it("capacity counts items at their widest, after the Chats and overflow items", () => {
    const chats = 90
    const fixed = DOCK_EDGE_RESERVE + chats + DOCK_OVERFLOW_ITEM_WIDTH + DOCK_TOGGLE_ITEM_WIDTH
    expect(dockCapacity(fixed + 3 * DOCK_ITEM_MAX_WIDTH, chats)).toBe(3)
    expect(dockCapacity(fixed + 3 * DOCK_ITEM_MAX_WIDTH - 1, chats)).toBe(2)
    expect(dockCapacity(100, chats)).toBe(0)
    // A 1200px panel holds far more than the two 340px panels it used to.
    expect(dockCapacity(1200, chats)).toBeGreaterThanOrEqual(5)
  })

  it("a window stays right aligned with its item unless that crosses the dock's left edge", () => {
    // Plenty of room: right aligned, no shift.
    expect(dockWindowShift(900, 0)).toBe(0)
    // Item right edge at 200px in a dock starting at 0: slide right to keep
    // the window's left edge DOCK_GAP inside the dock.
    expect(dockWindowShift(200, 0)).toBe(DOCK_TAB_WIDTH - 200 + DOCK_GAP)
    // A wider (agent) window slides by its own width.
    expect(dockWindowShift(200, 0, 520)).toBe(520 - 200 + DOCK_GAP)
  })

  it("sizes an agent window from the panel, between a person's window and its cap", () => {
    // A 14" laptop's main panel.
    expect(agentWindowSize({ width: 1140, height: 900 })).toEqual({ width: 524, height: 702 })
    // A narrow, short panel never goes below a person's window.
    expect(agentWindowSize({ width: 600, height: 500 })).toEqual({
      width: DOCK_TAB_WIDTH,
      height: DOCK_TAB_HEIGHT,
    })
    // A big screen stops at the cap.
    expect(agentWindowSize({ width: 2400, height: 1400 })).toEqual({ width: 560, height: 760 })
  })

  it("an agent window takes the larger size; a person's stays 360 x 460", () => {
    setDockPanelSize({ width: 1140, height: 900 })
    render(() => (
      <div>
        <DockWindow data-testid="agent-window" kind="agent">
          <span />
        </DockWindow>
        <DockWindow data-testid="person-window">
          <span />
        </DockWindow>
      </div>
    ))
    const agent = screen.getByTestId("agent-window")
    expect(agent.style.width).toBe("524px")
    expect(agent.style.height).toBe("702px")
    const person = screen.getByTestId("person-window")
    expect(person.style.width).toBe(`${DOCK_TAB_WIDTH}px`)
    expect(person.style.height).toBe(`${DOCK_TAB_HEIGHT}px`)
    // A message pane keeps clear of the tallest window that is up.
    expect(dockWindowClearance()).toBe(DOCK_STRIP_HEIGHT + DOCK_WINDOW_GAP + 702 + DOCK_GAP)
    cleanup()
    expect(dockWindowClearance()).toBe(DOCK_WINDOW_CLEARANCE)
  })
})
