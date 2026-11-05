// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The switch primitive, and the one thing that was actually broken about the
// two copies it replaces: at the touch tiers the shared 44px hit floor in
// index.css inflated the 24x44 track to 44x44, so it went square and the thumb
// rode out past its own right edge.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Switch } from "~/ui/Switch"

/**
 * The tier touch floor from `index.css`, injected so getComputedStyle reports
 * what a real browser computes from the same classes. The `:is(...)` list is
 * flattened to the one selector this assertion needs; the semantics for a
 * button at phone tier are identical.
 */
function injectTierFloor(): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent =
    '[data-shell-tier="phone"] button:not([data-touch-dense]) { min-height: 44px; min-width: 44px; }\n' +
    ".h-6 { height: 24px; }\n" +
    ".w-11 { width: 44px; }"
  document.head.appendChild(style)
  return style
}

describe("Switch", () => {
  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute("data-shell-tier")
    for (const el of document.head.querySelectorAll("style")) el.remove()
  })

  it("keeps its 24px track at phone tier instead of being squared off by the touch floor", () => {
    injectTierFloor()
    document.documentElement.setAttribute("data-shell-tier", "phone")

    render(() => <Switch label="Email digest" checked={false} onChange={() => {}} />)
    const track = screen.getByRole("switch")

    expect(getComputedStyle(track).height).toBe("24px")
    // The floor does not reach it: with it applied the track would be at least
    // 44px tall and the thumb, positioned from the top, would sit off centre
    // while the 22px travel ran out inside a 44px-wide box.
    expect(getComputedStyle(track).minHeight).not.toBe("44px")
    expect(track.getAttribute("data-touch-dense")).not.toBeNull()

    // Control: the injected floor is real and does reach an ordinary button,
    // so the assertion above is about the opt-out and not about a rule that
    // never applied.
    const plain = document.createElement("button")
    document.body.appendChild(plain)
    expect(getComputedStyle(plain).minHeight).toBe("44px")
    plain.remove()
  })

  it("reports and flips its state", () => {
    const onChange = vi.fn()
    render(() => <Switch label="Email digest" checked={true} onChange={onChange} />)
    const track = screen.getByRole("switch")

    expect(track).toHaveAttribute("aria-checked", "true")
    expect(track).toHaveAttribute("aria-label", "Email digest")
    fireEvent.click(track)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it("paints the checked TRACK with the accent, not only moving the thumb", () => {
    render(() => <Switch label="Email digest" checked={true} onChange={() => {}} />)
    const track = screen.getByRole("switch")

    expect(track).toHaveAttribute("data-checked")
    expect(track.className).toContain("bg-accent")
    expect(track.className).toContain("border-accent")
    // The 10% wash the track used to carry is what made on and off read alike.
    expect(track.className).not.toContain("bg-accent-glow")
  })

  it("leaves the unchecked track unpainted, so the two states differ", () => {
    render(() => <Switch label="Email digest" checked={false} onChange={() => {}} />)
    const track = screen.getByRole("switch")

    expect(track).not.toHaveAttribute("data-checked")
    expect(track.className).toContain("bg-bg")
    expect(track.className).not.toContain("bg-accent")
  })

  it("keeps the accent track at the dense phone tier, with the 44px row target intact", () => {
    injectTierFloor()
    document.documentElement.setAttribute("data-shell-tier", "phone")

    render(() => <Switch label="Email digest" checked={true} onChange={() => {}} />)
    const track = screen.getByRole("switch")

    // The dense opt-out is what keeps the track 24px at this tier; the accent
    // must survive it (the enclosing row owns the 44px tap area).
    expect(track.getAttribute("data-touch-dense")).not.toBeNull()
    expect(getComputedStyle(track).height).toBe("24px")
    expect(track.className).toContain("bg-accent")
    expect(track.className).not.toContain("bg-accent-glow")
  })

  it("passes a disabled switch through and does not fire", () => {
    const onChange = vi.fn()
    render(() => <Switch label="Email digest" checked={false} disabled onChange={onChange} />)
    const track = screen.getByRole("switch") as HTMLButtonElement

    expect(track.disabled).toBe(true)
    fireEvent.click(track)
    expect(onChange).not.toHaveBeenCalled()
  })
})
