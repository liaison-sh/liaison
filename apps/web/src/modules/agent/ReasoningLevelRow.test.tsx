// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import ReasoningLevelRow from "./ReasoningLevelRow"

describe("ReasoningLevelRow", () => {
  it("renders nothing for Auto (null model)", () => {
    const { container } = render(() => (
      <ReasoningLevelRow modelId={null} level="off" onSelect={() => {}} />
    ))
    expect(container.querySelector('[data-testid="reasoning-row"]')).toBeNull()
  })

  it("renders nothing for a non-reasoning model", () => {
    const { container } = render(() => (
      <ReasoningLevelRow modelId="mistral-large-latest" level="off" onSelect={() => {}} />
    ))
    expect(container.querySelector('[data-testid="reasoning-row"]')).toBeNull()
  })

  it("renders the segmented control for a reasoning model and fires onSelect", () => {
    const onSelect = vi.fn()
    render(() => <ReasoningLevelRow modelId="claude-opus-4-6" level="medium" onSelect={onSelect} />)
    expect(screen.getByTestId("reasoning-row")).toBeInTheDocument()
    expect(screen.getByTestId("reasoning-level-off")).toBeInTheDocument()
    expect(screen.getByTestId("reasoning-level-high")).toBeInTheDocument()
    expect(screen.getByTestId("reasoning-level-medium").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByTestId("reasoning-level-high"))
    expect(onSelect).toHaveBeenCalledWith("high")
  })
})
