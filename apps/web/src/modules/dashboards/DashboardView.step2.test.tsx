// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Filters on the dashboard's tab (which values it opens on: link > remembered > default; a pick
// is remembered, written into the URL and re-reads the blocks; "All"; reset), and the panel of
// rows behind a figure (opens on a pick, pages, opens a row's record).
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import * as tabStoreModule from "~/modules/shell/tab-store"
import { DashboardView } from "./DashboardView"
import { resetDashboardsStore } from "./dashboards-store"

const opened = vi.hoisted(() => ({ paths: [] as string[], entities: [] as unknown[][] }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: (p: string) => opened.paths.push(p) }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: async (...args: unknown[]) => {
    opened.entities.push(args.slice(1))
  },
}))
vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})
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
const route = () => tabStoreModule.tabStore.tabs[0]?.routePath ?? ""

const spec = {
  v: 1,
  layout: "grid",
  filters: [
    {
      id: "market",
      label: "Market",
      type: "select",
      options: { fromDataset: "orders", field: "m" },
    },
    { id: "channel", label: "Channel", type: "multi", options: ["b2b", "dtc"] },
  ],
  blocks: [
    { id: "m", type: "metric", title: "Orders", width: 1, dataset: "orders" },
    { id: "b", type: "bar", title: "By market", width: 2, dataset: "orders" },
    { id: "n", type: "text", title: "Notes", width: 1, text: "Hi" },
  ],
}

function mount(filters: { values: Record<string, string[]>; saved: boolean }) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/d1") {
      return {
        id: "d1",
        title: "Sales",
        visibility: "org",
        version: 1,
        spec,
        usesTimeRange: false,
        filters,
        defaultFilters: { market: [], channel: [] },
      }
    }
    if (path.startsWith("/dashboards/d1/filters/market/options")) {
      return { filterId: "market", options: ["DE", "FR"], truncated: false }
    }
    if (path.startsWith("/dashboards/d1/blocks/n/")) return { kind: "text", markdown: "Hi" }
    if (path.startsWith("/dashboards/d1/blocks/b/data")) {
      return { kind: "bar", labels: ["DE", "FR"], series: [{ name: "value", values: [2, 5] }] }
    }
    if (path.startsWith("/dashboards/d1/blocks/") && path.includes("/rows")) {
      const q = new URLSearchParams(path.split("?")[1])
      const offset = Number(q.get("offset"))
      return {
        blockId: "b",
        columns: [{ field: "id", label: "Order" }],
        rows: [{ id: `o${offset + 1}` }, { id: `o${offset + 2}` }],
        links: [
          { kind: "path", href: `/shop/orders/o${offset + 1}` },
          { kind: "entity", app: "tickets", entityType: "ticket", id: `t${offset + 2}` },
        ],
        total: 52,
        offset,
        limit: 50,
        nextOffset: offset === 0 ? 50 : null,
        truncated: false,
      }
    }
    return { kind: "metric", value: 7 }
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

const reads = (get: ReturnType<typeof vi.fn>, id: string) =>
  get.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => p.startsWith(`/dashboards/d1/blocks/${id}/data`))
const rowReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/rows"))

function choose(testId: string) {
  const item = screen.getByTestId(testId)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}
async function openFilter(id: string) {
  await waitFor(() => expect(screen.getByTestId(`dashboard-filter-${id}`)).toBeTruthy())
  fireEvent.keyDown(screen.getByTestId(`dashboard-filter-${id}`), { key: "ArrowDown" })
  await waitFor(() => expect(screen.getByTestId(`dashboard-filter-menu-${id}`)).toBeTruthy())
}

beforeEach(() => {
  resetDashboardsStore()
  setRoute("/dashboard/d1")
  opened.paths.length = 0
  opened.entities.length = 0
})
afterEach(cleanup)

describe("DashboardView filters", () => {
  it("the link's values win over the remembered ones, filter by filter", async () => {
    setRoute("/dashboard/d1?f.market=DE")
    const { get } = mount({ values: { market: ["FR"], channel: ["dtc"] }, saved: true })
    await waitFor(() => expect(reads(get, "m").length).toBe(1))
    const q = new URLSearchParams(reads(get, "m")[0]!.split("?")[1])
    expect(q.getAll("f.market")).toEqual(["DE"])
    expect(q.getAll("f.channel")).toEqual(["dtc"])
    expect(screen.getByTestId("dashboard-filter-value-market").textContent).toBe("DE")
  })

  it("opens on the defaults and sends an empty value for 'All'", async () => {
    const { get } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(reads(get, "m").length).toBe(1))
    expect(reads(get, "m")[0]).toContain("f.channel=&f.market=")
    expect(screen.getByTestId("dashboard-filter-value-market").textContent).toBe("All")
    expect(screen.queryByTestId("dashboard-filters-reset")).toBeNull()
    // A text block carries no drill-down.
    expect(screen.queryByTestId("dashboard-block-rows-n")).toBeNull()
  })

  it("a pick re-reads the blocks, is remembered and goes into the URL; reset forgets it", async () => {
    const { get, put } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(reads(get, "m").length).toBe(1))
    await openFilter("market")
    // Options from the server, read when the menu opens, without the filter's own value.
    await waitFor(() => expect(screen.getByTestId("dashboard-filter-option-market-1")).toBeTruthy())
    const optionsRead = get.mock.calls.map((c) => String(c[0])).find((p) => p.includes("/options"))
    expect(optionsRead).toBe("/dashboards/d1/filters/market/options?f.channel=")
    choose("dashboard-filter-option-market-1")
    await waitFor(() => expect(reads(get, "m").length).toBe(2))
    expect(reads(get, "m")[1]).toContain("f.market=FR")
    expect(put).toHaveBeenCalledWith(
      "/dashboards/d1/viewer-state",
      { filters: { market: ["FR"], channel: [] } },
      expect.anything(),
    )
    expect(new URLSearchParams(route().split("?")[1]).get("f.market")).toBe("FR")

    fireEvent.click(screen.getByTestId("dashboard-filters-reset"))
    await waitFor(() => expect(reads(get, "m").length).toBe(3))
    expect(route()).toBe("/dashboard/d1")
    expect(put).toHaveBeenLastCalledWith(
      "/dashboards/d1/viewer-state",
      { filters: {} },
      expect.anything(),
    )
  })

  it("a multi's ticks apply together when its menu closes: one menu session, one read", async () => {
    const { get, put } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(reads(get, "m").length).toBe(1))
    await openFilter("channel")
    choose("dashboard-filter-option-channel-1")
    choose("dashboard-filter-option-channel-0")
    // Ticked, not yet applied: no read, nothing remembered.
    await new Promise((r) => setTimeout(r, 30))
    expect(reads(get, "m").length).toBe(1)
    expect(put).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId("dashboard-filter-menu-channel"), { key: "Escape" })
    await waitFor(() => expect(reads(get, "m").length).toBe(2))
    expect(new URLSearchParams(reads(get, "m")[1]!.split("?")[1]).getAll("f.channel")).toEqual([
      "b2b",
      "dtc",
    ])
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe("DashboardView drill-down", () => {
  it("a bar opens its rows on the right, pages, and opens each row's record", async () => {
    setRoute("/dashboard/d1?f.channel=b2b")
    const { get } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(screen.getByTestId("dashboard-chart-pick-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("dashboard-chart-pick-1"))
    await waitFor(() => expect(screen.getByTestId("dashboard-drill-row-0")).toBeTruthy())
    const first = new URLSearchParams(rowReads(get)[0]!.split("?")[1])
    expect(first.get("category")).toBe("FR")
    expect(first.get("offset")).toBe("0")
    expect(first.getAll("f.channel")).toEqual(["b2b"])
    expect(screen.getByTestId("dashboard-drill-subtitle").textContent).toBe("FR")
    expect(screen.getByTestId("dashboard-drill-count").textContent).toBe("1 to 2 of 52")

    fireEvent.click(screen.getByTestId("dashboard-drill-next"))
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-drill-count").textContent).toBe("51 to 52 of 52"),
    )
    expect(new URLSearchParams(rowReads(get)[1]!.split("?")[1]).get("offset")).toBe("50")
    expect((screen.getByTestId("dashboard-drill-next") as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId("dashboard-drill-open-0"))
    expect(opened.paths).toEqual(["/shop/orders/o51"])
    fireEvent.click(screen.getByTestId("dashboard-drill-open-1"))
    await waitFor(() => expect(opened.entities).toEqual([["tickets", "ticket", "t52"]]))

    fireEvent.keyDown(screen.getByTestId("dashboard-drill-panel"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("dashboard-drill-panel")).toBeNull())
  })

  it("a filter change while the rows are open reads them again from the first page", async () => {
    const { get } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(screen.getByTestId("dashboard-chart-pick-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("dashboard-chart-pick-1"))
    await waitFor(() => expect(screen.getByTestId("dashboard-drill-row-0")).toBeTruthy())
    fireEvent.click(screen.getByTestId("dashboard-drill-next"))
    await waitFor(() => expect(rowReads(get).length).toBe(2))
    await openFilter("channel")
    choose("dashboard-filter-option-channel-0")
    fireEvent.keyDown(screen.getByTestId("dashboard-filter-menu-channel"), { key: "Escape" })
    await waitFor(() => expect(rowReads(get).length).toBe(3))
    const q = new URLSearchParams(rowReads(get)[2]!.split("?")[1])
    expect(q.get("offset")).toBe("0")
    expect(q.getAll("f.channel")).toEqual(["b2b"])
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-drill-count").textContent).toBe("1 to 2 of 52"),
    )
  })

  it("Escape closes the rows from the grid, and focus goes back to what opened them", async () => {
    mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(screen.getByTestId("dashboard-chart-pick-1")).toBeTruthy())
    const pick = screen.getByTestId("dashboard-chart-pick-1")
    pick.focus()
    fireEvent.click(pick)
    await waitFor(() => expect(screen.getByTestId("dashboard-drill-row-0")).toBeTruthy())
    // Focus back on the grid (another bar), then Escape there.
    const other = screen.getByTestId("dashboard-chart-pick-0")
    other.focus()
    fireEvent.keyDown(other, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("dashboard-drill-panel")).toBeNull())
    expect(document.activeElement).toBe(pick)
  })

  it("a metric opens every row it adds up", async () => {
    const { get } = mount({ values: { market: [], channel: [] }, saved: false })
    await waitFor(() => expect(screen.getByTestId("block-metric-drill")).toBeTruthy())
    fireEvent.keyDown(screen.getByTestId("block-metric-drill"), { key: "Enter" })
    await waitFor(() => expect(rowReads(get).length).toBe(1))
    const q = new URLSearchParams(rowReads(get)[0]!.split("?")[1])
    expect(q.has("category")).toBe(false)
    expect(screen.getByTestId("dashboard-drill-subtitle").textContent).toBe("All rows")
  })
})
