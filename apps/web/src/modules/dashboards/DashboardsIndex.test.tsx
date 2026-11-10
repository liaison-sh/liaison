// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import { tabStore } from "~/modules/shell/tab-store"
import { DashboardsIndex } from "./DashboardsIndex"
import { handleDashboardEvent, resetDashboardsStore } from "./dashboards-store"

function mount(rows: { current: unknown[] }) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/dashboards") return rows.current
      throw new Error(`unexpected ${path}`)
    }),
  } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <DashboardsIndex />
    </ApiContext.Provider>
  ))
  return api
}

beforeEach(resetDashboardsStore)
afterEach(cleanup)

describe("DashboardsIndex", () => {
  it("with no dashboard, says what one is and to ask the agent to build one", async () => {
    mount({ current: [] })
    const empty = await screen.findByTestId("dashboards-index-empty")
    expect(empty.textContent).toContain("No dashboards yet")
    expect(screen.getByTestId("dashboards-index-empty-hint").textContent).toContain(
      "Ask your agent to build one",
    )
    expect(screen.queryByTestId("dashboards-index-list")).toBeNull()
  })

  it("lists the viewer's dashboards, their own first, and opens one in a tab", async () => {
    mount({
      current: [
        { id: "o1", title: "Team sales", visibility: "org", ownerUserId: "x" },
        { id: "p1", title: "My orders", visibility: "personal", ownerUserId: "me" },
      ],
    })
    await screen.findByTestId("dashboards-index-list")
    const rows = screen.getAllByTestId(/^dashboards-index-row-[a-z0-9]+$/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "dashboards-index-row-p1",
      "dashboards-index-row-o1",
    ])
    expect(screen.getByTestId("dashboards-index-row-o1-visibility").textContent).toBe("Org")
    fireEvent.click(screen.getByTestId("dashboards-index-row-o1"))
    expect(tabStore.tabs.some((t) => t.type === "kernel:dashboard" && t.entityId === "o1")).toBe(
      true,
    )
  })

  it("leaves the empty state when a dashboard is shared with the viewer", async () => {
    const rows = { current: [] as unknown[] }
    const api = mount(rows)
    await screen.findByTestId("dashboards-index-empty")
    rows.current = [{ id: "o1", title: "Team sales", visibility: "org", ownerUserId: "x" }]
    await handleDashboardEvent(api, "updated", { dashboardId: "o1", visibility: "org" })
    await waitFor(() => expect(screen.getByTestId("dashboards-index-row-o1")).toBeTruthy())
    expect(screen.queryByTestId("dashboards-index-empty")).toBeNull()
  })
})
