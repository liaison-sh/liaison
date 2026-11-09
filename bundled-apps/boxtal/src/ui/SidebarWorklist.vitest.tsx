// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidebar names the shipping worklist ONCE: To prepare and Ready to ship are the worklist's
// own filters (Queues.tsx), never two sidebar entries that read as two lists.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

let path = "/boxtal/shipments"
vi.mock("@liaison/host", () => ({
  currentPath: () => path,
  navigate: () => {},
  app: {
    invokeTool: (name: string) =>
      name === "queue_counts"
        ? Promise.resolve({ to_prepare: 3, ready: 2, returns: 0, exceptions: 0 })
        : Promise.reject(new Error(`no ${name}`)),
  },
}))

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => cleanup())

describe("Boxtal sidebar: one shipping worklist", () => {
  it("has one worklist row (no separate To prepare / Ready to ship rows), badged with both counts", async () => {
    window.history.replaceState({}, "", "/boxtal/shipments")
    const { BoxtalSidebar } = await import("./sidebar")
    render(() => <BoxtalSidebar />)
    await flush()
    expect(screen.queryByTestId("boxtal-sidebar-link-to-prepare")).toBeNull()
    expect(screen.queryByTestId("boxtal-sidebar-link-ready")).toBeNull()
    const row = screen.getByTestId("boxtal-sidebar-link-worklist")
    expect(row.getAttribute("href")).toBe("/boxtal/queue/worklist")
    expect(row.textContent).toContain("Shipping worklist")
    expect(screen.getByTestId("boxtal-sidebar-badge-worklist").textContent).toBe("5")
  })

  it("the worklist row is the active one on every queue route, the retired ones included", async () => {
    const { isWorklistActive } = await import("./sidebar")
    expect(isWorklistActive("/boxtal/queue/worklist")).toBe(true)
    expect(isWorklistActive("/boxtal/queue/worklist?state=packed")).toBe(true)
    expect(isWorklistActive("/boxtal/queue/to-prepare")).toBe(true)
    expect(isWorklistActive("/boxtal/queue/ready")).toBe(true)
    expect(isWorklistActive("/boxtal/shipments")).toBe(false)
    expect(isWorklistActive("/boxtal/queuex")).toBe(false)
  })
})
