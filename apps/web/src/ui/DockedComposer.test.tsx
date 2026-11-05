// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every text input at the bottom of a surface is a DockedComposer. A footer
// composer is the last row of a full-height column, which the shell already
// lifts above the native keyboard; an inline composer sits inside a scrolling
// page, so while it is being typed in under the native keyboard it docks
// itself to the keyboard's top instead of scrolling away with the page.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { applyKeyboardInset } from "~/primitives/keyboardInset"
import { DockedComposer } from "~/ui/DockedComposer"

afterEach(() => applyKeyboardInset(0))

const renderInline = () =>
  render(() => (
    <div>
      <p>Task body</p>
      <DockedComposer mode="inline" data-testid="composer" class="my-own-class">
        <textarea data-testid="field" />
        <button type="button" data-testid="send">
          Send
        </button>
      </DockedComposer>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
    </div>
  ))

describe("DockedComposer", () => {
  it("marks its root with the dock mode and keeps the caller's attributes", () => {
    render(() => (
      <DockedComposer data-testid="composer" class="px-4">
        <textarea />
      </DockedComposer>
    ))
    const root = screen.getByTestId("composer")
    expect(root.getAttribute("data-composer-dock")).toBe("footer")
    expect(root.classList.contains("px-4")).toBe(true)
  })

  it("docks an inline composer to the keyboard's top while it is typed in", () => {
    renderInline()
    const root = screen.getByTestId("composer")
    fireEvent.focusIn(screen.getByTestId("field"))
    applyKeyboardInset(320)

    expect(root.hasAttribute("data-docked")).toBe(true)
    expect(root.style.position).toBe("fixed")
    expect(root.style.bottom).toBe("var(--keyboard-inset, 0px)")
    // The page behind keeps the composer's place, so nothing below it jumps.
    expect(document.querySelector("[data-composer-spacer]")).not.toBeNull()
  })

  it("stays docked while focus moves inside it, and returns when focus leaves", () => {
    renderInline()
    const root = screen.getByTestId("composer")
    fireEvent.focusIn(screen.getByTestId("field"))
    applyKeyboardInset(320)
    fireEvent.focusOut(screen.getByTestId("field"), { relatedTarget: screen.getByTestId("send") })
    expect(root.hasAttribute("data-docked")).toBe(true)

    fireEvent.focusOut(screen.getByTestId("send"), {
      relatedTarget: screen.getByTestId("elsewhere"),
    })
    expect(root.hasAttribute("data-docked")).toBe(false)
    expect(root.style.position).toBe("")
    expect(document.querySelector("[data-composer-spacer]")).toBeNull()
  })

  it("returns to the page when the keyboard goes down", () => {
    renderInline()
    const root = screen.getByTestId("composer")
    fireEvent.focusIn(screen.getByTestId("field"))
    applyKeyboardInset(320)
    applyKeyboardInset(0)
    expect(root.hasAttribute("data-docked")).toBe(false)
  })

  it("never docks without the native keyboard (desktop and web are unchanged)", () => {
    renderInline()
    const root = screen.getByTestId("composer")
    fireEvent.focusIn(screen.getByTestId("field"))
    expect(root.hasAttribute("data-docked")).toBe(false)
    expect(root.style.position).toBe("")
  })

  it("never docks a footer composer: the shell's height already lifts it", () => {
    render(() => (
      <DockedComposer data-testid="composer">
        <textarea data-testid="field" />
      </DockedComposer>
    ))
    fireEvent.focusIn(screen.getByTestId("field"))
    applyKeyboardInset(320)
    const root = screen.getByTestId("composer")
    expect(root.hasAttribute("data-docked")).toBe(false)
    expect(root.style.position).toBe("")
  })
})
