// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { TabBar } from "~/modules/shell/TabBar"
import { closeTab, makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

function TestWrapper(props: { children: any }) {
  return <PanelProvider>{props.children}</PanelProvider>
}

describe("TabBar", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("renders tabs with labels", () => {
    openTab({ type: "thread", entityId: "t1", label: "Bug Report" })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getByText("Bug Report")).toBeInTheDocument()
    closeTab(makeTabId("thread", "t1"))
  })

  // THE BADGE IS THE PAGE'S OWN NOW (A33, P6d-T09). The shell drew it over
  // this page and pinned it to the window's top right corner, where it landed
  // on the agent panel's "New conversation" button whenever the conversation
  // title was long (driven walk, 2026-09-13). It is a flex sibling on the
  // composer row since P6d-T09, so the hole the toolbar reserved for it is
  // gone and nothing here is drawn over.
  it("reserves no slot for a shell to draw into", () => {
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    expect(document.querySelector("[data-liaison-shell-slot]")).toBeNull()
    expect(screen.getByLabelText("Command palette")).toBeTruthy()
  })

  // Nothing opens the right panel any more: the toggle in the top right corner
  // opened and closed an empty, zero-width column (2026-09-24).
  it("has no right panel toggle", () => {
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    expect(screen.queryByLabelText("Open panel")).toBeNull()
    expect(screen.queryByLabelText("Close panel")).toBeNull()
  })

  it("highlights active tab", () => {
    openTab({ type: "thread", entityId: "t1", label: "Bug Report" })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const activeTab = screen.getByText("Bug Report").closest("[data-tab]")
    expect(activeTab).toHaveAttribute("data-active", "true")
    closeTab(makeTabId("thread", "t1"))
  })

  it("shows close button on active tab", () => {
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const homeTab = screen.getByText("Home").closest("[data-tab]")
    const closeBtn = homeTab?.querySelector("[data-tab-close]")
    expect(closeBtn).toBeInTheDocument()
  })

  it("renders preview tab with italic label", () => {
    openTab({ type: "thread", entityId: "t1", label: "Preview Thread", preview: true })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const label = screen.getByText("Preview Thread")
    expect(label).toHaveClass("italic")
    closeTab(makeTabId("thread", "t1"))
  })

  it("calls closeTab on close button click", () => {
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const threadTab = screen.getByText("Thread 1").closest("[data-tab]")
    const closeBtn = threadTab?.querySelector("[data-tab-close]") as HTMLElement
    fireEvent.click(closeBtn)
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeUndefined()
  })

  it("renders a tabstrip with data-tab-type on each tab", () => {
    openTab({ type: "knowledge:home", entityId: "knowledge-home", label: "Knowledge" })
    const { container } = render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    expect(container.querySelector('[data-testid="tabstrip"]')).not.toBeNull()
    const active = container.querySelector(
      '[data-testid="tabstrip"] [data-active="true"]',
    ) as HTMLElement
    expect(active.getAttribute("data-tab-type")).toBe("knowledge:home")
    closeTab(makeTabId("knowledge:home", "knowledge-home"))
  })

  it("calls closeTab on middle-click", () => {
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const threadTab = screen.getByText("Thread 1").closest("[data-tab]") as HTMLElement
    fireEvent.mouseDown(threadTab, { button: 1 })
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t1"))).toBeUndefined()
  })

  it("pointercancel mid-drag removes the document move/up/cancel listeners", () => {
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    render(() => (
      <TestWrapper>
        <TabBar />
      </TestWrapper>
    ))
    const threadTab = screen.getByText("Thread 1").closest("[data-tab]") as HTMLElement

    const addSpy = vi.spyOn(document, "addEventListener")
    const removeSpy = vi.spyOn(document, "removeEventListener")

    fireEvent.pointerDown(threadTab, { pointerId: 1, button: 0, clientX: 0 })
    const addedPointerListeners = addSpy.mock.calls.filter(
      ([type]) => type === "pointermove" || type === "pointerup" || type === "pointercancel",
    )
    expect(addedPointerListeners.length).toBe(3)

    fireEvent(document, new PointerEvent("pointercancel", { pointerId: 1 }))

    const removedPointerListeners = removeSpy.mock.calls.filter(
      ([type]) => type === "pointermove" || type === "pointerup" || type === "pointercancel",
    )
    expect(removedPointerListeners.length).toBe(3)

    addSpy.mockRestore()
    removeSpy.mockRestore()
    closeTab(makeTabId("thread", "t1"))
  })
})
