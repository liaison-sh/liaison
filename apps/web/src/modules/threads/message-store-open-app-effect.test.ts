// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const { openTabMock, me } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  me: { userId: "me" as string | null },
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: openTabMock }))
vi.mock("~/modules/auth/auth-store", async (original) => ({
  ...(await original<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => (me.userId ? { userId: me.userId } : null),
}))

import { registerActivityBarEntry, unregisterActivityBarEntry } from "~/framework/app-registry"
import { handleWsAgentStreamEvent } from "~/modules/threads/message-store"

const TAB = { type: "projects:task", entityId: "task-1" }
const WIRE_NAME = "kernel__open_app"

let n = 0
function turn(): string {
  const threadId = `thread-${++n}`
  handleWsAgentStreamEvent("start", { threadId })
  return threadId
}

function openTabFrame(data: Record<string, unknown>) {
  handleWsAgentStreamEvent("open_tab", { threadId: "t", tab: TAB, label: "Fix the pump", ...data })
}

describe("open_app moves the screen of the person who asked", () => {
  beforeEach(() => {
    openTabMock.mockClear()
    me.userId = "me"
    vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  })

  it("the name the tool has on the wire opens the app", () => {
    registerActivityBarEntry({
      id: "wire-tickets",
      icon: () => null as never,
      label: "Tickets",
      order: 10,
      appId: "tickets",
      tabAction: { type: "tickets:inbox", entityId: "tickets-inbox", label: "Tickets" },
    })
    handleWsAgentStreamEvent("tool_call", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "me",
      args: { app: "tickets" },
    })
    unregisterActivityBarEntry("wire-tickets")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "tickets:inbox",
      entityId: "tickets-inbox",
      label: "Tickets",
    })
  })

  it("a record opens from the server's frame, titled by the frame", () => {
    openTabFrame({ requesterId: "me" })
    expect(openTabMock).toHaveBeenCalledWith({ ...TAB, label: "Fix the pump" })
  })

  it("carries the route of a record that lives in a pane of its page", () => {
    const tab = {
      type: "agents:agent",
      entityId: "ada",
      routePath: "/agents/ada/routines?selected=r1",
    }
    openTabFrame({ requesterId: "me", tab, label: "Weekly" })
    expect(openTabMock).toHaveBeenCalledWith({ ...tab, label: "Weekly" })
  })

  it("another person's agent moves no tab, by a call or by a frame", () => {
    handleWsAgentStreamEvent("tool_call", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "colleague",
      args: { app: "tickets" },
    })
    openTabFrame({ requesterId: "colleague" })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a call that names nobody moves no tab: a routine's run has no viewer", () => {
    registerActivityBarEntry({
      id: "wire-routine",
      icon: () => null as never,
      label: "Tickets",
      order: 10,
      appId: "tickets",
      tabAction: { type: "tickets:inbox", entityId: "tickets-inbox", label: "Tickets" },
    })
    handleWsAgentStreamEvent("tool_call", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      args: { app: "tickets" },
    })
    unregisterActivityBarEntry("wire-routine")
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a call naming a record moves nothing by itself: only the server's frame does", () => {
    handleWsAgentStreamEvent("tool_call", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "me",
      args: { app: "projects", view: "task", id: "task-1" },
    })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a tool's result never opens a tab, whatever it holds", () => {
    handleWsAgentStreamEvent("tool_result", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "me",
      result: { ok: true, tab: TAB, label: "Fix the pump" },
    })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a browser tab in the background is not moved", () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    openTabFrame({ requesterId: "me" })
    expect(openTabMock).not.toHaveBeenCalled()
  })
})
