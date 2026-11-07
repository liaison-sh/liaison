// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import { blockSpanClass, DashboardView } from "./DashboardView"
import { dashboardTitle, resetDashboardsStore } from "./dashboards-store"

vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})

const spec = {
  v: 1,
  layout: "grid",
  blocks: [
    { id: "m", type: "metric", title: "Orders", width: 1, source: { kind: "store" } },
    { id: "t", type: "table", title: "Recent orders", width: 3, source: { kind: "tool" } },
  ],
}

function mount(get: (path: string, init?: any) => Promise<unknown>) {
  const api = { get: vi.fn(get) } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <DashboardView entityId="d1" />
    </ApiContext.Provider>
  ))
  return api
}

beforeEach(resetDashboardsStore)
afterEach(cleanup)

describe("DashboardView", () => {
  it("shows the toolbar at the top and each block on its own", async () => {
    const api = mount(async (path) => {
      if (path === "/dashboards/d1") return { id: "d1", title: "Sales", visibility: "org", spec }
      if (path.startsWith("/dashboards/d1/blocks/m/")) return { kind: "metric", value: 42 }
      return { error: "no_access" }
    })
    await waitFor(() => expect(screen.getByTestId("dashboard-title").textContent).toBe("Sales"))
    expect(screen.getByTestId("dashboard-visibility").dataset.visibility).toBe("org")
    expect(screen.getByTestId("dashboard-visibility").textContent).toBe("Org")
    // The toolbar comes before the grid: actions at the top.
    const toolbar = screen.getByTestId("dashboard-toolbar")
    expect(toolbar.contains(screen.getByTestId("dashboard-refresh-all"))).toBe(true)
    await waitFor(() => expect(screen.getByTestId("dashboard-block-m").dataset.state).toBe("ready"))
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-block-t").dataset.error).toBe("no_access"),
    )
    expect(screen.getByTestId("dashboard-block-t").className).toContain("@5xl:col-span-3")
    // The tab is named by the title.
    expect(dashboardTitle("d1")).toBe("Sales")

    fireEvent.click(screen.getByTestId("dashboard-refresh-all"))
    await waitFor(() =>
      expect(
        (api.get as any).mock.calls.some((c: any[]) => String(c[0]).endsWith("?refresh=1")),
      ).toBe(true),
    )
  })

  it("shows the empty state for a dashboard with no blocks", async () => {
    mount(async () => ({
      id: "d1",
      title: "New",
      visibility: "personal",
      spec: { v: 1, layout: "grid", blocks: [] },
    }))
    await waitFor(() => expect(screen.getByTestId("dashboard-empty")).toBeTruthy())
    expect(screen.getByTestId("dashboard-visibility").textContent).toBe("Personal")
  })

  it("says a missing dashboard is gone", async () => {
    mount(async () => {
      throw new ApiError("Not found", 404)
    })
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-not-found").textContent).toBe(
        "This dashboard no longer exists, or it is not shared with you.",
      ),
    )
  })
})

describe("blockSpanClass", () => {
  it("spans by width, one column until the panel is wide", () => {
    expect(blockSpanClass(1)).toBe("")
    expect(blockSpanClass(2)).toBe("@2xl:col-span-2")
    expect(blockSpanClass(3)).toBe("@2xl:col-span-2 @5xl:col-span-3")
  })
})
