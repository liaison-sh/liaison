// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OverlaySheet } from "~/ui/OverlaySheet"

describe("OverlaySheet", () => {
  it("renders children when open is true", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(screen.getByText("sheet body")).toBeInTheDocument()
  })

  it("renders nothing when open is false", () => {
    render(() => (
      <OverlaySheet open={false} onClose={() => {}} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(screen.queryByText("sheet body")).not.toBeInTheDocument()
  })

  it("calls onClose once on Escape keydown", async () => {
    const onClose = vi.fn()
    render(() => (
      <OverlaySheet open={true} onClose={onClose} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await Promise.resolve()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("variant full sets data-variant=full on the root", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(document.querySelector("[data-overlay-sheet]")?.getAttribute("data-variant")).toBe(
      "full",
    )
  })

  it("variant bottom sets data-variant=bottom on the root", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="bottom" title="Actions">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(document.querySelector("[data-overlay-sheet]")?.getAttribute("data-variant")).toBe(
      "bottom",
    )
  })

  it("renders a close control for variant full and closes the sheet when pressed", async () => {
    const onClose = vi.fn()
    render(() => (
      <OverlaySheet open={true} onClose={onClose} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    const close = screen.getByTestId("overlay-sheet-close")
    expect(close).toBeInTheDocument()
    fireEvent.click(close)
    await Promise.resolve()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders a close control for variant bottom even without a title", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="bottom">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument()
  })

  it("the close control carries a 44 px minimum hit area", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="full" title="Agent">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    const cls = screen.getByTestId("overlay-sheet-close").className
    expect(cls).toContain("min-h-11")
    expect(cls).toContain("min-w-11")
  })

  it("labels the close control from closeLabel so callers own translation", () => {
    render(() => (
      <OverlaySheet open={true} onClose={() => {}} variant="full" closeLabel="Fermer">
        <p>sheet body</p>
      </OverlaySheet>
    ))
    expect(screen.getByTestId("overlay-sheet-close").getAttribute("aria-label")).toBe("Fermer")
  })
})

describe("OverlaySheet - the side drawer sits BESIDE what opened it", () => {
  afterEach(() => cleanup())

  const renderSide = () =>
    render(() => (
      <>
        <button type="button" data-testid="outside-control">
          rail entry
        </button>
        <OverlaySheet open={true} onClose={() => {}} variant="side" offsetLeft="48px" width="320px">
          <p>drawer body</p>
        </OverlaySheet>
      </>
    ))

  it("variant side sets data-variant=side on the root", () => {
    renderSide()
    expect(document.querySelector("[data-overlay-sheet]")?.getAttribute("data-variant")).toBe(
      "side",
    )
  })

  it("offsets the drawer AND its scrim by offsetLeft, so the strip to their left is untouched", () => {
    renderSide()
    // Without the offset the sheet is a `full` sheet at x=0: it covers the
    // surface that opened it, and the scrim dims it.
    const drawer = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(drawer.style.marginLeft).toBe("48px")
    expect(drawer.style.width).toBe("320px")
    const scrim = screen.getByTestId("overlay-sheet-scrim")
    expect(scrim.style.left).toBe("48px")
  })

  it("the positioning container takes no pointer events, so the strip to its left stays live", () => {
    renderSide()
    // The container is `fixed inset-0`: it spans the rail too. jsdom has no
    // layout, so `elementFromPoint` cannot be used to dispatch a real tap at
    // (24, 226); what decides the outcome in a browser is exactly these three
    // classes, so they are what is asserted. Without `pointer-events-none` on
    // the container every rail tap lands on the container instead of the rail
    // button, and `keepOpenOutside` (which looks for a `[data-activity-rail]`
    // ancestor) dismisses the drawer.
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    const positioner = panel.parentElement as HTMLElement
    expect(positioner.className).toContain("pointer-events-none")
    expect(panel.className).toContain("pointer-events-auto")
    expect(screen.getByTestId("overlay-sheet-scrim").className).toContain("pointer-events-auto")
  })

  it("reads as a raised layer: dim scrim, elevation shadow, no border", () => {
    renderSide()
    const scrim = screen.getByTestId("overlay-sheet-scrim")
    // `bg-overlay` is a 55% WHITE veil in the light theme, which washes the
    // content out instead of dimming it and swallows the drawer's shadow.
    expect(scrim.className).toContain("bg-overlay-heavy")
    expect(scrim.className).not.toContain("bg-overlay ")
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(panel.className).toContain("shadow-drawer")
    expect(panel.className).not.toContain("border-r")
  })

  it("anchor right holds the drawer against the RIGHT edge, its scrim and shadow mirrored", () => {
    render(() => (
      <OverlaySheet
        open={true}
        onClose={() => {}}
        variant="side"
        anchor="right"
        offsetRight="12px"
        width="82%"
      >
        <p>drawer body</p>
      </OverlaySheet>
    ))
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(panel.style.marginRight).toBe("12px")
    expect(panel.style.marginLeft).toBe("")
    expect(panel.style.width).toBe("82%")
    expect(panel.className).toContain("shadow-drawer-end")
    const positioner = panel.parentElement as HTMLElement
    expect(positioner.className).toContain("justify-end")
    expect(positioner.className).not.toContain("justify-start")
    const scrim = screen.getByTestId("overlay-sheet-scrim")
    expect(scrim.style.right).toBe("12px")
    expect(scrim.style.left).toBe("")
  })

  it("renders no header band at all when the side drawer has no title", () => {
    renderSide()
    // An untitled drawer's header was a 61 px empty band holding a lone X.
    // The scrim, the rail entry and Escape all close it.
    expect(screen.queryByTestId("overlay-sheet-close")).toBeNull()
    expect(screen.getByText("drawer body")).toBeInTheDocument()
  })

  it("a TITLED side drawer keeps its header and its close control", () => {
    render(() => (
      <OverlaySheet
        open={true}
        onClose={() => {}}
        variant="side"
        offsetLeft="48px"
        width="320px"
        title="Settings"
      >
        <p>drawer body</p>
      </OverlaySheet>
    ))
    expect(screen.getByText("Settings")).toBeInTheDocument()
    expect(screen.getByTestId("overlay-sheet-close")).toBeInTheDocument()
  })

  it("leaves the rest of the page interactive: it is not a modal dialog", async () => {
    renderSide()
    // Kobalte applies the modal treatment a tick after mount.
    await new Promise((r) => setTimeout(r, 30))
    const outside = screen.getByTestId("outside-control")
    expect(outside.closest("[aria-hidden='true']")).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe("none")
    outside.focus()
    expect(document.activeElement).toBe(outside)
  })

  it("a full sheet by contrast DOES take the page away (the modal treatment)", async () => {
    render(() => (
      <>
        <button type="button" data-testid="outside-control">
          rail entry
        </button>
        <OverlaySheet open={true} onClose={() => {}} variant="full">
          <p>sheet body</p>
        </OverlaySheet>
      </>
    ))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId("outside-control").closest("[aria-hidden='true']")).not.toBeNull()
    expect(document.body.style.pointerEvents).toBe("none")
    expect(screen.queryByTestId("overlay-sheet-scrim")).toBeNull()
  })
})
