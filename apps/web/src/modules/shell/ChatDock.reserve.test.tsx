// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dock strip FLOATS over the bottom of the main panel and reserves no
// band: the panel used to pad its bottom by the strip's height, which left an
// empty strip under every page and pushed every page up. The bar is kept
// small (32px, anchored flush to the bottom right corner) so it covers as
// little as possible.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ChatDock } from "~/modules/shell/ChatDock"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { DOCK_PILL_HEIGHT, DOCK_STRIP_HEIGHT, openConversation, resetDockStore } from "./dock-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

function renderPanel(withDock: boolean) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <PanelProvider>
            <MainPanel tier="desktop">{withDock ? <ChatDock /> : null}</MainPanel>
          </PanelProvider>
        )}
      />
    </Router>
  ))
}

/** px value of a CSS length, or 0 for "" / "0px". */
function px(value: string): number {
  return Number.parseFloat(value) || 0
}

describe("chat dock strip reserve", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    resetDockStore()
  })
  afterEach(() => {
    cleanup()
    resetDockStore()
  })

  it("the strip floats over the panel and the panel reserves no band for it", () => {
    renderPanel(true)

    const panel = screen.getByTestId("main-panel")
    const strip = document.querySelector("[data-chat-dock]") as HTMLElement
    expect(strip).toBeTruthy()

    expect(px(getComputedStyle(panel).paddingBottom)).toBe(0)

    const stripStyle = getComputedStyle(strip)
    expect(stripStyle.position).toBe("absolute")
    expect(stripStyle.bottom).toBe("0px")
    expect(stripStyle.pointerEvents).toBe("none")
    expect(px(stripStyle.height)).toBe(DOCK_STRIP_HEIGHT)
  })

  // Anchored flush to the panel's bottom right corner: no float gap, no
  // shadow, the bar's bottom and right edges are the panel's edges.
  it("the strip is the 32px bar alone, anchored flush to the corner", () => {
    renderPanel(true)
    expect(DOCK_PILL_HEIGHT).toBe(32)
    expect(DOCK_STRIP_HEIGHT).toBe(DOCK_PILL_HEIGHT)
    const strip = document.querySelector("[data-chat-dock]") as HTMLElement
    expect(px(strip.style.paddingRight)).toBe(0)
    const bar = strip.querySelector("[data-dock-bar]") as HTMLElement
    expect(bar.className).not.toContain("shadow")
    expect(bar.className).toContain("border-t")
    expect(bar.className).toContain("border-l")
    expect(bar.className).not.toMatch(/(^|\s)border(\s|$)/)
    expect(bar.className).toContain("rounded-tl-lg")
    openConversation("t1")
    for (const pill of document.querySelectorAll("[data-dock-pill]")) {
      expect(px(getComputedStyle(pill as HTMLElement).height)).toBeLessThanOrEqual(DOCK_PILL_HEIGHT)
    }
  })

  it("a panel with no dock strip reserves nothing", () => {
    renderPanel(false)
    const panel = screen.getByTestId("main-panel")
    expect(px(getComputedStyle(panel).paddingBottom)).toBe(0)
  })
})
