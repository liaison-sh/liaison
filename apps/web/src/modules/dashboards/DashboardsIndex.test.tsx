// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  userFromToken: () => ({ userId: "me", name: "Tester", scopes: [] }),
}))

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

  it("shows the viewer's own dashboards, then the team's, as cards, and opens one in a tab", async () => {
    mount({
      current: [
        {
          id: "o1",
          title: "Team sales",
          visibility: "org",
          ownerUserId: "x",
          ownerName: "Claire Martin",
          blockCount: 6,
        },
        { id: "s1", title: "Support load", visibility: "org", ownerUserId: "me", blockCount: 1 },
        { id: "p1", title: "My orders", visibility: "personal", ownerUserId: "me", blockCount: 4 },
      ],
    })
    await screen.findByTestId("dashboards-index-list")
    const ids = (group: string) =>
      Array.from(
        screen.getByTestId(group).querySelectorAll("[data-testid^='dashboards-index-row-']"),
      )
        .map((r) => r.getAttribute("data-testid"))
        .filter((id) => !id?.endsWith("-meta"))
    expect(ids("dashboards-index-yours")).toEqual([
      "dashboards-index-row-p1",
      "dashboards-index-row-s1",
    ])
    expect(ids("dashboards-index-team")).toEqual(["dashboards-index-row-o1"])
    expect(screen.getByTestId("dashboards-index-row-p1-meta").textContent).toBe(
      "Only you · 4 blocks",
    )
    expect(screen.getByTestId("dashboards-index-row-s1-meta").textContent).toBe(
      "Shared with the team · 1 block",
    )
    expect(screen.getByTestId("dashboards-index-row-o1-meta").textContent).toBe(
      "By Claire Martin · 6 blocks",
    )
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
