// SPDX-License-Identifier: FSL-1.1-ALv2
// HomeCard: only the header drags. A body inside a `draggable` element gets
// `user-select: none` in Chromium and a text drag there becomes a card drag,
// so text in a Home card (an approval's payload) could not be selected or
// copied, and the row folded open on mouseup.
import { fireEvent, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import HomeCard from "~/modules/shell/HomeCard"
import { cardOrder, draggedId, resetHomeCardLayout } from "~/modules/shell/home-card-layout"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

function dragEvent(type: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const data = new Map<string, string>()
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      setDragImage: vi.fn(),
      effectAllowed: "all",
      dropEffect: "none",
    },
  })
  return ev
}

function renderCards() {
  return render(() => (
    <>
      <HomeCard id="approvals" title="Approvals" count={1}>
        <p data-testid="approvals-text">description: a parcel late, stuck, refused</p>
      </HomeCard>
      <HomeCard id="messages" title="Alerts">
        <p data-testid="messages-text">an alert</p>
      </HomeCard>
      <HomeCard id="feed" title="Activity">
        <p data-testid="feed-text">an activity line</p>
      </HomeCard>
    </>
  ))
}

beforeEach(() => resetHomeCardLayout())
afterEach(() => resetHomeCardLayout())

describe("HomeCard: text in a card body stays selectable", () => {
  it("no card body sits inside a draggable element; the header is the drag source", () => {
    const { getByTestId } = renderCards()
    for (const id of ["approvals", "messages", "feed"]) {
      expect(getByTestId(`${id}-text`).closest('[draggable="true"]')).toBeNull()
      expect(getByTestId(`home-card-${id}`).getAttribute("draggable")).not.toBe("true")
      expect(getByTestId(`home-card-header-${id}`).getAttribute("draggable")).toBe("true")
    }
  })

  it("a dragstart from the body (a text drag) is cancelled and starts no card drag", () => {
    const { getByTestId } = renderCards()
    const ev = dragEvent("dragstart")
    getByTestId("approvals-text").dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(draggedId()).toBeNull()
  })

  it("dragging by the header still reorders the cards", () => {
    const { getByTestId } = renderCards()
    expect(cardOrder().indexOf("messages")).toBeGreaterThan(cardOrder().indexOf("approvals"))
    const start = dragEvent("dragstart")
    getByTestId("home-card-header-messages").dispatchEvent(start)
    expect(start.defaultPrevented).toBe(false)
    expect(draggedId()).toBe("messages")
    fireEvent(getByTestId("home-card-approvals"), dragEvent("dragover"))
    fireEvent(getByTestId("home-card-approvals"), dragEvent("drop"))
    expect(cardOrder().indexOf("messages")).toBeLessThan(cardOrder().indexOf("approvals"))
    expect(draggedId()).toBeNull()
  })
})
