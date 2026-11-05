// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The revealed action rail is clipped to the CARD it belongs to. The row
// container was already `overflow-hidden`, but with square corners: a danger
// action painted its own right angles over the card's rounded ones, so the
// rail read as a red block sticking out of the row.
//
// The radius is asserted against the radius `ResponsiveList` gives the phone
// card, not against a literal, so the two cannot drift apart. jsdom has no
// Tailwind, so the two utilities involved are declared here and the assertion
// reads the COMPUTED values.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ResponsiveList } from "~/ui/ResponsiveList"
import { SwipeRow } from "~/ui/SwipeRow"

const RADIUS_CSS = `
.rounded-lg{border-radius:8px;border-top-left-radius:8px;border-top-right-radius:8px;border-bottom-right-radius:8px;border-bottom-left-radius:8px}
.rounded-xl{border-radius:12px;border-top-left-radius:12px;border-top-right-radius:12px;border-bottom-right-radius:12px;border-bottom-left-radius:12px}
.overflow-hidden{overflow:hidden}
.rounded-l-none{border-top-left-radius:0;border-bottom-left-radius:0}
.rounded-r-none{border-top-right-radius:0;border-bottom-right-radius:0}
`

let styleEl: HTMLStyleElement | undefined

beforeEach(() => {
  styleEl = document.createElement("style")
  styleEl.textContent = RADIUS_CSS
  document.head.appendChild(styleEl)
})
afterEach(() => {
  styleEl?.remove()
  cleanup()
})

describe("a swipe row's action rail", () => {
  it("is clipped to the same corner radius as the card it sits in", () => {
    render(() => (
      <ResponsiveList
        items={[{ id: "a" }]}
        renderRow={() => <div />}
        renderCard={() => (
          <SwipeRow
            testid="probe-swipe"
            actions={[{ label: "Close", tone: "danger", onSelect: () => {} }]}
          >
            <div data-testid="probe-content">Row</div>
          </SwipeRow>
        )}
      />
    ))

    const card = document.querySelector('[data-responsive="card"]') as HTMLElement
    expect(card).toBeTruthy()
    const cardRadius = getComputedStyle(card).borderRadius
    expect(cardRadius).toBe("8px")
    // The rail is what needs clipping now: the card itself moves as one block.
    const rail = screen.getByTestId("swipe-row-actions")
    expect(getComputedStyle(rail).borderRadius).toBe(cardRadius)
    expect(getComputedStyle(rail).overflow).toBe("hidden")
    expect(getComputedStyle(screen.getByTestId("swipe-row-content")).borderRadius).toBe(cardRadius)
  })

  it("lets a caller override the radius for a row that is not a card", () => {
    render(() => (
      <SwipeRow
        testid="probe-swipe"
        class="rounded-xl"
        actions={[{ label: "Close", onSelect: () => {} }]}
      >
        <div>Row</div>
      </SwipeRow>
    ))
    const rail = screen.getByTestId("swipe-row-actions")
    expect(getComputedStyle(screen.getByTestId("swipe-row-content")).borderRadius).toBe("12px")
    // The rail follows the card, so it cannot paint square corners over it.
    expect(getComputedStyle(rail).borderRadius).toBe("12px")
    expect(getComputedStyle(rail).overflow).toBe("hidden")
  })

  // A reviewer's pass on the phone: with the rail revealed, the card's right
  // corners and the rail's left corners were both round, so the open row read
  // as two rounded tiles with a notch between them. The seam is square; only
  // the row's outer corners keep the radius.
  it("squares the seam between the card and the rail while the row is open", () => {
    render(() => (
      <SwipeRow
        testid="probe-swipe"
        class="rounded-xl"
        actions={[{ label: "Close", tone: "danger", onSelect: () => {} }]}
      >
        <div data-testid="probe-content">Row</div>
      </SwipeRow>
    ))
    const rail = screen.getByTestId("swipe-row-actions")
    const card = screen.getByTestId("swipe-row-content")
    // The rail's left edge is always under the card: square from the start.
    expect(getComputedStyle(rail).borderTopLeftRadius).toBe("0px")
    expect(getComputedStyle(rail).borderTopRightRadius).toBe("12px")
    // Closed, the card keeps all four corners.
    expect(getComputedStyle(card).borderTopRightRadius).toBe("12px")

    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 300, clientY: 0 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 200, clientY: 0 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 200, clientY: 0 })
    expect(screen.getByTestId("probe-swipe").getAttribute("data-swipe-open")).toBe("true")

    expect(getComputedStyle(card).borderTopRightRadius).toBe("0px")
    expect(getComputedStyle(card).borderBottomRightRadius).toBe("0px")
    expect(getComputedStyle(card).borderTopLeftRadius).toBe("12px")
  })
})
