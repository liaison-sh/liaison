// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * More tabs than the strip is wide. The strip scrolls, but a pointer wheel is
 * the only way to discover that: nothing on screen says the right-most tab is
 * still there, so the tab a person just opened looks lost. The strip carries
 * an explicit affordance that brings its far end into view.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { TabBar } from "~/modules/shell/TabBar"
import { openTab, resetTabStore, tabStore, updateTabLabel } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

/** jsdom has no layout, so the strip is told what it would measure in a
 *  browser: a 240px window onto 900px of tabs. `scrollLeft` is backed by a
 *  real value so the affordance's effect is observable. */
function makeStripOverflow(clientWidth: number, scrollWidth: number): HTMLElement {
  const strip = document.querySelector<HTMLElement>(".tab-bar")
  if (!strip) throw new Error("tab strip not rendered")
  let left = 0
  Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => clientWidth })
  Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => scrollWidth })
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (v: number) => {
      left = v
    },
  })
  fireEvent.scroll(strip)
  return strip
}

describe("TabBar overflow affordance", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("offers no affordance while every tab already fits", () => {
    openTab({ type: "thread", entityId: "t1", label: "One" })
    render(() => (
      <PanelProvider>
        <TabBar />
      </PanelProvider>
    ))
    makeStripOverflow(900, 900)
    expect(screen.queryByTestId("tabstrip-overflow")).toBeNull()
  })

  it("reveals the far end of the strip when the tabs no longer fit", () => {
    for (let i = 0; i < 12; i++) {
      openTab({ type: "thread", entityId: `t${i}`, label: `Thread ${i}` })
    }
    render(() => (
      <PanelProvider>
        <TabBar />
      </PanelProvider>
    ))
    const strip = makeStripOverflow(240, 900)

    const affordance = screen.getByTestId("tabstrip-overflow")
    expect(affordance.getAttribute("aria-label")).toBeTruthy()

    fireEvent.click(affordance)
    // The right-most tab is now inside the visible window.
    expect(strip.scrollLeft).toBe(900 - 240)

    // Once the end is reached the affordance has nothing left to reveal.
    fireEvent.scroll(strip)
    expect(screen.queryByTestId("tabstrip-overflow")).toBeNull()
  })

  it("brings the active tab back into view when a rename widens it", async () => {
    openTab({ type: "thread", entityId: "t1", label: "One" })
    const scrolled = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrolled
    render(() => (
      <PanelProvider>
        <TabBar />
      </PanelProvider>
    ))
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    await frame()
    scrolled.mockClear()
    updateTabLabel(tabStore.activeTabId as string, "A much longer channel name after a rename")
    await frame()
    expect(scrolled).toHaveBeenCalled()
  })
})
