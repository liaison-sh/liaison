// SPDX-License-Identifier: FSL-1.1-ALv2
// A tool group holding a pending approval is open: the walk found the cards of
// "Enable App ×2" hidden in a collapsed group, so the person never saw what
// they had to decide.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="approval-card-stub" data-request-id={props.requestId} />
  ),
}))

const ensureLoaded = vi.fn(async (_api: unknown, id: string) => {
  if (id.startsWith("gone-")) throw new Error("not found")
  return undefined
})

// A reactive store, like the real one: a row update re-runs what reads it.
vi.mock("~/modules/approvals/approvals-store", async () => {
  const { createStore } = await import("solid-js/store")
  const [rows, setRows] = createStore<Record<string, { id: string; status: string; n?: number }>>(
    {},
  )
  return {
    getById: (id: string) => rows[id],
    ensureLoaded: (api: unknown, id: string) => ensureLoaded(api, id),
    setTestRow: (id: string, status: string, n = 0) => setRows(id, { id, status, n }),
  }
})

import { ApiContext } from "~/modules/shell/ApiContext"
import type { ToolCallState } from "~/modules/threads/message-store"
import { StackedToolCallGroup } from "./ToolCallRow"

async function setRow(id: string, status: string, n = 0): Promise<void> {
  const store: object = await import("~/modules/approvals/approvals-store")
  const set: unknown = Reflect.get(store, "setTestRow")
  if (typeof set !== "function") throw new Error("the store mock has no setTestRow")
  set(id, status, n)
}

function enableApp(id: string, approvalRequestId: string): ToolCallState {
  return {
    toolCallId: id,
    toolName: "kernel__enable_app",
    status: "completed",
    result: { blocked: { reason: "approval", approvalRequestId } },
  }
}

describe("a tool group holding an approval", () => {
  it("opens when one of its approvals is pending, so its card shows", async () => {
    await setRow("apr-1", "pending")
    await setRow("apr-2", "pending")
    render(() => (
      <StackedToolCallGroup toolCalls={[enableApp("tc-1", "apr-1"), enableApp("tc-2", "apr-2")]} />
    ))
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("true")
    const cards = screen.getAllByTestId("approval-card-stub")
    expect(cards.map((c) => c.getAttribute("data-request-id"))).toEqual(["apr-1", "apr-2"])
  })

  it("stays collapsed when its approvals are decided, and still opens on a click", async () => {
    await setRow("apr-3", "approved")
    await setRow("apr-4", "denied")
    render(() => (
      <StackedToolCallGroup toolCalls={[enableApp("tc-3", "apr-3"), enableApp("tc-4", "apr-4")]} />
    ))
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("false")
    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
    await fireEvent.click(screen.getByTestId("tool-call-group-toggle"))
    expect(screen.getAllByTestId("approval-card-stub")).toHaveLength(2)
  })

  it("stays collapsed when it holds no approval", () => {
    render(() => (
      <StackedToolCallGroup
        toolCalls={[
          { toolCallId: "r-1", toolName: "kernel__threads_read", status: "completed", result: {} },
          { toolCallId: "r-2", toolName: "kernel__threads_read", status: "completed", result: {} },
        ]}
      />
    ))
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("false")
  })

  it("a group the person closed stays closed while its approval is still pending", async () => {
    await setRow("apr-5", "pending")
    await setRow("apr-6", "approved")
    const [calls, setCalls] = createSignal([enableApp("tc-5", "apr-5"), enableApp("tc-6", "apr-6")])
    render(() => <StackedToolCallGroup toolCalls={calls()} />)
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("true")
    await fireEvent.click(screen.getByTestId("tool-call-group-toggle"))
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("false")
    // The turn goes on: another call joins the group, the approval still pending.
    setCalls([...calls(), enableApp("tc-6b", "apr-6")])
    expect(screen.getByTestId("tool-call-group").getAttribute("data-open")).toBe("false")
    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
  })

  it("asks for each approval once, and does not retry one that failed to load", async () => {
    const api = {} as never
    const calls = () => [enableApp("tc-7", "gone-7"), enableApp("tc-8", "apr-8")]
    await setRow("apr-8", "approved")
    const first = render(() => (
      <ApiContext.Provider value={api}>
        <StackedToolCallGroup toolCalls={calls()} />
      </ApiContext.Provider>
    ))
    await Promise.resolve()
    first.unmount()
    render(() => (
      <ApiContext.Provider value={api}>
        <StackedToolCallGroup toolCalls={calls()} />
      </ApiContext.Provider>
    ))
    await Promise.resolve()
    const asked = ensureLoaded.mock.calls.map((c) => c[1])
    expect(asked.filter((id) => id === "gone-7")).toHaveLength(1)
    expect(asked.filter((id) => id === "apr-8")).toHaveLength(1)
  })
})
