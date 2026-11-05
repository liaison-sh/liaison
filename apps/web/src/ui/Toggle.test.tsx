// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { Toggle } from "~/ui/Toggle"

describe("Toggle", () => {
  it("renders in off state by default", () => {
    render(() => (
      <Toggle pressed={false} onChange={() => {}}>
        Toggle
      </Toggle>
    ))
    const btn = screen.getByRole("button")
    expect(btn).toHaveAttribute("aria-pressed", "false")
  })

  it("renders in on state when pressed", () => {
    render(() => (
      <Toggle pressed={true} onChange={() => {}}>
        Toggle
      </Toggle>
    ))
    const btn = screen.getByRole("button")
    expect(btn).toHaveAttribute("aria-pressed", "true")
  })

  it("calls onChange on click", () => {
    const handler = vi.fn()
    render(() => (
      <Toggle pressed={false} onChange={handler}>
        Toggle
      </Toggle>
    ))
    fireEvent.click(screen.getByRole("button"))
    expect(handler).toHaveBeenCalledWith(true)
  })
})
