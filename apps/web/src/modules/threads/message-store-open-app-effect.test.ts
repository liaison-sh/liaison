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
const OK = {
  ok: true,
  app: "projects",
  view: "task",
  id: "task-1",
  label: "Fix the pump",
  tab: TAB,
}
const WIRE_NAME = "kernel__open_app"

let n = 0
function turn(): string {
  const threadId = `thread-${++n}`
  handleWsAgentStreamEvent("start", { threadId })
  return threadId
}

function result(threadId: string, data: Record<string, unknown>) {
  handleWsAgentStreamEvent("tool_result", {
    threadId,
    toolCallId: "c1",
    toolName: WIRE_NAME,
    ...data,
  })
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

  it("a record opens from the result, with the tab and the label the server gave", () => {
    result(turn(), { requesterId: "me", result: OK })
    expect(openTabMock).toHaveBeenCalledWith({ ...TAB, label: "Fix the pump" })
  })

  it("carries the route of a record that lives in a pane of its page", () => {
    const tab = {
      type: "agents:agent",
      entityId: "ada",
      routePath: "/agents/ada/routines?selected=r1",
    }
    result(turn(), { requesterId: "me", result: { ok: true, label: "Weekly", tab } })
    expect(openTabMock).toHaveBeenCalledWith({ ...tab, label: "Weekly" })
  })

  it("another person's agent moves no tab, on the call or on its result", () => {
    const threadId = turn()
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "colleague",
      args: { app: "tickets" },
    })
    result(threadId, { requesterId: "colleague", result: OK })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a frame that names nobody moves no tab: a routine's run has no viewer", () => {
    result(turn(), { result: OK })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a refused call moves no tab", () => {
    result(turn(), { requesterId: "me", result: { ok: false, code: "NOT_FOUND", tab: TAB } })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a call naming a record waits for its result: the arguments alone move nothing", () => {
    handleWsAgentStreamEvent("tool_call", {
      threadId: turn(),
      toolCallId: "c1",
      toolName: WIRE_NAME,
      requesterId: "me",
      args: { app: "projects", view: "task", id: "task-1" },
    })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("a browser tab in the background is not moved", () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    result(turn(), { requesterId: "me", result: OK })
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("another tool's result never opens a tab, whatever it holds", () => {
    result(turn(), { toolName: "kernel__threads_read", requesterId: "me", result: OK })
    expect(openTabMock).not.toHaveBeenCalled()
  })
})
