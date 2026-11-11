// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dashboard's time range on its tab: which range it opens on (link > the
// person's saved one > the dashboard's default), what a pick does (remembered,
// written into the tab's URL, blocks re-read), and blocks that keep their own window.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import * as tabStoreModule from "~/modules/shell/tab-store"
import { DashboardView } from "./DashboardView"
import { resetDashboardsStore } from "./dashboards-store"

vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})

// The tab store, reactive (built inside the factory: one Solid instance), with the dashboard's
// tab in it, so the view reads and writes its URL the way it does in the shell.
vi.mock("~/modules/shell/tab-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/tab-store")>()
  const { createStore } = await import("solid-js/store")
  const [store, setStore] = createStore<{
    tabs: Array<{ id: string; type: string; entityId: string; routePath?: string }>
    activeTabId: string | null
  }>({ tabs: [], activeTabId: null })
  return {
    ...actual,
    tabStore: store,
    updateTabRoutePath: vi.fn((id: string, routePath: string) =>
      setStore("tabs", (t) => t.id === id, "routePath", routePath),
    ),
    __setRoute: (routePath: string) =>
      setStore({
        tabs: [{ id: "kernel:dashboard:d1", type: "kernel:dashboard", entityId: "d1", routePath }],
        activeTabId: "kernel:dashboard:d1",
      }),
  }
})

const setRoute = (path: string) =>
  (tabStoreModule as unknown as { __setRoute: (p: string) => void }).__setRoute(path)
const updateRoute = tabStoreModule.updateTabRoutePath as unknown as ReturnType<typeof vi.fn>

const spec = {
  v: 1,
  layout: "grid",
  blocks: [
    { id: "m", type: "metric", title: "Orders", width: 1, source: { kind: "tool" } },
    { id: "t", type: "metric", title: "Open orders", width: 1, source: { kind: "tool" } },
  ],
}

type Saved = { timeRange: { preset: string }; compare: string; saved: boolean } | undefined

function record(range: Saved, usesTimeRange = true) {
  return {
    id: "d1",
    title: "Sales",
    visibility: "org",
    version: 1,
    spec,
    usesTimeRange,
    blockTimeRange: { m: "dashboard", t: "fixed" },
    defaultRange: { timeRange: { preset: "last30d" }, compare: "lastYear" },
    ...(range
      ? {
          range: {
            ...range,
            window: { from: "2026-01-01", to: "2026-11-11" },
            compareWindow: { from: "2025-01-01", to: "2025-11-11" },
          },
        }
      : {}),
  }
}

function mount(range: Saved, usesTimeRange = true) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/d1") return record(range, usesTimeRange)
    if (path.startsWith("/dashboards/d1/blocks/t/")) {
      return {
        kind: "metric",
        value: 7,
        window: { mode: "fixed", dates: [{ token: "{{today-90d}}", date: "2026-08-13" }] },
      }
    }
    const q = new URLSearchParams(path.split("?")[1] ?? "")
    return {
      kind: "metric",
      value: 10,
      previous: 8,
      computedAt: new Date().toISOString(),
      window: {
        mode: "dashboard",
        preset: q.get("range") ?? "last30d",
        from: "2026-10-01",
        to: "2026-10-31",
      },
      compareWindow: { mode: "lastYear", from: "2025-10-01", to: "2025-10-31" },
    }
  })
  const put = vi.fn(async (_path: string, body: unknown) => body)
  const del = vi.fn(async () => ({ cleared: true }))
  const api = { get, put, delete: del } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <DashboardView entityId="d1" />
    </ApiContext.Provider>
  ))
  return { get, put, del }
}

const blockReads = (get: ReturnType<typeof vi.fn>, id: string) =>
  get.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => p.startsWith(`/dashboards/d1/blocks/${id}/`))

/** Picks a menu row as the keyboard does (Kobalte selects on Enter). */
function choose(testId: string) {
  const item = screen.getByTestId(testId)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}

async function openMenu() {
  await waitFor(() => expect(screen.getByTestId("dashboard-range-trigger")).toBeTruthy())
  fireEvent.keyDown(screen.getByTestId("dashboard-range-trigger"), { key: "ArrowDown" })
  await waitFor(() => expect(screen.getByTestId("dashboard-range-menu")).toBeTruthy())
}

beforeEach(() => {
  resetDashboardsStore()
  updateRoute.mockClear()
  setRoute("/dashboard/d1")
})
afterEach(cleanup)

describe("DashboardView time range", () => {
  it("the link's range wins over the saved one", async () => {
    setRoute("/dashboard/d1?range=qtd&compare=none")
    const { get } = mount({ timeRange: { preset: "ytd" }, compare: "previousPeriod", saved: true })
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    expect(blockReads(get, "m")[0]).toContain("range=qtd&compare=none")
    // No comparison: the label is the range alone.
    expect(screen.getByTestId("dashboard-range-label").textContent).not.toContain("vs")
  })

  it("opens on the person's saved range when the link carries none", async () => {
    const { get } = mount({ timeRange: { preset: "ytd" }, compare: "previousPeriod", saved: true })
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    expect(blockReads(get, "m")[0]).toContain("range=ytd&compare=previousPeriod")
  })

  it("compares with the same period last year by default", async () => {
    const { get } = mount(undefined)
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    expect(blockReads(get, "m")[0]).toContain("range=last30d&compare=lastYear")
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-range-label").textContent).toMatch(/vs/),
    )
  })

  it("a pick re-reads the blocks, is remembered and goes into the URL", async () => {
    const { get, put } = mount({
      timeRange: { preset: "last30d" },
      compare: "lastYear",
      saved: false,
    })
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    await openMenu()
    choose("dashboard-range-preset-lastMonth")
    await waitFor(() => expect(blockReads(get, "m").length).toBe(2))
    expect(blockReads(get, "m")[1]).toContain("range=lastMonth&compare=lastYear")
    expect(put).toHaveBeenCalledWith(
      "/dashboards/d1/viewer-state",
      { timeRange: { preset: "lastMonth" }, compare: "lastYear" },
      expect.anything(),
    )
    expect(updateRoute).toHaveBeenCalledWith(
      "kernel:dashboard:d1",
      "/dashboard/d1?range=lastMonth&compare=lastYear",
    )
    // The label follows the days the server reported for that read.
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-range-label").textContent).toMatch(
        /Oct.*2026.*vs.*Oct.*2025/,
      ),
    )
    // A block that keeps its own window is not re-read for the dashboard's range.
    expect(blockReads(get, "t")).toEqual(["/dashboards/d1/blocks/t/data"])
  })

  it("going back to the default forgets the saved range and clears the URL", async () => {
    setRoute("/dashboard/d1?range=ytd&compare=previousPeriod")
    const { del, get } = mount({
      timeRange: { preset: "ytd" },
      compare: "previousPeriod",
      saved: true,
    })
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    await openMenu()
    choose("dashboard-range-reset")
    expect(del).toHaveBeenCalledWith("/dashboards/d1/viewer-state", undefined, expect.anything())
    expect(updateRoute).toHaveBeenCalledWith("kernel:dashboard:d1", "/dashboard/d1")
    await waitFor(() => expect(blockReads(get, "m").length).toBe(2))
    expect(blockReads(get, "m")[1]).toContain("range=last30d&compare=lastYear")
  })

  it("offers the default back when only the link carries a range", async () => {
    setRoute("/dashboard/d1?range=qtd&compare=none")
    const { get } = mount(undefined)
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    await openMenu()
    choose("dashboard-range-reset")
    expect(updateRoute).toHaveBeenCalledWith("kernel:dashboard:d1", "/dashboard/d1")
    await waitFor(() => expect(blockReads(get, "m").length).toBe(2))
    expect(blockReads(get, "m")[1]).toContain("range=last30d&compare=lastYear")
  })

  it("a block keeping its own window shows it as a chip", async () => {
    mount(undefined)
    await waitFor(() => expect(screen.getByTestId("dashboard-block-window-t")).toBeTruthy())
    expect(screen.getByTestId("dashboard-block-window-t").textContent).toMatch(/Aug/)
    expect(screen.queryByTestId("dashboard-block-window-m")).toBeNull()
  })

  it("a dashboard whose blocks all keep their own windows has no picker and sends no range", async () => {
    const { get } = mount(undefined, false)
    await waitFor(() => expect(blockReads(get, "m").length).toBe(1))
    expect(screen.queryByTestId("dashboard-range")).toBeNull()
    expect(blockReads(get, "m")[0]).not.toContain("range=")
    expect(screen.queryByTestId("dashboard-block-window-t")).toBeNull()
  })

  it("shows the change on the metric and when it was read", async () => {
    mount(undefined)
    await waitFor(() => expect(screen.getByTestId("block-metric-delta")).toBeTruthy())
    expect(screen.getByTestId("block-metric-delta").textContent).toContain(
      "+25% vs same period last year",
    )
    expect(screen.getByTestId("dashboard-block-updated-m").textContent).toBe("Updated just now")
  })
})
