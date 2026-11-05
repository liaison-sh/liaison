// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card 115. A swiped ticket card showed its title cut in half and a status
// pill as a sliver, inside a frame that had not moved, with two solid blocks
// (slate, red) sitting unevenly in the card's corner. The cause was two boxes:
// the card's frame and its 12px of padding were OUTSIDE the swipe row, so the
// clip happened 12px inside a border that stayed put, and the rail was a second
// rounded rectangle floating in the first.
//
// The first repair kept the frame OUTSIDE and slid the content under it, which
// clipped the card's title mid-word ("rder RAL-2244") and halved a status pill.
//
// What this pins: the ONE translated element IS the framed card, border,
// radius and padding included; the rail is a sibling REVEALED behind it, out of
// flow and clipped to the card's radius; the box around them clips nothing; and
// the actions are tints, not fills.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SwipeRow } from "~/ui/SwipeRow"

const LAYOUT_CSS = `
.absolute{position:absolute}
.relative{position:relative}
.overflow-hidden{overflow:hidden}
`

let styleEl: HTMLStyleElement | undefined
beforeEach(() => {
  styleEl = document.createElement("style")
  styleEl.textContent = LAYOUT_CSS
  document.head.appendChild(styleEl)
})
afterEach(() => {
  styleEl?.remove()
  cleanup()
})

function renderRow(contentClass?: string) {
  render(() => (
    <SwipeRow
      testid="probe-swipe"
      class="border border-border"
      contentClass={contentClass}
      actions={[
        { label: "Assign", tone: "accent", onSelect: () => {} },
        { label: "Close", tone: "danger", onSelect: () => {} },
      ]}
    >
      <div data-testid="probe-content">
        <span data-testid="probe-pill">Waiting on us</span>
      </div>
    </SwipeRow>
  ))
  return screen.getByTestId("probe-swipe")
}

describe("a swipe row's card frame", () => {
  it("translates the FRAMED card, so the frame never cuts the content it holds", () => {
    const row = renderRow("p-3")
    const card = screen.getByTestId("swipe-row-content")
    // The border, the radius and the padding all ride on the moving block.
    expect(card.className).toContain("border-border")
    expect(card.className).toContain("rounded-lg")
    expect(card.className).toContain("p-3")
    // ...and the box they used to sit on clips nothing and frames nothing.
    expect(row.className).not.toContain("overflow-hidden")
    expect(row.className).not.toContain("border")
    expect(row.className).not.toContain("p-3")
    expect(getComputedStyle(row).overflow).not.toBe("hidden")
  })

  it("reveals the rail from BEHIND the card, clipped to the card's radius", () => {
    const row = renderRow("p-3")
    const rail = screen.getByTestId("swipe-row-actions")
    const card = screen.getByTestId("swipe-row-content")
    // Siblings, rail first: the card paints over it until the drag moves it.
    expect(rail.parentElement).toBe(row)
    expect(card.parentElement).toBe(row)
    expect(Array.from(row.children).indexOf(rail)).toBeLessThan(
      Array.from(row.children).indexOf(card),
    )
    expect(rail.className).toContain("rounded-lg")
    expect(getComputedStyle(rail).overflow).toBe("hidden")
  })

  it("translates ONE element, and nothing inside the children moves on its own", () => {
    const row = renderRow()
    const translated = Array.from(row.querySelectorAll<HTMLElement>("*")).filter((el) =>
      (el.style.transform ?? "").includes("translateX"),
    )
    expect(translated).toHaveLength(1)
    expect(translated[0].getAttribute("data-testid")).toBe("swipe-row-content")
    // The caller's markup is INSIDE it, untouched.
    expect(translated[0].contains(screen.getByTestId("probe-content"))).toBe(true)
    expect(screen.getByTestId("probe-content").style.transform).toBe("")
    expect(screen.getByTestId("probe-pill").style.transform).toBe("")
  })

  it("keeps the rail out of flow, so revealing it never narrows the content", () => {
    const row = renderRow()
    const rail = screen.getByTestId("swipe-row-actions")
    const content = screen.getByTestId("swipe-row-content")
    expect(getComputedStyle(rail).position).toBe("absolute")
    // A rail laid out beside the content (a flex sibling, a reserved gutter)
    // is what would change the width the children lay out in.
    expect(rail.parentElement).toBe(row)
    expect(content.className).not.toMatch(/(^|\s)(w-|pr-|mr-)/)
    expect(row.className).not.toContain("flex")
  })

  it("puts the caller's padding inside the translated block, not on the box around it", () => {
    const row = renderRow("p-3")
    expect(row.className).not.toContain("p-3")
    expect(row.className.trim()).toBe("relative")
    expect(screen.getByTestId("swipe-row-content").className).toContain("p-3")
  })

  it("paints the actions as pale tints with coloured text, never solid fills", () => {
    renderRow()
    const assign = screen.getByTestId("swipe-action-assign")
    const close = screen.getByTestId("swipe-action-close")
    expect(assign.className).toContain("bg-accent-wash")
    expect(assign.className).toContain("text-accent")
    expect(close.className).toContain("bg-error-glow")
    expect(close.className).toContain("text-error")
    for (const el of [assign, close]) {
      expect(el.className).not.toMatch(/bg-(accent|danger|error)(\s|$)/)
      expect(el.className).not.toContain("text-white")
      // Full height, so the two blocks end level with the card's edges.
      expect(el.className).toContain("h-full")
    }
  })
})
