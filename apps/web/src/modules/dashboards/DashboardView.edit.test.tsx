// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 3 on the dashboard's tab: the Edit toggle (only for someone who may edit), each change
// sent as one operation with the version shown (rename, move by keyboard and by drop, resize,
// duplicate, delete after a confirm, title, description), a stale version reloading, Undo, the
// version history panel with Restore, the export menu, Send regularly, the org's today, a
// metric read from one object (no drill button), and the filter search.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import { DashboardView } from "./DashboardView"
import { reloadDashboard, resetDashboardsStore } from "./dashboards-store"
import { FILTER_SEARCH_DEBOUNCE_MS } from "./FilterBar"

const toasts = vi.hoisted(() => [] as Array<{ type: string; message: string }>)
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (t: { type: string; message: string }) => {
    toasts.push(t)
    return "t"
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
  const [store] = createStore({
    tabs: [
      {
        id: "kernel:dashboard:d1",
        type: "kernel:dashboard",
        entityId: "d1",
        routePath: "/dashboard/d1",
      },
    ],
    activeTabId: "kernel:dashboard:d1",
  })
  return { ...actual, tabStore: store, updateTabRoutePath: vi.fn(), openTab: vi.fn() }
})

const blocks = [
  { id: "a", type: "metric", title: "Orders", width: 1, source: { tool: "x" } },
  { id: "b", type: "bar", title: "By market", width: 2, height: 2, source: { tool: "y" } },
  { id: "c", type: "metric", title: "Shop status", width: 1, source: { tool: "z" } },
]

function record(version: number, over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    title: "Sales",
    visibility: "personal",
    version,
    canEdit: true,
    today: "2026-11-12",
    timeZone: "Europe/Paris",
    usesTimeRange: true,
    range: undefined,
    defaultRange: { timeRange: { preset: "mtd" }, compare: "none" },
    spec: { v: 1, layout: "grid", blocks, ...((over.spec as object) ?? {}) },
    ...over,
  }
}

function mount(
  opts: {
    canEdit?: boolean
    post?: (path: string, body: unknown) => unknown
    /** Awaited before the dashboard's own read answers. */
    readGate?: () => Promise<void>
  } = {},
) {
  let current = record(3, opts.canEdit === false ? { canEdit: false } : {})
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/d1") {
      if (opts.readGate) await opts.readGate()
      return current
    }
    if (path === "/dashboards") return []
    if (path === "/dashboards/d1/versions") {
      return {
        versions: [
          {
            version: 3,
            title: "Sales",
            savedAt: "2026-11-12T09:00:00Z",
            savedBy: "u1",
            savedByName: "Ada",
            blockCount: 3,
            current: true,
          },
          {
            version: 2,
            title: "Sales",
            savedAt: "2026-11-11T09:00:00Z",
            savedBy: "u1",
            savedByName: "Ada",
            blockCount: 2,
            current: false,
          },
        ],
      }
    }
    if (path === "/dashboards/d1/versions/2") {
      return {
        version: 2,
        title: "Sales",
        spec: { v: 1, layout: "grid", blocks: blocks.slice(0, 2) },
        savedAt: "x",
        savedBy: null,
        savedByName: null,
      }
    }
    if (path.startsWith("/dashboards/d1/blocks/b/")) {
      return {
        kind: "bar",
        labels: ["DE"],
        series: [{ name: "v", values: [1] }],
        meta: { sourceRows: 4 },
      }
    }
    if (path.startsWith("/dashboards/d1/blocks/c/")) {
      return { kind: "metric", value: "open", meta: { sourceRows: 0 } }
    }
    return { kind: "metric", value: 7, meta: { sourceRows: 12 } }
  })
  const post = vi.fn(async (path: string, body: unknown) => {
    if (opts.post) return opts.post(path, body)
    current = record(current.version + 1)
    return current
  })
  const rawGet = vi.fn(async (_path: string) => new Response("x"))
  const api = {
    get,
    post,
    rawGet,
    put: vi.fn(async () => ({})),
    delete: vi.fn(),
  } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <DashboardView entityId="d1" />
    </ApiContext.Provider>
  ))
  return {
    get,
    post,
    rawGet,
    /** Someone else saved: the server is at version `v` now. */
    setVersion: (v: number) => {
      current = record(v)
    },
  }
}
const reads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter((c) => c[0] === "/dashboards/d1").length

function choose(testId: string) {
  const item = screen.getByTestId(testId)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}
async function openMenu(testId: string) {
  await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy())
  fireEvent.keyDown(screen.getByTestId(testId), { key: "ArrowDown" })
}
async function startEditing() {
  await waitFor(() => expect(screen.getByTestId("dashboard-edit-toggle")).toBeTruthy())
  fireEvent.click(screen.getByTestId("dashboard-edit-toggle"))
  await waitFor(() => expect(screen.getByTestId("dashboard-title-input")).toBeTruthy())
}
const ops = (post: ReturnType<typeof vi.fn>) =>
  post.mock.calls
    .filter((c) => String(c[0]).endsWith("/edit"))
    .map((c) => c[1] as { ifVersion: number; operations: unknown[] })

beforeEach(() => {
  resetDashboardsStore()
  toasts.length = 0
})
afterEach(cleanup)

describe("edit mode", () => {
  it("is offered only to someone who may edit", async () => {
    mount({ canEdit: false })
    await waitFor(() => expect(screen.getByTestId("dashboard-title").textContent).toBe("Sales"))
    expect(screen.queryByTestId("dashboard-edit-toggle")).toBeNull()
  })

  it("renames a block inline and the dashboard's title, each as one operation", async () => {
    const { post } = mount()
    await startEditing()
    const input = screen.getByTestId("dashboard-block-title-input-a") as HTMLInputElement
    input.value = "All orders"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(ops(post).length).toBe(1))
    expect(ops(post)[0]).toEqual({
      ifVersion: 3,
      operations: [{ op: "updateBlock", blockId: "a", changes: { title: "All orders" } }],
    })
    const title = screen.getByTestId("dashboard-title-input") as HTMLInputElement
    title.value = "Sales 2026"
    fireEvent.blur(title)
    await waitFor(() => expect(ops(post).length).toBe(2))
    // The next change carries the version the first one produced.
    expect(ops(post)[1]).toEqual({
      ifVersion: 4,
      operations: [{ op: "setTitle", title: "Sales 2026" }],
    })
    const desc = screen.getByTestId("dashboard-description-input") as HTMLTextAreaElement
    desc.value = "Weekly view"
    fireEvent.blur(desc)
    await waitFor(() => expect(ops(post).length).toBe(3))
    expect(ops(post)[2]?.operations).toEqual([{ op: "setDescription", description: "Weekly view" }])
  })

  it("moves a block with the keyboard buttons; first and last cannot go further", async () => {
    const { post } = mount()
    await startEditing()
    const left = screen.getByTestId("dashboard-block-move-left-a") as HTMLButtonElement
    expect(left.disabled).toBe(true)
    expect((screen.getByTestId("dashboard-block-move-right-c") as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(ops(post).length).toBe(1))
    expect(ops(post)[0]?.operations).toEqual([{ op: "moveBlock", blockId: "a", position: 1 }])
    // jsdom draws one column: up is one place. The arrows wait while a change is saved.
    const up = screen.getByTestId("dashboard-block-move-up-c") as HTMLButtonElement
    await waitFor(() => expect(up.disabled).toBe(false))
    fireEvent.click(up)
    await waitFor(() => expect(ops(post).length).toBe(2))
    expect(ops(post)[1]?.operations).toEqual([{ op: "moveBlock", blockId: "c", position: 1 }])
  })

  it("a block dropped on another takes its place", async () => {
    const { post } = mount()
    await startEditing()
    fireEvent.dragStart(screen.getByTestId("dashboard-block-c"))
    fireEvent.dragOver(screen.getByTestId("dashboard-block-a"))
    fireEvent.drop(screen.getByTestId("dashboard-block-a"))
    await waitFor(() => expect(ops(post).length).toBe(1))
    expect(ops(post)[0]?.operations).toEqual([
      { op: "moveBlock", blockId: "c", position: { before: "a" } },
    ])
    fireEvent.dragStart(screen.getByTestId("dashboard-block-a"))
    fireEvent.dragOver(screen.getByTestId("dashboard-block-b"))
    fireEvent.drop(screen.getByTestId("dashboard-block-b"))
    await waitFor(() => expect(ops(post).length).toBe(2))
    expect(ops(post)[1]?.operations).toEqual([
      { op: "moveBlock", blockId: "a", position: { after: "b" } },
    ])
  })

  it("resizes, duplicates, and deletes after a confirm", async () => {
    const { post } = mount()
    await startEditing()
    await openMenu("dashboard-block-menu-b")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-height-1-b")).toBeTruthy())
    choose("dashboard-block-height-1-b")
    await waitFor(() => expect(ops(post).length).toBe(1))
    expect(ops(post)[0]?.operations).toEqual([{ op: "resizeBlock", blockId: "b", height: 1 }])

    await openMenu("dashboard-block-menu-a")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-width-3-a")).toBeTruthy())
    choose("dashboard-block-width-3-a")
    await waitFor(() => expect(ops(post).length).toBe(2))
    expect(ops(post)[1]?.operations).toEqual([{ op: "resizeBlock", blockId: "a", width: 3 }])

    await openMenu("dashboard-block-menu-a")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-duplicate-a")).toBeTruthy())
    choose("dashboard-block-duplicate-a")
    await waitFor(() => expect(ops(post).length).toBe(3))
    expect(ops(post)[2]?.operations).toEqual([{ op: "duplicateBlock", blockId: "a" }])

    await openMenu("dashboard-block-menu-a")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-delete-a")).toBeTruthy())
    choose("dashboard-block-delete-a")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-delete-confirm")).toBeTruthy())
    expect(ops(post).length).toBe(3)
    fireEvent.click(screen.getByTestId("dashboard-block-delete-confirm"))
    await waitFor(() => expect(ops(post).length).toBe(4))
    expect(ops(post)[3]?.operations).toEqual([{ op: "removeBlock", blockId: "a" }])
  })

  it("Undo reverts to the version before the last change, one change at a time", async () => {
    const { post } = mount()
    await startEditing()
    const undo = screen.getByTestId("dashboard-undo") as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(undo.disabled).toBe(false))
    fireEvent.click(undo)
    await waitFor(() => expect(ops(post).length).toBe(2))
    expect(ops(post)[1]).toEqual({ ifVersion: 4, operations: [{ op: "revert", toVersion: 3 }] })
    await waitFor(() => expect(undo.disabled).toBe(true))
  })

  it("Undo twice walks back two changes, each on the version the last one produced", async () => {
    const { post } = mount()
    await startEditing()
    const undo = screen.getByTestId("dashboard-undo") as HTMLButtonElement
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(ops(post).length).toBe(1))
    const title = screen.getByTestId("dashboard-title-input") as HTMLInputElement
    title.value = "Sales 2026"
    fireEvent.blur(title)
    await waitFor(() => expect(ops(post).length).toBe(2))
    await waitFor(() => expect(undo.disabled).toBe(false))
    fireEvent.click(undo)
    await waitFor(() => expect(ops(post).length).toBe(3))
    expect(ops(post)[2]).toEqual({ ifVersion: 5, operations: [{ op: "revert", toVersion: 4 }] })
    await waitFor(() => expect(undo.disabled).toBe(false))
    fireEvent.click(undo)
    await waitFor(() => expect(ops(post).length).toBe(4))
    expect(ops(post)[3]).toEqual({ ifVersion: 6, operations: [{ op: "revert", toVersion: 3 }] })
    await waitFor(() => expect(undo.disabled).toBe(true))
  })

  it("Undo never erases someone else's later change: it says so and opens the history", async () => {
    const { post, get, setVersion } = mount()
    await startEditing()
    const undo = screen.getByTestId("dashboard-undo") as HTMLButtonElement
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(undo.disabled).toBe(false))
    // Someone else saves version 5; this view reloads onto it.
    setVersion(5)
    const before = reads(get)
    reloadDashboard("d1")
    await waitFor(() => expect(reads(get)).toBeGreaterThan(before))
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-view").getAttribute("data-version")).toBe("5"),
    )
    fireEvent.click(undo)
    await waitFor(() => expect(toasts.length).toBe(1))
    expect(toasts[0]).toMatchObject({ type: "info" })
    expect(toasts[0]?.message).toMatch(/someone else changed/i)
    expect(ops(post).length).toBe(1)
    await waitFor(() => expect(screen.getByTestId("dashboard-history-panel")).toBeTruthy())
    expect(undo.disabled).toBe(true)
  })

  it("a newer version saved meanwhile reloads the dashboard and says so", async () => {
    const { post, get } = mount({
      post: () => {
        throw new ApiError("stale", 409, "VERSION_CONFLICT")
      },
    })
    await startEditing()
    const before = get.mock.calls.filter((c) => c[0] === "/dashboards/d1").length
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(toasts.length).toBe(1))
    expect(toasts[0]?.message).toMatch(/changed this dashboard/)
    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === "/dashboards/d1").length).toBeGreaterThan(
        before,
      ),
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId("dashboard-undo") as HTMLButtonElement).disabled).toBe(true)
  })

  it("a change made while the reload after a conflict is on its way waits for the new version", async () => {
    let release: () => void = () => {}
    let gate: Promise<void> | null = null
    let serverVersion = 3
    const m = mount({
      readGate: () => gate ?? Promise.resolve(),
      post: (_path, body) => {
        const { ifVersion } = body as { ifVersion: number }
        if (ifVersion !== serverVersion) throw new ApiError("stale", 409, "VERSION_CONFLICT")
        serverVersion++
        m.setVersion(serverVersion)
        return record(serverVersion)
      },
    })
    await startEditing()
    // Someone else saved version 5; the reload it triggers is slow.
    serverVersion = 5
    m.setVersion(5)
    gate = new Promise<void>((r) => {
      release = r
    })
    fireEvent.click(screen.getByTestId("dashboard-block-move-right-a"))
    await waitFor(() => expect(toasts.length).toBe(1))
    const title = screen.getByTestId("dashboard-title-input") as HTMLInputElement
    title.value = "Sales 2026"
    fireEvent.blur(title)
    await new Promise((r) => setTimeout(r, 30))
    gate = null
    release()
    await waitFor(() => expect(ops(m.post).length).toBe(2))
    expect(ops(m.post)[1]).toEqual({
      ifVersion: 5,
      operations: [{ op: "setTitle", title: "Sales 2026" }],
    })
    expect(toasts.length).toBe(1)
  })

  it("reloads once when the org's day turns over in an open tab", async () => {
    // 23:50 in Paris on the 12th, then 00:10 on the 13th.
    let clock = Date.parse("2026-11-12T22:50:00Z")
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock)
    try {
      const { get } = mount()
      await waitFor(() => expect(screen.getByTestId("dashboard-title").textContent).toBe("Sales"))
      document.dispatchEvent(new Event("visibilitychange"))
      await new Promise((r) => setTimeout(r, 20))
      const before = reads(get)
      clock = Date.parse("2026-11-12T23:10:00Z")
      document.dispatchEvent(new Event("visibilitychange"))
      await waitFor(() => expect(reads(get)).toBe(before + 1))
      document.dispatchEvent(new Event("visibilitychange"))
      await new Promise((r) => setTimeout(r, 30))
      expect(reads(get)).toBe(before + 1)
    } finally {
      spy.mockRestore()
    }
  })

  it("a block is drawn two rows tall when its height is 2", async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId("dashboard-block-b")).toBeTruthy())
    const b = screen.getByTestId("dashboard-block-b")
    expect(b.getAttribute("data-height")).toBe("2")
    expect(b.className).toContain("row-span-2")
    expect(screen.getByTestId("dashboard-block-a").getAttribute("data-height")).toBe("1")
  })
})

describe("version history", () => {
  it("opens in a side panel, lists who saved what, previews and restores", async () => {
    const { post } = mount()
    await openMenu("dashboard-menu")
    await waitFor(() => expect(screen.getByTestId("dashboard-history")).toBeTruthy())
    choose("dashboard-history")
    await waitFor(() => expect(screen.getByTestId("dashboard-history-version-2")).toBeTruthy())
    expect(screen.getByTestId("dashboard-history-change-3").textContent).toBe("1 block added")
    expect(screen.getByTestId("dashboard-history-saved-3").textContent).toMatch(/^Ada, /)
    // The current version has no Restore.
    expect(screen.queryByTestId("dashboard-history-restore-3")).toBeNull()
    fireEvent.click(screen.getByTestId("dashboard-history-preview-2"))
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-history-blocks-2").textContent).toContain("By market"),
    )
    fireEvent.click(screen.getByTestId("dashboard-history-restore-2"))
    await waitFor(() => expect(ops(post).length).toBe(1))
    expect(ops(post)[0]).toEqual({ ifVersion: 3, operations: [{ op: "revert", toVersion: 2 }] })
    fireEvent.click(screen.getByTestId("dashboard-history-close"))
    await waitFor(() => expect(screen.queryByTestId("dashboard-history-panel")).toBeNull())
  })

  it("someone who may not edit sees the history without Restore", async () => {
    mount({ canEdit: false })
    await openMenu("dashboard-menu")
    await waitFor(() => expect(screen.getByTestId("dashboard-history")).toBeTruthy())
    choose("dashboard-history")
    await waitFor(() => expect(screen.getByTestId("dashboard-history-version-2")).toBeTruthy())
    expect(screen.queryByTestId("dashboard-history-restore-2")).toBeNull()
  })
})

describe("toolbar menus", () => {
  it("exports the PDF and a block's CSV with the range shown", async () => {
    // jsdom has no object URLs: the save itself is stubbed.
    URL.createObjectURL = vi.fn(() => "blob:x")
    URL.revokeObjectURL = vi.fn()
    const { rawGet } = mount()
    await openMenu("dashboard-export")
    await waitFor(() => expect(screen.getByTestId("dashboard-export-pdf")).toBeTruthy())
    choose("dashboard-export-pdf")
    await waitFor(() => expect(rawGet).toHaveBeenCalledTimes(1))
    expect(String(rawGet.mock.calls[0]?.[0])).toBe(
      "/dashboards/d1/export.pdf?range=mtd&compare=none",
    )
    await openMenu("dashboard-block-menu-b")
    await waitFor(() => expect(screen.getByTestId("dashboard-block-csv-rows-b")).toBeTruthy())
    choose("dashboard-block-csv-rows-b")
    await waitFor(() => expect(rawGet).toHaveBeenCalledTimes(2))
    expect(String(rawGet.mock.calls[1]?.[0])).toBe(
      "/dashboards/d1/blocks/b/rows.csv?range=mtd&compare=none",
    )
  })

  it("duplicates the dashboard as the viewer's own", async () => {
    const { post } = mount({ post: () => record(1, { id: "d2", title: "Sales (copy)" }) })
    await openMenu("dashboard-menu")
    await waitFor(() => expect(screen.getByTestId("dashboard-duplicate")).toBeTruthy())
    choose("dashboard-duplicate")
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/dashboards/d1/duplicate",
        {},
        { suppressGlobalError: true },
      ),
    )
  })

  it("Send regularly explains the routine with an example naming the dashboard", async () => {
    mount()
    await openMenu("dashboard-menu")
    await waitFor(() => expect(screen.getByTestId("dashboard-send-regularly")).toBeTruthy())
    choose("dashboard-send-regularly")
    await waitFor(() => expect(screen.getByTestId("dashboard-schedule-hint")).toBeTruthy())
    expect(screen.getByTestId("dashboard-schedule-example").textContent).toContain("Sales")
    fireEvent.click(screen.getByTestId("dashboard-schedule-hint-close"))
    expect(screen.queryByTestId("dashboard-schedule-hint")).toBeNull()
  })
})

describe("org time zone and drill button", () => {
  it("resolves the range label from the org's today, not the browser's date", async () => {
    mount()
    // mtd from the org's today (2026-11-12): 1 to 12 Nov 2026, whatever the browser's date.
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-range").textContent).toMatch(
        /1.*12.*Nov.*2026|Nov 1.*12.*2026/,
      ),
    )
  })

  it("hides the drill button on a metric read from one object (LOW 15)", async () => {
    mount()
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-block-c").getAttribute("data-state")).toBe("ready"),
    )
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-block-a").getAttribute("data-state")).toBe("ready"),
    )
    expect(screen.queryByTestId("dashboard-block-rows-c")).toBeNull()
    expect(screen.getByTestId("dashboard-block-rows-a")).toBeTruthy()
  })
})

describe("filter search", () => {
  it("searches a source's values on the server (q), after a short pause", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const spec = {
        filters: [
          {
            id: "market",
            label: "Market",
            type: "select",
            options: { fromDataset: "o", field: "m" },
          },
        ],
      }
      let current = {
        ...record(3),
        spec: { ...record(3).spec, ...spec },
        filters: { values: { market: [] }, saved: false },
        defaultFilters: { market: [] },
      }
      const get = vi.fn(async (path: string) => {
        if (path === "/dashboards/d1") return current
        if (path.includes("/options")) {
          const q = new URLSearchParams(path.split("?")[1]).get("q")
          return { options: q ? ["France"] : ["Austria", "Belgium"], truncated: !q }
        }
        return { kind: "metric", value: 1, meta: { sourceRows: 1 } }
      })
      void current
      current = { ...current }
      const api = {
        get,
        post: vi.fn(),
        put: vi.fn(async () => ({})),
        delete: vi.fn(),
      } as unknown as ApiClient
      render(() => (
        <ApiContext.Provider value={api}>
          <DashboardView entityId="d1" />
        </ApiContext.Provider>
      ))
      await openMenu("dashboard-filter-market")
      await waitFor(() =>
        expect(screen.getByTestId("dashboard-filter-truncated-market")).toBeTruthy(),
      )
      const box = screen.getByTestId("dashboard-filter-search-market") as HTMLInputElement
      fireEvent.input(box, { target: { value: "fra" } })
      vi.advanceTimersByTime(FILTER_SEARCH_DEBOUNCE_MS + 10)
      await waitFor(() =>
        expect(get.mock.calls.map((c) => String(c[0])).some((p) => p.includes("q=fra"))).toBe(true),
      )
      await waitFor(() =>
        expect(screen.getByTestId("dashboard-filter-option-market-0").textContent).toContain(
          "France",
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
