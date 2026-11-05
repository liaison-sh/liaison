// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import ThinkingBlock from "./ThinkingBlock"

describe("ThinkingBlock", () => {
  it("renders nothing without reasoning, streaming, or tokens", () => {
    const { container } = render(() => <ThinkingBlock reasoning="" />)
    expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull()
  })

  it("stays collapsed while streaming and expands on click", () => {
    render(() => <ThinkingBlock reasoning="Let me think" streaming={true} />)
    expect(screen.getByText("Thinking")).toBeInTheDocument()
    expect(screen.queryByText("Let me think")).toBeNull()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Let me think")).toBeInTheDocument()
  })

  it("collapses to 'Thought' when done and expands on click", () => {
    render(() => <ThinkingBlock reasoning="Hidden chain of thought" />)
    expect(screen.getByText("Thought")).toBeInTheDocument()
    expect(screen.queryByText("Hidden chain of thought")).toBeNull()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Hidden chain of thought")).toBeInTheDocument()
  })

  it("shows a static, non-expandable label for tokens-only reasoning", () => {
    render(() => <ThinkingBlock reasoning="" tokenCount={128} />)
    expect(screen.getByText("Thought")).toBeInTheDocument()
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("hints when the reasoning is only a summary", () => {
    const { container } = render(() => <ThinkingBlock reasoning="brief summary" summary={true} />)
    // "· summary" is split across text nodes — assert on the rendered textContent.
    expect(container.textContent).toContain("· summary")
  })
})
