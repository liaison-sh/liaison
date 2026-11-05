// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PullToRefresh } from "~/ui/PullToRefresh"

afterEach(() => cleanup())

function renderWrapper(onRefresh = vi.fn(async () => {})) {
  const result = render(() => (
    <PullToRefresh onRefresh={onRefresh} label="Refreshing">
      <div data-testid="list">rows</div>
    </PullToRefresh>
  ))
  return { ...result, onRefresh, box: screen.getByTestId("pull-to-refresh") }
}

function pull(box: HTMLElement, from: number, to: number): void {
  fireEvent.touchStart(box, { touches: [{ clientY: from }] })
  fireEvent.touchMove(box, { touches: [{ clientY: to }] })
}

describe("the pull to refresh wrapper", () => {
  it("shows no indicator at rest", () => {
    renderWrapper()
    expect(screen.queryByTestId("pull-to-refresh-indicator")).toBeNull()
  })

  it("keeps the wrapped list mounted", () => {
    renderWrapper()
    expect(screen.getByTestId("list").textContent).toBe("rows")
  })

  it("shows the indicator during a pull and arms past the threshold", () => {
    const { box } = renderWrapper()
    pull(box, 0, 40)
    expect(screen.queryByTestId("pull-to-refresh-indicator")).not.toBeNull()
    expect(box.getAttribute("data-pull-armed")).toBe("false")
    fireEvent.touchMove(box, { touches: [{ clientY: 300 }] })
    expect(box.getAttribute("data-pull-armed")).toBe("true")
  })

  it("refreshes on release and reports it while it runs", async () => {
    let release!: () => void
    const onRefresh = vi.fn(() => new Promise<void>((r) => (release = r)))
    const { box } = renderWrapper(onRefresh as never)
    pull(box, 0, 300)
    fireEvent.touchEnd(box)
    expect(box.getAttribute("data-pull-refreshing")).toBe("true")
    await new Promise((r) => setTimeout(r, 0))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(box.getAttribute("data-pull-refreshing")).toBe("false")
    expect(screen.queryByTestId("pull-to-refresh-indicator")).toBeNull()
  })

  it("does not refresh on a short pull", () => {
    const { box, onRefresh } = renderWrapper()
    pull(box, 0, 40)
    fireEvent.touchEnd(box)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("announces the refresh with the caller's own label", () => {
    const { box } = renderWrapper()
    pull(box, 0, 300)
    const indicator = screen.getByTestId("pull-to-refresh-indicator")
    expect(indicator.getAttribute("role")).toBe("status")
    expect(indicator.getAttribute("aria-label")).toBe("Refreshing")
  })
})
