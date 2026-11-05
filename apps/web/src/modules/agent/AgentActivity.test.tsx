// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { describe, expect, it } from "vitest"
import type { ToolCallState, TurnTimelineEntry } from "~/modules/threads/message-store"
import AgentActivity from "./AgentActivity"

describe("AgentActivity", () => {
  it("keeps an opened thinking block open when the turn's data updates", () => {
    const [turn, setTurn] = createStore<{
      timeline: TurnTimelineEntry[]
      reasoningTokens?: number
    }>({
      timeline: [
        { kind: "reasoning", text: "Weighing the options" },
        { kind: "text", text: "Here is" },
      ],
    })
    render(() => (
      <AgentActivity
        toolCalls={[]}
        timeline={turn.timeline}
        reasoningTokens={turn.reasoningTokens}
        renderText={(text) => text}
      />
    ))

    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("Weighing the options")).toBeInTheDocument()

    // A store write that leaves the reasoning untouched: the turn's usage lands.
    setTurn("reasoningTokens", 42)
    expect(screen.getByText("Weighing the options")).toBeInTheDocument()

    // The answer keeps streaming after the reasoning.
    setTurn("timeline", 1, { kind: "text", text: "Here is the answer" })
    expect(screen.getByText("Weighing the options")).toBeInTheDocument()

    // The server copy replaces the timeline with fresh, equal objects.
    setTurn("timeline", [
      { kind: "reasoning", text: "Weighing the options" },
      { kind: "text", text: "Here is the answer" },
    ])
    expect(screen.getByText("Weighing the options")).toBeInTheDocument()
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
    expect(screen.getByText("Here is the answer")).toBeInTheDocument()
  })

  it("keeps an opened stack of tool calls open when the turn's data updates", () => {
    const [turn, setTurn] = createStore<{ toolCalls: ToolCallState[] }>({
      toolCalls: [
        { toolCallId: "a", toolName: "kernel__tool_search", status: "completed" },
        { toolCallId: "b", toolName: "kernel__tool_search", status: "completed" },
      ],
    })
    render(() => <AgentActivity toolCalls={turn.toolCalls} />)

    const group = screen.getByTestId("tool-call-group")
    fireEvent.click(screen.getByTestId("tool-call-group-toggle"))
    expect(group.getAttribute("data-open")).toBe("true")

    // Another call lands in the turn: the groups are rebuilt as fresh objects.
    setTurn("toolCalls", (calls) => [
      ...calls,
      { toolCallId: "c", toolName: "tickets__search", status: "running" },
    ])
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("true")

    // A call's status changes.
    setTurn("toolCalls", 2, "status", "completed")
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("true")
  })
})
