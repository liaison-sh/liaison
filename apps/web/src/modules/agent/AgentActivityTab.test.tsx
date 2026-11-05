// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T37: one timeline per agent, deep linking to the conversations.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import AgentActivityTab from "~/modules/agent/AgentActivityTab"
import { ApiContext } from "~/modules/shell/ApiContext"

const AGENT = "11111111-1111-4111-8111-111111111111"
const THREAD = "55555555-5555-4555-8555-555555555555"

const openTab = vi.fn()
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: (...args: unknown[]) => openTab(...args),
}))

function row(over: Record<string, unknown> = {}) {
  return {
    at: "2026-09-13T10:00:00.000Z",
    kind: "turn",
    threadId: THREAD,
    threadName: "Shipping",
    summary: "Replied in a conversation",
    runLocation: "liaison",
    ...over,
  }
}

function setup(rows: unknown[]) {
  const api: any = {
    get: vi.fn(async () => ({ data: rows })),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentActivityTab agentId={AGENT} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentActivityTab (P4c-T37)", () => {
  afterEach(() => {
    cleanup()
    openTab.mockClear()
  })

  it("a row opens the thread", async () => {
    setup([row(), row({ at: "2026-09-13T09:00:00.000Z", threadId: null, threadName: null })])
    await waitFor(() => expect(screen.getByTestId(`agent-activity-row-0`)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("agent-activity-row-0"))
    expect(openTab).toHaveBeenCalledWith({
      type: "thread",
      entityId: THREAD,
      label: "Shipping",
    })
    // A row with no conversation to open is inert rather than a dead click.
    fireEvent.click(screen.getByTestId("agent-activity-row-1"))
    expect(openTab).toHaveBeenCalledTimes(1)
  })

  it("local rows show the Local badge", async () => {
    setup([row({ runLocation: "local" }), row({ at: "2026-09-13T09:00:00.000Z" })])
    await waitFor(() => expect(screen.getByTestId("agent-activity-row-0")).toBeInTheDocument())
    expect(screen.getByTestId("agent-activity-badge-0").textContent).toBe("Local")
    expect(screen.queryByTestId("agent-activity-badge-1")).toBeNull()
  })

  // The Computers page renamed what a node is called (Settings, Computers):
  // the badge says Computer, as every other surface now does.
  it("node rows show the Computer badge (P4 N-D T4, F15)", async () => {
    setup([row({ runLocation: "node" as never }), row({ runLocation: "local" })])
    await waitFor(() => expect(screen.getByTestId("agent-activity-row-0")).toBeInTheDocument())
    expect(screen.getByTestId("agent-activity-badge-0").textContent).toBe("Computer")
    expect(screen.getByTestId("agent-activity-badge-1").textContent).toBe("Local")
  })

  it("an agent with no rows says so in the normative words", async () => {
    setup([])
    await waitFor(() => expect(screen.getByTestId("agent-activity-empty")).toBeInTheDocument())
    expect(screen.getByTestId("agent-activity-empty").textContent).toBe(
      "Mention this agent or send it a message to see its first turn here.",
    )
  })

  it("a full page offers the next one and appends it", async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      row({ at: `2026-09-13T10:${String(59 - i).padStart(2, "0")}:00.000Z` }),
    )
    const api = setup(first)
    await waitFor(() => expect(screen.getByTestId("agent-activity-more")).toBeInTheDocument())
    api.get.mockImplementation(async () => ({ data: [row({ at: "2026-09-13T08:00:00.000Z" })] }))
    fireEvent.click(screen.getByTestId("agent-activity-more"))
    await waitFor(() =>
      expect(screen.getAllByTestId(/^agent-activity-row-/).length).toBe(first.length + 1),
    )
    // The next page is asked for from the oldest row already shown.
    expect(api.get.mock.calls.at(-1)?.[0]).toContain("before=2026-09-13T10%3A10%3A00.000Z")
    // A short page ends the timeline.
    expect(screen.queryByTestId("agent-activity-more")).toBeNull()
  })
})
