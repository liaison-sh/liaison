// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: openTabMock }))

import { registerActivityBarEntry, unregisterActivityBarEntry } from "~/framework/app-registry"
import { handleWsAgentStreamEvent } from "~/modules/threads/message-store"

// The agent's `open_app` tool is a client-effect tool: it rides the agent_stream
// `tool_call` channel and the web app reacts by navigating. These tests pin that
// the navigation fires only for `open_app`, resolves the app id to a tab action,
// and is a harmless no-op for an unknown app.
describe("open_app navigation via agent_stream tool_call", () => {
  beforeEach(() => {
    openTabMock.mockClear()
  })

  it("opens the resolved app tab when the agent calls open_app", () => {
    registerActivityBarEntry({
      id: "test-tickets",
      icon: () => null as never,
      label: "Tickets",
      order: 10,
      appId: "tickets",
      tabAction: { type: "tickets:inbox", entityId: "tickets-inbox", label: "Tickets" },
    })
    handleWsAgentStreamEvent("start", { threadId: "t1" })
    handleWsAgentStreamEvent("tool_call", {
      threadId: "t1",
      toolCallId: "c1",
      toolName: "open_app",
      args: { app: "tickets" },
    })
    expect(openTabMock).toHaveBeenCalledWith({
      type: "tickets:inbox",
      entityId: "tickets-inbox",
      label: "Tickets",
    })
    unregisterActivityBarEntry("test-tickets")
  })

  it("is a no-op for an unknown app id", () => {
    handleWsAgentStreamEvent("start", { threadId: "t2" })
    handleWsAgentStreamEvent("tool_call", {
      threadId: "t2",
      toolCallId: "c2",
      toolName: "open_app",
      args: { app: "does-not-exist" },
    })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("ignores non-open_app tool calls", () => {
    handleWsAgentStreamEvent("start", { threadId: "t3" })
    handleWsAgentStreamEvent("tool_call", {
      threadId: "t3",
      toolCallId: "c3",
      toolName: "threads_search",
      args: { query: "x" },
    })
    expect(openTabMock).not.toHaveBeenCalled()
  })
})
