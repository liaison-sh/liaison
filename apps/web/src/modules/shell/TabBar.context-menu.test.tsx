// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { TabBar } from "~/modules/shell/TabBar"
import {
  makeTabId,
  openTab,
  reopenLastClosed,
  resetTabStore,
  tabStore,
} from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const ids = () => tabStore.tabs.map((t) => t.entityId)
const tabEl = (entityId: string) =>
  document.querySelector<HTMLElement>(`[data-tab-id="${makeTabId("thread", entityId)}"]`)!

function setup() {
  for (const n of ["a", "b", "c", "d"]) {
    openTab({ type: "thread", entityId: n, label: `Thread ${n}`, preview: false })
  }
  render(() => (
    <PanelProvider>
      <TabBar />
    </PanelProvider>
  ))
}

describe("TabBar context menu", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("right-click opens a menu with Close, Close other tabs, Close tabs to the right", () => {
    setup()
    expect(screen.queryByTestId("tab-context-menu")).toBeNull()
    fireEvent.contextMenu(tabEl("b"))
    expect(screen.getByTestId("tab-context-menu")).toBeInTheDocument()
    expect(screen.getByTestId("tab-context-close")).toHaveTextContent("Close")
    expect(screen.getByTestId("tab-context-close-others")).toHaveTextContent("Close other tabs")
    expect(screen.getByTestId("tab-context-close-right")).toHaveTextContent(
      "Close tabs to the right",
    )
  })

  it("Copy link copies this server's address of the tab, and Home offers none", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    setup()
    fireEvent.contextMenu(tabEl("b"))
    fireEvent.click(screen.getByTestId("tab-context-copy-link"))
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/threads/b`),
    )
    expect(screen.queryByTestId("tab-context-menu")).toBeNull()
    fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-tab-type="kernel:home"]')!)
    expect(screen.queryByTestId("tab-context-copy-link")).toBeNull()
  })

  it("Close tabs to the right closes only the tabs to the right and keeps Home", () => {
    setup()
    fireEvent.contextMenu(tabEl("b"))
    fireEvent.click(screen.getByTestId("tab-context-close-right"))
    expect(ids()).toEqual(["home", "a", "b"])
    expect(screen.queryByTestId("tab-context-menu")).toBeNull()
  })

  it("Close other tabs keeps the clicked tab and Home, and activates the clicked tab", () => {
    setup()
    fireEvent.contextMenu(tabEl("b"))
    fireEvent.click(screen.getByTestId("tab-context-close-others"))
    expect(ids()).toEqual(["home", "b"])
    expect(tabStore.activeTabId).toBe(makeTabId("thread", "b"))
  })

  it("Close closes just that tab", () => {
    setup()
    fireEvent.contextMenu(tabEl("b"))
    fireEvent.click(screen.getByTestId("tab-context-close"))
    expect(ids()).toEqual(["home", "a", "c", "d"])
  })

  it("never closes Home: its menu offers only the bulk entries, and Close is disabled", () => {
    setup()
    const home = document.querySelector<HTMLElement>('[data-tab-type="kernel:home"]')!
    fireEvent.contextMenu(home)
    expect(screen.getByTestId("tab-context-close")).toBeDisabled()
    fireEvent.click(screen.getByTestId("tab-context-close-right"))
    expect(ids()).toEqual(["home"])
  })

  it("Reopen closed tab restores what the menu closed", () => {
    setup()
    fireEvent.contextMenu(tabEl("a"))
    fireEvent.click(screen.getByTestId("tab-context-close-right"))
    expect(ids()).toEqual(["home", "a"])
    reopenLastClosed()
    reopenLastClosed()
    reopenLastClosed()
    expect(ids().sort()).toEqual(["a", "b", "c", "d", "home"])
  })

  it("is keyboard accessible: Shift+F10 opens it, Escape closes it and refocuses the tab", () => {
    setup()
    const b = tabEl("b")
    b.focus()
    fireEvent.keyDown(b, { key: "F10", shiftKey: true })
    expect(screen.getByTestId("tab-context-menu")).toBeInTheDocument()
    expect(screen.getByTestId("tab-context-close")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("tab-context-menu"), { key: "Escape" })
    expect(screen.queryByTestId("tab-context-menu")).toBeNull()
    expect(b).toHaveFocus()
  })

  it("the ContextMenu key opens it too", () => {
    setup()
    const b = tabEl("b")
    fireEvent.keyDown(b, { key: "ContextMenu" })
    expect(screen.getByTestId("tab-context-menu")).toBeInTheDocument()
  })

  it("disables entries with nothing to close", () => {
    setup()
    fireEvent.contextMenu(tabEl("d"))
    expect(screen.getByTestId("tab-context-close-right")).toBeDisabled()
  })
})
