// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Tooltip } from "~/ui/Tooltip"

describe("Tooltip", () => {
  it("renders trigger content", () => {
    render(() => (
      <Tooltip content="Help text">
        <button type="button">Hover me</button>
      </Tooltip>
    ))
    expect(screen.getByText("Hover me")).toBeInTheDocument()
  })

  describe("never covers the next control", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
      cleanup()
      vi.useRealTimers()
    })

    const trigger = () => screen.getByText("Search").parentElement as HTMLElement

    it("opens on hover after the delay, and the hint takes no pointer events", () => {
      render(() => (
        <Tooltip content="Search hint">
          <button type="button">Search</button>
        </Tooltip>
      ))
      fireEvent.pointerEnter(trigger(), { pointerType: "mouse" })
      vi.advanceTimersByTime(400)
      const hint = screen.getByTestId("tooltip-content")
      expect(hint.textContent).toContain("Search hint")
      expect(hint.className).toContain("pointer-events-none")
    })

    it("a click inside the open delay does not let the hint open afterwards", () => {
      render(() => (
        <Tooltip content="Search hint">
          <button type="button">Search</button>
        </Tooltip>
      ))
      fireEvent.pointerEnter(trigger(), { pointerType: "mouse" })
      vi.advanceTimersByTime(100)
      fireEvent.pointerDown(trigger(), { pointerType: "mouse" })
      fireEvent.click(trigger())
      vi.advanceTimersByTime(1000)
      expect(screen.queryByText("Search hint")).toBeNull()
    })

    it("a click on an open hint closes it and it stays closed while the pointer rests there", () => {
      render(() => (
        <Tooltip content="Search hint">
          <button type="button">Search</button>
        </Tooltip>
      ))
      fireEvent.pointerEnter(trigger(), { pointerType: "mouse" })
      vi.advanceTimersByTime(400)
      expect(screen.queryByText("Search hint")).not.toBeNull()
      fireEvent.pointerDown(trigger(), { pointerType: "mouse" })
      fireEvent.click(trigger())
      vi.advanceTimersByTime(1000)
      expect(screen.queryByText("Search hint")).toBeNull()
    })
  })
})
