// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * More apps than the rail is tall. The rail draws the icons that fit and ends
 * on a "+N" control; pointing at it, clicking it or dragging an app onto it
 * opens the rail into as many columns as every app needs, so none is out of
 * reach on a short window.
 */
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerActivityBarEntry, resetRegistry } from "~/framework/app-registry"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { RAIL_FOLD_DELAY_MS, RAIL_OPEN_INTENT_MS } from "~/modules/shell/activity-bar-fit"
import {
  customActivityBarOrder,
  resetActivityBarOrderStore,
} from "~/modules/shell/activity-bar-order-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { WsProvider } from "~/modules/shell/WsContext"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

/** jsdom has no layout: the rail's app column is told the height it would
 *  measure in a browser, and its ResizeObserver is fired by hand. */
const observers: Array<() => void> = []
class ManualResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(() => this.callback([], this))
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setColumnHeight(px: number) {
  const column = screen.getByTestId("activity-bar-apps")
  Object.defineProperty(column, "clientHeight", { configurable: true, get: () => px })
  for (const fire of observers) fire()
}

const Glyph = () => null
const APPS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]

function registerApps(badges: Record<string, { count: () => number; tone?: "warning" }> = {}) {
  APPS.forEach((label, i) => {
    const id = label.toLowerCase()
    registerActivityBarEntry({
      id,
      icon: Glyph,
      label,
      order: i,
      appId: id,
      badge: badges[label]?.count,
      badgeTone: badges[label]?.tone,
      tabAction: { type: `${id}:home`, entityId: `${id}-home`, label },
    })
  })
}

const [wsStatus] = createSignal<"connected" | "disconnected">("connected")

function renderRail(tier: "desktop" | "tablet" = "desktop") {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <WsProvider send={() => {}} status={wsStatus}>
            <ActivityBar tier={tier} />
          </WsProvider>
        )}
      />
    </Router>
  ))
}

const railButtons = () =>
  APPS.filter((label) => screen.queryByTestId(`activity-${label.toLowerCase()}`) !== null)

/** Rail entries in DOM order, i.e. column one top to bottom, then column two. */
const railOrder = () =>
  Array.from(
    screen
      .getByTestId("activity-bar-apps-track")
      .querySelectorAll<HTMLElement>("[data-rail-entry]"),
  ).map((el) => el.getAttribute("data-rail-entry"))

const track = () => screen.getByTestId("activity-bar-apps-track")

// Desktop slots are 34px with a 4px gap: 186px holds five slots, so four apps
// and the "+N" control.
const FIVE_SLOTS = 186

describe("ActivityBar overflow", () => {
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal("ResizeObserver", ManualResizeObserver)
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetTabStore()
    resetActivityBarOrderStore()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    attentionStore._setForTest({ items: [], errors: [] })
  })

  it("offers no control while every app fits", () => {
    registerApps()
    renderRail()
    setColumnHeight(1000)
    expect(railButtons()).toEqual(APPS)
    expect(screen.queryByTestId("activity-bar-more")).toBeNull()
    expect(track().getAttribute("data-columns")).toBe("1")
  })

  it("draws what fits and gives the last slot to +N", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    expect(railButtons()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"])
    const more = screen.getByTestId("activity-bar-more")
    expect(more.textContent).toBe("+4")
    expect(more.getAttribute("aria-expanded")).toBe("false")
    expect(more.getAttribute("aria-controls")).toBe(track().id)
    expect(more.getAttribute("data-overflow-count")).toBe("4")
    expect(more.getAttribute("aria-label")).toBe("4 more apps")
  })

  it("the tablet rail counts its larger touch slots", () => {
    registerApps()
    renderRail("tablet")
    // 44px slots with a 4px gap: 186px holds three, two apps and the control.
    setColumnHeight(FIVE_SLOTS)
    expect(railButtons()).toEqual(["Alpha", "Bravo"])
    expect(screen.getByTestId("activity-bar-more").textContent).toBe("+6")
  })

  it("recomputes when the window grows and when an app is installed", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    expect(screen.getByTestId("activity-bar-more")).toBeInTheDocument()
    setColumnHeight(1000)
    expect(screen.queryByTestId("activity-bar-more")).toBeNull()
    expect(railButtons()).toEqual(APPS)
    setColumnHeight(FIVE_SLOTS)
    registerActivityBarEntry({
      id: "india",
      icon: Glyph,
      label: "India",
      order: 100,
      appId: "india",
      tabAction: { type: "india:home", entityId: "india-home", label: "India" },
    })
    expect(screen.getByTestId("activity-bar-more").getAttribute("data-overflow-count")).toBe("5")
  })

  it("keeps the app you are in on the folded rail", () => {
    registerApps()
    openTab({ type: "golf:home", entityId: "golf-home", label: "Golf" })
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    expect(railButtons()).toEqual(["Alpha", "Bravo", "Charlie", "Golf"])
    expect(screen.getByTestId("activity-golf").getAttribute("aria-current")).toBe("page")
  })

  it("marks +N with a danger dot when any folded app carries a danger count", () => {
    const [unread] = createSignal(3)
    const [waiting] = createSignal(2)
    registerApps({
      Foxtrot: { count: unread },
      Hotel: { count: waiting, tone: "warning" },
    })
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    const badge = screen.getByTestId("activity-bar-more-badge")
    expect(badge.getAttribute("data-count")).toBe("5")
    expect(badge.getAttribute("data-tone")).toBe("danger")
    // A dot, not a number: "+N" already carries a figure.
    expect(badge.textContent).toBe("")
  })

  it("keeps a warning-only dot in the warning tone", () => {
    const [waiting] = createSignal(2)
    registerApps({ Hotel: { count: waiting, tone: "warning" } })
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    expect(screen.getByTestId("activity-bar-more-badge").getAttribute("data-tone")).toBe("warning")
  })

  it("carries an attention dot of a folded app", () => {
    registerApps()
    attentionStore._setForTest({
      items: [
        {
          id: "echo:x:1",
          app: "echo",
          entity: "thing",
          entityId: "1",
          kind: "sla_risk",
          summary: "x",
          urgency: 70,
          occurredAt: "2026-05-06T00:00:00Z",
          action: { type: "open_entity", tabType: "echo:thing", entityId: "1" },
        },
      ],
      errors: [],
    })
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    expect(screen.getByTestId("activity-bar-more-attention")).toBeInTheDocument()
    expect(screen.queryByTestId("activity-bar-more-badge")).toBeNull()
  })

  it("a click on +N opens every app in columns, column one first", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    // Five slots per column for eight apps: two columns, and +N is gone.
    expect(track().getAttribute("data-columns")).toBe("2")
    expect(screen.getByTestId("activity-bar").getAttribute("data-rail-open")).toBe("true")
    expect(screen.queryByTestId("activity-bar-more")).toBeNull()
    expect(railOrder()).toEqual(APPS.map((label) => label.toLowerCase()))
    // Keyboard and click openings land on the first app that was folded away.
    expect(document.activeElement).toBe(screen.getByTestId("activity-echo"))
  })

  it("lays the folded apps out from the bottom up, beside +N", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    const cell = (label: string) => {
      const trigger = screen.getByTestId(`activity-${label}`).parentElement as HTMLElement
      return [trigger.style.gridRow, trigger.style.gridColumn]
    }
    expect(cell("alpha")).toEqual(["1", "1"])
    // Echo takes the slot "+N" had, at the bottom of column one.
    expect(cell("echo")).toEqual(["5", "1"])
    expect(cell("foxtrot")).toEqual(["5", "2"])
    expect(cell("golf")).toEqual(["4", "2"])
    expect(cell("hotel")).toEqual(["3", "2"])
  })

  it("needs as many columns as the apps fill", () => {
    registerApps()
    renderRail()
    // Three slots per column for eight apps: three columns.
    setColumnHeight(110)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    expect(track().getAttribute("data-columns")).toBe("3")
    expect(track().style.gridTemplateRows).toBe("repeat(3, 34px)")
  })

  it("opens on a held pointer over +N, not on a pass over it", () => {
    vi.useFakeTimers()
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    const more = screen.getByTestId("activity-bar-more")
    fireEvent.pointerEnter(more, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_OPEN_INTENT_MS - 40)
    fireEvent.pointerLeave(more, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_OPEN_INTENT_MS)
    expect(track().getAttribute("data-columns")).toBe("1")

    fireEvent.pointerEnter(more, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_OPEN_INTENT_MS)
    expect(track().getAttribute("data-columns")).toBe("2")
  })

  it("folds a moment after the pointer leaves, unless it comes back", () => {
    vi.useFakeTimers()
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    const rail = screen.getByTestId("activity-bar")

    fireEvent.pointerLeave(rail, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_FOLD_DELAY_MS - 50)
    fireEvent.pointerEnter(rail, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_FOLD_DELAY_MS)
    expect(track().getAttribute("data-columns")).toBe("2")

    fireEvent.pointerLeave(rail, { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_FOLD_DELAY_MS)
    expect(track().getAttribute("data-columns")).toBe("1")
    expect(screen.getByTestId("activity-bar-more")).toBeInTheDocument()
  })

  it("Escape folds it and hands focus back to +N", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(track().getAttribute("data-columns")).toBe("1")
    expect(document.activeElement).toBe(screen.getByTestId("activity-bar-more"))
  })

  it("a press outside folds it, a press inside does not", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    fireEvent.pointerDown(screen.getByTestId("activity-hotel"))
    expect(track().getAttribute("data-columns")).toBe("2")
    fireEvent.pointerDown(document.body)
    expect(track().getAttribute("data-columns")).toBe("1")
  })

  it("opens the chosen app from the open rail", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    fireEvent.click(screen.getByTestId("activity-hotel"))
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type).toBe("hotel:home")
    // Folded again, the app just opened takes the rail's last slot.
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(railButtons()).toEqual(["Alpha", "Bravo", "Charlie", "Hotel"])
  })

  it("dragging an app onto +N opens the rail and it stays open through the drag", () => {
    vi.useFakeTimers()
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.dragStart(screen.getByTestId("activity-alpha"))
    fireEvent.dragOver(screen.getByTestId("activity-bar-more"))
    expect(track().getAttribute("data-columns")).toBe("2")
    // The pointer crossing out of the rail mid-drag does not fold it.
    fireEvent.pointerLeave(screen.getByTestId("activity-bar"), { pointerType: "mouse" })
    vi.advanceTimersByTime(RAIL_FOLD_DELAY_MS * 2)
    expect(track().getAttribute("data-columns")).toBe("2")
  })

  it("reorders across columns and persists the order", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    // Alpha (column one, top) onto Golf (column two): it lands after Golf.
    fireEvent.dragStart(screen.getByTestId("activity-alpha"))
    fireEvent.dragOver(screen.getByTestId("activity-golf"))
    fireEvent.drop(screen.getByTestId("activity-golf"))
    const expected = ["bravo", "charlie", "delta", "echo", "foxtrot", "golf", "alpha", "hotel"]
    expect(customActivityBarOrder()).toEqual(expected)
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "liaison:activityBarOrder",
      JSON.stringify(expected),
    )
    expect(railOrder()).toEqual(expected)

    // Hotel (column two) back to the top of column one.
    fireEvent.dragStart(screen.getByTestId("activity-hotel"))
    fireEvent.dragOver(screen.getByTestId("activity-bravo"))
    fireEvent.drop(screen.getByTestId("activity-bravo"))
    expect(railOrder()).toEqual([
      "hotel",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "alpha",
    ])
  })

  it("does not spring back open after everything fit for a while", () => {
    registerApps()
    renderRail()
    setColumnHeight(FIVE_SLOTS)
    fireEvent.click(screen.getByTestId("activity-bar-more"))
    setColumnHeight(1000)
    expect(track().getAttribute("data-columns")).toBe("1")
    setColumnHeight(FIVE_SLOTS)
    expect(track().getAttribute("data-columns")).toBe("1")
    expect(screen.getByTestId("activity-bar-more").getAttribute("aria-expanded")).toBe("false")
  })
})
